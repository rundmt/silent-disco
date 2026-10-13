#!/bin/bash
# Builds the phone page, console and app, then runs the browser tests
# against the real binary. First time on a new machine:
#   npx playwright install chromium
set -e
cd "$(dirname "$0")/.."
npm run build --silent
rm -rf native/web/dist && cp -R dist native/web/dist
(cd native && go build -tags nolibopusfile -o silent-disco-test .)
npx playwright test "$@"
