# Silent Disco

![status: alpha](https://img.shields.io/badge/status-alpha-orange) ![license: MIT](https://img.shields.io/badge/license-MIT-blue)

Turn your Mac into a silent disco. You DJ as usual, guests scan a QR code and listen on their phones in their own headphones, and the room stays quiet. Guests don't install anything, and you don't need extra hardware or audio drivers.

> Alpha: a side project I'm still tinkering with, so expect rough edges.

<table>
  <tr>
    <td width="60%"><img src="docs/host-live.png" alt="DJ console while on air: audio sources, QR code, listener count and phone visuals"></td>
    <td width="20%"><img src="docs/listener-join.png" alt="Phone page: Tap to listen"></td>
    <td width="20%"><img src="docs/listener-playing.png" alt="Phone page: listening live with visualizer and volume"></td>
  </tr>
  <tr>
    <td align="center"><b>1. Go live</b><br>Pick your DJ software, show the QR code.</td>
    <td align="center"><b>2. Scan and tap</b><br>Guests just need a browser.</td>
    <td align="center"><b>3. Dance quietly</b><br>Own headphones, own volume.</td>
  </tr>
</table>

## How it works

Silent Disco is a small native Mac app (macOS 14.2+). It records the sound of one app, such as djay, rekordbox, Serato, Traktor, VirtualDJ or Mixxx, using Core Audio process taps, so you keep hearing it normally. It can also take all system audio or an audio input like a mixer's USB out.

It encodes the audio once as Opus and streams it over WebRTC (the tech behind video calls) to every phone on the same Wi-Fi, with about 60 to 200 ms of delay. Nothing goes through the internet.

* **Any DJ software, no setup.** It picks up open DJ software automatically and follows it if it restarts. Click any other app or input to switch, even while live.
* **Phone visuals you control.** Pick a style and colors from the console and every phone follows. Flash all phones at once from the console.
* **Built to keep playing.** Phones keep the music going through Wi-Fi blips and locked screens, and reconnect on their own.

## Getting started

### 1. Build the app (once)

You need a Mac on macOS 14.2 or later and [Homebrew](https://brew.sh).

```
brew install go opus pkg-config
git clone https://github.com/rundmt/silent-disco.git
cd silent-disco/native
./build.sh
```

This runs the tests and makes **Silent Disco.app** in the `native` folder. Drag it to Applications if you like. If you change the phone page or console in `src/`, run `npm install` once in the repo root and `build.sh` rebuilds them too.

### 2. First launch

```
open "Silent Disco.app"
```

macOS asks a few things the first time. Allow them all:

* **System audio recording**, so the app can hear your DJ software.
* **Local network** (macOS 15 and later), so phones can reach your Mac.
* **Incoming connections**, if your firewall is on.

If you miss one, the console shows a button that opens the right Privacy & Security setting. A rebuilt app counts as new to macOS, so it may ask again after `build.sh`.

### 3. Pick your music

Open your DJ software (djay, rekordbox, Serato, Traktor, VirtualDJ, Mixxx and others). Silent Disco picks it automatically and shows it at the top of the **Audio source** panel. Play a track and the level meter should move. You can click any other app, all system audio, or an audio input like your controller's USB out instead. You still hear everything through your speakers or headphones as normal.

### 4. Test with your own phone

1. Join your phone to the same Wi-Fi as the Mac.
2. Click **Go live**.
3. Scan the QR code in the console and tap **Tap to listen**.
4. Put headphones on. You should hear what's playing, and the console shows 1 listening.

No music handy? Pick **Test tone** under Testing.

### 5. At the party

* Put the QR code where people can scan it: on a screen, or print the address shown under it.
* Pick a visual style and colors under **Phone visuals**, and tap a flash color to light up every phone at once.
* Click **Stop broadcast** to go off air. Phones stay connected and pick back up when you go live again.
* Closing the window keeps the party going. The menu bar icon brings it back or quits.

### If something's not working

* **Level meter is flat while music plays:** macOS is blocking the recording. Use the button in the console, turn on Silent Disco under Screen & System Audio Recording, then quit and reopen.
* **Phones can't open the page:** they're probably on a different network, or the Wi-Fi keeps devices apart (common on guest and venue networks). A cheap travel router fixes it.
* **Music stops when an Android phone locks:** Chrome's battery saver. Settings → Apps → Chrome → Battery → Unrestricted. The phone page shows this tip too.

There's also a Terminal mode with flags like `-app serato` and `-tone`; see [`native/README.md`](native/README.md).

## Good to know

* Phones must be on the **same Wi-Fi** as the Mac. Venue and guest networks often block devices from talking to each other, so a cheap travel router is the reliable fix.
* A recent MacBook handles a few dozen listeners. Bluetooth headphones add 150 to 300 ms of delay, so wired is best.
* Anyone on the Wi-Fi with the link can listen.

## More

* [Development notes](docs/development.md): code layout, dev mode, tests, latency
* Ideas for later: multiple channels (red/green/blue like real silent disco headsets), Windows, joining over the internet, a signed downloadable app

## License

[MIT](LICENSE)
