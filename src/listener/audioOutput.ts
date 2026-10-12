// Plays the incoming stream through Web Audio so the volume slider works
// everywhere (iPhones ignore volume on <audio>). The <audio> element stays
// attached but muted, because Chrome only feeds WebRTC audio into Web Audio
// when the stream is also attached to a media element.

const audio = new Audio();
audio.autoplay = true;
audio.setAttribute('playsinline', '');

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let volume = 1;

/** Must be called inside a tap so mobile browsers allow sound. */
export function unlock() {
  if (!ctx) {
    try {
      // iOS 17+: keep playing when the ringer switch is on silent.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'playback';
      ctx = new AudioContext({ latencyHint: 'interactive' });
      gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
    } catch {
      ctx = null; // fall back to plain <audio> playback
    }
  }
  resume();
}

export function resume() {
  ctx?.resume().catch(() => {});
  if (audio.srcObject) audio.play().catch(() => {});
}

export function attach(stream: MediaStream) {
  audio.srcObject = stream;
  if (ctx && gain) {
    audio.muted = true;
    source?.disconnect();
    source = ctx.createMediaStreamSource(stream);
    source.connect(gain);
  }
  resume();
}

export function detach() {
  source?.disconnect();
  source = null;
  audio.pause();
  audio.srcObject = null;
}

export function setVolume(v: number) {
  volume = v;
  if (gain) gain.gain.value = v;
  audio.volume = v; // only matters without Web Audio
}
