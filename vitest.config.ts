import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // 逐拍状态机核对为纯同步计算，单线程即可保证确定性。
    pool: 'forks',
    reporters: 'default',
  },
});
