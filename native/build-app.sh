#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Habibi.app"
CONTENTS="$APP/Contents"
SERVICE="$CONTENTS/Resources/service"
STAGE="$ROOT/build/stage"

cd "$ROOT"

command -v swiftc >/dev/null || { echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found. See https://pnpm.io/installation" >&2; exit 1; }

pnpm run build
rm -rf "$APP" "$STAGE"
mkdir -p "$CONTENTS/MacOS" "$SERVICE"
cp native/Info.plist "$CONTENTS/Info.plist"
# A release build stamps the version CI calculated; a plain local build keeps
# whatever native/Info.plist already has checked in.
if [[ -n "${HABIBI_APP_VERSION:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $HABIBI_APP_VERSION" "$CONTENTS/Info.plist"
fi
ICONSET="$CONTENTS/Resources/Habibi.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/logo.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" assets/logo.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/Habibi.icns"
rm -rf "$ICONSET"
# Universal binary so one download runs on both Apple Silicon and Intel.
FRAMEWORKS=(-framework AppKit -framework WebKit -framework Carbon -framework EventKit)
swiftc -O -target arm64-apple-macos13.0 native/HabibiApp.swift -o "$ROOT/build/Habibi-arm64" "${FRAMEWORKS[@]}"
swiftc -O -target x86_64-apple-macos13.0 native/HabibiApp.swift -o "$ROOT/build/Habibi-x86_64" "${FRAMEWORKS[@]}"
lipo -create "$ROOT/build/Habibi-arm64" "$ROOT/build/Habibi-x86_64" -output "$CONTENTS/MacOS/Habibi"
rm -f "$ROOT/build/Habibi-arm64" "$ROOT/build/Habibi-x86_64"

# The bundled interpreter runs the local service. nodejs.org publishes only
# per-architecture macOS builds, so fetch both and lipo them together rather than
# shipping whichever `node` happens to be on the build machine's PATH.
NODE_VERSION="${HABIBI_NODE_VERSION:-22.22.0}"
NODE_CACHE="$ROOT/build/node-cache/$NODE_VERSION"
if [[ -n "${HABIBI_NODE_BIN:-}" ]]; then
  cp "$HABIBI_NODE_BIN" "$CONTENTS/MacOS/node"
else
  mkdir -p "$NODE_CACHE"
  for arch in arm64 x64; do
    if [[ ! -f "$NODE_CACHE/node-$arch" ]]; then
      echo "Fetching node v$NODE_VERSION ($arch)…"
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.gz" \
        | tar xz -C "$NODE_CACHE" "node-v$NODE_VERSION-darwin-$arch/bin/node"
      mv "$NODE_CACHE/node-v$NODE_VERSION-darwin-$arch/bin/node" "$NODE_CACHE/node-$arch"
      rm -rf "$NODE_CACHE/node-v$NODE_VERSION-darwin-$arch"
    fi
  done
  lipo -create "$NODE_CACHE/node-arm64" "$NODE_CACHE/node-x64" -output "$CONTENTS/MacOS/node"
fi
chmod +x "$CONTENTS/MacOS/node"
echo "Bundled node $("$CONTENTS/MacOS/node" --version) ($(lipo -archs "$CONTENTS/MacOS/node"))"

# Production dependencies only. Dev tooling (TypeScript, esbuild, jsdom) is a
# build-time concern, and every Mach-O binary shipped has to be code-signed for
# notarization — so anything unused is both dead weight and signing surface.
mkdir -p "$STAGE"
cp package.json pnpm-lock.yaml "$STAGE/"
(cd "$STAGE" && pnpm install --prod --ignore-scripts --silent)

# node-pty ships prebuilt binaries for every platform it supports and resolves
# `prebuilds/<platform>-<arch>` at runtime (see its lib/utils.js), so a universal
# app needs both darwin directories kept. The Windows ones can never load, and
# every Mach-O left in the bundle has to be signed for notarization to pass.
find "$STAGE/node_modules" -type d -name prebuilds 2>/dev/null | while read -r prebuilds; do
  for dir in "$prebuilds"/*(N/); do
    case "${dir:t}" in
      darwin-arm64|darwin-x64) ;;
      *) rm -rf "$dir" ;;
    esac
  done
done

# `.bin` holds shims for CLIs the running service never invokes.
rm -rf "$STAGE/node_modules/.bin" "$STAGE/node_modules/.pnpm/node_modules/.bin"

# node-pty forks through a helper binary. Installing with --ignore-scripts (this
# build, and any machine with ignore-scripts in its npm config) leaves it
# non-executable, and the terminal then fails with "posix_spawnp failed".
find "$STAGE/node_modules" -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true
PTY_HELPER="$(find "$STAGE/node_modules" -name spawn-helper -type f -print -quit 2>/dev/null)"
[[ -n "$PTY_HELPER" && -x "$PTY_HELPER" ]] || { echo "node-pty spawn-helper is missing or not executable; the terminal would fail at runtime." >&2; exit 1; }

mv "$STAGE/node_modules" "$SERVICE/node_modules"
rm -rf "$STAGE"

# The service needs its compiled output, the client bundle, static assets, skill
# manifests and its manifest. `native/` (this script, the Swift source) and the
# unbundled client sources are build inputs and are deliberately excluded.
for item in dist assets index.html app.css skills package.json; do
  cp -R "$item" "$SERVICE/"
done

# The compiled test suite is not part of the product, and source maps plus
# declaration files only exist to support development — shipping them hands a
# reader the original sources and internal paths for no runtime benefit.
rm -rf "$SERVICE/dist/test"
find "$SERVICE" \( -name "*.map" -o -name "*.d.ts" \) -type f -delete 2>/dev/null || true

echo "Built $APP ($(du -sh "$APP" | cut -f1))"
