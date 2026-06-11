#!/usr/bin/env bash
# Regenerates ./dev/ — an unpacked build for local testing that's identical to
# the repo except oauth2.client_id is swapped for the "local unpacked" OAuth
# client (registered in GCP against this dev extension's ID).
#
# Load `dev/` (not the repo root) in chrome://extensions for local testing.
# manifest.json at the repo root stays untouched and is what ships to the
# Chrome Web Store.
#
# Files are COPIED (not symlinked) — Chrome's unpacked-extension loader is
# unreliable with symlinked content scripts. Re-run this script after editing
# source files, then click "reload" on the extension in chrome://extensions.
set -euo pipefail

DEV_CLIENT_ID="396260624027-g6p0gf57jtl7t0c0305j7odrife1g2c8.apps.googleusercontent.com"

cd "$(dirname "$0")/.."
rm -rf dev
mkdir dev

for f in *; do
  [ "$f" = "dev" ] && continue
  [ "$f" = "manifest.json" ] && continue
  [ "$f" = "scripts" ] && continue
  cp -r "$f" "dev/$f"
done

jq --arg cid "$DEV_CLIENT_ID" '.oauth2.client_id = $cid' manifest.json > dev/manifest.json

echo "dev/ ready — load this folder as an unpacked extension in Chrome."
