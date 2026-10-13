// The phone visuals the DJ can choose from. Shared by the phone page and the
// DJ console so both agree on names.

export type VisualStyle = 'bars' | 'ring' | 'wave' | 'off';
export type Palette = 'neon' | 'sunset' | 'ocean' | 'mono';

export interface Visual {
  style: VisualStyle;
  palette: Palette;
}

export const defaultVisual: Visual = { style: 'ring', palette: 'neon' };

export const styles: { id: VisualStyle; label: string }[] = [
  { id: 'ring', label: 'Pulse ring' },
  { id: 'bars', label: 'Bars' },
  { id: 'wave', label: 'Wave' },
  { id: 'off', label: 'Off' },
];

/** Each palette runs from low (bass) to high (treble) colors. */
export const palettes: Record<Palette, { label: string; colors: string[] }> = {
  neon: { label: 'Neon', colors: ['#7c5cff', '#22d3ee', '#ff3bd4'] },
  sunset: { label: 'Sunset', colors: ['#ff3b6b', '#ff8a3d', '#facc15'] },
  ocean: { label: 'Ocean', colors: ['#1e40af', '#06b6d4', '#a7f3d0'] },
  mono: { label: 'Mono', colors: ['#6b7280', '#e5e7eb', '#ffffff'] },
};

/** Colors the DJ can flash on every phone at once. */
export const flashColors = ['#ffffff', '#ff3b6b', '#22d3ee', '#facc15', '#7c5cff'];

export function isVisual(v: unknown): v is Visual {
  const x = v as Visual;
  return !!x && styles.some((s) => s.id === x.style) && x.palette in palettes;
}
