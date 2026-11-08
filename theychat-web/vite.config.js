import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' → 产物可在任意路径子目录下直接部署（相对资源引用；路由走 hash，无需服务端改写）
// 开发时 /v1 代理到本地服务端（THEYCHAT_DEV_API，默认 http://127.0.0.1:8000）
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.THEYCHAT_DEV_API ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  preview: { host: true, port: 4173 },
});
