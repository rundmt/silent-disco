// One WebRTC connection from the host to one listener, as an XState callback
// actor spawned per listener. Audio flows peer-to-peer; the server only relays
// the setup messages.
import { fromCallback } from 'xstate';
import { postSignal } from '../shared/signaling';
import { serialQueue, tuneOpus } from '../shared/opus';

export type HostPeerInput = {
  listenerId: string;
  myId: string;
  track: MediaStreamTrack | null;
  kbps: number;
};

export type HostPeerReceive =
  | { type: 'ANSWER'; sdp: string }
  | { type: 'CANDIDATE'; candidate: RTCIceCandidateInit }
  | { type: 'TRACK'; track: MediaStreamTrack | null }
  | { type: 'BITRATE'; kbps: number };

export type HostPeerEvent =
  | { type: 'PEER.STATE'; listenerId: string; state: RTCPeerConnectionState }
  | { type: 'PEER.GONE'; listenerId: string };

export const hostPeer = fromCallback<HostPeerReceive, HostPeerInput, HostPeerEvent>(({ input, sendBack, receive }) => {
  const { listenerId, myId } = input;
  let kbps = input.kbps;
  // On a LAN, direct host candidates are all we need, so no STUN/TURN.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const run = serialQueue();

  // A send-only transceiver lets us swap or mute the track without renegotiating.
  const { sender } = pc.addTransceiver('audio', { direction: 'sendonly', streams: [new MediaStream()] });

  const applyBitrate = () => {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = kbps * 1000;
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    sender.setParameters(params).catch(() => {});
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) postSignal({ from: myId, to: listenerId, type: 'candidate', candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    sendBack({ type: 'PEER.STATE', listenerId, state: pc.connectionState });
    if (pc.connectionState === 'connected') applyBitrate();
    if (pc.connectionState === 'failed') sendBack({ type: 'PEER.GONE', listenerId });
  };

  receive((event) => {
    switch (event.type) {
      case 'ANSWER':
        run(() => pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(event.sdp, kbps) }));
        break;
      case 'CANDIDATE':
        run(() => pc.addIceCandidate(event.candidate));
        break;
      case 'TRACK':
        sender.replaceTrack(event.track).catch((e) => console.warn(e));
        break;
      case 'BITRATE':
        kbps = event.kbps;
        applyBitrate();
        break;
    }
  });

  run(async () => {
    await sender.replaceTrack(input.track);
    const offer = await pc.createOffer();
    offer.sdp = tuneOpus(offer.sdp!, kbps);
    await pc.setLocalDescription(offer);
    await postSignal({ from: myId, to: listenerId, type: 'offer', sdp: pc.localDescription!.sdp, kbps });
  });

  return () => pc.close();
});
