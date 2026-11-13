#!/bin/zsh
# Checks the exact app bytes inside the notarized release DMG.
#
#   smoke-test-release.sh <dmg> <version>
set -euo pipefail

DMG="${1:?Usage: smoke-test-release.sh <dmg> <version>}"
VERSION="${2:?Usage: smoke-test-release.sh <dmg> <version>}"

MOUNT="$(mktemp -d)/Habibi"
mkdir -p "$MOUNT"
cleanup() {
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rm -rf "${MOUNT:h}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

xcrun stapler validate "$DMG"
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT" -quiet
APP="$MOUNT/Habibi.app"
BINARY="$APP/Contents/MacOS/Habibi"
[[ -d "$APP" && -x "$BINARY" ]] || { echo "DMG is missing Habibi.app" >&2; exit 1; }
[[ -L "$MOUNT/Applications" ]] || { echo "DMG is missing its /Applications link" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$APP"

# One universal download serves both architectures.
archs="$(lipo -archs "$BINARY")"
[[ "$archs" == *arm64* && "$archs" == *x86_64* ]] || { echo "Habibi is not universal ($archs)" >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" == "$VERSION" ]] \
  || { echo "App version does not match $VERSION" >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$APP/Contents/Info.plist")" == true ]] \
  || { echo "Habibi must stay a menu-bar (LSUIElement) app" >&2; exit 1; }
# The UI is served from bundled resources, and Node stays out of the app.
[[ -f "$APP/Contents/Resources/index.html" ]] || { echo "Bundled UI is missing" >&2; exit 1; }
if find "$APP" \( -name node -o -name '*.node' -o -name node_modules -o -name 'openwa-supervisor.js' -o -path '*/openwa/dist' \) -print -quit | grep -q .; then
  echo "The app bundle contains Node or OpenWA" >&2
  exit 1
fi
echo "Release DMG smoke test passed for $VERSION."
