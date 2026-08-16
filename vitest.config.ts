import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/conformance/**/*.test.ts', 'tests/golden/**/*.test.ts', 'tests/e2e/**/*.test.ts', 'tests/model/**/*.test.ts', 'tests/store/**/*.test.ts'],
    // 골든·e2e 는 도커로 실제 nginx 를 돌린다.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
