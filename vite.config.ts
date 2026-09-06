import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT || 4173}`,
      '/mcp': `http://127.0.0.1:${process.env.PORT || 4173}`,
    },
  },
});
