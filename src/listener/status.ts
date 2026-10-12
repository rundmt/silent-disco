// What the listener sees, derived purely from the machine's snapshot.
import type { SnapshotFrom } from 'xstate';
import type { listenerMachine } from './machine';

type ListenerSnapshot = SnapshotFrom<typeof listenerMachine>;

export const isListening = (s: ListenerSnapshot) => s.matches('listening');
export const isPlaying = (s: ListenerSnapshot) => s.matches({ listening: { session: 'playing' } });

export function statusText(s: ListenerSnapshot): string {
  const { hostOnline, meta, serverLost, myId } = s.context;
  if (serverLost && !myId) return 'Connecting…';
  if (serverLost) return isListening(s) ? 'Lost contact with the DJ, retrying…' : 'Reconnecting…';
  if (s.matches('idle')) {
    if (!hostOnline) return 'Waiting for the DJ…';
    return meta.live ? 'The DJ is live. Tap to listen.' : 'Connected. Waiting for the DJ to go live…';
  }
  if (s.matches({ listening: 'waitingForHost' })) return 'Waiting for the DJ…';
  if (s.matches({ listening: 'joining' })) return 'Connecting to the DJ…';
  if (s.matches({ listening: { session: 'connecting' } })) return 'Connecting to the DJ…';
  if (s.matches({ listening: { session: 'dropped' } })) return 'Signal dropped, reconnecting…';
  return meta.live ? 'Listening live' : 'Connected. The DJ is off air right now.';
}
