import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/e2e/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
    maxWorkers: 1,
    isolate: true,
  },
});
