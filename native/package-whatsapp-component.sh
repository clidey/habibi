#!/bin/zsh
# Packages the already-signed OpenWA/Chromium tree from Habibi.app as a
# separately signed and notarized on-demand component.
set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Habibi.app"
OPENWA="$APP/Contents/Resources/openwa"
VERSION="${VERSION:-$(node -p "require('$ROOT/package.json').version")}"
ARCH="${HABIBI_OPENWA_ARCH:?Set HABIBI_OPENWA_ARCH=arm64 or x64}"
IDENTIFIER="com.clidey.habibi.whatsapp-runtime"
COMPONENT_NAME="Habibi WhatsApp Runtime.app"
COMPONENT="$ROOT/build/$COMPONENT_NAME"
ARCHIVE="$ROOT/build/Habibi-WhatsApp-$ARCH-$VERSION.zip"

: "${APPLE_DEVELOPER_ID_APPLICATION:?Set APPLE_DEVELOPER_ID_APPLICATION to the signing identity}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to the signing team identifier}"
[[ -d "$OPENWA" ]] || { echo "Missing signed OpenWA tree at $OPENWA" >&2; exit 1; }
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || { echo "HABIBI_OPENWA_ARCH must be arm64 or x64" >&2; exit 1; }

rm -rf "$COMPONENT"
mkdir -p "$COMPONENT/Contents/MacOS" "$COMPONENT/Contents/Resources"
cp "$ROOT/native/WhatsAppRuntime-Info.plist" "$COMPONENT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$COMPONENT/Contents/Info.plist"
cp -R "$OPENWA" "$COMPONENT/Contents/Resources/openwa"

TARGET="arm64-apple-macos13.0"
[[ "$ARCH" == x64 ]] && TARGET="x86_64-apple-macos13.0"
mkdir -p "$ROOT/build/swift-module-cache"
swiftc -O -module-cache-path "$ROOT/build/swift-module-cache" -target "$TARGET" \
  "$ROOT/native/WhatsAppRuntime.swift" -o "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp \
  "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$COMPONENT"

codesign --verify --deep --strict --verbose=2 "$COMPONENT"
INFO="$(codesign -d --verbose=4 "$COMPONENT" 2>&1)"
echo "$INFO" | grep -q "Identifier=$IDENTIFIER" || { echo "Component identifier mismatch" >&2; exit 1; }
echo "$INFO" | grep -q "TeamIdentifier=$APPLE_TEAM_ID" || { echo "Component Team ID mismatch" >&2; exit 1; }

SUBMISSION="$ROOT/build/Habibi-WhatsApp-$ARCH-$VERSION-submission.zip"
rm -f "$ARCHIVE" "$SUBMISSION"
ditto -c -k --keepParent "$COMPONENT" "$SUBMISSION"

if [[ "${SKIP_NOTARIZE:-}" == "1" ]]; then
  mv "$SUBMISSION" "$ARCHIVE"
  echo "SKIP_NOTARIZE=1 — built signed component $ARCHIVE"
  exit 0
fi

: "${APPLE_ID:?Set APPLE_ID for notarization}"
: "${APPLE_APP_PASSWORD:?Set APPLE_APP_PASSWORD for notarization}"

PROFILE="habibi-whatsapp-notarize"
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/notary.keychain-db"
KEYCHAIN_PW="$(uuidgen)"
cleanup() {
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$KEYCHAIN_DIR" "$SUBMISSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
xcrun notarytool store-credentials "$PROFILE" --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --keychain "$KEYCHAIN" >/dev/null

NOTARY_OUTPUT="$(mktemp)"
echo "Submitting WhatsApp component for notarization…"
if ! xcrun notarytool submit "$SUBMISSION" --keychain-profile "$PROFILE" \
  --keychain "$KEYCHAIN" --wait | tee "$NOTARY_OUTPUT"; then
  echo "notarytool submit failed" >&2
fi
SUBMISSION_ID="$(grep -m1 '^\s*id:' "$NOTARY_OUTPUT" | awk '{print $2}')"
if ! grep -q "status: Accepted" "$NOTARY_OUTPUT"; then
  [[ -z "$SUBMISSION_ID" ]] || xcrun notarytool log "$SUBMISSION_ID" \
    --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" || true
  rm -f "$NOTARY_OUTPUT"
  exit 1
fi
rm -f "$NOTARY_OUTPUT"

attempt=1
until xcrun stapler staple "$COMPONENT"; do
  (( attempt >= 5 )) && { echo "Could not staple component after $attempt attempts" >&2; exit 1; }
  sleep $(( attempt * 30 ))
  attempt=$(( attempt + 1))
done
xcrun stapler validate "$COMPONENT"
spctl -a -t exec -vv "$COMPONENT"

# Recreate the public archive after stapling so the embedded ticket ships.
ditto -c -k --keepParent "$COMPONENT" "$ARCHIVE"
echo "Built and notarized $ARCHIVE"
