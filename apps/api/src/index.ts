import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate } from './db.js';
import { buildApp } from './server.js';
import { startWorker } from './worker.js';

const cfg = loadConfig();
const log = {
  info: (o: unknown, m?: string) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  warn: (o: unknown, m?: string) => console.warn(m ?? '', JSON.stringify(o)),
  error: (o: unknown, m?: string) => console.error(m ?? '', o),
};
const ctx = createContext(cfg, log);
await migrate(ctx.db, (m) => log.info(m));

const app = await buildApp(ctx, { logger: cfg.NODE_ENV !== 'test' });
const stopWorker = cfg.RUN_WORKER_IN_PROCESS ? startWorker(ctx) : () => {};
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

const shutdown = async () => {
  stopWorker();
  await app.close();
  await ctx.pubsub.close();
  await ctx.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
