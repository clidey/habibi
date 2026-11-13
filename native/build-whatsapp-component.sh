#!/usr/bin/env bash
# Stages the on-demand WhatsApp component for this machine's OS and
# architecture: Node, native/openwa-supervisor.js, OpenWA and the Chrome for
# Testing build it drives. The Habibi app itself ships none of these; it
# downloads this component from the GitHub release the first time WhatsApp is
# opened (crates/habibi-integrations/src/whatsapp/runtime.rs).
#
#   HABIBI_COMPONENT_ARCH  arm64 or x64; must match this machine, because
#                          OpenWA's native modules are installed for the host
#   VERSION                release version (defaults to package.json's)
#
# Output, under build/whatsapp-component/:
#   macOS          "Habibi WhatsApp Runtime.app" (unsigned; native/
#                  package-whatsapp-component.sh signs, notarizes and zips it)
#                    Contents/MacOS/HabibiWhatsAppRuntime   bundle executable
#                    Contents/MacOS/node
#                    Contents/Resources/openwa-supervisor.js
#                    Contents/Resources/openwa/{dist,node_modules,chrome/*.app}
#   Windows/Linux  whatsapp-runtime/{node.exe|node, openwa-supervisor.js, openwa/}
#                  plus build/Habibi-WhatsApp-<windows|linux>-x64-<version>.tar.gz,
#                  whose SHA-256 the release workflow pins into the app build.
#
# Runs with bash 3.2 (macOS) and Git Bash (Windows runners), so no bash 4
# features. Pinned versions live in native/versions.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=native/versions.sh
source "$ROOT/native/versions.sh"

ARCH="${HABIBI_COMPONENT_ARCH:?Set HABIBI_COMPONENT_ARCH=arm64 or x64}"
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) HOST_ARCH=arm64 ;;
  x86_64 | amd64) HOST_ARCH=x64 ;;
  *) HOST_ARCH="$(uname -m)" ;;
esac
[[ "$ARCH" == "$HOST_ARCH" ]] || {
  echo "HABIBI_COMPONENT_ARCH=$ARCH but this machine is $HOST_ARCH; build each component on matching hardware." >&2
  exit 1
}

# Chrome for Testing publishes mac-arm64, mac-x64, linux64 and win64 builds
# only, so Linux and Windows components are x64.
case "$OS-$ARCH" in
  macos-arm64) NODE_DIST=darwin-arm64; PUPPETEER_PLATFORM=mac_arm; PREBUILD=darwin-arm64 ;;
  macos-x64) NODE_DIST=darwin-x64; PUPPETEER_PLATFORM=mac; PREBUILD=darwin-x64 ;;
  linux-x64) NODE_DIST=linux-x64; PUPPETEER_PLATFORM=linux; PREBUILD=linux-x64 ;;
  windows-x64) NODE_DIST=win-x64; PUPPETEER_PLATFORM=win64; PREBUILD=win32-x64 ;;
  *) echo "No WhatsApp component for $OS-$ARCH (Chrome for Testing has no build for it)." >&2; exit 1 ;;
esac

# Native Windows programs (node, npx, tar.exe) need Windows paths.
native_path() {
  if [[ "$OS" == windows ]]; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}
# Windows' own bsdtar reads and writes the gzip archives and Node's zip; it is
# also what Habibi unpacks the component with at runtime.
if [[ "$OS" == windows ]]; then
  TAR="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/tar.exe"
else
  TAR=tar
fi
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
fetch() {
  curl --http1.1 --fail --silent --show-error --location \
    --retry 4 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 600 \
    --output "$2" "$1"
}

VERSION="${VERSION:-$(cd "$ROOT" && node -p "require('./package.json').version")}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION must look like X.Y.Z (got '$VERSION')" >&2; exit 1; }
for tool in node npm npx git curl; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done
# OpenWA's native modules are compiled/downloaded for the Node running npm,
# so it must be the exact Node the component ships.
[[ "$(node --version)" == "v$NODE_VERSION" ]] || {
  echo "Build with Node v$NODE_VERSION (.nvmrc), not $(node --version): the component's native modules must match its bundled Node." >&2
  exit 1
}

OUT="$ROOT/build/whatsapp-component"
CACHE="$ROOT/build/component-cache"
# Staging lives outside the repository: pnpm-workspace.yaml makes any
# directory under $ROOT with its own package.json an implicit workspace member,
# and OpenWA has one — staging it under $ROOT once corrupted the root install.
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT
mkdir -p "$OUT" "$CACHE"

if [[ "$OS" == macos ]]; then
  COMPONENT="$OUT/Habibi WhatsApp Runtime.app"
  RESOURCES="$COMPONENT/Contents/Resources"
  NODE_DEST="$COMPONENT/Contents/MacOS/node"
else
  COMPONENT="$OUT/whatsapp-runtime"
  RESOURCES="$COMPONENT"
  NODE_DEST="$COMPONENT/node"
  [[ "$OS" == windows ]] && NODE_DEST="$COMPONENT/node.exe"
fi
OPENWA_DEST="$RESOURCES/openwa"
rm -rf "$COMPONENT"
mkdir -p "$(dirname "$NODE_DEST")" "$RESOURCES"

# --- Node -------------------------------------------------------------------
# The official build for this OS/arch, checked against nodejs.org's published
# SHASUMS256 so a truncated or corrupted download never ships.
NODE_NAME="node-v$NODE_VERSION-$NODE_DIST"
NODE_ARCHIVE_NAME="$NODE_NAME.tar.gz"
[[ "$OS" == windows ]] && NODE_ARCHIVE_NAME="$NODE_NAME.zip"
NODE_CACHE="$CACHE/$NODE_NAME"
if [[ ! -d "$NODE_CACHE/$NODE_NAME" ]]; then
  echo "Fetching Node v$NODE_VERSION ($NODE_DIST)…"
  rm -rf "$NODE_CACHE"
  mkdir -p "$NODE_CACHE"
  # Extract only a completed download. A retried stream piped into tar can
  # concatenate partial archives after a transient GitHub runner failure.
  fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE_NAME" "$NODE_CACHE/$NODE_ARCHIVE_NAME"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$NODE_CACHE/SHASUMS256.txt"
  expected="$(awk -v name="$NODE_ARCHIVE_NAME" '$2 == name { print $1 }' "$NODE_CACHE/SHASUMS256.txt")"
  actual="$(sha256 "$NODE_CACHE/$NODE_ARCHIVE_NAME")"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "Node download checksum mismatch" >&2; exit 1; }
  if [[ "$OS" == windows ]]; then
    "$TAR" -xf "$(native_path "$NODE_CACHE/$NODE_ARCHIVE_NAME")" -C "$(native_path "$NODE_CACHE")"
  else
    tar -xzf "$NODE_CACHE/$NODE_ARCHIVE_NAME" -C "$NODE_CACHE"
  fi
  rm -f "$NODE_CACHE/$NODE_ARCHIVE_NAME"
fi
if [[ "$OS" == windows ]]; then
  cp "$NODE_CACHE/$NODE_NAME/node.exe" "$NODE_DEST"
else
  cp "$NODE_CACHE/$NODE_NAME/bin/node" "$NODE_DEST"
  chmod 755 "$NODE_DEST"
fi
cp "$NODE_CACHE/$NODE_NAME/LICENSE" "$RESOURCES/node-LICENSE"

# --- Supervisor ---------------------------------------------------------------
cp "$ROOT/native/openwa-supervisor.js" "$RESOURCES/openwa-supervisor.js"

# --- OpenWA ---------------------------------------------------------------------
# Fetched fresh at build time; nothing about OpenWA's source is checked into
# this repo. Cached by tag so a repeat local build doesn't re-clone; CI starts
# from a clean cache every run.
OPENWA_CACHE="$CACHE/openwa-$OPENWA_VERSION"
if [[ ! -f "$OPENWA_CACHE/package.json" ]]; then
  echo "Fetching OpenWA $OPENWA_VERSION…"
  rm -rf "$OPENWA_CACHE"
  git -c advice.detachedHead=false clone --depth 1 --branch "$OPENWA_VERSION" https://github.com/rmyndharis/OpenWA.git "$OPENWA_CACHE"
fi
OPENWA_STAGE="$STAGE_ROOT/openwa-stage"
mkdir -p "$OPENWA_STAGE"
cp -R "$OPENWA_CACHE"/. "$OPENWA_STAGE/"
# dashboard/ is OpenWA's own standalone web UI; Habibi only calls its HTTP
# API, and removing the directory before install makes postinstall's own
# existence check skip the (otherwise unconditional) nested dashboard build.
rm -rf "$OPENWA_STAGE/.git" "$OPENWA_STAGE/dashboard"

echo "Installing OpenWA…"
# PUPPETEER_SKIP_DOWNLOAD: whatsapp-web.js's own puppeteer dependency would
# otherwise download a second, redundant Chrome into ~/.cache/puppeteer during
# `npm ci`. The Chromium actually shipped is fetched deliberately below and
# pointed at by PUPPETEER_EXECUTABLE_PATH at runtime.
(cd "$OPENWA_STAGE" && PUPPETEER_SKIP_DOWNLOAD=true npm ci --silent)
(cd "$OPENWA_STAGE" && npm run build --silent)
(cd "$OPENWA_STAGE" && npm prune --omit=dev --silent)
rm -rf "$OPENWA_STAGE/node_modules/.bin"

# Native dependencies in OpenWA's tree ship prebuilds for every platform they
# support, in two shapes (better-sqlite3's flat "darwin-arm64.node" files vs.
# bare-fs's "darwin-arm64/bare-fs.bare" directories, via ssh2). Keep only this
# component's platform: on macOS Apple's notary service inspects EVERY binary
# in the archive and rejected the unsigned off-target bare-fs/bare-os/bare-url
# prebuilds as "The binary is not signed"; elsewhere they are dead weight.
find "$OPENWA_STAGE/node_modules" -type d -name prebuilds 2>/dev/null | while IFS= read -r prebuilds; do
  for entry in "$prebuilds"/*; do
    [[ -e "$entry" ]] || continue
    case "$(basename "$entry")" in
      "$PREBUILD" | "$PREBUILD".*) ;;
      *) rm -rf "$entry" ;;
    esac
  done
done

mkdir -p "$OPENWA_DEST"
cp -R "$OPENWA_STAGE/dist" "$OPENWA_STAGE/node_modules" "$OPENWA_STAGE/package.json" "$OPENWA_DEST/"
for license in "$OPENWA_STAGE"/LICENSE*; do
  [[ -f "$license" ]] && cp "$license" "$OPENWA_DEST/"
done
# The runtime executes compiled JavaScript only. Source maps, declarations,
# and incremental TypeScript build caches are build-time artifacts.
find "$OPENWA_DEST" \( -name "*.map" -o -name "*.d.ts" -o -name "*.tsbuildinfo" \) -type f -delete 2>/dev/null || true
[[ -f "$OPENWA_DEST/dist/main.js" ]] || { echo "OpenWA build did not produce dist/main.js" >&2; exit 1; }

# --- Chromium -----------------------------------------------------------------
echo "Fetching Chromium ($PUPPETEER_PLATFORM)…"
CHROME_CACHE="$CACHE/chrome-$PUPPETEER_CHROME_BUILD_ID-$PUPPETEER_PLATFORM"
mkdir -p "$CHROME_CACHE"
# PUPPETEER_CLI_VERSION/PUPPETEER_CHROME_BUILD_ID come from native/versions.sh —
# see that file for how to re-derive them after an OpenWA version bump.
npx --yes "puppeteer@$PUPPETEER_CLI_VERSION" browsers install "chrome@$PUPPETEER_CHROME_BUILD_ID" \
  --path "$(native_path "$CHROME_CACHE")" --platform "$PUPPETEER_PLATFORM"
mkdir -p "$OPENWA_DEST/chrome"
case "$OS" in
  macos)
    CHROME_DIR="$(find "$CHROME_CACHE" -maxdepth 4 -iname "*.app" -print -quit)"
    [[ -n "$CHROME_DIR" ]] || { echo "Chromium download did not produce a .app bundle" >&2; exit 1; }
    # No stable-named symlink here on purpose: one broke Puppeteer's own launch
    # once already — Chromium dlopens its Framework via a relative
    # `../Frameworks/...` walk from the executable path it's given, and that
    # walk resolves against the SYMLINK's directory. Ship the real .app as
    # downloaded; the runtime finds it by globbing chrome/*.app.
    cp -R "$CHROME_DIR" "$OPENWA_DEST/chrome/"
    # Chrome for Testing carries hundreds of locale bundles. The embedded
    # browser automates WhatsApp Web for Habibi's English interface and is
    # never shown as a general UI: keep every English variant and remove only
    # other .lproj directories before signing.
    before="$(find "$OPENWA_DEST/chrome" -type d -name "*.lproj" | wc -l | tr -d ' ')"
    find "$OPENWA_DEST/chrome" -type d -name "*.lproj" ! -name "en*.lproj" -prune -exec rm -rf {} +
    find "$OPENWA_DEST/chrome" -type d -name "en*.lproj" -print -quit | grep -q . \
      || { echo "Chromium locale pruning removed every English locale" >&2; exit 1; }
    after="$(find "$OPENWA_DEST/chrome" -type d -name "*.lproj" | wc -l | tr -d ' ')"
    echo "Pruned Chromium locales ($before -> $after English bundles)."
    ;;
  linux | windows)
    # The runtime expects openwa/chrome/<dir>/chrome(.exe), one level down.
    executable=chrome
    [[ "$OS" == windows ]] && executable=chrome.exe
    CHROME_BIN="$(find "$CHROME_CACHE" -maxdepth 5 -type f -name "$executable" -print -quit)"
    [[ -n "$CHROME_BIN" ]] || { echo "Chromium download did not produce $executable" >&2; exit 1; }
    cp -R "$(dirname "$CHROME_BIN")" "$OPENWA_DEST/chrome/"
    ;;
esac

# --- Package ------------------------------------------------------------------
if [[ "$OS" == macos ]]; then
  # The bundle wrapper exists so macOS can validate, notarize and staple the
  # component as a conventional app; Habibi never launches it.
  cp "$ROOT/native/WhatsAppRuntime-Info.plist" "$COMPONENT/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$COMPONENT/Contents/Info.plist"
  TARGET="arm64-apple-macos13.0"
  [[ "$ARCH" == x64 ]] && TARGET="x86_64-apple-macos13.0"
  mkdir -p "$ROOT/build/swift-module-cache"
  swiftc -O -module-cache-path "$ROOT/build/swift-module-cache" -target "$TARGET" \
    "$ROOT/native/WhatsAppRuntime.swift" -o "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime"
  echo "Staged $COMPONENT ($(du -sh "$COMPONENT" | cut -f1)); sign it with native/package-whatsapp-component.sh"
  exit 0
fi

ARCHIVE="$ROOT/build/Habibi-WhatsApp-$OS-$ARCH-$VERSION.tar.gz"
rm -f "$ARCHIVE"
# One top-level entry, the component directory: the runtime rejects anything
# else before unpacking.
if [[ "$OS" == windows ]]; then
  "$TAR" -czf "$(native_path "$ARCHIVE")" -C "$(native_path "$OUT")" whatsapp-runtime
else
  tar --owner=0 --group=0 --numeric-owner -czf "$ARCHIVE" -C "$OUT" whatsapp-runtime
fi
echo "Built $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
echo "SHA-256 $(sha256 "$ARCHIVE")"
