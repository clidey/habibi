#!/usr/bin/env bash
# Unpacks the exact WhatsApp component archive users download and runs its
# Node, supervisor and Chromium on matching-architecture hardware.
#
#   smoke-test-whatsapp-component.sh <archive> <arm64|x64>
#
# macOS: the notarized .zip (signature, stapled ticket and Gatekeeper are
# checked too). Windows/Linux: the .tar.gz, unpacked with the same system tar
# Habibi uses.
set -euo pipefail

ARCHIVE="${1:?Usage: smoke-test-whatsapp-component.sh <archive> <arm64|x64>}"
ARCH="${2:?Usage: smoke-test-whatsapp-component.sh <archive> <arm64|x64>}"
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || { echo "Unsupported architecture: $ARCH" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=native/versions.sh
source "$ROOT/native/versions.sh"
case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows ;;
  *) echo "Unsupported OS" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

case "$OS" in
  macos)
    ditto -x -k "$ARCHIVE" "$WORK"
    COMPONENT="$WORK/Habibi WhatsApp Runtime.app"
    [[ -d "$COMPONENT" ]] || { echo "Archive is missing its component app" >&2; exit 1; }
    codesign --verify --deep --strict --verbose=2 "$COMPONENT"
    xcrun stapler validate "$COMPONENT"
    spctl -a -t exec -vv "$COMPONENT"
    RESOURCES="$COMPONENT/Contents/Resources"
    NODE="$COMPONENT/Contents/MacOS/node"
    EXPECTED="$ARCH"
    [[ "$ARCH" == x64 ]] && EXPECTED=x86_64
    [[ "$(lipo -archs "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime")" == "$EXPECTED" ]] \
      || { echo "Component wrapper architecture mismatch" >&2; exit 1; }
    [[ "$(lipo -archs "$NODE")" == "$EXPECTED" ]] || { echo "Node architecture mismatch" >&2; exit 1; }
    "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime" 2>&1 | grep -q "managed by Habibi"
    CHROME_APP="$(find "$RESOURCES/openwa/chrome" -maxdepth 1 -type d -name '*.app' -print -quit)"
    CHROME="$(find "$CHROME_APP/Contents/MacOS" -maxdepth 1 -type f -print -quit)"
    [[ -n "$CHROME" && "$(lipo -archs "$CHROME")" == "$EXPECTED" ]] || { echo "Chromium is missing or has the wrong architecture" >&2; exit 1; }
    if find "$RESOURCES/openwa/chrome" -type d -name '*.lproj' ! -name 'en*.lproj' -print -quit | grep -q .; then
      echo "Non-English Chromium locale remained in the component" >&2
      exit 1
    fi
    find "$RESOURCES/openwa/chrome" -type d -name 'en*.lproj' -print -quit | grep -q .
    ;;
  linux | windows)
    [[ "$ARCH" == x64 ]] || { echo "Only x64 components exist for $OS" >&2; exit 1; }
    if [[ "$OS" == windows ]]; then
      TAR="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/tar.exe"
      "$TAR" -xzf "$(cygpath -w "$ARCHIVE")" -C "$(cygpath -w "$WORK")"
    else
      tar -xzf "$ARCHIVE" -C "$WORK"
    fi
    # Exactly one top-level entry, as the runtime requires.
    [[ "$(find "$WORK" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == 1 ]] \
      || { echo "The archive has entries outside whatsapp-runtime/" >&2; exit 1; }
    COMPONENT="$WORK/whatsapp-runtime"
    RESOURCES="$COMPONENT"
    NODE="$COMPONENT/node"
    CHROME="$(find "$COMPONENT/openwa/chrome" -mindepth 2 -maxdepth 2 -type f -name chrome -print -quit)"
    if [[ "$OS" == windows ]]; then
      NODE="$COMPONENT/node.exe"
      CHROME="$(find "$COMPONENT/openwa/chrome" -mindepth 2 -maxdepth 2 -type f -name chrome.exe -print -quit)"
    fi
    [[ -n "$CHROME" && -x "$CHROME" ]] || { echo "Chromium is missing from openwa/chrome/<dir>/" >&2; exit 1; }
    ;;
esac

[[ -x "$NODE" ]] || { echo "Node is missing from the component" >&2; exit 1; }
[[ -f "$RESOURCES/openwa-supervisor.js" && -f "$RESOURCES/openwa/dist/main.js" ]] \
  || { echo "Component runtime is incomplete" >&2; exit 1; }

# The shipped Node runs (on macOS under the hardened runtime, which needs the
# component's JIT entitlements) and is the pinned version and architecture.
[[ "$("$NODE" --version)" == "v$NODE_VERSION" ]] || { echo "Unexpected Node version" >&2; exit 1; }
[[ "$("$NODE" -e 'process.stdout.write(process.arch + ":" + String([1, 2, 3].map((n) => n * 2)))')" == "$ARCH:2,4,6" ]] \
  || { echo "The bundled Node did not run JavaScript for $ARCH" >&2; exit 1; }

# OpenWA's native SQLite module was built for this exact Node.
if [[ -d "$RESOURCES/openwa/node_modules/better-sqlite3" ]]; then
  (cd "$RESOURCES/openwa" && "$NODE" -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()") \
    || { echo "OpenWA's native SQLite module does not load in the bundled Node" >&2; exit 1; }
fi

# The supervisor refuses to run without its live Habibi parent.
if output="$("$NODE" "$RESOURCES/openwa-supervisor.js" "$RESOURCES/openwa/dist/main.js" 2>&1)"; then
  echo "The supervisor started without a Habibi parent" >&2
  exit 1
fi
[[ "$output" == *"requires its live Habibi parent"* ]] || { echo "Unexpected supervisor output: $output" >&2; exit 1; }

# Chrome for Testing prints its version on macOS and Linux; on Windows
# chrome.exe --version writes nothing to the console, so presence suffices.
if [[ "$OS" != windows ]]; then
  "$CHROME" --version | grep -q "Chrome"
fi
echo "WhatsApp component smoke test passed for $OS-$ARCH."
