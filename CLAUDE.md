# Silent Disco

A native Mac app that captures DJ software audio and streams it to phones on the same Wi-Fi. Guests scan a QR code and listen in their browser over WebRTC. Read README.md, docs/development.md and native/README.md for the full picture.

## Layout

- `native/`: the app, in Go (module `silentdisco`, package main). Pion WebRTC, Opus via cgo (`gopkg.in/hraban/opus.v2`), Core Audio process taps and the Cocoa window in Objective-C via cgo (`*_darwin.m`). `*_other.go` files are stubs so it builds and tests on Linux with only the test tone.
- `native/web/dist/`: built web pages, embedded with `//go:embed`. Committed. Regenerate with `npm run build` after changing `src/`.
- `src/listener/`: the phone page (Solid + an XState machine). `src/console/`: the DJ console shown in the app window. `src/shared/`: signaling, visuals, CSS.
- `e2e/`: Playwright tests that run the real binary with `-nowindow -tone`.

## Commands

- Always pass `-tags nolibopusfile` to `go build` / `go test` (in `native/`).
- `npm run test:all`: vitest, typecheck, `go test -race`, Playwright. `npm test` alone is the phone machine's model-based tests.
- `cd native && ./build.sh`: web build, Go tests, binary and ad-hoc signed `Silent Disco.app` (needs `brew install go opus pkg-config`).
- `npm run dev`: app on :8081 plus Vite hot reload on :8080; prints the console URL with its token.

## How it fits together

- `engine.go` owns the state: which source is captured, live/off air, settings (`~/Library/Application Support/Silent Disco/settings.json`). It auto-picks DJ software (`djNames` in `sources.go`), follows apps across restarts by pid and inputs across replugs, and never switches away from a source the DJ picked.
- Off air still sends Opus frames (silence) and `fillLoop` fills gaps, so phones' jitter buffers don't grow. Don't stop the stream when nothing is playing.
- `hub.go` is signaling: SSE `/events` (each message carries `id: <phone id>`) and POST `/signal`. Phones resume with `Last-Event-ID`; a detached phone is kept until its WebRTC connection is gone (`Broadcaster.Active`), because Android drops SSE whenever Chrome is backgrounded.
- `api.go` is the console API: loopback only, plus a random token passed in the window URL (`#t=`) and sent as `X-Token` or `?t=`.
- Visual style/palette and flashes go to phones in the signaling `meta` and `flash` messages.

## Testing conventions

- Go: `pgregory.net/rapid` for the model-based engine test (`engine_model_test.go`: fake Mac + rules) and property tests (`property_test.go`). `audio_test.go` is a Pion fake phone that decodes the stream and checks the tone's channels. Add a rule or property when fixing an engine bug.
- Front end: the listener machine is tested by walking its graph (`xstate/graph`) and checking invariants and transition rules after every step; extend the rules, not hand-written scenarios.
- `newStation()` in `main.go` wires the real hub, broadcaster, encoder and engine; tests use it rather than rebuilding the wiring.

## Constraints

- Mac first (macOS 14.2+), Windows later (WASAPI loopback). No Electron; the window is our own WKWebView.
- The Objective-C code only compiles on a Mac.
- Android audio stopping on lock is Chrome's battery saver, not a bug; the phone page tells users how to fix it.
