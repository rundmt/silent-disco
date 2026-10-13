# Silent Disco

![status: alpha](https://img.shields.io/badge/status-alpha-orange) ![license: MIT](https://img.shields.io/badge/license-MIT-blue)

Turn your Mac into a silent disco. You play music, everyone scans a QR code on their phone and listens in their own headphones, and the room stays quiet. No app for guests, no special hardware.

> Alpha: a side project I'm still tinkering with, so expect rough edges.

<table>
  <tr>
    <td width="60%"><img src="docs/host-live.png" alt="DJ console while on air, with QR code and listener count"></td>
    <td width="20%"><img src="docs/listener-join.png" alt="Phone page: Tap to listen"></td>
    <td width="20%"><img src="docs/listener-playing.png" alt="Phone page: listening live with visualizer and volume"></td>
  </tr>
  <tr>
    <td align="center"><b>1. Go live</b><br>Pick what to play, show the QR code.</td>
    <td align="center"><b>2. Scan and tap</b><br>Guests just need a browser.</td>
    <td align="center"><b>3. Dance quietly</b><br>Own headphones, own volume.</td>
  </tr>
</table>

## How it works

Your Mac grabs whatever audio you're playing and streams it over Wi-Fi to every phone that joins, using WebRTC (the same tech as video calls) so the delay stays small, around 60 to 200 ms on a normal network. Nothing goes through the internet or a server.

There are two ways to run the Mac side:

* **Mac app** (in `native/`, macOS 14.2+): picks up audio straight from DJ software or the whole system. Nothing else to install.
* **Browser version** (`npm start`): works on any Mac, but needs [BlackHole](https://existential.audio/blackhole/) (a free virtual audio cable) to capture sound.

## Try it

**Browser version:**

```
brew install blackhole-2ch    # once, then restart
npm install && npm start
```

Open `http://localhost:8080/host` in Chrome, pick **BlackHole 2ch**, send your music app's output to it, click **Go live**, and have guests scan the QR code.

**Mac app:**

```
brew install go opus pkg-config
cd native && ./build.sh
open "Silent Disco.app"
```

Allow the audio recording prompt, pick an app, and go live. More in [`native/README.md`](native/README.md).

## Good to know

* Phones must be on the **same Wi-Fi** as the Mac. Venue and guest networks often block devices from talking to each other, so a cheap travel router is the reliable fix.
* A recent MacBook handles a few dozen listeners. Bluetooth headphones add noticeable delay, wired is best.
* Anyone on the Wi-Fi with the link can listen.

## More

* [Development notes](docs/development.md): code layout, tests, latency numbers
* Ideas for later: multiple channels (red/green/blue like real silent disco headsets), joining over the internet, a downloadable signed Mac app

## License

[MIT](LICENSE)
