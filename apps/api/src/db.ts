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
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, max = Number(process.env.DB_POOL_MAX ?? 20)): Db {
  return new pg.Pool({ connectionString: url, max });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
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
