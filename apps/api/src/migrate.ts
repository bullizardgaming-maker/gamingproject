import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
await migrate(db, console.log);
await db.end();
console.log('migrations complete');
