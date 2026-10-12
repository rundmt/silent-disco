import { Show, createEffect, onCleanup } from 'solid-js';
import { useActor } from '@xstate/solid';
import { listenerMachine } from './machine';
import { isListening, isPlaying, statusText } from './status';

export function ListenerApp() {
  const [state, send] = useActor(listenerMachine);

  const listening = () => isListening(state);
  const playing = () => isPlaying(state);

  const stats = () => {
    const s = state.context.stats;
    if (!s || !playing()) return '';
    return [
      s.delayMs != null ? `delay ≈ ${s.delayMs} ms` : null,
      s.kbps != null ? `${Math.round(s.kbps)} kbps` : null,
      `lost ${s.lost}`,
    ].filter(Boolean).join(' · ');
  };

  createEffect(() => (document.title = state.context.meta.name));

  const onVisible = () => document.visibilityState === 'visible' && send({ type: 'VISIBLE' });
  document.addEventListener('visibilitychange', onVisible);
  onCleanup(() => document.removeEventListener('visibilitychange', onVisible));

  return (
    <main class="listener">
      <div>
        <h1>🎧 {state.context.meta.name}</h1>
        <div class="muted">{statusText(state)}</div>
      </div>

      <button class="play" classList={{ playing: playing() }} onClick={() => send({ type: 'TAP' })}>
        {listening() ? 'Tap to stop' : 'Tap to listen'}
      </button>

      <div class="vol">
        <label for="vol">Volume</label>
        <input
          id="vol"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={state.context.volume}
          onInput={(e) => send({ type: 'VOLUME', value: Number(e.currentTarget.value) })}
        />
      </div>

      <div class="muted hint-narrow">
        Plug in your headphones. Keep this page open; locking the screen may pause the music.
      </div>
      <Show when={stats()}>
        <div class="stats">{stats()}</div>
      </Show>
    </main>
  );
}
