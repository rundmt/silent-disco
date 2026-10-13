import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { useActor } from '@xstate/solid';
import { listenerMachine } from './machine';
import { isListening, isPlaying, statusText } from './status';
import { setNowPlaying } from './audioOutput';
import { Visualizer } from './Visualizer';
import { defaultVisual, isVisual, palettes } from '../shared/visuals';

// Android's battery saver pauses Chrome in the background, which cuts the
// music; only the phone's owner can turn that off.
const isAndroid = /Android/.test(navigator.userAgent);

// While music plays, controls fade so the visuals fill the screen. Any touch
// brings them back.
const FADE_AFTER_MS = 4000;

export function ListenerApp() {
  const [state, send] = useActor(listenerMachine);

  const listening = () => isListening(state);
  const playing = () => isPlaying(state);
  const visual = () => (isVisual(state.context.meta.visual) ? state.context.meta.visual : defaultVisual);

  // The page's own colors follow the palette the DJ picked.
  const theme = () => {
    const [c1, c2, c3] = palettes[visual().palette].colors;
    return { '--c1': c1, '--c2': c2, '--c3': c3 };
  };

  const [awake, setAwake] = createSignal(true);
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    setAwake(true);
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => setAwake(false), FADE_AFTER_MS);
  };
  createEffect(() => {
    if (playing()) poke();
    else {
      clearTimeout(fadeTimer);
      setAwake(true);
    }
  });
  onCleanup(() => clearTimeout(fadeTimer));

  const stats = () => {
    const s = state.context.stats;
    if (!s || !playing()) return '';
    return [
      s.delayMs != null ? `delay ≈ ${s.delayMs} ms` : null,
      s.kbps != null ? `${Math.round(s.kbps)} kbps` : null,
      `lost ${s.lost}`,
    ].filter(Boolean).join(' · ');
  };

  createEffect(() => {
    document.title = state.context.meta.name;
    setNowPlaying(state.context.meta.name);
  });

  const onVisible = () => document.visibilityState === 'visible' && send({ type: 'VISIBLE' });
  document.addEventListener('visibilitychange', onVisible);
  onCleanup(() => document.removeEventListener('visibilitychange', onVisible));

  return (
    <main class="listener" classList={{ stage: listening(), dim: !awake() }} style={theme()} onPointerDown={poke}>
      <Visualizer visual={visual()} playing={playing()} />

      <Show
        when={listening()}
        fallback={
          <>
            <div>
              <h1>🎧 {state.context.meta.name}</h1>
              <div class="muted">{statusText(state)}</div>
            </div>
            <button class="play" onClick={() => send({ type: 'TAP' })}>
              Tap to listen
            </button>
            <div class="muted hint-narrow">
              Plug in your headphones and keep this page open.
              <Show when={isAndroid}>
                <p class="android-tip">
                  <strong>Music stops when you lock your phone or switch apps?</strong> Android's battery saver is
                  pausing Chrome. Go to Settings → Apps → Chrome → Battery and choose <strong>Unrestricted</strong>.
                </p>
              </Show>
            </div>
          </>
        }
      >
        <header class="stage-top fades">
          <h1>{state.context.meta.name}</h1>
          <div class="status-line">
            <span class="live-dot" classList={{ on: playing() && state.context.meta.live }} />
            {statusText(state)}
          </div>
        </header>

        {/* The visuals center on this; it's empty so they're the show. */}
        <div class="stage-center" />

        <footer class="stage-controls fades">
          <button class="stop" aria-label="Stop listening" onClick={() => send({ type: 'TAP' })}>
            <span />
          </button>
          <label class="vol" for="vol">
            <span class="vol-icon" aria-hidden="true">🔈</span>
            <input
              id="vol"
              type="range"
              min="0"
              max="1"
              step="0.01"
              aria-label="Volume"
              value={state.context.volume}
              onInput={(e) => send({ type: 'VOLUME', value: Number(e.currentTarget.value) })}
            />
            <span class="vol-icon" aria-hidden="true">🔊</span>
          </label>
          <Show when={stats()}>
            <div class="stats">{stats()}</div>
          </Show>
        </footer>
      </Show>
    </main>
  );
}
