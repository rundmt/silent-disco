// Getting audio into the browser: an input device (ideally a virtual loopback
// like BlackHole that your DJ software outputs to) or a shared tab/system audio.
import { fromCallback, fromPromise, type EventObject } from 'xstate';

export interface AudioDevice {
  id: string;
  label: string;
}

const VIRTUAL_DEVICE = /blackhole|loopback|soundflower|vb-cable/i;

// Turn off all voice-call processing; we want the music untouched.
const musicConstraints = (deviceId?: string): MediaTrackConstraints => ({
  deviceId: deviceId ? { exact: deviceId } : undefined,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
});

export async function listDevices(): Promise<AudioDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
}

export const isVirtual = (d: AudioDevice | undefined) => !!d && VIRTUAL_DEVICE.test(d.label);

/** Opens an input. With no device chosen, prefers a virtual loopback device. */
export const openDevice = fromPromise<
  { stream: MediaStream; devices: AudioDevice[]; deviceId: string },
  { deviceId: string | null }
>(async ({ input, signal }) => {
  let deviceId = input.deviceId;
  if (!deviceId) {
    // Ask once so device labels become visible, then pick the best one.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: musicConstraints() });
    probe.getTracks().forEach((t) => t.stop());
    const devices = await listDevices();
    deviceId = (devices.find(isVirtual) ?? devices[0])?.id ?? '';
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: musicConstraints(deviceId || undefined), video: false });
  if (signal.aborted) {
    // Another device was picked while this one was opening; release it.
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Superseded');
  }
  stream.getAudioTracks().forEach((t) => (t.contentHint = 'music'));
  const devices = await listDevices();
  const actual = stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId;
  return { stream, devices, deviceId: actual };
});

/**
 * Chrome can share a tab's audio everywhere, and full system audio on recent
 * macOS. The API requires a video track; we drop it.
 */
export const shareTab = fromPromise<MediaStream>(async ({ signal }) => {
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
  } as DisplayMediaStreamOptions);
  s.getVideoTracks().forEach((t) => t.stop());
  if (signal.aborted) {
    s.getTracks().forEach((t) => t.stop());
    throw new Error('Superseded');
  }
  const audio = s.getAudioTracks();
  if (!audio.length) throw new Error('No audio was shared. Tick "Share audio" in the picker.');
  audio.forEach((t) => (t.contentHint = 'music'));
  return new MediaStream(audio);
});

/** Reports when the current source stops (unplugged device, tab share ended). */
export const watchTrack = fromCallback<EventObject, { stream: MediaStream | null }, { type: 'TRACK_ENDED' }>(
  ({ input, sendBack }) => {
    const track = input.stream?.getAudioTracks()[0];
    if (!track) return;
    const onEnded = () => sendBack({ type: 'TRACK_ENDED' });
    track.addEventListener('ended', onEnded);
    return () => track.removeEventListener('ended', onEnded);
  },
);

/** Keeps the device list fresh as things are plugged in or out. */
export const watchDevices = fromCallback<EventObject, void, { type: 'DEVICES'; devices: AudioDevice[] }>(({ sendBack }) => {
  const onChange = () => listDevices().then((devices) => sendBack({ type: 'DEVICES', devices }));
  navigator.mediaDevices.addEventListener('devicechange', onChange);
  return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
});
