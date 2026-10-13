// The DJ's "flash every phone" button arrives over signaling; the visualizer
// listens here. Kept free of DOM code so the state machine tests can load it.

type Listener = (color: string) => void;
const listeners = new Set<Listener>();

export function onFlash(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitFlash(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  listeners.forEach((fn) => fn(color));
}
