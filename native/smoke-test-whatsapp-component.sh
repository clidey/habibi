#!/bin/zsh
# Validates and executes the signed wrapper and Chromium from the exact ZIP
# users download, on a matching-architecture GitHub runner.
set -euo pipefail

ARCHIVE="${1:?Usage: smoke-test-whatsapp-component.sh <zip> <arm64|x64>}"
ARCH="${2:?Usage: smoke-test-whatsapp-component.sh <zip> <arm64|x64>}"
EXPECTED="$ARCH"
[[ "$ARCH" == "x64" ]] && EXPECTED="x86_64"
[[ "$ARCH" == "arm64" || "$ARCH" == "x64" ]] || { echo "Unsupported architecture: $ARCH" >&2; exit 1; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT INT TERM
ditto -x -k "$ARCHIVE" "$ROOT"
COMPONENT="$ROOT/Habibi WhatsApp Runtime.app"
[[ -d "$COMPONENT" ]] || { echo "Archive is missing its component app" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$COMPONENT"
[[ "$(lipo -archs "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime")" == "$EXPECTED" ]] \
  || { echo "Component wrapper architecture mismatch" >&2; exit 1; }
"$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime" 2>&1 | grep -q "managed by Habibi"

OPENWA="$COMPONENT/Contents/Resources/openwa"
CHROME_APP="$(find "$OPENWA/chrome" -maxdepth 1 -type d -name '*.app' -print -quit)"
CHROME_EXECUTABLE="$(find "$CHROME_APP/Contents/MacOS" -maxdepth 1 -type f -print -quit)"
[[ -f "$OPENWA/dist/main.js" && -n "$CHROME_EXECUTABLE" ]] || { echo "Component runtime is incomplete" >&2; exit 1; }
[[ "$(lipo -archs "$CHROME_EXECUTABLE")" == "$EXPECTED" ]] || { echo "Chromium architecture mismatch" >&2; exit 1; }
"$CHROME_EXECUTABLE" --version | grep -q "Chrome"
if find "$OPENWA/chrome" -type d -name '*.lproj' ! -name 'en*.lproj' -print -quit | grep -q .; then
  echo "Non-English Chromium locale remained in the component" >&2
  exit 1
fi
find "$OPENWA/chrome" -type d -name 'en*.lproj' -print -quit | grep -q .
echo "WhatsApp component smoke test passed for $ARCH."
