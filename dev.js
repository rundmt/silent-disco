// Development mode: runs the Mac app in Terminal on :8081 and Vite on :8080,
// so the phone page and DJ console hot reload while the app does the audio.
// Extra arguments go to the app, e.g. `npm run dev -- -tone`.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const PORT = Number(process.env.PORT || 8080);
const APP_PORT = PORT + 1;

const app = spawn('go', ['run', '-tags', 'nolibopusfile', '.', '-nowindow', '-port', String(APP_PORT), ...process.argv.slice(2)], {
  cwd: 'native',
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => app.kill());
process.on('SIGINT', () => process.exit());

// The console needs the app's token, which it prints on startup.
const token = await new Promise((resolve, reject) => {
  let out = '';
  app.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/#t=(\w+)/);
    if (m) resolve(m[1]);
  });
  app.on('exit', (code) => reject(new Error(`the app exited (${code})`)));
});

process.env.APP_PORT = String(APP_PORT);
const vite = await createServer({ server: { port: PORT } });
await vite.listen();
console.log(`\n  Dev mode (hot reload)\n  DJ console: http://localhost:${PORT}/console.html#t=${token}\n  Phone page: http://localhost:${PORT}/\n`);
