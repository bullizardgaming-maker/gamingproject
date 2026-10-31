import { loadConfig, originWarning } from './config.js';
import { createContext } from './context.js';
import { loadLeagues } from './domain/leagues.js';
import { migrate } from './db.js';
import { buildApp } from './server.js';
import { startWorker } from './worker.js';
import { startIndexer } from './indexer.js';
import { NowPaymentsProvider } from './providers/payments/nowpayments.js';
import { asCtxLogger, createLogger, initSentry } from './observability.js';

const cfg = loadConfig();
initSentry(cfg);
const logger = createLogger(cfg);
const log = asCtxLogger(logger);
const warning = originWarning(cfg);
if (warning) log.warn({ config: 'ORIGIN_SHARED_SECRET' }, warning);
const ctx = createContext(cfg, log);
await migrate(ctx.db, (m) => log.info({ migration: m }, 'migration applied'));
await loadLeagues(ctx.db); // open challenge leagues become sell-form choices

const app = await buildApp(ctx, { logger });
const stopWorker = cfg.RUN_WORKER_IN_PROCESS ? startWorker(ctx) : () => {};
const stopIndexer = startIndexer(ctx);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
// Round 27 (3): warm the coin list and minimums so the first buyer's payment-method step answers from cache.
if (ctx.payments instanceof NowPaymentsProvider) ctx.payments.warmCoins();

const shutdown = async () => {
  stopWorker();
  stopIndexer();
  await app.close();
  await ctx.pubsub.close();
  await ctx.views.close();
  await ctx.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
