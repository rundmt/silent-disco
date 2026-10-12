// The listener's whole lifecycle as one state machine:
//
//   idle ──TAP──► listening
//                  ├─ waitingForHost   (DJ page not open)
//                  ├─ joining          (asked the DJ for a stream, awaiting offer)
//                  └─ session          (WebRTC peer running)
//                       ├─ connecting
//                       ├─ playing
//                       └─ dropped     (Wi-Fi blip; rejoin if it lasts)
//
import { assign, fromCallback, sendTo, setup, type EventObject } from 'xstate';
import { connectEvents, postSignal, type PartyMeta, type ServerMessage } from '../shared/signaling';
import { peerActor, type PeerEvent, type PeerStats } from './peer';
import * as output from './audioOutput';

const JOIN_RETRY_MS = 8000;
const DROP_GRACE_MS = 4000;

type ServerEvent =
  | { type: 'SERVER.WELCOME'; id: string; hostOnline: boolean; meta?: PartyMeta }
  | { type: 'SERVER.HOST_ONLINE'; meta: PartyMeta }
  | { type: 'SERVER.HOST_OFFLINE' }
  | { type: 'SERVER.META'; meta: PartyMeta }
  | { type: 'SERVER.OFFER'; sdp: string; kbps: number }
  | { type: 'SERVER.CANDIDATE'; candidate: RTCIceCandidateInit }
  | { type: 'SERVER.LOST' };

type UiEvent = { type: 'TAP' } | { type: 'VOLUME'; value: number } | { type: 'VISIBLE' };

export type ListenerEvent = ServerEvent | UiEvent | PeerEvent;

/** Turns the server's event stream into machine events. */
const signaling = fromCallback<EventObject, void, ServerEvent>(({ sendBack }) =>
  connectEvents(
    'listener',
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'welcome':
          return sendBack({ type: 'SERVER.WELCOME', id: msg.id, hostOnline: !!msg.hostOnline, meta: msg.meta });
        case 'host-online':
          return sendBack({ type: 'SERVER.HOST_ONLINE', meta: msg.meta });
        case 'host-offline':
          return sendBack({ type: 'SERVER.HOST_OFFLINE' });
        case 'meta':
          return sendBack({ type: 'SERVER.META', meta: msg.meta });
        case 'offer':
          return sendBack({ type: 'SERVER.OFFER', sdp: msg.sdp, kbps: msg.kbps });
        case 'candidate':
          return sendBack({ type: 'SERVER.CANDIDATE', candidate: msg.candidate });
      }
    },
    () => sendBack({ type: 'SERVER.LOST' }),
  ),
);

let wakeLock: WakeLockSentinel | null = null;

export const listenerMachine = setup({
  types: {
    context: {} as {
      myId: string | null;
      hostOnline: boolean;
      meta: PartyMeta;
      offer: { sdp: string; kbps: number } | null;
      stats: PeerStats | null;
      volume: number;
      serverLost: boolean;
    },
    events: {} as ListenerEvent,
  },
  actors: { signaling, peer: peerActor },
  actions: {
    unlockAudio: () => output.unlock(),
    stopAudio: () => output.detach(),
    resumeAudio: () => output.resume(),
    setVolume: assign(({ event }) => {
      if (event.type !== 'VOLUME') return {};
      output.setVolume(event.value);
      return { volume: event.value };
    }),
    sendJoin: ({ context }) => {
      if (context.myId) postSignal({ from: context.myId, type: 'join' });
    },
    sendLeave: ({ context }) => {
      if (context.myId) postSignal({ from: context.myId, type: 'leave' });
    },
    acquireWakeLock: () => {
      navigator.wakeLock?.request('screen').then((l) => (wakeLock = l)).catch(() => {});
    },
    releaseWakeLock: () => {
      wakeLock?.release().catch(() => {});
      wakeLock = null;
    },
  },
  guards: {
    // We can only ask the DJ for a stream once the server has given us an id.
    canJoin: ({ context }) => context.hostOnline && !!context.myId,
    hasId: ({ context }) => !!context.myId,
  },
}).createMachine({
  id: 'listener',
  context: {
    myId: null,
    hostOnline: false,
    meta: { name: 'Silent Disco', live: false },
    offer: null,
    stats: null,
    volume: 1,
    serverLost: false,
  },
  invoke: { src: 'signaling' },
  on: {
    'SERVER.WELCOME': {
      actions: assign(({ event, context }) => ({
        myId: event.id,
        hostOnline: event.hostOnline,
        meta: event.meta ?? context.meta,
        serverLost: false,
      })),
    },
    'SERVER.META': { actions: assign({ meta: ({ event }) => event.meta }) },
    'SERVER.HOST_ONLINE': { actions: assign({ hostOnline: true, meta: ({ event }) => event.meta }) },
    'SERVER.HOST_OFFLINE': { actions: assign({ hostOnline: false }) },
    'SERVER.LOST': { actions: assign({ serverLost: true }) },
    VOLUME: { actions: 'setVolume' },
  },
  initial: 'idle',
  states: {
    idle: {
      on: { TAP: { target: 'listening', actions: 'unlockAudio' } },
    },
    listening: {
      entry: 'acquireWakeLock',
      exit: ['sendLeave', 'stopAudio', 'releaseWakeLock', assign({ stats: null })],
      on: {
        TAP: 'idle',
        VISIBLE: { actions: ['acquireWakeLock', 'resumeAudio'] },
        // The server restarted (new id) or the DJ page reopened: start over.
        'SERVER.WELCOME': {
          target: '.checkHost',
          reenter: true,
          actions: assign(({ event, context }) => ({
            myId: event.id,
            hostOnline: event.hostOnline,
            meta: event.meta ?? context.meta,
            serverLost: false,
          })),
        },
        'SERVER.HOST_ONLINE': {
          guard: 'hasId',
          target: '.joining',
          actions: assign({ hostOnline: true, meta: ({ event }) => event.meta }),
        },
        'SERVER.HOST_OFFLINE': { target: '.waitingForHost', actions: assign({ hostOnline: false }) },
      },
      initial: 'checkHost',
      states: {
        checkHost: {
          always: [{ guard: 'canJoin', target: 'joining' }, { target: 'waitingForHost' }],
        },
        waitingForHost: {},
        joining: {
          entry: 'sendJoin',
          after: { [JOIN_RETRY_MS]: { target: 'joining', reenter: true } },
          on: {
            'SERVER.OFFER': {
              target: 'session',
              actions: assign({ offer: ({ event }) => ({ sdp: event.sdp, kbps: event.kbps }) }),
            },
          },
        },
        session: {
          invoke: {
            id: 'peer',
            src: 'peer',
            input: ({ context }) => ({ myId: context.myId!, offer: context.offer! }),
          },
          exit: 'stopAudio',
          on: {
            'SERVER.CANDIDATE': {
              actions: sendTo('peer', ({ event }) => ({ type: 'CANDIDATE' as const, candidate: event.candidate })),
            },
            // The DJ restarted negotiation: replace the peer.
            'SERVER.OFFER': {
              target: 'session',
              reenter: true,
              actions: assign({ offer: ({ event }) => ({ sdp: event.sdp, kbps: event.kbps }) }),
            },
            'PEER.FAILED': 'joining',
            'PEER.STATS': { actions: assign({ stats: ({ event }) => event.stats }) },
          },
          initial: 'connecting',
          states: {
            connecting: {
              after: { [JOIN_RETRY_MS]: '#listener.listening.joining' },
              on: { 'PEER.CONNECTED': 'playing' },
            },
            playing: {
              on: { 'PEER.DISCONNECTED': 'dropped' },
            },
            dropped: {
              after: { [DROP_GRACE_MS]: '#listener.listening.joining' },
              on: { 'PEER.CONNECTED': 'playing' },
            },
          },
        },
      },
    },
  },
});
