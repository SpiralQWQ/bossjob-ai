import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 独立 vitest 配置：不加载 vite.config.ts 的 strict-csp 构建插件（只服务 build），
// 测试环境 jsdom + React Testing Library（setupFiles 注入 jest-dom 匹配器）。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
