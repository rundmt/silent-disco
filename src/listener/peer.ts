// One WebRTC connection to the DJ, as an XState callback actor. It answers the
// host's offer, reports connection changes and stats back to the machine, and
// closes itself when the machine stops it.
import { fromCallback } from 'xstate';
import { postSignal } from '../shared/signaling';
import { serialQueue, tuneOpus } from '../shared/opus';
import * as output from './audioOutput';

export interface PeerStats {
  delayMs: number | null;
  kbps: number | null;
  lost: number;
}

export type PeerEvent =
  | { type: 'PEER.CONNECTED' }
  | { type: 'PEER.DISCONNECTED' }
  | { type: 'PEER.FAILED' }
  | { type: 'PEER.STATS'; stats: PeerStats };

export type PeerInput = { myId: string; offer: { sdp: string; kbps: number } };
export type PeerReceive = { type: 'CANDIDATE'; candidate: RTCIceCandidateInit };

export const peerActor = fromCallback<PeerReceive, PeerInput, PeerEvent>(({ input, sendBack, receive }) => {
  const { myId, offer } = input;
  // On a LAN, direct host candidates are all we need, so no STUN/TURN.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const run = serialQueue();

  pc.ontrack = (e) => output.attach(e.streams[0] ?? new MediaStream([e.track]));
  pc.onicecandidate = (e) => {
    if (e.candidate) postSignal({ from: myId, type: 'candidate', candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') sendBack({ type: 'PEER.CONNECTED' });
    if (pc.connectionState === 'disconnected') sendBack({ type: 'PEER.DISCONNECTED' });
    if (pc.connectionState === 'failed') sendBack({ type: 'PEER.FAILED' });
  };

  receive((event) => {
    if (event.type === 'CANDIDATE') run(() => pc.addIceCandidate(event.candidate));
  });

  run(async () => {
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    answer.sdp = tuneOpus(answer.sdp!, offer.kbps || 192);
    await pc.setLocalDescription(answer);
    await postSignal({ from: myId, type: 'answer', sdp: pc.localDescription!.sdp });
  });

  let last: { bytes: number; t: number } | null = null;
  let lastJb = { delay: 0, count: 0 };
  const statsTimer = setInterval(async () => {
    if (pc.connectionState !== 'connected') return;
    const report = await pc.getStats();
    let jitterMs: number | null = null;
    let rttMs = 0;
    let lost = 0;
    let kbps: number | null = null;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        // Delay over the last second, not since connecting: a lifetime average
        // keeps climbing after one hiccup and is slow to come back down.
        const count = r.jitterBufferEmittedCount - lastJb.count;
        if (count > 0) jitterMs = ((r.jitterBufferDelay - lastJb.delay) / count) * 1000;
        lastJb = { delay: r.jitterBufferDelay, count: r.jitterBufferEmittedCount };
        lost = r.packetsLost ?? 0;
        if (last) kbps = ((r.bytesReceived - last.bytes) * 8) / (r.timestamp - last.t);
        last = { bytes: r.bytesReceived, t: r.timestamp };
      }
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) {
        rttMs = r.currentRoundTripTime * 1000;
      }
    });
    // Rough end-to-end: one 20 ms Opus frame + one-way network + jitter buffer.
    const delayMs = jitterMs == null ? null : Math.round(20 + rttMs / 2 + jitterMs);
    sendBack({ type: 'PEER.STATS', stats: { delayMs, kbps, lost } });
  }, 1000);

  return () => {
    clearInterval(statsTimer);
    pc.close();
  };
});
