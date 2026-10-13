#!/bin/bash
# Builds a "Silent Disco.app" anyone can download and run: Apple Silicon and
# Intel in one app, with the Opus codec built in, so nothing needs installing.
# Used by .github/workflows/release.yml; also runs on a Mac with Go and the
# Xcode command line tools. Output: dist/Silent-Disco-<version>-mac.zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-dev}"
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
MIN_MACOS=14.2
BUILD="$PWD/build"
APP="$BUILD/Silent Disco.app"
mkdir -p "$BUILD"

# Opus, static, once per architecture. The app then has no Homebrew dependency.
if [ ! -f "$BUILD/opus-$OPUS_VERSION.tar.gz" ]; then
  curl -fsSL -o "$BUILD/opus-$OPUS_VERSION.tar.gz" \
    "https://github.com/xiph/opus/releases/download/v$OPUS_VERSION/opus-$OPUS_VERSION.tar.gz"
fi
echo "$OPUS_SHA256  $BUILD/opus-$OPUS_VERSION.tar.gz" | shasum -a 256 -c -

build_opus() { # arch host
  local prefix="$BUILD/opus-$1"
  [ -f "$prefix/lib/libopus.a" ] && return
  rm -rf "$BUILD/src-$1" && mkdir -p "$BUILD/src-$1"
  tar xzf "$BUILD/opus-$OPUS_VERSION.tar.gz" -C "$BUILD/src-$1" --strip-components 1
  (cd "$BUILD/src-$1" &&
    ./configure --host="$2" --prefix="$prefix" --disable-shared --enable-static \
      --disable-doc --disable-extra-programs \
      CFLAGS="-arch $1 -O2 -mmacosx-version-min=$MIN_MACOS" LDFLAGS="-arch $1" >/dev/null &&
    make -j"$(sysctl -n hw.ncpu)" >/dev/null && make install >/dev/null)
  # Only the static library is installed, so the linker can't pick a dylib.
}

build_app() { # arch goarch host
  build_opus "$1" "$3"
  PKG_CONFIG_PATH="$BUILD/opus-$1/lib/pkgconfig" \
  CGO_ENABLED=1 GOOS=darwin GOARCH="$2" CGO_LDFLAGS="-lm" \
  CC="clang -arch $1" MACOSX_DEPLOYMENT_TARGET=$MIN_MACOS \
    go build -tags nolibopusfile -trimpath -ldflags "-s -w" -o "$BUILD/silent-disco-$2" .
}

build_app arm64 arm64 aarch64-apple-darwin
build_app x86_64 amd64 x86_64-apple-darwin

rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
lipo -create -output "$APP/Contents/MacOS/silent-disco" "$BUILD/silent-disco-arm64" "$BUILD/silent-disco-amd64"
sed -e "s|<string>0.3.0</string>|<string>${VERSION#v}</string>|" Info.plist > "$APP/Contents/Info.plist"

# Fail rather than ship an app that still needs Homebrew.
if otool -L "$APP/Contents/MacOS/silent-disco" | grep -qE "opus|/opt/homebrew|/usr/local"; then
  otool -L "$APP/Contents/MacOS/silent-disco"
  echo "The app still links a library outside macOS." && exit 1
fi

# Ad-hoc signature: Apple Silicon won't run unsigned code at all.
codesign --force --deep --sign - "$APP"

mkdir -p dist
ZIP="dist/Silent-Disco-${VERSION}-mac.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $ZIP"
