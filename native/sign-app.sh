#!/bin/zsh
# Checks the Developer ID signature `tauri build` put on Habibi.app, then
# packages it into a DMG and signs, notarizes and staples that DMG.
#
#   sign-app.sh <Habibi.app> <output.dmg>
#
#   APPLE_DEVELOPER_ID_APPLICATION  "Developer ID Application: … (TEAMID)"
#   APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID   notarization credentials
#
# The app itself is signed by the Tauri bundler (APPLE_SIGNING_IDENTITY, with
# hardened runtime and src-tauri/entitlements.plist) because the updater
# artifact it creates must contain the same signed bytes. Set SKIP_NOTARIZE=1
# to sign and package without submitting to Apple.
set -euo pipefail

ROOT="${0:A:h:h}"
APP="${1:?Usage: sign-app.sh <Habibi.app> <output.dmg>}"
DMG="${2:?Usage: sign-app.sh <Habibi.app> <output.dmg>}"
[[ -d "$APP" ]] || { echo "No app bundle at $APP. Run pnpm tauri build first." >&2; exit 1; }
: "${APPLE_DEVELOPER_ID_APPLICATION:?Set APPLE_DEVELOPER_ID_APPLICATION to the signing identity}"

echo "Checking the signature on $APP"
codesign --verify --deep --strict --verbose=2 "$APP"
INFO="$(codesign -d --verbose=4 "$APP" 2>&1)"
echo "$INFO" | grep -qxF "Authority=$APPLE_DEVELOPER_ID_APPLICATION" \
  || { echo "::error::$APP is not signed with $APPLE_DEVELOPER_ID_APPLICATION" >&2; exit 1; }
[[ -z "${APPLE_TEAM_ID:-}" ]] || echo "$INFO" | grep -qxF "TeamIdentifier=$APPLE_TEAM_ID" \
  || { echo "::error::$APP has the wrong Team ID" >&2; exit 1; }
# Notarization requires both on every executable.
echo "$INFO" | grep -q "flags=.*runtime" || { echo "::error::$APP lacks the hardened runtime" >&2; exit 1; }
echo "$INFO" | grep -q "^Timestamp=" || { echo "::error::$APP has no secure timestamp" >&2; exit 1; }

# The app ships no JavaScript engine of its own: Node and Chromium live only in
# the separately notarized WhatsApp component, and the JIT/library-validation
# exceptions they need must never come back to the main app.
ENTITLEMENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
for forbidden in com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory \
  com.apple.security.cs.disable-library-validation com.apple.security.cs.allow-dyld-environment-variables \
  com.apple.security.app-sandbox; do
  [[ "$ENTITLEMENTS" != *"$forbidden"* ]] || { echo "::error::$APP must not carry $forbidden" >&2; exit 1; }
done
# (skills/openwa/ is only the skill manifest the launcher lists.)
if find "$APP" \( -name node -o -name 'node.exe' -o -name '*.node' -o -name node_modules -o -name 'openwa-supervisor.js' -o -path '*/openwa/dist' \) -print -quit | grep -q .; then
  echo "::error::$APP contains Node or OpenWA; they belong in the WhatsApp component" >&2
  exit 1
fi

# Under hardened runtime, TCC silently refuses a permission request instead of
# prompting when the matching entitlement is absent — no error, no dialog. An
# Info.plist usage string with no corresponding entitlement shipped exactly
# this bug for Calendar once already, so check the signed entitlements.
check_entitlement_pair() {
  local usage_key="$1" entitlement="$2" feature="$3"
  if /usr/libexec/PlistBuddy -c "Print :$usage_key" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
    [[ "$ENTITLEMENTS" == *"$entitlement"* ]] \
      || { echo "::error::Info.plist has $usage_key but the signature lacks $entitlement ($feature would silently fail to prompt)" >&2; exit 1; }
  fi
}
check_entitlement_pair "NSAppleEventsUsageDescription" "com.apple.security.automation.apple-events" "Automation"
check_entitlement_pair "NSCalendarsFullAccessUsageDescription" "com.apple.security.personal-information.calendars" "Calendar access"
check_entitlement_pair "NSRemindersFullAccessUsageDescription" "com.apple.security.personal-information.calendars" "Reminders access"
check_entitlement_pair "NSContactsUsageDescription" "com.apple.security.personal-information.addressbook" "Contacts lookup"
check_entitlement_pair "NSMicrophoneUsageDescription" "com.apple.security.device.audio-input" "Teleprompter voice following"
check_entitlement_pair "NSSpeechRecognitionUsageDescription" "com.apple.security.personal-information.speech-recognition" "Teleprompter speech recognition"

# A DMG containing only the app invites double-clicking it straight off the
# mounted, read-only, ejectable volume. LSUIElement apps like this one show no
# window on launch, so a user who does that sees nothing happen and loses the
# app the moment the volume is unmounted. Staging an /Applications symlink
# alongside the app is what makes Finder show the drag-to-install affordance.
DMG_ROOT="$(mktemp -d)/habibi-dmg"
mkdir -p "$DMG_ROOT"
ditto "$APP" "$DMG_ROOT/${APP:t}"
ln -s /Applications "$DMG_ROOT/Applications"

rm -f "$DMG"
echo "Building $DMG"
# LZMA (ULMO) shrinks the download but was extremely slow to CREATE on GitHub's
# macOS runners: hdiutil ran 70+ seconds with zero output and its
# diskimages-helper had to be force-reaped, never printing a real error. UDZO
# (zlib) compresses fast and reliably at a modest size cost.
hdiutil create -volname "Habibi" -srcfolder "$DMG_ROOT" -ov -format UDZO -quiet "$DMG"
rm -rf "${DMG_ROOT:h}"
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
# via `ps` for the lifetime of the call. The profile lives in a throwaway
# keychain, because notarytool has no delete-credentials subcommand.
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

# Notarizing the DMG also registers the app inside it, so the app keeps
# passing Gatekeeper once it is copied to /Applications.
echo "Submitting for notarization…"
NOTARY_OUTPUT="$(mktemp)"
if ! xcrun notarytool submit "$DMG" \
  --keychain-profile "$NOTARY_PROFILE" --keychain "$NOTARY_KEYCHAIN" --wait | tee "$NOTARY_OUTPUT"; then
  echo "notarytool submit failed; see the log fetch below for Apple's actual rejection reason." >&2
fi

# `--wait` reports a final status but not *why*; fetch the notary log whenever
# the outcome isn't a clean Accepted so the reason lands in this job's log.
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
xcrun stapler validate "$DMG"

echo "Verifying Gatekeeper acceptance…"
spctl -a -t open --context context:primary-signature -vv "$DMG"

echo "Built and notarized $DMG"
