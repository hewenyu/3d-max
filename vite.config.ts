import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { rollupOptions: { input: { editor: resolve('index.html'), review: resolve('review.html') } } },
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/review-api': `http://127.0.0.1:${process.env.WHITEFRAME_REVIEW_PORT || Number(process.env.PORT || 4173) + 100}`,
      '/api': `http://127.0.0.1:${process.env.PORT || 4173}`,
      '/mcp': `http://127.0.0.1:${process.env.PORT || 4173}`,
    },
  },
});
