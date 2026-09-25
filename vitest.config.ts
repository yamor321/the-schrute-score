import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests must never hit the network or depend on a real key.
    env: { ARTIFICIAL_ANALYSIS_API_KEY: '' },
  },
});
