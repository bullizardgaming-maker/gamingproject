import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// int8 (bigint) -> number. All money values are cents and stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric -> number (risk scores).
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that runs a parameterised query: the pool, a transaction client, or the read pool. */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(url: string, max = Number(process.env.DB_POOL_MAX ?? 20), opts: { connectTimeoutMs?: number } = {}): Db {
  // The timeout covers queueing for a free pooled connection, not just connecting, so it must
  // tolerate load bursts on the primary; replicas use a short one because reads can fall back.
  const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: opts.connectTimeoutMs ?? 30_000 });
  // An idle connection dropped by the server (failover, restart, admin kill) is reported here.
  // Without a listener Node treats it as an uncaught error and the process dies; the pool
  // already discards the broken client and opens a new one on demand.
  pool.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') console.error(JSON.stringify({ level: 'warn', msg: 'database connection lost', err: err.message }));
  });
  return pool;
}

/** The connection itself failed (server restart, failover, admin kill, network), as opposed to a SQL error. */
export function isConnectionError(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e?.code && /^(08|57P0[1-3])/.test(e.code)) return true;
  return /Connection terminated|ECONNRESET|ECONNREFUSED|EPIPE|connection timeout/i.test(e?.message ?? '');
}

/**
 * Run `fn` in a transaction. If the connection dies before COMMIT is sent, the transaction
 * certainly rolled back, so it is retried once on a fresh connection (fn must keep external
 * calls idempotent, which ours do; realtime publishes happen after commit). A failure during
 * COMMIT is never retried: the outcome is unknown and the caller must check.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    // A connection killed mid-transaction also emits 'error' on the checked-out client. The failing
    // query rejects with it anyway; listening stops it becoming an uncaught exception, and the broken
    // client is destroyed on release instead of going back into the pool.
    let broken: Error | undefined;
    const onClientError = (err: Error) => (broken = err);
    client.on('error', onClientError);
    let committing = false;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isConnectionError(err)) broken ??= err as Error;
      if (attempt === 0 && !committing && isConnectionError(err)) continue;
      throw err;
    } finally {
      client.off('error', onClientError);
      client.release(broken);
    }
  }
}

export async function one<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T> {
  const res = await q.query(sql, params);
  if (res.rowCount === 0) throw new Error(`Expected one row: ${sql.slice(0, 80)}`);
  return res.rows[0] as T;
}

export async function maybeOne<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await q.query(sql, params);
  return (res.rows[0] as T) ?? null;
}

export async function many<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await q.query(sql, params);
  return res.rows as T[];
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await withTx(db, async (tx) => {
      // Serialize concurrent migrators.
      await tx.query('SELECT pg_advisory_xact_lock(727274)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await tx.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log(`applied ${file}`);
    });
  }
}

/**
 * Read-only queries that tolerate slightly stale data (market search, listings, seller
 * profiles, metrics) go to a streaming replica when DATABASE_READ_URL is set. If the replica
 * falls more than `maxLagSeconds` behind or stops answering, reads go to the primary until
 * it recovers. Never use this for a read that decides a write (stock, balances, order state).
 */
export class ReadPool {
  lagSeconds: number | null = null;
  healthy = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly primary: Db,
    private readonly replica: Db | null,
    private readonly maxLagSeconds = 10,
  ) {
    if (replica) {
      void this.check();
      this.timer = setInterval(() => void this.check(), 5_000);
      this.timer.unref();
    }
  }

  get usingReplica() {
    return !!this.replica && this.healthy;
  }

  async check() {
    if (!this.replica) return;
    try {
      // On a replica: seconds since the last replayed transaction (0 when idle and caught up).
      const { rows } = await this.replica.query<{ lag: number | null; in_recovery: boolean }>(
        `SELECT pg_is_in_recovery() AS in_recovery,
                CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                     ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END::float AS lag`,
      );
      this.lagSeconds = rows[0]!.in_recovery ? (rows[0]!.lag ?? 0) : 0;
      this.healthy = this.lagSeconds <= this.maxLagSeconds;
    } catch {
      this.healthy = false;
      this.lagSeconds = null;
    }
  }

  async query<R extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
    if (this.usingReplica) {
      try {
        return await this.replica!.query<R>(text, params as any[]);
      } catch (err) {
        // Real SQL errors (a 5-character SQLSTATE outside connection classes) are rethrown. Anything else
        // (refused, reset, timed out, server shutting down) marks the replica unhealthy and the primary answers.
        const code = (err as { code?: string }).code ?? '';
        if (/^[0-9A-Z]{5}$/.test(code) && !/^(08|57P)/.test(code)) throw err;
        this.healthy = false;
      }
    }
    return this.primary.query<R>(text, params as any[]);
  }

  async end() {
    if (this.timer) clearInterval(this.timer);
    await this.replica?.end();
  }
}
