import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Every file uses the one test database, so files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
