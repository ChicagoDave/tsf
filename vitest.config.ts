import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['docs/ref/**', 'node_modules/**', 'extensions/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
