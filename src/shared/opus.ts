// Browsers default Opus to voice-call settings. These fmtp params ask for
// full-band stereo music quality. Applied to the SDP on both sides.
export function tuneOpus(sdp: string, kbps: number): string {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const wanted: Record<string, string> = {
    stereo: '1',
    'sprop-stereo': '1',
    maxaveragebitrate: String(kbps * 1000),
    maxplaybackrate: '48000',
    useinbandfec: '1', // forward error correction smooths over Wi-Fi packet loss
    usedtx: '0', // never go quiet during quiet passages
  };
  const format = (kv: Record<string, string>) =>
    Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(';');

  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_, params: string) => {
      const kv = Object.fromEntries(
        params.split(';').filter(Boolean).map((p) => p.trim().split('=') as [string, string]),
      );
      return `a=fmtp:${pt} ${format({ ...kv, ...wanted })}`;
    });
  }
  return sdp.replace(`a=rtpmap:${pt} opus/48000/2`, (s) => `${s}\r\na=fmtp:${pt} ${format(wanted)}`);
}

/** Runs async steps strictly in order (e.g. ICE candidates arriving mid-offer). */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn: () => Promise<unknown>) => {
    tail = tail.then(fn).catch((e) => console.warn(e));
  };
}
