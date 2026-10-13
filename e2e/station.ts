// Starts the real app (-nowindow -tone) for browser tests, with its own empty
// settings so tests never touch the DJ's saved ones.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export const binary = join(import.meta.dirname, '..', 'native', 'silent-disco-test');

export interface Station {
  /** Phone page, as a phone on the Wi-Fi would open it. */
  phoneURL: string;
  /** DJ console with its token. */
  consoleURL: string;
  port: number;
  token: string;
  stop(): Promise<void>;
}

export async function startStation(): Promise<Station> {
  const home = mkdtempSync(join(tmpdir(), 'sd-e2e-'));
  const proc: ChildProcess = spawn(binary, ['-nowindow', '-tone', '-port', String(20000 + Math.floor(Math.random() * 20000))], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const consoleURL = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app didn't start:\n${out}`)), 15_000);
    proc.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/DJ console \(this computer only\): (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.stderr!.on('data', (d) => (out += d));
    proc.on('exit', (code) => reject(new Error(`app exited (${code}):\n${out}`)));
  });
  const u = new URL(consoleURL);
  return {
    consoleURL,
    phoneURL: `http://localhost:${u.port}/`,
    port: Number(u.port),
    token: u.hash.replace('#t=', ''),
    async stop() {
      proc.kill('SIGINT');
      await new Promise((r) => proc.once('exit', r));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A TCP relay in front of the app whose connections can be cut, like Wi-Fi blips or Android backgrounding Chrome. */
export async function startRelay(port: number) {
  const pairs = new Set<[net.Socket, net.Socket]>();
  let accepted = 0;
  const server = net.createServer((c) => {
    accepted++;
    const u = net.connect(port, '127.0.0.1');
    const pair: [net.Socket, net.Socket] = [c, u];
    pairs.add(pair);
    const end = () => {
      pairs.delete(pair);
      c.destroy();
      u.destroy();
    };
    c.pipe(u).pipe(c);
    for (const s of pair) s.on('error', end).on('close', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://localhost:${(server.address() as net.AddressInfo).port}/`,
    /** Connections accepted so far: a reconnecting page shows up here. */
    get accepted() {
      return accepted;
    },
    cut() {
      for (const [c, u] of pairs) {
        c.destroy();
        u.destroy();
      }
    },
    close() {
      const closed = new Promise((r) => server.close(r));
      this.cut();
      return closed;
    },
  };
}

/** Keeps every RTCPeerConnection the page makes so tests can read its stats. */
export async function watchPeers(page: Page) {
  await page.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    const pcs: RTCPeerConnection[] = [];
    (window as any).__pcs = pcs;
    window.RTCPeerConnection = class extends Real {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        pcs.push(this);
      }
    } as typeof RTCPeerConnection;
  });
}

/** Audio bytes received and connection count on a phone page. */
export async function audioStats(page: Page) {
  return page.evaluate(async () => {
    const pcs: RTCPeerConnection[] = (window as any).__pcs ?? [];
    let bytes = 0;
    let level = 0;
    for (const pc of pcs) {
      (await pc.getStats()).forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          bytes += r.bytesReceived ?? 0;
          level = Math.max(level, r.audioLevel ?? 0);
        }
      });
    }
    return { bytes, level, peers: pcs.length, open: pcs.filter((p) => p.connectionState === 'connected').length };
  });
}
