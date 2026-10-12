#!/bin/bash
# Builds Silent Disco for this Mac: "Silent Disco.app" plus a ./silent-disco
# command for Terminal.
set -e
cd "$(dirname "$0")"

command -v go >/dev/null || { echo "Go is not installed. Run: brew install go"; exit 1; }
pkg-config --exists opus 2>/dev/null || { echo "The Opus codec library is missing. Run: brew install opus pkg-config"; exit 1; }

# Refresh the embedded web pages (phone page and DJ console) if the web app is set up.
if [ -d ../node_modules ]; then
  (cd .. && npm run build --silent)
  rm -rf web/dist && cp -R ../dist web/dist
fi

go build -tags nolibopusfile -o silent-disco .

APP="Silent Disco.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp silent-disco "$APP/Contents/MacOS/silent-disco"
cp Info.plist "$APP/Contents/Info.plist"
# Ad-hoc signature so macOS can remember the permissions you grant. Each
# rebuild is a "new" app to macOS, so it may ask again after rebuilding.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "Built \"$APP\" and ./silent-disco"
echo "Open the app:     open \"$APP\"   (or double-click it in Finder)"
echo "Or in Terminal:   ./silent-disco -nowindow"
