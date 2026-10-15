import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
  server: {
    proxy: { '/api': { target: process.env.GIGI_DEV_API ?? 'http://127.0.0.1:8470', changeOrigin: false } },
  },
});
