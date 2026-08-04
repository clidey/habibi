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
# Only the main executable and the bundle get --options runtime. The hardened
# runtime is a process-level property inherited by loaded code; applying it to a
# helper binary would additionally demand its own entitlements.
sign_nested() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "$1"
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
done < <(find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "spawn-helper" \) -print0 2>/dev/null)

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
xcrun notarytool submit "$DMG" \
  --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" --wait

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
