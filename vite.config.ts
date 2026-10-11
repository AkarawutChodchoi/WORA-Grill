/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const apiPort = process.env.PORT ?? '3000';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)) } },
  server: {
    // Listen on the LAN too, so phones/tablets on the shop Wi-Fi can open the app and guest QR links.
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, ws: true },
      '/uploads': `http://localhost:${apiPort}`,
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
  test: {
    root: '.',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'web/**/*.test.ts', 'web/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['./web/src/test-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
  },
});
