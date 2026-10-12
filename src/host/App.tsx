import { For, Show } from 'solid-js';
import { useActor } from '@xstate/solid';
import { hostMachine } from './machine';
import { isVirtual } from './capture';
import { Meter } from './Meter';
import { QrCode } from './QrCode';

export function HostApp() {
  const [state, send] = useActor(hostMachine);
  const ctx = () => state.context;

  const onAir = () => state.matches({ active: { broadcast: 'onAir' } });
  const listenUrl = () => `http://${ctx().address}:${ctx().port}/`;
  const virtualDevice = () => ctx().devices.find(isVirtual);

  const deviceHint = () => {
    if (state.matches({ active: { audio: 'error' } }))
      return `Could not open audio input: ${ctx().error}. Allow microphone access for this page and reload.`;
    if (ctx().source === 'tab') return 'Using shared tab/system audio. Pick a device above to switch back.';
    const v = virtualDevice();
    return v
      ? `Found ${v.label}. Set your DJ software's master output to it.`
      : 'No virtual audio device found. Install BlackHole 2ch (see README) to send your DJ software’s output here, or pick a real input like an audio interface.';
  };

  const peerSummary = () => {
    const peers = Object.values(ctx().peers);
    if (!peers.length) return 'Nobody has pressed play yet.';
    const streaming = peers.filter((p) => p.state === 'connected').length;
    const connecting = peers.length - streaming;
    return `${streaming} streaming${connecting ? `, ${connecting} connecting` : ''}`;
  };

  return (
    <Show
      when={!state.matches('replaced')}
      fallback={<div class="listener"><h1>This host tab was replaced by a newer one.</h1></div>}
    >
      <div class="host">
        <header>
          <div>
            <h1>🎧 Silent Disco</h1>
            <div class="muted">Host console. Keep this tab open while you play.</div>
          </div>
          <span class="pill" classList={{ on: onAir() }}>
            <span class="dot" />
            {onAir() ? 'ON AIR' : 'OFF AIR'}
          </span>
        </header>

        <div class="grid">
          <section class="panel">
            <h2>1 · Audio source</h2>
            <label for="device">Input device</label>
            <select
              id="device"
              value={ctx().source === 'device' ? ctx().deviceId ?? '' : ''}
              onChange={(e) => send({ type: 'SELECT_DEVICE', deviceId: e.currentTarget.value })}
            >
              <Show when={ctx().source === 'tab'}>
                <option value="">Shared tab / system audio</option>
              </Show>
              <Show when={!ctx().devices.length}>
                <option value="">Click "Allow" when asked for microphone access…</option>
              </Show>
              <For each={ctx().devices}>{(d) => <option value={d.id}>{d.label}</option>}</For>
            </select>
            <div class="hint" style={{ 'margin-top': '8px' }}>{deviceHint()}</div>

            <label>Level</label>
            <Meter stream={ctx().stream} />

            <label for="bitrate">Quality</label>
            <select
              id="bitrate"
              value={String(ctx().kbps)}
              onChange={(e) => send({ type: 'SET_BITRATE', kbps: Number(e.currentTarget.value) })}
            >
              <option value="128">128 kbps · lighter on busy Wi-Fi</option>
              <option value="192">192 kbps · great for music</option>
              <option value="256">256 kbps · maximum</option>
            </select>

            <label for="name">Party name (shown to listeners)</label>
            <input
              id="name"
              type="text"
              maxLength={60}
              value={ctx().name}
              onChange={(e) => send({ type: 'SET_NAME', name: e.currentTarget.value.trim() })}
            />

            <div class="row" style={{ 'margin-top': '18px' }}>
              <button
                id="goLive"
                classList={{ live: onAir() }}
                disabled={!onAir() && !ctx().stream}
                onClick={() => send({ type: onAir() ? 'STOP' : 'GO_LIVE' })}
              >
                {onAir() ? 'Stop broadcast' : 'Go live'}
              </button>
              <button
                class="secondary"
                title="Capture audio from a browser tab or the whole system, where your browser supports it"
                onClick={() => send({ type: 'SHARE_TAB' })}
              >
                Use tab / system audio instead
              </button>
            </div>
          </section>

          <section class="panel">
            <h2>2 · Listeners scan this</h2>
            <QrCode text={listenUrl()} />
            <div class="url" id="url">{listenUrl()}</div>
            <Show when={ctx().lan.length > 1}>
              <div class="row" style={{ 'justify-content': 'center' }}>
                <select
                  style={{ width: 'auto' }}
                  value={ctx().address}
                  onChange={(e) => send({ type: 'SELECT_ADDRESS', address: e.currentTarget.value })}
                >
                  <For each={ctx().lan}>{(a) => <option value={a.address}>{`${a.address} (${a.name})`}</option>}</For>
                </select>
              </div>
            </Show>
            <p class="hint" style={{ 'text-align': 'center' }}>
              Phones must be on the same Wi-Fi as this Mac.
              <br />
              They open the link, tap play, and plug in headphones.
            </p>
            <hr class="divider" />
            <h2>Listeners</h2>
            <div class="big-number" id="count">{ctx().listenerCount}</div>
            <div class="hint" id="peers">{peerSummary()}</div>
          </section>
        </div>
      </div>
    </Show>
  );
}
