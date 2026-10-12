// The host console as one state machine. Two regions run side by side:
//
//   audio:      opening ─► ready ⇄ sharingTab      (error if no input can open)
//   broadcast:  offAir ⇄ onAir
//
// Each listener gets its own spawned `hostPeer` actor. Going live, going off
// air or switching source just swaps the track on every peer.
import { assign, enqueueActions, fromCallback, setup, type ActorRefFrom, type EventObject } from 'xstate';
import { connectEvents, postSignal, type LanAddress, type ServerMessage } from '../shared/signaling';
import { openDevice, shareTab, watchDevices, watchTrack, type AudioDevice } from './capture';
import { hostPeer, type HostPeerEvent } from './peer';

type ServerEvent =
  | { type: 'SERVER.WELCOME'; id: string; lan: LanAddress[]; port: number; listeners: number }
  | { type: 'SERVER.COUNT'; listeners: number }
  | { type: 'SERVER.REPLACED' }
  | { type: 'SERVER.JOIN'; from: string }
  | { type: 'SERVER.LEAVE'; from: string }
  | { type: 'SERVER.ANSWER'; from: string; sdp: string }
  | { type: 'SERVER.CANDIDATE'; from: string; candidate: RTCIceCandidateInit };

type UiEvent =
  | { type: 'GO_LIVE' }
  | { type: 'STOP' }
  | { type: 'SELECT_DEVICE'; deviceId: string }
  | { type: 'SHARE_TAB' }
  | { type: 'SET_BITRATE'; kbps: number }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SELECT_ADDRESS'; address: string };

export type HostEvent =
  | ServerEvent
  | UiEvent
  | HostPeerEvent
  | { type: 'DEVICES'; devices: AudioDevice[] }
  | { type: 'TRACK_ENDED' };

export interface PeerInfo {
  childId: string;
  state: RTCPeerConnectionState;
}

/** Turns the server's event stream into machine events. */
const signaling = fromCallback<EventObject, void, ServerEvent>(({ sendBack }) =>
  connectEvents('host', (msg: ServerMessage) => {
    switch (msg.type) {
      case 'welcome':
        return sendBack({ type: 'SERVER.WELCOME', id: msg.id, lan: msg.lan ?? [], port: msg.port ?? 8080, listeners: msg.listeners ?? 0 });
      case 'count':
        return sendBack({ type: 'SERVER.COUNT', listeners: msg.listeners });
      case 'replaced':
        return sendBack({ type: 'SERVER.REPLACED' });
      case 'join':
        return sendBack({ type: 'SERVER.JOIN', from: msg.from });
      case 'leave':
        return sendBack({ type: 'SERVER.LEAVE', from: msg.from });
      case 'answer':
        return sendBack({ type: 'SERVER.ANSWER', from: msg.from, sdp: msg.sdp });
      case 'candidate':
        return sendBack({ type: 'SERVER.CANDIDATE', from: msg.from, candidate: msg.candidate });
    }
  }),
);

let peerSeq = 0;

export const hostMachine = setup({
  types: {
    context: {} as {
      myId: string | null;
      lan: LanAddress[];
      address: string;
      port: number;
      listenerCount: number;
      peers: Record<string, PeerInfo>;
      devices: AudioDevice[];
      deviceId: string | null;
      stream: MediaStream | null;
      source: 'device' | 'tab';
      live: boolean;
      kbps: number;
      name: string;
      error: string | null;
    },
    events: {} as HostEvent,
  },
  actors: { signaling, openDevice, shareTab, watchDevices, watchTrack, hostPeer },
  actions: {
    sendMeta: ({ context }) => {
      if (context.myId) postSignal({ from: context.myId, type: 'meta', name: context.name || 'Silent Disco', live: context.live });
    },
    /** Point every listener at the current track (or silence when off air). */
    syncTracks: enqueueActions(({ context, enqueue }) => {
      const track = context.live ? context.stream?.getAudioTracks()[0] ?? null : null;
      for (const p of Object.values(context.peers)) enqueue.sendTo(p.childId, { type: 'TRACK', track });
    }),
    stopAllPeers: enqueueActions(({ context, enqueue }) => {
      for (const p of Object.values(context.peers)) enqueue.stopChild(p.childId);
      enqueue.assign({ peers: {} });
    }),
    dropPeer: enqueueActions(({ context, event, enqueue }) => {
      const id = event.type === 'PEER.GONE' ? event.listenerId : 'from' in event ? event.from : null;
      const p = id ? context.peers[id] : undefined;
      if (!id || !p) return;
      enqueue.stopChild(p.childId);
      const { [id]: _, ...rest } = context.peers;
      enqueue.assign({ peers: rest });
    }),
    replaceStream: assign(({ context }, stream: MediaStream) => {
      if (context.stream && context.stream !== stream) context.stream.getTracks().forEach((t) => t.stop());
      return { stream, error: null };
    }),
  },
  guards: {
    hasStream: ({ context }) => !!context.stream,
    knownPeer: ({ context, event }) => 'from' in event && !!context.peers[event.from],
  },
}).createMachine({
  id: 'host',
  context: {
    myId: null,
    lan: [],
    address: 'localhost',
    port: typeof location === 'undefined' ? 8080 : Number(location.port) || 80,
    listenerCount: 0,
    peers: {},
    devices: [],
    deviceId: null,
    stream: null,
    source: 'device',
    live: false,
    kbps: 192,
    name: 'Silent Disco',
    error: null,
  },
  initial: 'active',
  states: {
    active: {
      type: 'parallel',
      invoke: [{ src: 'signaling' }, { src: 'watchDevices' }],
      on: {
        'SERVER.WELCOME': {
          actions: [
            'stopAllPeers', // after a server restart every old connection is gone
            assign(({ event }) => ({
              myId: event.id,
              lan: event.lan,
              port: event.port,
              address: event.lan[0]?.address ?? 'localhost',
              listenerCount: event.listeners,
            })),
            'sendMeta',
          ],
        },
        'SERVER.COUNT': { actions: assign({ listenerCount: ({ event }) => event.listeners }) },
        'SERVER.REPLACED': 'replaced',

        'SERVER.JOIN': {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const old = context.peers[event.from];
            if (old) enqueue.stopChild(old.childId); // a rejoin replaces the old connection
            const childId = `peer-${++peerSeq}`;
            enqueue.spawnChild('hostPeer', {
              id: childId,
              input: {
                listenerId: event.from,
                myId: context.myId!,
                track: context.live ? context.stream?.getAudioTracks()[0] ?? null : null,
                kbps: context.kbps,
              },
            });
            enqueue.assign({ peers: { ...context.peers, [event.from]: { childId, state: 'new' } } });
          }),
        },
        'SERVER.ANSWER': {
          guard: 'knownPeer',
          actions: enqueueActions(({ context, event, enqueue }) =>
            enqueue.sendTo(context.peers[event.from].childId, { type: 'ANSWER', sdp: event.sdp }),
          ),
        },
        'SERVER.CANDIDATE': {
          guard: 'knownPeer',
          actions: enqueueActions(({ context, event, enqueue }) =>
            enqueue.sendTo(context.peers[event.from].childId, { type: 'CANDIDATE', candidate: event.candidate }),
          ),
        },
        'PEER.STATE': {
          actions: assign(({ context, event }) => {
            const p = context.peers[event.listenerId];
            return p ? { peers: { ...context.peers, [event.listenerId]: { ...p, state: event.state } } } : {};
          }),
        },
        'SERVER.LEAVE': { actions: 'dropPeer' },
        'PEER.GONE': { actions: 'dropPeer' },

        DEVICES: { actions: assign({ devices: ({ event }) => event.devices }) },
        SET_NAME: { actions: [assign({ name: ({ event }) => event.name }), 'sendMeta'] },
        SELECT_ADDRESS: { actions: assign({ address: ({ event }) => event.address }) },
        SET_BITRATE: {
          actions: [
            assign({ kbps: ({ event }) => event.kbps }),
            enqueueActions(({ context, enqueue }) => {
              for (const p of Object.values(context.peers)) enqueue.sendTo(p.childId, { type: 'BITRATE', kbps: context.kbps });
            }),
          ],
        },
      },
      states: {
        audio: {
          initial: 'opening',
          on: {
            // Picking a device always wins, even with the tab picker up.
            // (Not `reenter` here: re-entering a parallel region resets its siblings.)
            SELECT_DEVICE: { target: '.opening', actions: assign({ deviceId: ({ event }) => event.deviceId }) },
          },
          states: {
            opening: {
              on: {
                // A different device picked mid-open: restart with that one.
                SELECT_DEVICE: { target: 'opening', reenter: true, actions: assign({ deviceId: ({ event }) => event.deviceId }) },
              },
              invoke: {
                id: 'openDevice',
                src: 'openDevice',
                input: ({ context }) => ({ deviceId: context.deviceId }),
                onDone: {
                  target: 'ready',
                  actions: [
                    { type: 'replaceStream', params: ({ event }) => event.output.stream },
                    assign(({ event }) => ({ devices: event.output.devices, deviceId: event.output.deviceId, source: 'device' as const })),
                    'syncTracks',
                  ],
                },
                onError: {
                  target: 'error',
                  actions: assign({ error: ({ event }) => (event.error as Error)?.message ?? String(event.error) }),
                },
              },
            },
            ready: {
              invoke: { src: 'watchTrack', input: ({ context }) => ({ stream: context.stream }) },
              on: {
                SHARE_TAB: 'sharingTab',
                // Source vanished (device unplugged or tab share stopped): fall back to the device.
                TRACK_ENDED: 'opening',
              },
            },
            sharingTab: {
              invoke: {
                id: 'shareTab',
                src: 'shareTab',
                onDone: {
                  target: 'ready',
                  actions: [
                    { type: 'replaceStream', params: ({ event }) => event.output },
                    assign({ source: 'tab' }),
                    'syncTracks',
                  ],
                },
                onError: [
                  { guard: 'hasStream', target: 'ready' }, // picker cancelled: keep the current source
                  { target: 'error', actions: assign({ error: ({ event }) => (event.error as Error)?.message ?? 'Sharing failed' }) },
                ],
              },
            },
            error: {
              on: { SHARE_TAB: 'sharingTab' },
            },
          },
        },
        broadcast: {
          initial: 'offAir',
          states: {
            offAir: {
              entry: [assign({ live: false }), 'syncTracks', 'sendMeta'],
              on: { GO_LIVE: { guard: 'hasStream', target: 'onAir' } },
            },
            onAir: {
              entry: [assign({ live: true }), 'syncTracks', 'sendMeta'],
              on: { STOP: 'offAir' },
            },
          },
        },
      },
    },
    replaced: {
      type: 'final',
      entry: 'stopAllPeers',
    },
  },
});

export type HostActor = ActorRefFrom<typeof hostMachine>;
