# Development notes

How the code is laid out and how it's tested. Back to the [README](../README.md).

## How the code is organized

The web pages are written in **TypeScript** with **Solid** for the UI and **XState** state machines for all the connection logic, built with **Vite**. The server is a single dependency-free Node file.

| Path | What it does |
|---|---|
| `server.js` | Serves the built app from `dist/` and relays connection setup messages. No dependencies. |
| `src/listener/machine.ts` | The phone's lifecycle as a state machine: idle, waiting for the DJ, joining, connecting, playing, dropped and reconnecting. |
| `src/listener/peer.ts` | The WebRTC connection to the DJ, as an actor the machine starts and stops. Reports stats. |
| `src/listener/audioOutput.ts` | Playback through Web Audio, so the volume slider works on every phone. |
| `src/listener/App.tsx` | The phone UI. Status text is derived from the machine's current state. |
| `src/host/machine.ts` | The DJ console machine. Two parallel regions (audio source, on/off air) and one spawned actor per listener. |
| `src/host/peer.ts` | One WebRTC connection to one listener. |
| `src/host/capture.ts` | Opening BlackHole or another input, tab/system audio sharing, device and track watchers. |
| `src/host/App.tsx`, `Meter.tsx`, `QrCode.tsx` | The host UI. |
| `src/listener/status.ts` | The status line text, derived from the machine state (kept separate so it's testable). |
| `src/**/machine.test.ts` | Model-based tests (see below). |
| `src/console/` | The DJ console for the Mac app window (`native/`). Talks to the app's API instead of doing WebRTC itself. |
| `src/shared/` | Signaling client, Opus quality tuning, styles. |
| `dist/` | The built app. Included so `npm start` works without building. |

## Changing the code

```
npm install        # once
npm run dev        # hot reload on http://localhost:8080/host.html
npm run build      # rebuild dist/ for `npm start`
npm run typecheck
npm test           # model-based tests of both state machines
npm run test:go    # the Mac app's Go tests, with the race detector
npm run test:e2e   # browser tests against the real app (builds it first)
npm run test:all   # all of the above, plus typecheck
```

The first time on a machine, `npx playwright install chromium` fetches the browser the e2e tests use.

### Model-based tests

`src/listener/machine.test.ts` and `src/host/machine.test.ts` don't list scenarios by hand. `xstate/graph` explores each state machine, finds a path to every distinct state (about 45 for the listener and 315 for the host), and then tries every possible event from each one. Each run drives the real machine with fake signaling, audio devices and WebRTC peers that record what happened, and checks two kinds of rules after every step:

* **Invariants** hold in every state, whatever route led there. For example: each listener hears the current source when on air and silence when off; there's never more than one connection per listener; replaced audio sources are released; joining always means a join was just sent.
* **Transition rules** say what a specific event must do, written separately from the machine. For example: a failed connection always rejoins, a blip while playing waits before rejoining, and picking a device never takes you off air.

When you change a machine, the paths regenerate automatically, so new states get covered without writing new tests.

### Tests for the Mac app (`native/`)

The phone page's machines are statecharts, so XState can walk them. The Go engine isn't a statechart; its model is a fake Mac plus a list of rules, and [rapid](https://github.com/flyingmutant/rapid) generates the walks:

* **Model-based** (`engine_model_test.go`). Thousands of random party timelines: apps open, quit, restart and start playing, inputs get plugged and unplugged, macOS blocks a source, the DJ picks sources and goes live. After every step the engine must obey the rules: exactly one capture while capturing, of the right processes; an error always says why; once the DJ picks a source it never switches away on its own; phones are told the truth about being live and hear silence when off air. Rescans have their own rules (follow an app to its new processes after a restart, wait under the same name when it quits, don't retry a blocked capture until something changes). A failure shrinks to the shortest timeline that breaks a rule.
* **Property** (`property_test.go`). Rules that hold for any input: the resampler gives the right length, never overshoots, keeps a steady level, and sounds the same however Core Audio chunks the buffers; every full 20 ms of audio is exactly one Opus frame; each process lands in one app and the list is in DJ-first order; any settings file, even garbage, loads as something usable; and the hub never forgets a phone whose audio is still playing, however its event streams drop and reconnect.
* **Real audio** (`audio_test.go`). A fake phone built from Pion connects over real WebRTC, decodes the Opus it receives, and checks the test chord arrives with C♯ on the left and E on the right. Then it goes off air (silence, not a gap), drops its event stream (the audio keeps flowing), and resumes as the same phone.
* **Console API** (`api_test.go`). The token and this-Mac-only checks, source picks, going live, name and quality limits, visuals and flashes reaching phones.
* **Browser** (`e2e/`). Chromium phone pages and the DJ console against the real binary with `-nowindow -tone`: a phone hears the DJ, off air and back, the stream to the page server is cut and the music keeps playing on the same connection, the DJ restyles and flashes phones.

`native/build.sh` runs the Go tests before building and stops if they fail (`SKIP_TESTS=1 ./build.sh` to build anyway).

In dev mode, phones can still join from the QR code. Unlike `npm start`, dev mode doesn't lock the host page to this Mac.

## Latency, honestly

| Approach | Typical delay | Why not |
|---|---|---|
| Twitch / HLS streaming | 3 to 30 s | Way too late to dance to |
| Plain web radio (Icecast/MP3) | 1 to 5 s | Same problem |
| **WebRTC on local Wi-Fi (this)** | **~60 to 200 ms** | Chosen |
| Raw packets + custom native app | ~20 to 50 ms | Needs an app installed on every phone |

In testing the network and buffering part measured about **50 ms**. On a real party Wi-Fi expect 80 to 200 ms, and each listener's phone may drift a little from the next. That's fine for a silent disco because everyone is in their own headphones. Two things add a lot more delay: **Bluetooth headphones add 150 to 300 ms** (wired is best; AirPods are okay), and a crowded, weak Wi-Fi.
