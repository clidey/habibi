#!/bin/zsh
# Signs, notarizes and zips the WhatsApp component staged by
# native/build-whatsapp-component.sh (macOS). The result is the release asset
# build/Habibi-WhatsApp-<arm64|x64>-<version>.zip that Habibi downloads,
# verifies against its own signing team, and checks with Gatekeeper before
# running anything inside it.
#
#   APPLE_DEVELOPER_ID_APPLICATION  "Developer ID Application: … (TEAMID)"
#   APPLE_TEAM_ID                   expected Team ID of that identity
#   APPLE_ID / APPLE_APP_PASSWORD   notarization credentials
#
# SKIP_NOTARIZE=1 signs and zips without submitting to Apple.
set -euo pipefail

ROOT="${0:A:h:h}"
COMPONENT_NAME="Habibi WhatsApp Runtime.app"
COMPONENT="$ROOT/build/whatsapp-component/$COMPONENT_NAME"
ENTITLEMENTS="$ROOT/native/whatsapp-runtime-entitlements.plist"
VERSION="${VERSION:-$(node -p "require('$ROOT/package.json').version")}"
ARCH="${HABIBI_COMPONENT_ARCH:?Set HABIBI_COMPONENT_ARCH=arm64 or x64}"
IDENTIFIER="com.clidey.habibi.whatsapp-runtime"
ARCHIVE="$ROOT/build/Habibi-WhatsApp-$ARCH-$VERSION.zip"

: "${APPLE_DEVELOPER_ID_APPLICATION:?Set APPLE_DEVELOPER_ID_APPLICATION to the signing identity}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to the signing team identifier}"
[[ -d "$COMPONENT/Contents/Resources/openwa" && -x "$COMPONENT/Contents/MacOS/node" ]] \
  || { echo "No staged component at $COMPONENT. Run native/build-whatsapp-component.sh first." >&2; exit 1; }
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || { echo "HABIBI_COMPONENT_ARCH must be arm64 or x64" >&2; exit 1; }

echo "Signing $COMPONENT as $APPLE_DEVELOPER_ID_APPLICATION"

# Nested code must be signed before the bundle that contains it, so the outer
# signature covers the final bytes of everything inside. `--deep` is not used:
# Apple discourages it because it signs in an unpredictable order and applies
# one set of entitlements to nested code that should not receive them.
#
# `.node`/`.dylib`/`.so`/`.bare` are loaded into the process that opens them
# (dlopen), so they inherit hardened runtime from it and get no entitlements of
# their own. `.bare` (Bare's native-module extension, from OpenWA's transitive
# bare-fs/bare-os/bare-url) is a plain Mach-O dylib despite the name; the
# notary rejected it as "The binary is not signed" the first time it shipped
# unsigned. Anything fork/exec'd as its own process must carry
# --options runtime itself ("does not have the hardened runtime enabled").
sign_nested() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "$1"
}

sign_nested_executable() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$1"
}

sign_with_entitlements() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
    --entitlements "$ENTITLEMENTS" --options runtime --timestamp "$1"
}

# Chrome for Testing ships only ad-hoc signed (flags=0x20002(adhoc,linker-
# signed)), with 4-5 nested Helper .app bundles, a Framework, loose dylibs and
# a few standalone executables. Apple's signing order requires the deepest
# code first (Electron's @electron/osx-sign, the precedent for this exact
# shape, calls it "arcane apple logic"), so nested bundles are depth-sorted and
# signed bottom-up before the outer Chrome .app.
sign_chromium() {
  local chrome_root="$1"
  local chrome_app
  chrome_app="$(find "$chrome_root" -iname "*.app" -maxdepth 1 -print -quit)"
  [[ -n "$chrome_app" ]] || { echo "No Chromium .app under $chrome_root" >&2; exit 1; }
  echo "  Signing bundled Chromium (${chrome_app#$COMPONENT/})…"

  while IFS= read -r -d '' binary; do
    echo "    ${binary#$COMPONENT/}"
    sign_nested_executable "$binary"
  done < <(find "$chrome_app/Contents/Frameworks" -type f \( -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null)

  # Loose .dylibs under the Framework's Libraries/ (GL/ANGLE/SwiftShader shims,
  # Widevine) sit inside no Helper .app; missing them was a real rejection
  # ("UNSIGNED: .../Libraries/libEGL.dylib").
  while IFS= read -r -d '' dylib; do
    echo "    ${dylib#$COMPONENT/}"
    sign_nested "$dylib"
  done < <(find "$chrome_app" -type f -name "*.dylib" -print0 2>/dev/null)

  # The .framework is a signed bundle in its own right; leaving its ad-hoc
  # signature failed `codesign --verify --deep` with "code has no resources but
  # signature indicates they must be present".
  while IFS= read -r nested_bundle; do
    echo "    ${nested_bundle#$COMPONENT/}"
    sign_with_entitlements "$nested_bundle"
  done < <(find "$chrome_app" \( -iname "*.app" -o -iname "*.framework" \) -not -path "$chrome_app" -print0 2>/dev/null \
    | xargs -0 -n1 printf '%s\n' \
    | awk -F'/' '{print NF, $0}' | sort -rn | cut -d' ' -f2-)

  echo "    ${chrome_app#$COMPONENT/}"
  sign_with_entitlements "$chrome_app"
}

sign_chromium "$COMPONENT/Contents/Resources/openwa/chrome"

while IFS= read -r -d '' binary; do
  echo "  ${binary#$COMPONENT/}"
  sign_nested "$binary"
done < <(find "$COMPONENT" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "*.bare" \) -not -path "*/openwa/chrome/*" -print0 2>/dev/null)

# `node` is a full interpreter: V8 needs the JIT exceptions, and it loads
# OpenWA's native modules.
echo "  Contents/MacOS/node"
sign_with_entitlements "$COMPONENT/Contents/MacOS/node"

echo "  Contents/MacOS/HabibiWhatsAppRuntime"
sign_nested_executable "$COMPONENT/Contents/MacOS/HabibiWhatsAppRuntime"
echo "  $COMPONENT_NAME"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$COMPONENT"

codesign --verify --deep --strict --verbose=2 "$COMPONENT"
INFO="$(codesign -d --verbose=4 "$COMPONENT" 2>&1)"
echo "$INFO" | grep -q "Identifier=$IDENTIFIER" || { echo "Component identifier mismatch" >&2; exit 1; }
echo "$INFO" | grep -q "TeamIdentifier=$APPLE_TEAM_ID" || { echo "Component Team ID mismatch" >&2; exit 1; }

# Catches unsigned nested code that `codesign --verify` alone can miss, which
# is the most common reason notarization fails after a clean local sign.
echo "Checking for unsigned nested code…"
find "$COMPONENT" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "*.bare" -o -path "$COMPONENT/Contents/MacOS/*" \
  -o -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      codesign --verify "$binary" 2>/dev/null || { echo "UNSIGNED: ${binary#$COMPONENT/}" >&2; exit 1; }
    done
find "$COMPONENT/Contents/Resources/openwa/chrome" -iname "*.app" -print0 2>/dev/null \
  | while IFS= read -r -d '' nested_app; do
      codesign --verify --strict "$nested_app" 2>/dev/null || { echo "UNSIGNED: ${nested_app#$COMPONENT/}" >&2; exit 1; }
    done

# Every standalone executable the notary inspects must carry the hardened
# runtime flag itself. Capture codesign's output first: `grep -q` on a large
# dump exits before draining the pipe, and pipefail then reports codesign's
# SIGPIPE instead of grep's result.
echo "Checking hardened runtime on standalone executables…"
find "$COMPONENT" -type f \( -path "$COMPONENT/Contents/MacOS/*" \
  -o -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      info="$(codesign -d --verbose=4 "$binary" 2>&1)"
      echo "$info" | grep -q "flags=.*runtime" \
        || { echo "NO HARDENED RUNTIME: ${binary#$COMPONENT/}" >&2; exit 1; }
    done

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

# Submit against a stored keychain profile rather than passing the
# app-specific password to `notarytool submit`: argv is readable by any process
# on the machine via `ps`. The profile lives in a throwaway keychain, because
# notarytool has no delete-credentials subcommand.
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
