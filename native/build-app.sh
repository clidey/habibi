#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Habibi.app"
CONTENTS="$APP/Contents"
SERVICE="$CONTENTS/Resources/service"
# Outside the repo entirely, not just outside node_modules: pnpm-workspace.yaml
# makes any directory under $ROOT with its own package.json an implicit
# workspace member. Staging under $ROOT/build/stage put it inside that
# workspace, and because `packages: []` doesn't list it, pnpm silently pruned
# dependencies from the *root* install instead of giving the stage its own
# tree — deleting node_modules/.bin and breaking every subsequent build step.
STAGE="$(mktemp -d)/habibi-stage"

source "$ROOT/native/versions.sh"

if [[ -n "${HABIBI_APP_ARCH:-}" && "$HABIBI_APP_ARCH" != "arm64" && "$HABIBI_APP_ARCH" != "x64" ]]; then
  echo "HABIBI_APP_ARCH must be arm64 or x64 (got '$HABIBI_APP_ARCH')" >&2
  exit 1
fi

# Chromium makes the staged WhatsApp runtime architecture-specific, so
# component builds should not also carry the unused half of Node or node-pty.
# Release app builds set HABIBI_APP_ARCH to omit the other half of Node and
# node-pty; a plain local no-OpenWA build remains universal for convenience.
if [[ "${HABIBI_SKIP_OPENWA:-}" == "1" ]]; then
  case "${HABIBI_APP_ARCH:-universal}" in
    arm64) NODE_ARCHES=(arm64); SERVICE_PREBUILD_ARCHES=(darwin-arm64) ;;
    x64) NODE_ARCHES=(x64); SERVICE_PREBUILD_ARCHES=(darwin-x64) ;;
    universal) NODE_ARCHES=(arm64 x64); SERVICE_PREBUILD_ARCHES=(darwin-arm64 darwin-x64) ;;
  esac
else
  : "${HABIBI_OPENWA_ARCH:?Set HABIBI_OPENWA_ARCH=arm64 or x64 (the Chromium/OpenWA target architecture for this DMG), or HABIBI_SKIP_OPENWA=1 to build without WhatsApp bundling.}"
  case "$HABIBI_OPENWA_ARCH" in
    arm64)
      NODE_ARCHES=(arm64)
      SERVICE_PREBUILD_ARCHES=(darwin-arm64)
      PUPPETEER_PLATFORM="mac_arm"
      OPENWA_PREBUILD_ARCH="darwin-arm64"
      ;;
    x64)
      NODE_ARCHES=(x64)
      SERVICE_PREBUILD_ARCHES=(darwin-x64)
      PUPPETEER_PLATFORM="mac"
      OPENWA_PREBUILD_ARCH="darwin-x64"
      ;;
    *) echo "HABIBI_OPENWA_ARCH must be arm64 or x64 (got '$HABIBI_OPENWA_ARCH')" >&2; exit 1 ;;
  esac
fi

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
node scripts/build-icns.mjs "$ICONSET" "$CONTENTS/Resources/Habibi.icns"
rm -rf "$ICONSET"
FRAMEWORKS=(-framework AppKit -framework WebKit -framework Carbon -framework EventKit)
SWIFT_MODULE_CACHE="$ROOT/build/swift-module-cache"
mkdir -p "$SWIFT_MODULE_CACHE"
if [[ -n "${HABIBI_APP_ARCH:-}" ]]; then
  SWIFT_TARGET="arm64-apple-macos13.0"
  [[ "$HABIBI_APP_ARCH" == "x64" ]] && SWIFT_TARGET="x86_64-apple-macos13.0"
  swiftc -O -module-cache-path "$SWIFT_MODULE_CACHE" -target "$SWIFT_TARGET" native/HabibiApp.swift -o "$CONTENTS/MacOS/Habibi" "${FRAMEWORKS[@]}"
else
  # Universal by default for local development; release jobs set an explicit
  # architecture because Node accounts for nearly the entire app size.
  swiftc -O -module-cache-path "$SWIFT_MODULE_CACHE" -target arm64-apple-macos13.0 native/HabibiApp.swift -o "$ROOT/build/Habibi-arm64" "${FRAMEWORKS[@]}"
  swiftc -O -module-cache-path "$SWIFT_MODULE_CACHE" -target x86_64-apple-macos13.0 native/HabibiApp.swift -o "$ROOT/build/Habibi-x86_64" "${FRAMEWORKS[@]}"
  lipo -create "$ROOT/build/Habibi-arm64" "$ROOT/build/Habibi-x86_64" -output "$CONTENTS/MacOS/Habibi"
  rm -f "$ROOT/build/Habibi-arm64" "$ROOT/build/Habibi-x86_64"
fi

# The bundled interpreter runs the local service. nodejs.org publishes only
# per-architecture macOS builds, so fetch both and lipo them together rather than
# shipping whichever `node` happens to be on the build machine's PATH.
NODE_VERSION="${HABIBI_NODE_VERSION:-$NODE_VERSION}"
NODE_CACHE="$ROOT/build/node-cache/$NODE_VERSION"
if [[ -n "${HABIBI_NODE_BIN:-}" ]]; then
  cp "$HABIBI_NODE_BIN" "$CONTENTS/MacOS/node"
else
  mkdir -p "$NODE_CACHE"
  for arch in "${NODE_ARCHES[@]}"; do
    if [[ ! -f "$NODE_CACHE/node-$arch" ]]; then
      echo "Fetching node v$NODE_VERSION ($arch)…"
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.gz" \
        | tar xz -C "$NODE_CACHE" "node-v$NODE_VERSION-darwin-$arch/bin/node"
      mv "$NODE_CACHE/node-v$NODE_VERSION-darwin-$arch/bin/node" "$NODE_CACHE/node-$arch"
      rm -rf "$NODE_CACHE/node-v$NODE_VERSION-darwin-$arch"
    fi
  done
  if (( ${#NODE_ARCHES[@]} == 1 )); then
    cp "$NODE_CACHE/node-${NODE_ARCHES[1]}" "$CONTENTS/MacOS/node"
  else
    lipo -create "$NODE_CACHE/node-arm64" "$NODE_CACHE/node-x64" -output "$CONTENTS/MacOS/node"
  fi
fi
chmod +x "$CONTENTS/MacOS/node"
echo "Bundled node $("$CONTENTS/MacOS/node" --version) ($(lipo -archs "$CONTENTS/MacOS/node"))"

# Production dependencies only. Dev tooling (TypeScript, esbuild, jsdom) is a
# build-time concern, and every Mach-O binary shipped has to be code-signed for
# notarization — so anything unused is both dead weight and signing surface.
mkdir -p "$STAGE"
cp package.json pnpm-lock.yaml "$STAGE/"
# The staging directory must carry the checked-in supply-chain policy, but must
# not be treated as a child of the development workspace: a production install
# there must never prune the root's TypeScript and client build tooling.
[[ -f pnpm-workspace.yaml ]] && cp pnpm-workspace.yaml "$STAGE/"
(cd "$STAGE" && pnpm --ignore-workspace install --prod --ignore-scripts --silent)

# node-pty ships prebuilt binaries for every platform it supports and resolves
# `prebuilds/<platform>-<arch>` at runtime (see its lib/utils.js). Keep both
# Darwin directories for the universal no-OpenWA app, but only the matching one
# for architecture-specific WhatsApp builds. Other platforms can never load,
# and every Mach-O left in the bundle has to be signed for notarization to pass.
find "$STAGE/node_modules" -type d -name prebuilds 2>/dev/null | while read -r prebuilds; do
  for dir in "$prebuilds"/*(N/); do
    keep=0
    for allowed in "${SERVICE_PREBUILD_ARCHES[@]}"; do
      [[ "${dir:t}" == "$allowed" ]] && keep=1
    done
    (( keep )) || rm -rf "$dir"
  done
done

# `.bin` holds shims for CLIs the running service never invokes.
rm -rf "$STAGE/node_modules/.bin" "$STAGE/node_modules/.pnpm/node_modules/.bin"

# node-pty forks through a helper binary. Installing with --ignore-scripts (this
# build, and any machine with ignore-scripts in its npm config) leaves it
# non-executable, and the terminal then fails with "posix_spawnp failed".
find "$STAGE/node_modules" -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true
PTY_HELPER="$(find -L "$STAGE/node_modules/node-pty" -name spawn-helper -type f -print -quit 2>/dev/null)"
[[ -n "$PTY_HELPER" && -x "$PTY_HELPER" ]] || { echo "node-pty spawn-helper is missing or not executable; the terminal would fail at runtime." >&2; exit 1; }

# server.bundle.js contains every JavaScript dependency. Keep only node-pty,
# whose native binary cannot be bundled, and dereference pnpm's package symlink
# so the runtime tree is independent of the discarded virtual store.
mkdir -p "$SERVICE/node_modules/node-pty"
cp -RL "$STAGE/node_modules/node-pty"/. "$SERVICE/node_modules/node-pty/"

# Bundling removes package directories, but not the obligation to distribute
# their license texts. Preserve every production package license under a unique
# path; this is deliberately over-inclusive when esbuild tree-shakes a package.
LICENSES="$SERVICE/third-party-licenses"
mkdir -p "$LICENSES"
find "$STAGE/node_modules/.pnpm" -type f \( -iname "LICENSE" -o -iname "LICENSE.*" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' license; do
      relative="${license#$STAGE/node_modules/.pnpm/}"
      cp "$license" "$LICENSES/${relative//\//__}"
    done
rm -rf "$STAGE"

# The service needs the bundled server, client bundle, static assets, skill
# manifests and its manifest. The TypeScript output tree and unbundled client
# sources are build inputs and are deliberately excluded.
mkdir -p "$SERVICE/dist"
cp dist/server.bundle.js "$SERVICE/dist/server.js"
for item in assets index.html app.css skills package.json; do
  cp -R "$item" "$SERVICE/"
done

# Source maps and declarations only exist to support development — shipping
# them hands a reader the original sources and internal paths for no benefit.
find "$SERVICE" \( -name "*.map" -o -name "*.d.ts" \) -type f -delete 2>/dev/null || true

# Bundled WhatsApp gateway (OpenWA, fetched below — see native/versions.sh for
# its pinned version) + the real Chromium it drives, so the end user never sets
# up OpenWA themselves. Chrome for Testing has no lipo'd
# universal build, so this half of the bundle is architecture-specific — CI
# packages one component per architecture. HABIBI_SKIP_OPENWA=1 gives a fast
# local-dev path with no WhatsApp gateway at all; otherwise the caller must say which
# architecture this build targets. A silent default here would quietly ship
# the wrong Chromium onto the other architecture's DMG.
if [[ "${HABIBI_SKIP_OPENWA:-}" == "1" ]]; then
  echo "HABIBI_SKIP_OPENWA=1 — skipping WhatsApp gateway bundling."
else
  # Fetched fresh at build time, the same way node and Chromium are below —
  # nothing about OpenWA's source is checked into this repo. Cached by tag so a
  # repeat local build doesn't re-clone; CI starts from a clean cache every run.
  OPENWA_CACHE="$ROOT/build/openwa-cache/$OPENWA_VERSION"
  if [[ ! -f "$OPENWA_CACHE/package.json" ]]; then
    echo "Fetching OpenWA $OPENWA_VERSION…"
    rm -rf "$OPENWA_CACHE"
    mkdir -p "$OPENWA_CACHE"
    git clone --depth 1 --branch "$OPENWA_VERSION" https://github.com/rmyndharis/OpenWA.git "$OPENWA_CACHE"
  fi
  # Outside $ROOT for the same reason habibi's own $STAGE is: OpenWA has its own
  # package.json, so staging it under $ROOT would make it an implicit
  # pnpm-workspace.yaml member and corrupt the root install.
  OPENWA_STAGE="$(mktemp -d)/openwa-stage"
  OPENWA_DEST="$CONTENTS/Resources/openwa"

  echo "Staging OpenWA…"
  mkdir -p "$OPENWA_STAGE"
  cp -R "$OPENWA_CACHE"/. "$OPENWA_STAGE/"
  # dashboard/ is OpenWA's own standalone web UI; Habibi only calls its HTTP
  # API, and removing the directory before install makes postinstall's own
  # existence check skip the (otherwise unconditional) nested dashboard build.
  rm -rf "$OPENWA_STAGE/.git" "$OPENWA_STAGE/dashboard"

  # PUPPETEER_SKIP_DOWNLOAD: whatsapp-web.js's own puppeteer dependency would
  # otherwise download a second, redundant Chrome into ~/.cache/puppeteer on
  # the build machine during `npm ci` — wasted bandwidth, since the Chromium
  # actually shipped is fetched deliberately below via `puppeteer browsers
  # install`, pointed at by PUPPETEER_EXECUTABLE_PATH at runtime.
  (cd "$OPENWA_STAGE" && PUPPETEER_SKIP_DOWNLOAD=true npm ci --silent)
  (cd "$OPENWA_STAGE" && npm run build --silent)
  (cd "$OPENWA_STAGE" && npm prune --omit=dev --silent)
  rm -rf "$OPENWA_STAGE/node_modules/.bin"

  # Every native dependency in OpenWA's tree ships prebuilds for every platform
  # it supports — not just better-sqlite3: transitive deps like bare-fs/bare-os/
  # bare-url (pulled in via ssh2) carry win32/linux/android/ios-simulator
  # binaries too, in two different shapes (better-sqlite3's flat
  # "darwin-arm64.node" files vs. bare-fs's "darwin-arm64/bare-fs.bare"
  # directories). Missing this the first time round left every off-target
  # platform's binary in the bundle — harmless for one DMG's own architecture,
  # but Apple's notary service inspects EVERY binary in the archive regardless
  # of whether Habibi would ever load it, and rejected the unsigned x86_64/ios
  # bare-fs/bare-os/bare-url prebuilds as "The binary is not signed" even
  # though this is an arm64 build. Each DMG only ever runs on the one
  # architecture it targets, so prune every prebuild whose name doesn't start
  # with that architecture, whatever shape it takes.
  find "$OPENWA_STAGE/node_modules" -type d -name prebuilds 2>/dev/null | while read -r prebuilds; do
    for entry in "$prebuilds"/*(N); do
      case "$(basename "$entry")" in
        "$OPENWA_PREBUILD_ARCH"|"$OPENWA_PREBUILD_ARCH".*) ;;
        *) rm -rf "$entry" ;;
      esac
    done
  done

  mkdir -p "$OPENWA_DEST"
  cp -R "$OPENWA_STAGE/dist" "$OPENWA_DEST/"
  cp -R "$OPENWA_STAGE/node_modules" "$OPENWA_DEST/"
  cp "$OPENWA_STAGE/package.json" "$OPENWA_DEST/"
  rm -rf "$OPENWA_STAGE"
  find "$OPENWA_DEST" \( -name "*.map" -o -name "*.d.ts" \) -type f -delete 2>/dev/null || true

  echo "Fetching Chromium ($HABIBI_OPENWA_ARCH)…"
  CHROME_CACHE="$ROOT/build/chrome-cache/$PUPPETEER_CHROME_BUILD_ID-$HABIBI_OPENWA_ARCH"
  mkdir -p "$CHROME_CACHE"
  # PUPPETEER_CLI_VERSION/PUPPETEER_CHROME_BUILD_ID come from native/versions.sh —
  # see that file for how to re-derive them after an OpenWA version bump.
  npx --yes "puppeteer@$PUPPETEER_CLI_VERSION" browsers install "chrome@$PUPPETEER_CHROME_BUILD_ID" \
    --path "$CHROME_CACHE" --platform "$PUPPETEER_PLATFORM"
  CHROME_APP_DIR="$(find "$CHROME_CACHE" -iname "*.app" -maxdepth 4 -print -quit)"
  [[ -n "$CHROME_APP_DIR" ]] || { echo "Chromium download did not produce a .app bundle" >&2; exit 1; }
  mkdir -p "$OPENWA_DEST/chrome"
  # No stable-named symlink here on purpose: one broke Puppeteer's own launch
  # once already — it dlopen's its Framework via a relative `../Frameworks/...`
  # walk from the executable path it's given, and that walk resolves against
  # the SYMLINK's directory, not the real bundle's Contents/MacOS/. Ship the
  # real .app as downloaded; HabibiApp.swift finds it at launch by globbing
  # chrome/*.app instead of depending on a fixed name here.
  cp -R "$CHROME_APP_DIR" "$OPENWA_DEST/chrome/"

  # Chrome for Testing carries hundreds of locale and grammatical-gender bundles. The
  # embedded browser is never exposed as a general UI: it automates WhatsApp
  # Web for Habibi's English interface. Retain every English variant and remove
  # only other .lproj directories before signing. Shared .pak resources and all
  # executable/framework content remain untouched.
  CHROME_LOCALES_BEFORE="$(find "$OPENWA_DEST/chrome" -type d -name "*.lproj" | wc -l | tr -d ' ')"
  find "$OPENWA_DEST/chrome" -type d -name "*.lproj" ! -name "en*.lproj" -prune -exec rm -rf {} +
  find "$OPENWA_DEST/chrome" -type d -name "en*.lproj" -print -quit | grep -q . \
    || { echo "Chromium locale pruning removed every English locale" >&2; exit 1; }
  CHROME_LOCALES_AFTER="$(find "$OPENWA_DEST/chrome" -type d -name "*.lproj" | wc -l | tr -d ' ')"
  echo "Pruned Chromium locales ($CHROME_LOCALES_BEFORE -> $CHROME_LOCALES_AFTER English bundles)."

  echo "Bundled OpenWA ($(du -sh "$OPENWA_DEST" | cut -f1))"
fi

# Local builds need the same privacy/JIT entitlements as the distributed app.
# Sign nested native code first: lipo invalidates Node's original per-slice
# signatures, and signing only the outer bundle leaves an app that assembles but
# fails strict validation (and can fail when macOS launches the child process).
while IFS= read -r -d '' binary; do
  codesign --force --sign - "$binary"
done < <(find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "*.bare" \) -not -path "*/openwa/chrome/*" -print0 2>/dev/null)
while IFS= read -r -d '' binary; do
  codesign --force --sign - --options runtime "$binary"
done < <(find "$APP" -type f -name "spawn-helper" -print0 2>/dev/null)
codesign --force --sign - --entitlements "$ROOT/native/entitlements.plist" --options runtime "$CONTENTS/MacOS/node"
codesign --force --sign - --entitlements "$ROOT/native/entitlements.plist" --options runtime "$CONTENTS/MacOS/Habibi"
codesign --force --sign - --entitlements "$ROOT/native/entitlements.plist" --options runtime "$APP"
codesign --verify --deep --strict "$APP"

echo "Built $APP ($(du -sh "$APP" | cut -f1))"
