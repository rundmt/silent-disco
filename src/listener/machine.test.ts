// Model-based tests for the listener.
//
// xstate/graph walks the machine and finds the shortest event path to every
// distinct state (timeouts included). From each of those states we then try
// every possible event, so every transition gets exercised, not just every
// state. Each run replays against a real actor whose side effects (signaling,
// audio, the WebRTC peer) are recording fakes, and after every step we check:
//   - invariants: rules that hold in a state whatever route led there
//   - transition rules: what specific events must do, written independently
//     of the machine so a missing or wrong transition is caught
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor, fromCallback, type EventObject, type SnapshotFrom } from 'xstate';
import { getShortestPaths } from 'xstate/graph';
import { postSignal } from '../shared/signaling';
import * as output from './audioOutput';
import { listenerMachine, type ListenerEvent } from './machine';
import { statusText } from './status';
import { delayOf, delayedEvents, isDelayed, isInit } from '../test/delays';
import type { PeerEvent, PeerInput, PeerReceive } from './peer';

vi.mock('../shared/signaling', () => ({
  postSignal: vi.fn(async () => true),
  connectEvents: vi.fn(() => () => {}),
}));
vi.mock('./audioOutput', () => ({
  unlock: vi.fn(),
  resume: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  stopKeepAlive: vi.fn(),
  setVolume: vi.fn(),
}));

type Snapshot = SnapshotFrom<typeof listenerMachine>;

const party = (live: boolean) => ({ name: 'Party', live });

// Every external event the listener can receive, with representative payloads.
const EVENTS: ListenerEvent[] = [
  { type: 'TAP' },
  { type: 'SERVER.WELCOME', id: 'me', hostOnline: true, meta: party(true) },
  { type: 'SERVER.WELCOME', id: 'me', hostOnline: false, meta: party(false) },
  { type: 'SERVER.WELCOME', id: 'restarted', hostOnline: true, meta: party(true) },
  { type: 'SERVER.HOST_ONLINE', meta: party(true) },
  { type: 'SERVER.HOST_OFFLINE' },
  { type: 'SERVER.META', meta: party(false) },
  { type: 'SERVER.META', meta: party(true) },
  { type: 'SERVER.OFFER', sdp: 'offer-sdp', kbps: 192 },
  { type: 'SERVER.CANDIDATE', candidate: { candidate: 'cand' } },
  { type: 'SERVER.LOST' },
  { type: 'PEER.CONNECTED' },
  { type: 'PEER.DISCONNECTED' },
  { type: 'PEER.FAILED' },
];

// Only what matters for behavior; keeps the state space small and finite.
const serializeState = (s: Snapshot) =>
  JSON.stringify({
    value: s.value,
    hostOnline: s.context.hostOnline,
    live: s.context.meta.live,
    lost: s.context.serverLost,
    id: !!s.context.myId,
  });

const paths = getShortestPaths(listenerMachine, {
  events: (s) => [...EVENTS, ...delayedEvents(s)] as ListenerEvent[],
  serializeState: (s) => serializeState(s as Snapshot),
});

/** A fake WebRTC peer that records its lifetime and the candidates it gets. */
function fakePeers() {
  const peers: { offer: { sdp: string; kbps: number }; alive: boolean; candidates: unknown[] }[] = [];
  const logic = fromCallback<PeerReceive, PeerInput, PeerEvent>(
    ({ input, receive }) => {
      const peer = { offer: input.offer, alive: true, candidates: [] as unknown[] };
      peers.push(peer);
      receive((e) => peer.candidates.push(e.candidate));
      return () => (peer.alive = false);
    },
  );
  return { peers, logic };
}

const describePath = (steps: { event: EventObject }[]) =>
  steps.filter((s) => !isInit(s.event)).map((s) => s.event.type.replace(/^xstate\.after\.(\d+)\..*/, 'wait $1ms')).join(' → ') || 'start';

const signals = () => vi.mocked(postSignal).mock.calls.map(([m]) => m.type);
const lastCall = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder.at(-1) ?? 0;

/** Rules that must hold in every reachable state. */
function checkInvariants(
  s: Snapshot,
  peers: ReturnType<typeof fakePeers>['peers'],
  event: EventObject | undefined,
  prev: Snapshot,
  peersBefore: number,
) {
  const alive = peers.filter((p) => p.alive);
  const inSession = s.matches({ listening: 'session' });

  // Exactly one WebRTC connection while in a session, none otherwise.
  expect(alive).toHaveLength(inSession ? 1 : 0);
  // ...and it's for the latest offer the DJ sent.
  if (inSession) expect(alive[0].offer).toEqual(s.context.offer);

  // Joining always means we just asked the DJ for a stream.
  if (s.matches({ listening: 'joining' })) expect(signals().at(-1)).toBe('join');

  // Once you stop listening, the DJ is told and audio is torn down.
  if (s.matches('idle') && signals().length) {
    expect(signals().at(-1)).toBe('leave');
    expect(lastCall(vi.mocked(output.detach))).toBeGreaterThan(lastCall(vi.mocked(postSignal)) - 1);
  }

  // Starting to listen unlocks audio inside the tap (mobile autoplay rules).
  if (event?.type === 'TAP' && prev.matches('idle')) expect(output.unlock).toHaveBeenCalled();

  // The event stream resuming with the same id (Android drops it in the
  // background) never touches a working audio connection.
  const welcome = event?.type === 'SERVER.WELCOME' ? (event as Extract<ListenerEvent, { type: 'SERVER.WELCOME' }>) : null;
  if (welcome && welcome.id === prev.context.myId && welcome.hostOnline && prev.matches({ listening: 'session' })) {
    expect(s.value).toEqual(prev.value);
    expect(peers.length).toBe(peersBefore);
  }
  // A new id means the server restarted, so any old connection is dropped and we rejoin.
  if (welcome && welcome.id !== prev.context.myId && prev.matches('listening')) {
    expect(inSession).toBe(false);
  }

  // ICE candidates reach the live connection.
  if (event?.type === 'SERVER.CANDIDATE' && inSession && prev.matches({ listening: 'session' })) {
    expect(alive[0].candidates).toContainEqual({ candidate: 'cand' });
  }

  // The status line always says something, and the right thing for key states.
  const text = statusText(s);
  expect(text).toBeTruthy();
  if (!s.context.serverLost) {
    if (s.matches({ listening: { session: 'dropped' } })) expect(text).toMatch(/dropped/);
    if (s.matches({ listening: 'waitingForHost' })) expect(text).toMatch(/Waiting for the DJ/);
    if (s.matches({ listening: { session: 'playing' } })) expect(text).toMatch(s.context.meta.live ? /Listening live/ : /off air/);
  }
}

// Not a machine event: the replay just lets 10 seconds of real time pass.
// Used to check the machine never gets stuck, independent of its own timers.
const WAIT = { type: 'test.wait', ms: 10_000 } as const;
const isWait = (e: EventObject): e is typeof WAIT => e.type === WAIT.type;

/** What specific events must do, independent of how the machine is written. */
function checkTransitionRules(prev: Snapshot, s: Snapshot, event: EventObject) {
  // Nothing in the connection flow waits forever: after a while, a stalled
  // connection always rejoins.
  if (isWait(event) && (prev.matches({ listening: { session: 'dropped' } }) || prev.matches({ listening: { session: 'connecting' } }))) {
    expect(s.matches({ listening: 'joining' })).toBe(true);
  }
  if (isWait(event) && prev.matches({ listening: 'joining' })) expect(signals().filter((t) => t === 'join').length).toBeGreaterThan(1);

  const wasListening = prev.matches('listening');
  const wasInSession = prev.matches({ listening: 'session' });

  // Tapping toggles listening.
  if (event.type === 'TAP') expect(s.matches('listening')).toBe(!wasListening);
  // A failed connection always retries by asking the DJ again.
  if (event.type === 'PEER.FAILED' && wasInSession) {
    expect(s.matches({ listening: 'joining' })).toBe(true);
    expect(signals().at(-1)).toBe('join');
  }
  // A connection that comes up starts playback.
  if (event.type === 'PEER.CONNECTED' && wasInSession) expect(s.matches({ listening: { session: 'playing' } })).toBe(true);
  // A blip while playing doesn't drop the session immediately.
  if (event.type === 'PEER.DISCONNECTED' && prev.matches({ listening: { session: 'playing' } })) {
    expect(s.matches({ listening: { session: 'dropped' } })).toBe(true);
  }
  // A blip that lasts, or an offer that never connects, triggers a rejoin.
  if (isDelayed(event) && wasInSession) expect(s.matches({ listening: 'joining' })).toBe(true);
  // If the DJ leaves, we wait for them, without a connection.
  if ((event.type === 'SERVER.HOST_OFFLINE' || (event.type === 'SERVER.WELCOME' && !(event as { hostOnline?: boolean }).hostOnline)) && wasListening) expect(s.matches({ listening: 'waitingForHost' })).toBe(true);
  // When the DJ comes back, listeners who are listening rejoin by themselves.
  if (event.type === 'SERVER.HOST_ONLINE' && wasListening && s.context.myId) expect(s.matches({ listening: 'joining' })).toBe(true);
  // An offer while listening always starts a fresh connection.
  if (event.type === 'SERVER.OFFER' && (prev.matches({ listening: 'joining' }) || wasInSession)) {
    expect(s.matches({ listening: { session: 'connecting' } })).toBe(true);
  }
  // Events never start listening on their own; only a tap does.
  if (!wasListening && event.type !== 'TAP') expect(s.matches('idle')).toBe(true);
}

describe('listener machine (model-based)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('explores a meaningful number of states', () => {
    expect(paths.length).toBeGreaterThan(20);
  });

  /** Replays events on a fresh actor, checking everything after each step. */
  function replay(events: EventObject[], expectedValues: (Snapshot['value'] | undefined)[]) {
    vi.clearAllMocks();
    const { peers, logic } = fakePeers();
    const actor = createActor(
      listenerMachine.provide({ actors: { peer: logic, signaling: fromCallback(() => {}) } }),
    ).start();
    events.forEach((event, i) => {
      const prev = actor.getSnapshot();
      const peersBefore = peers.length;
      if (isWait(event)) vi.advanceTimersByTime(event.ms);
      else if (isDelayed(event)) vi.advanceTimersByTime(delayOf(event));
      else actor.send(event as ListenerEvent);
      const now = actor.getSnapshot();
      try {
        if (expectedValues[i] !== undefined) expect(now.value).toEqual(expectedValues[i]);
        checkInvariants(now, peers, event, prev, peersBefore);
        checkTransitionRules(prev, now, event);
      } catch (err) {
        (err as Error).message = `after ${describePath(events.slice(0, i + 1).map((event) => ({ event })))}\n${(err as Error).message}`;
        throw err;
      }
    });
    actor.stop();
  }

  for (const path of paths) {
    const steps = path.steps.filter((s) => !isInit(s.event));
    const toHere = steps.map((s) => s.event);
    const values = steps.map((s) => s.state.value);
    it(`${JSON.stringify(path.state.value)} via ${describePath(steps)}: every next event`, () => {
      replay(toHere, values);
      for (const event of [...EVENTS, ...delayedEvents(path.state), WAIT]) {
        replay([...toHere, event], values);
      }
    });
  }
});
