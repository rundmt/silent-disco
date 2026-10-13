# Development notes

How the code is laid out and how it's tested. Back to the [README](../README.md).

## How the code is organized

Two parts: a Go app in `native/` that captures, encodes and streams the audio, and two web pages in `src/` (TypeScript, Solid, XState, built with Vite) that the app serves and embeds.

```
DJ software ──Core Audio tap──▶ engine ──▶ Opus encoder ──▶ one shared WebRTC track ──▶ every phone
                                   ▲                                                    (src/listener)
                     DJ console (src/console) in the app's window, via a local API
```

| Path | What it does |
|---|---|
| `native/` | The Mac app. Its own [README](../native/README.md) lists every file. |
| `native/web/dist/` | The built pages, embedded into the binary. Committed so `go build` works without Node. |
| `src/listener/machine.ts` | The phone's lifecycle as a state machine: idle, waiting for the DJ, joining, connecting, playing, dropped and reconnecting. |
| `src/listener/peer.ts` | The WebRTC connection to the app, as an actor the machine starts and stops. Reports stats. |
| `src/listener/audioOutput.ts` | Playback that keeps going on a locked phone (Web Audio on iOS, a media element elsewhere) plus the analyser the visuals read. |
| `src/listener/Visualizer.tsx`, `flash.ts` | The phone visuals and the DJ's flashes. |
| `src/listener/App.tsx`, `status.ts` | The phone UI. Status text is derived from the machine's state. |
| `src/console/` | The DJ console shown in the app's window. Talks to the app's API (`native/api.go`). |
| `src/shared/` | Signaling client, Opus tuning, visual styles and palettes, styles. |
| `e2e/` | Browser tests against the real app. |

Signaling is Server-Sent Events from the app (`/events`) and POSTs from the phone (`/signal`). A phone's id survives a dropped event stream (the browser resumes with `Last-Event-ID`), and the app only forgets a phone once its audio connection is gone too, because Android drops the stream whenever Chrome goes to the background.

## Changing the code

```
npm install        # once
npm run dev        # the app on :8081 plus hot reload on :8080 (prints the console link)
npm run build      # rebuild native/web/dist (native/build.sh does this too)
npm run typecheck
npm test           # model-based tests of the phone's state machine
npm run test:go    # the Mac app's Go tests, with the race detector
npm run test:e2e   # browser tests against the real app (builds it first)
npm run test:all   # all of the above, plus typecheck
```

`npm run dev -- -tone` passes flags to the app, here a test tone. The first time on a machine, `npx playwright install chromium` fetches the browser the e2e tests use.

### Model-based tests

`src/listener/machine.test.ts` doesn't list scenarios by hand. `xstate/graph` explores the state machine, finds a path to every distinct state, and then tries every possible event from each one. Each run drives the real machine with fake signaling, audio and WebRTC peers that record what happened, and checks two kinds of rules after every step:

* **Invariants** hold in every state, whatever route led there. For example: there's never more than one connection, and joining always means a join was just sent.
* **Transition rules** say what a specific event must do, written separately from the machine. For example: a failed connection always rejoins, a blip while playing waits before rejoining, and a dropped event stream that comes back with the same id keeps the audio connection.

When you change the machine, the paths regenerate automatically, so new states get covered without writing new tests.

### Tests for the Mac app (`native/`)

The phone page's machines are statecharts, so XState can walk them. The Go engine isn't a statechart; its model is a fake Mac plus a list of rules, and [rapid](https://github.com/flyingmutant/rapid) generates the walks:

* **Model-based** (`engine_model_test.go`). Thousands of random party timelines: apps open, quit, restart and start playing, inputs get plugged and unplugged, macOS blocks a source, the DJ picks sources and goes live. After every step the engine must obey the rules: exactly one capture while capturing, of the right processes; an error always says why; once the DJ picks a source it never switches away on its own; phones are told the truth about being live and hear silence when off air. Rescans have their own rules (follow an app to its new processes after a restart, wait under the same name when it quits, don't retry a blocked capture until something changes). A failure shrinks to the shortest timeline that breaks a rule.
* **Property** (`property_test.go`). Rules that hold for any input: the resampler gives the right length, never overshoots, keeps a steady level, and sounds the same however Core Audio chunks the buffers; every full 20 ms of audio is exactly one Opus frame; each process lands in one app and the list is in DJ-first order; any settings file, even garbage, loads as something usable; and the hub never forgets a phone whose audio is still playing, however its event streams drop and reconnect.
* **Real audio** (`audio_test.go`). A fake phone built from Pion connects over real WebRTC, decodes the Opus it receives, and checks the test chord arrives with C♯ on the left and E on the right. Then it goes off air (silence, not a gap), drops its event stream (the audio keeps flowing), and resumes as the same phone.
* **Console API** (`api_test.go`). The token and this-Mac-only checks, source picks, going live, name and quality limits, visuals and flashes reaching phones.
* **Browser** (`e2e/`). Chromium phone pages and the DJ console against the real binary with `-nowindow -tone`: a phone hears the DJ, off air and back, the stream to the page server is cut and the music keeps playing on the same connection, the DJ restyles and flashes phones.

`native/build.sh` runs the Go tests before building and stops if they fail (`SKIP_TESTS=1 ./build.sh` to build anyway).

## Latency, honestly

| Approach | Typical delay | Why not |
|---|---|---|
| Twitch / HLS streaming | 3 to 30 s | Way too late to dance to |
| Plain web radio (Icecast/MP3) | 1 to 5 s | Same problem |
| **WebRTC on local Wi-Fi (this)** | **~60 to 200 ms** | Chosen |
| Raw packets + custom native app | ~20 to 50 ms | Needs an app installed on every phone |

In testing the network and buffering part measured about **50 ms**. On a real party Wi-Fi expect 80 to 200 ms, and each listener's phone may drift a little from the next. That's fine for a silent disco because everyone is in their own headphones. Two things add a lot more delay: **Bluetooth headphones add 150 to 300 ms** (wired is best; AirPods are okay), and a crowded, weak Wi-Fi.
