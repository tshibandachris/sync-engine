import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Vitest 4 removed poolOptions and minWorkers. maxWorkers alone
    // caps the concurrency, and isolate: false keeps the fork shared
    // across files so the Testcontainers containers do not contend.
    maxWorkers: 1,
    isolate: false,
  },
});