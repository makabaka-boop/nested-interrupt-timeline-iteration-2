import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑 src 下的 TypeScript 测试；dist-tests 是 tsc 编译产物，不重复执行。
    include: ['src/**/*.test.ts'],
  },
});
