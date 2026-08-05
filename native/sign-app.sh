#!/bin/zsh
# Signs, notarizes and packages the built app for Developer ID distribution.
#
# Runs both locally and in CI. Expects an already-built build/Habibi.app.
#
#   APPLE_DEVELOPER_ID_APPLICATION  "Developer ID Application: … (TEAMID)"
#   APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID   notarization credentials
#
# Set SKIP_NOTARIZE=1 to sign and package without submitting to Apple, which is
# useful for checking the signature locally without burning a notarization slot.
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Habibi.app"
ENTITLEMENTS="$ROOT/native/entitlements.plist"
VERSION="${VERSION:-$(node -p "require('$ROOT/package.json').version")}"
DMG="$ROOT/build/Habibi-$VERSION.dmg"

[[ -d "$APP" ]] || { echo "No app bundle at $APP. Run native/build-app.sh first." >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "Missing $ENTITLEMENTS" >&2; exit 1; }
: "${APPLE_DEVELOPER_ID_APPLICATION:?Set APPLE_DEVELOPER_ID_APPLICATION to the signing identity}"

echo "Signing $APP as $APPLE_DEVELOPER_ID_APPLICATION"

# Nested code must be signed before the bundle that contains it, so the outer
# signature covers the final bytes of everything inside. `--deep` is not used:
# Apple discourages it because it signs in an unpredictable order and applies the
# app's entitlements to nested binaries that should not receive them.
#
# `.node`/`.dylib`/`.so` are loaded into the process that opens them (dlopen),
# so they correctly inherit hardened runtime from it and get no entitlements of
# their own. `spawn-helper` is not loaded code: node-pty fork/execs it as its
# OWN process, so notarization requires it to carry --options runtime itself —
# confirmed by Apple's actual rejection ("does not have the hardened runtime
# enabled") the first time this shipped without it.
sign_nested() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "$1"
}

sign_nested_executable() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$1"
}

# `node` is a full interpreter, so it needs the same JIT and library-validation
# entitlements as the app or V8 cannot allocate executable memory.
echo "  node"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
  --entitlements "$ENTITLEMENTS" --options runtime --timestamp \
  "$APP/Contents/MacOS/node"

while IFS= read -r -d '' binary; do
  echo "  ${binary#$APP/}"
  sign_nested "$binary"
done < <(find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -print0 2>/dev/null)

while IFS= read -r -d '' binary; do
  echo "  ${binary#$APP/}"
  sign_nested_executable "$binary"
done < <(find "$APP" -type f -name "spawn-helper" -print0 2>/dev/null)

echo "  Habibi (main executable)"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
  --entitlements "$ENTITLEMENTS" --options runtime --timestamp \
  "$APP/Contents/MacOS/Habibi"

echo "  Habibi.app (bundle)"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
  --entitlements "$ENTITLEMENTS" --options runtime --timestamp \
  "$APP"

echo "Verifying signature…"
codesign --verify --strict --verbose=2 "$APP"

# Catches unsigned nested code that `codesign --verify` alone can miss, which is
# the most common reason notarization fails after a clean local sign.
echo "Checking for unsigned nested code…"
find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "spawn-helper" -o -name "node" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      codesign --verify "$binary" 2>/dev/null || { echo "UNSIGNED: ${binary#$APP/}" >&2; exit 1; }
    done

# Every standalone executable Apple's notary service inspects independently
# (node and spawn-helper — anything that gets exec'd as its own process, not
# just dlopen'd) must carry the hardened runtime flag itself. Missing it here
# is exactly what notarization rejected last time ("does not have the hardened
# runtime enabled"); check locally so that failure surfaces before a submission
# is spent on it.
echo "Checking hardened runtime on standalone executables…"
find "$APP" -type f \( -name "spawn-helper" -o -name "node" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      # `grep -q` on a large codesign dump (node's universal binary output runs
      # to hundreds of KB) exits before draining the pipe, so codesign gets
      # SIGPIPE and pipefail reports that instead of grep's real result.
      # Capturing to a variable first avoids the pipe entirely.
      info="$(codesign -d --verbose=4 "$binary" 2>&1)"
      echo "$info" | grep -q "flags=.*runtime" \
        || { echo "NO HARDENED RUNTIME: ${binary#$APP/}" >&2; exit 1; }
    done

rm -f "$DMG"
echo "Building $DMG"
hdiutil create -volname "Habibi" -srcfolder "$APP" -ov -format UDZO -quiet "$DMG"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "$DMG"

if [[ "${SKIP_NOTARIZE:-}" == "1" ]]; then
  echo "SKIP_NOTARIZE=1 — signed but not submitted."
  echo "Built $DMG"
  exit 0
fi

: "${APPLE_ID:?Set APPLE_ID for notarization}"
: "${APPLE_APP_PASSWORD:?Set APPLE_APP_PASSWORD for notarization}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID for notarization}"

# Submit against a stored keychain profile rather than passing the app-specific
# password to `notarytool submit`: argv is readable by any process on the machine
# via `ps` for the lifetime of the call.
#
# The profile lives in a throwaway keychain so it can be removed afterwards —
# notarytool has no delete-credentials subcommand, so deleting the keychain file
# is the only way to clean up.
NOTARY_PROFILE="habibi-notarize"
NOTARY_KEYCHAIN="$(mktemp -d)/notary.keychain-db"
NOTARY_KEYCHAIN_PW="$(uuidgen)"
notary_cleanup() {
  security delete-keychain "$NOTARY_KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "${NOTARY_KEYCHAIN:h}" >/dev/null 2>&1 || true
}
trap notary_cleanup EXIT INT TERM

security create-keychain -p "$NOTARY_KEYCHAIN_PW" "$NOTARY_KEYCHAIN"
security unlock-keychain -p "$NOTARY_KEYCHAIN_PW" "$NOTARY_KEYCHAIN"
security set-keychain-settings -lut 21600 "$NOTARY_KEYCHAIN"

xcrun notarytool store-credentials "$NOTARY_PROFILE" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" \
  --keychain "$NOTARY_KEYCHAIN" >/dev/null

echo "Submitting for notarization…"
NOTARY_OUTPUT="$(mktemp)"
if ! xcrun notarytool submit "$DMG" \
  --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" --wait | tee "$NOTARY_OUTPUT"; then
  echo "notarytool submit failed; see the log fetch below for Apple's actual rejection reason." >&2
fi

# `--wait` reports a final status but not *why* — Invalid/Rejected need the
# notary log to say which check failed (unsigned nested code, missing hardened
# runtime entitlement, disallowed entitlement, etc). Fetch it whenever the
# outcome isn't a clean Accepted, so the real reason lands in this job's log
# instead of requiring a second manual `notarytool log` afterward.
SUBMISSION_ID="$(grep -m1 '^\s*id:' "$NOTARY_OUTPUT" | awk '{print $2}')"
if ! grep -q "status: Accepted" "$NOTARY_OUTPUT"; then
  echo "Notarization did not report Accepted. Fetching the notary log…" >&2
  if [[ -n "$SUBMISSION_ID" ]]; then
    xcrun notarytool log "$SUBMISSION_ID" \
      --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" || true
  fi
  rm -f "$NOTARY_OUTPUT"
  exit 1
fi
rm -f "$NOTARY_OUTPUT"

# The ticket can lag availability briefly, so retry rather than failing a release
# that Apple has already approved.
echo "Stapling…"
attempt=1
until xcrun stapler staple "$DMG"; do
  (( attempt >= 5 )) && { echo "Could not staple after $attempt attempts." >&2; exit 1; }
  sleep $(( attempt * 30 ))
  attempt=$(( attempt + 1 ))
done

echo "Verifying Gatekeeper acceptance…"
spctl -a -t open --context context:primary-signature -vv "$DMG"

echo "Built and notarized $DMG"
