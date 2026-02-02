import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['docs/ref/**', 'node_modules/**', 'extensions/**'],
  },
});
