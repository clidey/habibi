#!/bin/zsh
# Exercises the exact app bytes inside a release DMG on a matching-architecture
# GitHub runner.
set -euo pipefail

DMG="${1:?Usage: smoke-test-release.sh <dmg> <arm64|x64>}"
ARCH="${2:?Usage: smoke-test-release.sh <dmg> <arm64|x64>}"
EXPECTED="$ARCH"
[[ "$ARCH" == "x64" ]] && EXPECTED="x86_64"
[[ "$ARCH" == "arm64" || "$ARCH" == "x64" ]] || { echo "Unsupported architecture: $ARCH" >&2; exit 1; }

MOUNT="$(mktemp -d)/Habibi"
STATE="$(mktemp -d)"
LOG="$STATE/service.log"
mkdir -p "$MOUNT"
SERVICE_PID=""
cleanup() {
  if [[ -n "$SERVICE_PID" ]]; then kill "$SERVICE_PID" >/dev/null 2>&1 || true; fi
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rm -rf "${MOUNT:h}" "$STATE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT" -quiet
APP="$MOUNT/Habibi.app"
NODE="$APP/Contents/MacOS/node"
SERVICE="$APP/Contents/Resources/service"
[[ -d "$APP" && -x "$NODE" && -f "$SERVICE/dist/server.js" ]] || { echo "DMG is missing runtime files" >&2; exit 1; }
[[ "$(lipo -archs "$APP/Contents/MacOS/Habibi")" == "$EXPECTED" ]] || { echo "Launcher architecture mismatch" >&2; exit 1; }
[[ "$(lipo -archs "$NODE")" == "$EXPECTED" ]] || { echo "Node architecture mismatch" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$APP"

# Exercise the deliberately pruned node-pty runtime, not merely its signature.
PTY_OUTPUT="$(cd "$SERVICE" && "$NODE" -e '
  const pty = require("node-pty");
  let output = "";
  const child = pty.spawn("/bin/sh", ["-c", "printf habibi-pty-smoke"]);
  child.onData(data => { output += data; });
  child.onExit(() => { process.stdout.write(output); process.exit(output.includes("habibi-pty-smoke") ? 0 : 1); });
  setTimeout(() => process.exit(1), 5000);
')"
[[ "$PTY_OUTPUT" == *habibi-pty-smoke* ]] || { echo "Packaged terminal runtime failed" >&2; exit 1; }

HABIBI_ROOT="$SERVICE" HABIBI_DATA_ROOT="$STATE" "$NODE" "$SERVICE/dist/server.js" >"$LOG" 2>&1 &
SERVICE_PID=$!
ready=0
for _ in {1..80}; do
  if curl -fsS http://127.0.0.1:4173/ >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$SERVICE_PID" >/dev/null 2>&1 || break
  sleep 0.25
done
(( ready )) || { echo "Packaged service did not become ready" >&2; cat "$LOG" >&2; exit 1; }
echo "Release smoke test passed for $ARCH."
