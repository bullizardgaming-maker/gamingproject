import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database; run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://market:market@localhost:5432/market_test',
    },
  },
});
