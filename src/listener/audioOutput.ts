// Plays the incoming stream, and taps it for the visualizer. Two routes,
// because phones disagree:
//
// * iPhone/iPad ignore volume on <audio>, so there the sound goes through Web
//   Audio (a GainNode) and the <audio> element stays attached but muted
//   (WebRTC only feeds Web Audio when the stream is also on a media element).
//   iOS keeps that playing with the screen locked.
// * Everywhere else the <audio> element plays the sound itself. Android
//   Chrome only keeps a locked phone playing when an unmuted media element is
//   playing; Web Audio alone gets suspended. There, audio.volume works.

const audio = new Audio();
audio.autoplay = true;
audio.setAttribute('playsinline', '');

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS

// Android Chrome treats a live WebRTC stream as something other than "media"
// for background purposes: it has no media session, so a locked phone
// suspends the page. A looping, inaudible audio file is ordinary media, which
// gives the page a media session and keeps it running while locked.
const keepAlive = new Audio();
keepAlive.loop = true;
let keepAliveUrl: string | null = null;

/** One second of a 20 Hz tone at -60 dB: nobody hears it, but Chrome counts it as playing sound. */
function inaudibleWav(): string {
  const rate = 8000;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(33 * Math.sin((2 * Math.PI * 20 * i) / rate)), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let volume = 1;

/** Must be called inside a tap so mobile browsers allow sound. */
export function unlock() {
  if (!ctx) {
    try {
      // iOS 17+: keep playing when the ringer switch is on silent.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (isIOS && session) session.type = 'playback';
      ctx = new AudioContext({ latencyHint: 'interactive' });
      // The visualizer reads from this. Elsewhere than iOS it's only for
      // looking at the sound, so it feeds a silent output (Chrome only runs
      // nodes that lead to the speakers).
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      if (isIOS) {
        gain = ctx.createGain();
        gain.gain.value = volume;
        gain.connect(ctx.destination);
      } else {
        const silent = ctx.createGain();
        silent.gain.value = 0;
        analyser.connect(silent).connect(ctx.destination);
      }
    } catch {
      ctx = null; // fall back to plain <audio> playback, no visuals
    }
  }
  // Unlock the element during the tap too, before the stream arrives.
  audio.play().catch(() => {});
  if (!isIOS) {
    keepAliveUrl ??= inaudibleWav();
    keepAlive.src = keepAliveUrl;
    keepAlive.play().catch(() => {});
  }
  resume();
}

/** What the visualizer reads, once listening has started. */
export const getAnalyser = () => analyser;

export function resume() {
  ctx?.resume().catch(() => {});
  if (keepAlive.src && keepAlive.paused) keepAlive.play().catch(() => {});
  if (audio.srcObject) audio.play().catch(() => {});
}

export function attach(stream: MediaStream) {
  audio.srcObject = stream;
  source?.disconnect();
  source = ctx ? ctx.createMediaStreamSource(stream) : null;
  if (source && analyser) source.connect(analyser);
  if (source && gain) {
    audio.muted = true;
    source.connect(gain);
  } else {
    audio.muted = false;
    audio.volume = volume;
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  resume();
}

export function detach() {
  source?.disconnect();
  source = null;
  audio.pause();
  audio.srcObject = null;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
}

/** The listener tapped stop: let the phone sleep normally again. */
export function stopKeepAlive() {
  keepAlive.pause();
  keepAlive.removeAttribute('src');
  keepAlive.load();
}

export function setVolume(v: number) {
  volume = v;
  if (gain) gain.gain.value = v;
  else audio.volume = v;
}

/** Names the party on the lock screen and in the phone's media controls. */
export function setNowPlaying(name: string) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: 'Silent Disco · live' });
  // Pressing play on the lock screen after an interruption picks the stream back up.
  navigator.mediaSession.setActionHandler('play', () => resume());
}
