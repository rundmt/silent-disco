import type { SourceInfo, State } from './api';

export interface SourceGroup {
  title: string;
  sources: SourceInfo[];
  collapsed?: boolean;
}

/** Splits the source list into the sections the picker shows. */
export function groupSources(sources: SourceInfo[], selected: string): SourceGroup[] {
  const apps = sources.filter((s) => s.kind === 'app');
  const groups: SourceGroup[] = [
    { title: 'DJ software', sources: apps.filter((s) => s.dj) },
    { title: 'Playing now', sources: apps.filter((s) => !s.dj && s.playing) },
    { title: 'Whole Mac', sources: sources.filter((s) => s.kind === 'system') },
    { title: 'Audio inputs', sources: sources.filter((s) => s.kind === 'input') },
    // Quiet apps rarely matter; keep them tucked away unless one is chosen.
    {
      title: 'Other apps',
      sources: apps.filter((s) => !s.dj && !s.playing),
      collapsed: !apps.some((s) => !s.dj && !s.playing && s.id === selected),
    },
    { title: 'Testing', sources: sources.filter((s) => s.kind === 'tone') },
  ];
  return groups.filter((g) => g.sources.length);
}

/** One line under the current source saying what's happening. */
export function sourceStatus(s: State): string {
  if (s.status === 'waiting')
    return s.source.kind === 'input' ? `Waiting for ${s.source.label} to be plugged in…` : `Waiting for ${s.source.label} to open…`;
  if (s.status === 'error') return `Can't capture: ${s.error}`;
  if (s.silent) return 'No sound coming in.';
  return s.auto ? 'Picked automatically. Choose another source below any time.' : 'Capturing.';
}

/** Help for silence, which is what macOS gives us when it blocks recording. */
export function silenceHelp(s: State): { text: string; privacy?: 'audio' | 'mic' } | null {
  if (s.status === 'error' && /Microphone/.test(s.error ?? '')) return { text: 'Allow Silent Disco to use audio inputs, then pick the input again.', privacy: 'mic' };
  if (!s.silent || s.source.kind === 'tone') return null;
  if (s.source.kind === 'input')
    return { text: 'Check the input is getting signal, and that Silent Disco is allowed under Privacy & Security → Microphone.', privacy: 'mic' };
  return {
    text: 'If music is playing, macOS is probably blocking the recording. Turn on Silent Disco (or Terminal, if you started it there) under Privacy & Security → Screen & System Audio Recording, then quit and reopen.',
    privacy: 'audio',
  };
}

export const listenUrl = (address: string, port: number) => `http://${address}:${port}/`;

/** Peak level (0..1) to meter width in percent, over a 60 dB range. */
export function meterPercent(level: number): number {
  const db = 20 * Math.log10(level || 1e-6);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}
