// Model-based tests for the host console.
//
// xstate/graph finds the shortest event path to every distinct combination
// of audio source, on/off air and connected listeners. From each of those
// states we then try every possible event, so every transition is exercised.
// Each run replays against a real actor whose capture devices, signaling and
// WebRTC peers are recording fakes, checking after every step that each
// listener hears exactly what it should (invariants) and that specific events
// do what they must (transition rules, written independently of the machine).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromCallback, fromPromise, type EventObject, type SnapshotFrom } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { postSignal } from '../shared/signaling';
import { hostMachine, type HostEvent } from './machine';
import type { HostPeerEvent, HostPeerInput, HostPeerReceive } from './peer';
import type { AudioDevice } from './capture';
import { isInit } from '../test/delays';

vi.mock('../shared/signaling', () => ({
  postSignal: vi.fn(async () => true),
  connectEvents: vi.fn(() => () => {}),
}));

type Snapshot = SnapshotFrom<typeof hostMachine>;

// --- Fake media -------------------------------------------------------------

interface FakeTrack {
  name: string;
  stopped: boolean;
  stop(): void;
}
function fakeStream(name: string) {
  const track: FakeTrack = { name, stopped: false, stop: () => (track.stopped = true) };
  return { name, getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream & { name: string };
}
const trackOf = (s: MediaStream | null) => (s?.getAudioTracks()[0] as unknown as FakeTrack | undefined) ?? null;

const DEVICES: AudioDevice[] = [{ id: 'blackhole', label: 'BlackHole 2ch' }, { id: 'mic', label: 'MacBook Mic' }];

// The model only needs stand-in streams; replays swap in fresh ones by name.
const modelStreams = { device: fakeStream('device'), tab: fakeStream('tab') };

// --- Events -----------------------------------------------------------------

const EVENTS = [
  { type: 'SERVER.WELCOME', id: 'host', lan: [{ name: 'en0', address: '192.168.1.20' }], port: 8080, listeners: 0 },
  { type: 'xstate.done.actor.openDevice', output: { stream: modelStreams.device, devices: DEVICES, deviceId: 'blackhole' } },
  { type: 'xstate.error.actor.openDevice', error: new Error('Permission denied') },
  { type: 'xstate.done.actor.shareTab', output: modelStreams.tab },
  { type: 'xstate.error.actor.shareTab', error: new Error('Cancelled') },
  { type: 'GO_LIVE' },
  { type: 'STOP' },
  { type: 'SELECT_DEVICE', deviceId: 'mic' },
  { type: 'SHARE_TAB' },
  { type: 'TRACK_ENDED' },
  { type: 'SET_BITRATE', kbps: 128 },
  { type: 'SERVER.JOIN', from: 'alice' },
  { type: 'SERVER.JOIN', from: 'bob' },
  { type: 'SERVER.LEAVE', from: 'alice' },
  { type: 'PEER.GONE', listenerId: 'bob' },
  { type: 'SERVER.ANSWER', from: 'alice', sdp: 'answer-sdp' },
  { type: 'SERVER.CANDIDATE', from: 'alice', candidate: { candidate: 'cand' } },
  { type: 'SERVER.REPLACED' },
] as HostEvent[];

// Behaviorally distinct states: where each region is, who's connected, and
// which source is current. Bitrate is folded in so its propagation is tested.
const serializeState = (s: Snapshot) =>
  JSON.stringify({
    value: s.value,
    peers: Object.keys(s.context.peers).sort(),
    stream: (s.context.stream as { name?: string } | null)?.name ?? null,
    id: !!s.context.myId,
    kbps: s.context.kbps,
  });

const paths = getShortestPaths(hostMachine, {
  events: EVENTS,
  serializeState: (s) => serializeState(s as Snapshot),
  limit: 100_000, // safety net; the real state space is a few hundred states
});

// --- Fakes for the replay ---------------------------------------------------

function harness() {
  const peers: { listenerId: string; alive: boolean; track: unknown; kbps: number; received: HostPeerReceive[] }[] = [];
  const pending: Record<'openDevice' | 'shareTab', { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null> = {
    openDevice: null,
    shareTab: null,
  };
  const streams = { device: [] as MediaStream[], tab: [] as MediaStream[] };

  const deferred = (key: 'openDevice' | 'shareTab') =>
    new Promise((resolve, reject) => (pending[key] = { resolve, reject }));

  const machine = hostMachine.provide({
    actors: {
      signaling: fromCallback(() => {}),
      watchDevices: fromCallback(() => {}),
      watchTrack: fromCallback(() => {}),
      openDevice: fromPromise(() => deferred('openDevice')) as never,
      shareTab: fromPromise(() => deferred('shareTab')) as never,
      hostPeer: fromCallback<HostPeerReceive, HostPeerInput, HostPeerEvent>(({ input, receive }) => {
        const peer = { listenerId: input.listenerId, alive: true, track: input.track, kbps: input.kbps, received: [] as HostPeerReceive[] };
        peers.push(peer);
        receive((e) => {
          peer.received.push(e);
          if (e.type === 'TRACK') peer.track = e.track;
          if (e.type === 'BITRATE') peer.kbps = e.kbps;
        });
        return () => (peer.alive = false);
      }),
    },
  });

  /** Plays one model event against the real actor. */
  async function play(actor: ReturnType<typeof createActor<typeof machine>>, event: EventObject) {
    const done = event.type.match(/^xstate\.(done|error)\.actor\.(openDevice|shareTab)$/);
    if (done) {
      const [, kind, key] = done as unknown as [string, 'done' | 'error', 'openDevice' | 'shareTab'];
      const p = pending[key]!;
      pending[key] = null;
      if (kind === 'error') p.reject((event as unknown as { error: unknown }).error);
      else {
        const s = fakeStream(key === 'openDevice' ? 'device' : 'tab');
        streams[key === 'openDevice' ? 'device' : 'tab'].push(s);
        p.resolve(key === 'openDevice' ? { stream: s, devices: DEVICES, deviceId: 'blackhole' } : s);
      }
      // Let the promise settle and the machine react.
      await new Promise((r) => setTimeout(r, 0));
    } else {
      actor.send(event as HostEvent);
    }
  }

  return { machine, peers, streams, play };
}

const metaCalls = () =>
  vi.mocked(postSignal).mock.calls.map(([m]) => m).filter((m) => m.type === 'meta') as unknown as { live: boolean }[];

function checkInvariants(s: Snapshot, h: ReturnType<typeof harness>, event: EventObject) {
  const alive = h.peers.filter((p) => p.alive);
  const live = s.matches({ active: { broadcast: 'onAir' } });

  // One live connection per known listener, never duplicates or leftovers.
  expect(alive.map((p) => p.listenerId).sort()).toEqual(Object.keys(s.context.peers).sort());

  // Every listener hears the current source when on air, and silence otherwise.
  const expected = live ? trackOf(s.context.stream) : null;
  for (const p of alive) expect(p.track).toBe(expected);

  // Every listener uses the chosen quality.
  for (const p of alive) expect(p.kbps).toBe(s.context.kbps);

  // You can't be on air without a source.
  if (live) expect(s.context.stream).not.toBeNull();

  // Replaced sources are released (no stuck mic indicator or leaked capture).
  for (const old of [...h.streams.device, ...h.streams.tab]) {
    if (old !== s.context.stream) expect(trackOf(old)!.stopped).toBe(true);
  }

  // Listeners are told whether the DJ is live.
  if (s.matches('active') && s.context.myId && metaCalls().length) expect(metaCalls().at(-1)!.live).toBe(live);

  // Answers and candidates reach the right listener's connection.
  if ((event.type === 'SERVER.ANSWER' || event.type === 'SERVER.CANDIDATE') && s.context.peers.alice) {
    const alice = alive.find((p) => p.listenerId === 'alice')!;
    expect(alice.received.at(-1)!.type).toBe(event.type === 'SERVER.ANSWER' ? 'ANSWER' : 'CANDIDATE');
  }

  // A replaced host tab shuts everything down.
  if (s.matches('replaced')) expect(alive).toHaveLength(0);
}

/** What specific events must do, independent of how the machine is written. */
function checkTransitionRules(prev: Snapshot, s: Snapshot, event: EventObject) {
  if (prev.matches('replaced')) return; // a replaced tab ignores everything
  const wasLive = prev.matches({ active: { broadcast: 'onAir' } });
  const live = s.matches({ active: { broadcast: 'onAir' } });
  const e = event as EventObject & { from?: string; listenerId?: string };

  if (event.type === 'GO_LIVE') expect(live).toBe(!!prev.context.stream);
  if (event.type === 'STOP') expect(live).toBe(false);
  // Only GO_LIVE and STOP change whether you're on air.
  if (!['GO_LIVE', 'STOP', 'SERVER.REPLACED'].includes(event.type)) expect(live).toBe(wasLive);

  // Joining always yields a fresh connection for that listener.
  if (event.type === 'SERVER.JOIN') {
    expect(s.context.peers[e.from!]).toBeDefined();
    expect(s.context.peers[e.from!].childId).not.toBe(prev.context.peers[e.from!]?.childId);
  }
  // Leaving or failing removes exactly that listener.
  if (event.type === 'SERVER.LEAVE' || event.type === 'PEER.GONE') {
    const who = e.from ?? e.listenerId!;
    expect(s.context.peers[who]).toBeUndefined();
    const { [who]: _, ...others } = prev.context.peers;
    expect(Object.keys(s.context.peers).sort()).toEqual(Object.keys(others).sort());
  }
  // Switching inputs reopens the device; a vanished source falls back to it.
  if (event.type === 'SELECT_DEVICE' || (event.type === 'TRACK_ENDED' && prev.matches({ active: { audio: 'ready' } }))) {
    expect(s.matches({ active: { audio: 'opening' } })).toBe(true);
  }
  // A cancelled tab share keeps the current source.
  if (event.type === 'xstate.error.actor.shareTab' && prev.context.stream) {
    expect(s.context.stream).toBe(prev.context.stream);
  }
  // A newer host tab takes over.
  if (event.type === 'SERVER.REPLACED') expect(s.matches('replaced')).toBe(true);
}

const describePath = (steps: { event: EventObject }[]) =>
  steps
    .filter((s) => !isInit(s.event))
    .map((s) => {
      const e = s.event as EventObject & { from?: string; listenerId?: string };
      const who = e.from ?? e.listenerId;
      return e.type.replace(/^xstate\.(done|error)\.actor\./, '$1:') + (who ? `(${who})` : '');
    })
    .join(' → ') || 'start';

describe('host machine (model-based)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('explores a meaningful number of states', () => {
    expect(paths.length).toBeGreaterThan(50);
  });

  /** Replays events on a fresh actor, checking everything after each step. */
  async function replay(events: EventObject[], expectedValues: (Snapshot['value'] | undefined)[]) {
    vi.clearAllMocks();
    const h = harness();
    const actor = createActor(h.machine).start();
    for (const [i, event] of events.entries()) {
      const prev = actor.getSnapshot();
      await h.play(actor, event);
      const now = actor.getSnapshot();
      try {
        if (expectedValues[i] !== undefined) expect(now.value).toEqual(expectedValues[i]);
        checkInvariants(now, h, event);
        checkTransitionRules(prev, now, event);
      } catch (err) {
        (err as Error).message = `after ${describePath(events.slice(0, i + 1).map((event) => ({ event })))}\n${(err as Error).message}`;
        throw err;
      }
    }
    actor.stop();
  }

  for (const path of paths) {
    const steps = path.steps.filter((s) => !isInit(s.event));
    const toHere = steps.map((s) => s.event);
    const values = steps.map((s) => s.state.value);
    it(`${describePath(steps)}: every next event`, async () => {
      await replay(toHere, values);
      // Only events this state can actually receive (e.g. a device can only
      // finish opening while it is being opened).
      for (const event of EVENTS.filter((e) => path.state.can(e) || !e.type.startsWith('xstate.'))) {
        await replay([...toHere, event], values);
      }
    });
  }
});
