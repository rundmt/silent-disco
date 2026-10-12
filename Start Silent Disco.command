#!/bin/bash
# Double-click this file in Finder to start Silent Disco.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org, then double-click this file again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
if [ ! -f dist/index.html ]; then
  echo "Building the web app (first run only)…"
  npm install && npm run build || exit 1
fi
node server.js
