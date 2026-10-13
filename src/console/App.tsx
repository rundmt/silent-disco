import { createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, connect, iconUrl, type SourceInfo, type State, type Tick } from './api';
import { groupSources, listenUrl, meterPercent, silenceHelp, sourceStatus } from './sources';
import { QrCode } from './QrCode';
import { flashColors, palettes, styles, type Palette } from '../shared/visuals';

export function ConsoleApp() {
  // A store reconciled by id keeps list rows (and their icons) in place
  // across updates instead of rebuilding them.
  const [store, setStore] = createStore<{ s: State | null }>({ s: null });
  const state = () => store.s;
  const setState = (next: State) => setStore('s', reconcile(next, { key: 'id' }));
  const [tick, setTick] = createSignal<Tick>({ level: 0, listeners: 0, open: 0 });
  const [up, setUp] = createSignal(true);
  const [pending, setPending] = createSignal<string | null>(null);
  const [address, setAddress] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  onCleanup(
    connect({
      state: (s) => {
        setState(s);
        setPending(null);
      },
      tick: setTick,
      connection: setUp,
    }),
  );

  const pick = async (s: SourceInfo) => {
    setPending(s.id);
    const next = await api.setSource(s.id);
    if (next) setState(next);
    setPending(null);
  };

  const addresses = () => state()?.addresses ?? [];
  const chosenAddress = () => {
    const a = address();
    return a && addresses().includes(a) ? a : addresses()[0];
  };
  const url = () => (chosenAddress() ? listenUrl(chosenAddress()!, state()!.port) : '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the URL is selectable */
    }
  };

  return (
    <Show when={state()} fallback={<div class="console-loading">{up() ? 'Starting…' : 'Silent Disco has stopped.'}</div>}>
      {(s) => (
        <div class="console">
          <Show when={!up()}>
            <div class="banner">Lost touch with Silent Disco. Reconnecting…</div>
          </Show>
          <header>
            <h1>🎧 Silent Disco</h1>
            <span class="pill" classList={{ on: s().live }}>
              <span class="dot" />
              {s().live ? 'ON AIR' : 'OFF AIR'}
            </span>
          </header>

          <div class="grid">
            <section class="panel sources-panel">
              <h2>Audio source</h2>
              <div class="current">
                <SourceIcon source={s().source} />
                <div class="current-text">
                  <div class="current-label">{s().source.label}</div>
                  <div class="hint" classList={{ warn: s().status !== 'capturing' || s().silent }} id="sourceStatus">
                    {sourceStatus(s())}
                  </div>
                </div>
              </div>
              <div class="meter" title="Level going out to phones">
                <div style={{ width: `${meterPercent(tick().level)}%` }} />
              </div>
              <Show when={silenceHelp(s())}>
                {(help) => (
                  <div class="help">
                    <span>{help().text}</span>
                    <Show when={help().privacy}>
                      <button class="secondary small" onClick={() => api.openPrivacy(help().privacy!)}>
                        Open Privacy Settings
                      </button>
                    </Show>
                  </div>
                )}
              </Show>

              <div class="source-list" id="sources">
                <Index each={groupSources(s().sources, s().source.id)}>
                  {(g) => (
                    <details class="group" open={!g().collapsed}>
                      <summary>{g().title}</summary>
                      <For each={g().sources}>
                        {(src) => (
                          <button
                            class="source"
                            classList={{ selected: src.id === s().source.id, pending: src.id === pending() }}
                            onClick={() => pick(src)}
                          >
                            <SourceIcon source={src} />
                            <span class="source-text">
                              <span class="source-label">{src.label}</span>
                              <Show when={src.detail}>
                                <span class="source-detail">{src.detail}</span>
                              </Show>
                            </span>
                            <Show when={src.playing}>
                              <span class="eq" title="Playing now">
                                <i />
                                <i />
                                <i />
                              </span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </details>
                  )}
                </Index>
                <Show when={!s().sources.some((x) => x.dj)}>
                  <p class="hint">Open your DJ software and it shows up here. Any app playing sound appears too.</p>
                </Show>
              </div>
            </section>

            <section class="panel">
              <button
                id="goLive"
                class="go-live"
                classList={{ live: s().live }}
                onClick={async () => {
                  const next = await api.setLive(!s().live);
                  if (next) setState(next);
                }}
              >
                {s().live ? 'Stop broadcast' : 'Go live'}
              </button>

              <hr class="divider" />
              <h2>Listeners scan this</h2>
              <Show when={url()} fallback={<p class="hint">No Wi-Fi address found. Connect this Mac to Wi-Fi so phones can reach it.</p>}>
                <QrCode text={url()} />
                <div class="url-row">
                  <span class="url" id="url">{url()}</span>
                  <button class="secondary small" onClick={copy}>{copied() ? 'Copied' : 'Copy'}</button>
                </div>
                <Show when={addresses().length > 1}>
                  <select class="small-select" value={chosenAddress()} onChange={(e) => setAddress(e.currentTarget.value)}>
                    <For each={addresses()}>{(a) => <option value={a}>{a}</option>}</For>
                  </select>
                </Show>
                <p class="hint center">Phones must be on the same Wi-Fi as this Mac.</p>
              </Show>

              <div class="stats-row">
                <div>
                  <div class="big-number" id="count">{tick().listeners}</div>
                  <div class="hint">listening</div>
                </div>
                <div>
                  <div class="big-number dim">{Math.max(0, tick().open - tick().listeners)}</div>
                  <div class="hint">page open, not playing</div>
                </div>
              </div>

              <hr class="divider" />
              <label for="name">Party name (shown to listeners)</label>
              <input
                id="name"
                type="text"
                maxLength={60}
                value={s().name}
                onChange={(e) => api.setName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <label for="kbps">Quality</label>
              <select id="kbps" value={String(s().kbps)} onChange={(e) => api.setKbps(Number(e.currentTarget.value))}>
                <option value="128">128 kbps · lighter on busy Wi-Fi</option>
                <option value="192">192 kbps · great for music</option>
                <option value="256">256 kbps · maximum</option>
              </select>
            </section>
          </div>

          <section class="panel visuals-panel">
            <h2>Phone visuals</h2>
            <div class="visuals-row">
              <div>
                <label>Style</label>
                <div class="chips" id="visualStyle">
                  <For each={styles}>
                    {(st) => (
                      <button
                        class="chip"
                        classList={{ selected: s().visual.style === st.id }}
                        onClick={() => api.setVisual({ ...s().visual, style: st.id })}
                      >
                        {st.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div>
                <label>Colors</label>
                <div class="chips">
                  <For each={Object.entries(palettes) as [Palette, (typeof palettes)[Palette]][]}>
                    {([id, p]) => (
                      <button
                        class="chip swatch-chip"
                        classList={{ selected: s().visual.palette === id }}
                        title={p.label}
                        onClick={() => api.setVisual({ ...s().visual, palette: id })}
                      >
                        <span class="swatch" style={{ background: `linear-gradient(90deg, ${p.colors.join(', ')})` }} />
                        {p.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div>
                <label>Flash every phone</label>
                <div class="chips" id="flash">
                  <For each={flashColors}>
                    {(c) => (
                      <button
                        class="flash-btn"
                        style={{ background: c }}
                        title="Flash all phones"
                        onPointerDown={() => api.flash(c)}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>
            <p class="hint">Each phone draws from the music it's playing, so the visuals stay in time with what every listener hears.</p>
          </section>
        </div>
      )}
    </Show>
  );
}

const glyphs: Record<string, string> = { system: '🔊', input: '🎛️', tone: '〰️', app: '🎵' };

function SourceIcon(props: { source: SourceInfo }) {
  const [broken, setBroken] = createSignal<string>();
  return (
    <Show
      when={props.source.icon && props.source.icon !== broken()}
      fallback={<span class="source-icon glyph">{glyphs[props.source.kind]}</span>}
    >
      <img class="source-icon" src={iconUrl(props.source.icon!)} alt="" onError={() => setBroken(props.source.icon)} />
    </Show>
  );
}
