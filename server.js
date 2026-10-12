#!/usr/bin/env node
// Silent Disco: tiny zero-dependency signaling + static server.
// Audio never touches this server. It flows peer-to-peer over WebRTC from the
// host page (running on the DJ's Mac) to each listener's phone browser.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
// The port phones should use. Differs from PORT only in dev, behind Vite.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || PORT);
// The built web app (`npm run build` writes it here).
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// Connected clients, keyed by id. Each has { id, role, res }.
const clients = new Map();
let hostId = null;
let hostMeta = { name: 'Silent Disco', live: false };

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  // Prefer typical Wi-Fi/Ethernet interfaces (en0, en1...) and private ranges.
  const score = (a) =>
    (a.name.startsWith('en') ? 0 : 10) +
    (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address) ? 0 : 5);
  return out.sort((x, y) => score(x) - score(y));
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function send(id, msg) {
  const c = clients.get(id);
  if (!c) return false;
  c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  return true;
}

function broadcastListeners(msg) {
  for (const c of clients.values()) if (c.role === 'listener') send(c.id, msg);
}

function listenerCount() {
  let n = 0;
  for (const c of clients.values()) if (c.role === 'listener') n++;
  return n;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      // Built assets have content hashes in their names, so they can be cached.
      'Cache-Control': file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    res.end(buf);
  });
}

// Server-Sent Events stream: how the server pushes signaling messages to a page.
function openEvents(req, res, role) {
  if (role === 'host' && !isLoopback(req)) {
    return json(res, 403, { error: 'The host page only works on the Mac running the server (localhost).' });
  }
  const id = crypto.randomUUID();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.set(id, { id, role, res });

  if (role === 'host') {
    // A new host tab replaces any old one.
    if (hostId && hostId !== id) {
      send(hostId, { type: 'replaced' });
    }
    hostId = id;
    send(id, { type: 'welcome', id, lan: lanAddresses(), port: PUBLIC_PORT, listeners: listenerCount() });
    broadcastListeners({ type: 'host-online', meta: hostMeta });
  } else {
    send(id, { type: 'welcome', id, hostOnline: Boolean(hostId), meta: hostMeta });
    if (hostId) send(hostId, { type: 'count', listeners: listenerCount() });
  }

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
    if (id === hostId) {
      hostId = null;
      hostMeta.live = false;
      broadcastListeners({ type: 'host-offline' });
    } else if (hostId) {
      send(hostId, { type: 'leave', from: id });
      send(hostId, { type: 'count', listeners: listenerCount() });
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/events') {
    return openEvents(req, res, url.searchParams.get('role') === 'host' ? 'host' : 'listener');
  }

  if (req.method === 'POST' && url.pathname === '/signal') {
    let msg;
    try { msg = await readBody(req); } catch { return json(res, 400, { error: 'bad json' }); }
    const from = msg.from;
    const sender = clients.get(from);
    if (!sender) return json(res, 400, { error: 'unknown sender' });

    if (sender.role === 'listener') {
      // Listeners may only talk to the host.
      if (!hostId) return json(res, 409, { error: 'host offline' });
      send(hostId, { ...msg, from });
      return json(res, 200, { ok: true });
    }

    // Host: either a meta update or a message to one listener.
    if (msg.type === 'meta') {
      hostMeta = { name: String(msg.name || 'Silent Disco').slice(0, 60), live: Boolean(msg.live) };
      broadcastListeners({ type: 'meta', meta: hostMeta });
      return json(res, 200, { ok: true });
    }
    const ok = send(msg.to, { ...msg, from });
    return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'GET' && !fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('The web app has not been built yet. Run "npm install" and "npm run build", then restart.');
  }

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/listen') return serveStatic(res, 'index.html');
    if (url.pathname === '/host') {
      if (!isLoopback(req)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      return serveStatic(res, 'host.html');
    }
    return serveStatic(res, url.pathname.slice(1));
  }

  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  if (process.env.QUIET) return; // dev.js prints its own URLs
  const lan = lanAddresses();
  console.log('\n  Silent Disco is running.\n');
  console.log(`  DJ / host page (open on this Mac):  http://localhost:${PUBLIC_PORT}/host`);
  for (const a of lan) console.log(`  Listeners on the Wi-Fi (${a.name}):     http://${a.address}:${PUBLIC_PORT}/`);
  if (!lan.length) console.log('  No network address found. Connect to Wi-Fi so phones can reach you.');
  console.log('\n  Press Ctrl+C to stop.\n');

  if (process.platform === 'darwin' && !process.env.NO_OPEN) {
    exec(`open "http://localhost:${PUBLIC_PORT}/host"`);
  }
});
