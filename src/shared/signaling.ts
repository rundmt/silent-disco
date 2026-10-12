// Thin wrapper around the server's signaling channel:
// Server-Sent Events for server -> page, POST /signal for page -> server.

export type Role = 'host' | 'listener';

export interface PartyMeta {
  name: string;
  live: boolean;
}

export interface LanAddress {
  name: string;
  address: string;
}

/** Messages the server pushes to pages. */
export type ServerMessage =
  | { type: 'welcome'; id: string; hostOnline?: boolean; meta?: PartyMeta; lan?: LanAddress[]; port?: number; listeners?: number }
  | { type: 'host-online'; meta: PartyMeta }
  | { type: 'host-offline' }
  | { type: 'meta'; meta: PartyMeta }
  | { type: 'count'; listeners: number }
  | { type: 'replaced' }
  | { type: 'join'; from: string }
  | { type: 'leave'; from: string }
  | { type: 'offer'; from: string; sdp: string; kbps: number }
  | { type: 'answer'; from: string; sdp: string }
  | { type: 'candidate'; from: string; candidate: RTCIceCandidateInit };

/** Opens the event stream. EventSource reconnects on its own after blips. */
export function connectEvents(role: Role, onMessage: (msg: ServerMessage) => void, onError?: () => void) {
  const es = new EventSource(`/events?role=${role}`);
  es.onmessage = (e) => onMessage(JSON.parse(e.data));
  es.onerror = () => onError?.();
  return () => es.close();
}

export async function postSignal(msg: Record<string, unknown> & { from: string; type: string }) {
  try {
    const r = await fetch('/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return r.ok;
  } catch {
    return false;
  }
}
