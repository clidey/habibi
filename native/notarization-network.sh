#!/bin/zsh
# GitHub runner workaround: https://github.com/actions/runner-images/issues/14924
# Force HTTPS/TCP by rejecting QUIC only for the signing job. Keep the existing
# PF rules and enable references intact; never replace or disable the firewall.
set -euo pipefail

MODE="${1:?Usage: notarization-network.sh enable|disable}"
[[ "$MODE" == enable || "$MODE" == disable ]] || { echo "Invalid network workaround mode" >&2; exit 1; }
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != macOS ]]; then
  echo "Notarization network workaround is limited to GitHub-hosted macOS runners."
  exit 0
fi

ANCHOR="com.apple/habibi-notarization"
STATE="${RUNNER_TEMP:?RUNNER_TEMP is required}/habibi-notarization-pf-token"
umask 077

if [[ "$MODE" == disable ]]; then
  if [[ ! -f "$STATE" ]]; then echo "No active notarization network workaround."; exit 0; fi
  TOKEN="$(cat "$STATE")"
  [[ "$TOKEN" == <-> || "$TOKEN" == already-enabled ]] || { echo "Invalid PF reference token" >&2; exit 1; }
  sudo -n pfctl -a "$ANCHOR" -F rules
  if [[ "$TOKEN" != already-enabled ]]; then sudo -n pfctl -X "$TOKEN"; fi
  rm -f "$STATE"
  echo "Removed notarization network workaround."
  exit 0
fi

if [[ -f "$STATE" ]]; then echo "Notarization network workaround is already active."; exit 0; fi
RULES="$(sudo -n pfctl -sr)"
if ! print -r -- "$RULES" | grep -E '^[[:space:]]*anchor "com[.]apple/[*]"' >/dev/null; then
  echo "The runner is missing the standard Apple PF anchor; refusing to replace existing firewall rules." >&2
  exit 1
fi
PF_STATUS="$(sudo -n pfctl -si)"
print -r -- 'block return out quick proto udp from any to any port 443' \
  | sudo -n pfctl -a "$ANCHOR" -f -
if print -r -- "$PF_STATUS" | grep -E '^Status:[[:space:]]+Enabled' >/dev/null; then
  print -r -- already-enabled > "$STATE"
  echo "Notarization will use HTTPS/TCP; keeping the existing PF enable state."
  exit 0
fi
if ! PF_OUTPUT="$(sudo -n pfctl -E 2>&1)"; then
  sudo -n pfctl -a "$ANCHOR" -F rules
  print -r -- "$PF_OUTPUT" >&2
  exit 1
fi
TOKEN="$(print -r -- "$PF_OUTPUT" | awk '/Token[[:space:]]*:/ {print $3; exit}')"
if [[ "$TOKEN" != <-> ]]; then
  sudo -n pfctl -a "$ANCHOR" -F rules
  echo "Could not obtain a PF enable-reference token." >&2
  exit 1
fi
print -r -- "$TOKEN" > "$STATE"
echo "Notarization will use HTTPS/TCP instead of the affected HTTP/3 path."
