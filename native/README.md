# Silent Disco for Mac

The whole Silent Disco app: capture, streaming, the phone page and the DJ
console, in one native binary.

* **Captures audio with a Core Audio process tap** (macOS 14.2+): one app such
  as djay, rekordbox, Serato, Traktor, VirtualDJ or Mixxx, or everything the
  Mac plays. The DJ still hears it normally.
* **Or an audio input**: a mixer's or controller's USB audio, or an audio
  interface.
* **Encodes Opus once** and sends the same packets to every phone over WebRTC
  ([Pion](https://github.com/pion/webrtc)), so CPU use barely grows with the
  crowd.
* **Serves the phone page** (embedded from `web/dist`, built from `../src`).
* **DJ console in a native window** (WKWebView, no Electron) plus a menu bar
  icon. Closing the window keeps the party going.

## Picking the audio

No settings needed. When the app opens it picks, in order:

1. the source you picked last time, if it's available;
2. any open DJ software (one that's playing wins);
3. all system audio, switching to DJ software automatically if you open some.

The window lists DJ software first, then other apps making sound, then all
system audio and audio inputs. Click any of them to switch, even while live.
If the chosen app quits or restarts, or the input is unplugged, the app waits
and picks it up again when it's back.

DJ software is spotted by name (see `djNames` in `sources.go`), but any app
can be picked.

## Build and run

```
brew install go opus pkg-config   # once
./build.sh
open "Silent Disco.app"
```

**First run:** macOS asks whether Silent Disco may record system audio (and,
on macOS 15, find devices on your local network). Allow both. If the level
meter stays flat while music plays, the window shows a button that opens the
right Privacy & Security pane.

Each rebuild looks like a new app to macOS, so it may ask again.

### Terminal mode

```
./silent-disco -nowindow              # QR code and status in Terminal
./silent-disco -list                  # see every source
./silent-disco -nowindow -app serato  # start with an app
./silent-disco -input Mixtour         # start with an audio input
./silent-disco -tone                  # test tone, no permissions needed
```

Other flags: `-name "Friday Party"`, `-kbps 256`, `-port 8080`. Settings
picked in the window are saved to
`~/Library/Application Support/Silent Disco/settings.json`.

## Files

| File | What it does |
|---|---|
| `main.go` | Flags, web server, window or Terminal mode. |
| `engine.go` | Which source is captured, live/off air, settings; follows apps and devices coming and going. |
| `sources.go` | The source list: grouping helper processes into apps, spotting DJ software. |
| `api.go` | The DJ console's API (this Mac only, token-protected). |
| `hub.go` | Signaling with phones (Server-Sent Events + POST); keeps a phone's id across dropped streams. |
| `broadcast.go` | Pion WebRTC: one shared Opus track, one peer connection per phone. |
| `encoder.go` | PCM to 20 ms stereo Opus frames, resampling to 48 kHz if needed. |
| `capture.go` | The source interface and the test tone. |
| `capture_darwin.go`, `tap_darwin.m` | Process taps, input devices, app list and icons (Objective-C via cgo). |
| `window_darwin.go`, `app_darwin.m` | The window, menu bar icon and menus. |
| `Info.plist` | App bundle info and the permission prompts' wording. |
| `engine_test.go` | Tests for the source rules above (`go test -tags nolibopusfile`). |
| `engine_model_test.go` | Model-based tests: random party timelines against the engine's rules. |
| `property_test.go` | Property tests for the resampler, encoder, app grouping, settings and the hub. |
| `audio_test.go` | A Pion fake phone that listens over real WebRTC and checks the chord. |
| `api_test.go` | The DJ console API. |
| `web/dist` | The built web pages, embedded into the binary (`npm run build` in the repo root). |

The console itself is `../src/console/` (Solid), built with the rest of the
web app.

## Not yet

* A proper app icon, and signing with a Developer ID and notarizing (so it
  opens on other Macs without a warning). `release.sh` already makes a
  self-contained Apple Silicon + Intel app with Opus built in.
* Picking which input channels to use (it takes 1–2).
* Windows.
