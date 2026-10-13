// Talks to the Silent Disco app (native/api.go). The window opens this page
// with a one-time token in the URL hash; every request carries it.

import type { Visual } from '../shared/visuals';

export type SourceKind = 'system' | 'app' | 'input' | 'tone';

export interface SourceInfo {
  id: string;
  kind: SourceKind;
  label: string;
  detail?: string;
  dj?: boolean;
  playing?: boolean;
  icon?: string;
}

export interface State {
  name: string;
  kbps: number;
  visual: Visual;
  live: boolean;
  port: number;
  addresses: string[] | null;
  source: SourceInfo;
  status: 'capturing' | 'waiting' | 'error';
  error?: string;
  silent: boolean;
  auto: boolean;
  sources: SourceInfo[];
}

export interface Tick {
  level: number;
  listeners: number;
  open: number;
}

const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';

export function connect(handlers: {
  state: (s: State) => void;
  tick: (t: Tick) => void;
  connection: (up: boolean) => void;
}): () => void {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  es.onopen = () => handlers.connection(true);
  es.onerror = () => handlers.connection(false);
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') handlers.state(msg as State);
    else if (msg.type === 'tick') handlers.tick(msg as Tick);
  };
  return () => es.close();
}

async function post(path: string, body: unknown): Promise<State | undefined> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': token },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : undefined;
}

export const api = {
  setSource: (id: string) => post('/api/source', { id }),
  setLive: (live: boolean) => post('/api/live', { live }),
  setName: (name: string) => post('/api/settings', { name }),
  setKbps: (kbps: number) => post('/api/settings', { kbps }),
  openPrivacy: (kind: 'audio' | 'mic') => post('/api/privacy', { kind }),
  setVisual: (visual: Visual) => post('/api/visual', visual),
  flash: (color: string) => post('/api/flash', { color }),
};

export const iconUrl = (icon: string) => `${icon}&t=${encodeURIComponent(token)}`;
