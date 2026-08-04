#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Habibi.app"
CONTENTS="$APP/Contents"
SERVICE="$CONTENTS/Resources/service"

cd "$ROOT"
npm run build
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$SERVICE"
cp native/Info.plist "$CONTENTS/Info.plist"
ICONSET="$CONTENTS/Resources/Habibi.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/logo.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" assets/logo.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/Habibi.icns"
rm -rf "$ICONSET"
swiftc native/HabibiApp.swift -o "$CONTENTS/MacOS/Habibi" -framework AppKit -framework WebKit -framework Carbon -framework EventKit
cp "$(command -v node)" "$CONTENTS/MacOS/node"

# The app owns the local service. Keep user state (.habibi, OpenWA sessions) out
# of the bundle; it remains in the workspace / user home as today.
for item in dist src assets index.html app.js app.css skills native node_modules package.json; do
  cp -R "$item" "$SERVICE/"
done

echo "Built $APP"
