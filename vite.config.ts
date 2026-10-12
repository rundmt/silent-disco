/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const SIGNAL_SERVER = `http://localhost:${process.env.SIGNAL_PORT || 8081}`;

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'es2020',
    rollupOptions: {
      input: { listener: 'index.html', host: 'host.html', console: 'console.html' },
    },
  },
  // The state machines are tested in plain Node; no DOM needed.
  test: { environment: 'node' },
  server: {
    host: true,
    port: Number(process.env.PORT || 8080),
    // In dev, Vite serves the pages and forwards signaling to server.js.
    proxy: {
      '/events': { target: SIGNAL_SERVER, changeOrigin: false },
      '/signal': { target: SIGNAL_SERVER, changeOrigin: false },
      '/info': { target: SIGNAL_SERVER, changeOrigin: false },
    },
  },
});
