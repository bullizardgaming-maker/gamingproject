import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { migrate } from './db.js';
import { buildApp } from './server.js';
import { startWorker } from './worker.js';
import { startIndexer } from './indexer.js';
import { asCtxLogger, createLogger, initSentry } from './observability.js';

const cfg = loadConfig();
initSentry(cfg);
const logger = createLogger(cfg);
const log = asCtxLogger(logger);
const ctx = createContext(cfg, log);
await migrate(ctx.db, (m) => log.info({ migration: m }, 'migration applied'));

const app = await buildApp(ctx, { logger });
const stopWorker = cfg.RUN_WORKER_IN_PROCESS ? startWorker(ctx) : () => {};
const stopIndexer = startIndexer(ctx);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

const shutdown = async () => {
  stopWorker();
  stopIndexer();
  await app.close();
  await ctx.pubsub.close();
  await ctx.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
