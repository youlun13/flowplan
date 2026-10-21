import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * base：
 *  - 正式部署（GitHub Pages）：FLOWPLAN_BASE=/flowplan/ → 啟用 Service Worker 離線快取
 *  - 其他（claude.ai 預覽、本機）：'./' 相對路徑；相對 base 下 Service Worker 的 scope 不可靠，故不啟用
 */
const base = process.env.FLOWPLAN_BASE ?? './';
const pwaEnabled = base.startsWith('/');

/** 未啟用 PWA 時，把 virtual:pwa-register 換成 no-op，讓同一份程式碼在兩種建置都能用 */
const pwaStub = {
  name: 'flowplan-pwa-stub',
  resolveId(id: string) {
    return id === 'virtual:pwa-register' ? '\0flowplan-pwa-stub' : null;
  },
  load(id: string) {
    return id === '\0flowplan-pwa-stub' ? 'export function registerSW(){ return async () => {}; }' : null;
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(pwaEnabled ? [] : [pwaStub]),
    ...(pwaEnabled
      ? [
          VitePWA({
            registerType: 'prompt',
            injectRegister: false,
            manifest: false,
            includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'],
            workbox: {
              globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
              navigateFallback: `${base}index.html`,
              // AI / 同步 Worker 永遠走網路，不快取
              navigateFallbackDenylist: [/workers\.dev/],
              runtimeCaching: [],
              cleanupOutdatedCaches: true,
            },
          }),
        ]
      : []),
  ],
  base,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-data': ['dexie', 'dexie-react-hooks', 'zod'],
          'vendor-date': ['date-fns', '@date-fns/tz'],
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
