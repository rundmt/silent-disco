// Development mode: Vite serves the pages with hot reload on :8080 and
// forwards signaling to server.js running on :8081.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const PORT = Number(process.env.PORT || 8080);
const SIGNAL_PORT = PORT + 1;

const signal = spawn(process.execPath, ['server.js'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(SIGNAL_PORT), PUBLIC_PORT: String(PORT), NO_OPEN: '1', QUIET: '1', SIGNAL_PORT: String(SIGNAL_PORT) },
});
process.on('exit', () => signal.kill());
process.on('SIGINT', () => process.exit());

process.env.SIGNAL_PORT = String(SIGNAL_PORT);
const vite = await createServer({ server: { port: PORT } });
await vite.listen();
console.log(`\n  Dev mode (hot reload)\n  Host page:  http://localhost:${PORT}/host.html\n  Listener:   http://localhost:${PORT}/\n`);
