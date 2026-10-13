/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// The Mac app embeds the build from native/web/dist. In dev, Vite serves the
// pages with hot reload and forwards everything else to the app (see dev.js).
const APP = `http://localhost:${process.env.APP_PORT || 8081}`;

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'es2020',
    outDir: 'native/web/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { listener: 'index.html', console: 'console.html' },
    },
  },
  // The state machines are tested in plain Node; no DOM needed.
  test: { environment: 'node' },
  server: {
    host: true,
    port: Number(process.env.PORT || 8080),
    proxy: {
      '/events': { target: APP, changeOrigin: false },
      '/signal': { target: APP, changeOrigin: false },
      '/api': { target: APP, changeOrigin: false },
    },
  },
});
