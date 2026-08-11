import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/golden/**/*.test.ts'],
    // 골든 테스트는 도커로 실제 nginx -t 를 돌린다.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
