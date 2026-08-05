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
# HABIBI_OPENWA_ARCH is the same build-time arch flag build-app.sh takes for the
# bundled Chromium; when set, it names the DMG so two arch-specific artifacts
# never collide on disk (or in a release's uploaded assets).
DMG_SUFFIX="${HABIBI_OPENWA_ARCH:+-$HABIBI_OPENWA_ARCH}"
DMG="$ROOT/build/Habibi$DMG_SUFFIX-$VERSION.dmg"

[[ -d "$APP" ]] || { echo "No app bundle at $APP. Run native/build-app.sh first." >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "Missing $ENTITLEMENTS" >&2; exit 1; }
: "${APPLE_DEVELOPER_ID_APPLICATION:?Set APPLE_DEVELOPER_ID_APPLICATION to the signing identity}"

# Under hardened runtime, TCC silently refuses a permission request instead of
# prompting when the matching entitlement is absent — no error, no dialog, and
# no signal short of a user reporting the feature does nothing. An Info.plist
# usage string with no corresponding entitlement shipped exactly this bug for
# Calendar once already, so check it here rather than trust it stays correct.
check_entitlement_pair() {
  local usage_key="$1" entitlement="$2" feature="$3"
  if /usr/libexec/PlistBuddy -c "Print :$usage_key" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
    grep -q "$entitlement" "$ENTITLEMENTS" \
      || { echo "::error::Info.plist has $usage_key but $ENTITLEMENTS is missing $entitlement ($feature would silently fail to prompt)" >&2; exit 1; }
  fi
}
check_entitlement_pair "NSCalendarsFullAccessUsageDescription" "com.apple.security.personal-information.calendars" "Calendar access"
check_entitlement_pair "NSContactsUsageDescription" "com.apple.security.personal-information.addressbook" "Contacts lookup"

echo "Signing $APP as $APPLE_DEVELOPER_ID_APPLICATION"

# Nested code must be signed before the bundle that contains it, so the outer
# signature covers the final bytes of everything inside. `--deep` is not used:
# Apple discourages it because it signs in an unpredictable order and applies the
# app's entitlements to nested binaries that should not receive them.
#
# `.node`/`.dylib`/`.so`/`.bare` are loaded into the process that opens them
# (dlopen), so they correctly inherit hardened runtime from it and get no
# entitlements of their own. `.bare` (Bare/Pear's own native-module extension,
# seen via a transitive OpenWA dependency — bare-fs/bare-os/bare-url) is a
# plain Mach-O dylib despite the nonstandard name, confirmed by inspecting one
# directly; the notary rejection ("The binary is not signed") that caught the
# missing pattern here was for exactly this reason. `spawn-helper` is not
# loaded code: node-pty fork/execs it as its
# OWN process, so notarization requires it to carry --options runtime itself —
# confirmed by Apple's actual rejection ("does not have the hardened runtime
# enabled") the first time this shipped without it.
sign_nested() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --timestamp "$1"
}

sign_nested_executable() {
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$1"
}

# Bundled Chromium (Contents/Resources/openwa/chrome, added by build-app.sh for
# WhatsApp) ships 4-5 nested Helper .app bundles (Helper.app, Helper (GPU).app,
# Helper (Renderer).app, Helper (Plugin).app, Helper (Alerts).app) plus a few
# standalone executables (chrome_crashpad_handler, app_mode_loader,
# web_app_shortcut_copier). None of this is signed with Habibi's identity as
# downloaded — Chrome for Testing ships only adhoc-signed
# (flags=0x20002(adhoc,linker-signed), confirmed by inspecting a real download).
#
# Apple's signing order requires the deepest code signed first (Electron's
# @electron/osx-sign — the proven precedent for this exact nested-Helper-app
# shape — calls this "arcane apple logic"; signing outer-first throws opaque
# errors). Depth-sort by path-segment count so every Helper .app is signed
# bottom-up before the outer Chrome.app that contains it.
#
# Habibi's own entitlements.plist is already a superset of what any single
# Chromium helper needs (allow-jit, allow-unsigned-executable-memory,
# disable-library-validation are all already present for `node`), so it is
# reused as-is rather than replicating Electron's per-helper-type entitlement
# files — slight over-provisioning of the GPU/Renderer helpers is not a
# rejection risk.
sign_chromium() {
  local chrome_root="$1"
  [[ -d "$chrome_root" ]] || return 0
  local chrome_app
  chrome_app="$(find "$chrome_root" -iname "*.app" -maxdepth 1 -print -quit)"
  [[ -n "$chrome_app" ]] || return 0

  echo "  Signing bundled Chromium ($chrome_app)…"

  # Standalone executables Chromium fork/execs as their own processes (not
  # dlopen'd), so — like spawn-helper — each needs the hardened runtime flag
  # itself, not just inherited from Chrome.app's own signature.
  while IFS= read -r -d '' binary; do
    echo "    ${binary#$APP/}"
    sign_nested_executable "$binary"
  done < <(find "$chrome_app/Contents/Frameworks" -type f \( -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null)

  # Loose .dylibs living directly under Framework.framework/.../Libraries/ (the
  # GL/ANGLE/SwiftShader shims and the Widevine CDM) are NOT inside any Helper
  # .app or named executable above, so the two loops before this one never
  # touch them — and the top-level generic .dylib/.so/.node loop deliberately
  # skips everything under openwa/chrome/ on the assumption this function
  # covers it. Missing this was a real notarization rejection ("UNSIGNED:
  # .../Libraries/libEGL.dylib") the first time this shipped. dlopen'd, not
  # fork/exec'd, so plain sign_nested (no --options runtime) is correct, same
  # as the top-level .dylib loop's own reasoning.
  while IFS= read -r -d '' dylib; do
    echo "    ${dylib#$APP/}"
    sign_nested "$dylib"
  done < <(find "$chrome_app" -type f -name "*.dylib" -print0 2>/dev/null)

  # Depth-sort every nested .app AND .framework (deepest path first) so each
  # Helper/framework signs before the bundle that contains it. The framework
  # is a signed bundle in its own right, not just a loose Mach-O — omitting it
  # left a stale adhoc signature that failed `codesign --verify --deep` with
  # "code has no resources but signature indicates they must be present",
  # confirmed by re-signing a real downloaded Chrome for Testing.
  while IFS= read -r nested_bundle; do
    echo "    ${nested_bundle#$APP/}"
    codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
      --entitlements "$ENTITLEMENTS" --options runtime --timestamp "$nested_bundle"
  done < <(find "$chrome_app" \( -iname "*.app" -o -iname "*.framework" \) -not -path "$chrome_app" -print0 2>/dev/null \
    | xargs -0 -n1 printf '%s\n' \
    | awk -F'/' '{print NF, $0}' | sort -rn | cut -d' ' -f2-)

  echo "    ${chrome_app#$APP/}"
  codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
    --entitlements "$ENTITLEMENTS" --options runtime --timestamp "$chrome_app"
}

# `node` is a full interpreter, so it needs the same JIT and library-validation
# entitlements as the app or V8 cannot allocate executable memory.
echo "  node"
codesign --force --sign "$APPLE_DEVELOPER_ID_APPLICATION" \
  --entitlements "$ENTITLEMENTS" --options runtime --timestamp \
  "$APP/Contents/MacOS/node"

sign_chromium "$APP/Contents/Resources/openwa/chrome"

while IFS= read -r -d '' binary; do
  echo "  ${binary#$APP/}"
  sign_nested "$binary"
done < <(find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "*.bare" \) -not -path "*/openwa/chrome/*" -print0 2>/dev/null)

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
find "$APP" -type f \( -name "*.node" -o -name "*.dylib" -o -name "*.so" -o -name "*.bare" -o -name "spawn-helper" -o -name "node" \
  -o -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      codesign --verify "$binary" 2>/dev/null || { echo "UNSIGNED: ${binary#$APP/}" >&2; exit 1; }
    done
# Every nested Helper .app is a unit, not a loose binary — verify each one
# independently, since the outer Chrome.app's own --verify does not recurse
# into bundles it contains.
find "$APP/Contents/Resources/openwa/chrome" -iname "*.app" -print0 2>/dev/null \
  | while IFS= read -r -d '' nested_app; do
      codesign --verify --strict "$nested_app" 2>/dev/null || { echo "UNSIGNED: ${nested_app#$APP/}" >&2; exit 1; }
    done

# Every standalone executable Apple's notary service inspects independently
# (node and spawn-helper — anything that gets exec'd as its own process, not
# just dlopen'd) must carry the hardened runtime flag itself. Missing it here
# is exactly what notarization rejected last time ("does not have the hardened
# runtime enabled"); check locally so that failure surfaces before a submission
# is spent on it.
echo "Checking hardened runtime on standalone executables…"
find "$APP" -type f \( -name "spawn-helper" -o -name "node" \
  -o -name "chrome_crashpad_handler" -o -name "app_mode_loader" -o -name "web_app_shortcut_copier" \) -print0 2>/dev/null \
  | while IFS= read -r -d '' binary; do
      # `grep -q` on a large codesign dump (node's universal binary output runs
      # to hundreds of KB) exits before draining the pipe, so codesign gets
      # SIGPIPE and pipefail reports that instead of grep's real result.
      # Capturing to a variable first avoids the pipe entirely.
      info="$(codesign -d --verbose=4 "$binary" 2>&1)"
      echo "$info" | grep -q "flags=.*runtime" \
        || { echo "NO HARDENED RUNTIME: ${binary#$APP/}" >&2; exit 1; }
    done

# A DMG containing only the app invites double-clicking it straight off the
# mounted, read-only, ejectable volume. LSUIElement apps like this one show no
# window on launch, so a user who does that sees nothing happen, has no
# working global shortcut, and loses the app the moment the volume is
# unmounted — with no visible sign anything was wrong. Staging an /Applications
# symlink alongside the app is what makes Finder show the familiar
# drag-to-install affordance instead.
DMG_ROOT="$(mktemp -d)/habibi-dmg"
mkdir -p "$DMG_ROOT"
cp -R "$APP" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"

rm -f "$DMG"
echo "Building $DMG"
hdiutil create -volname "Habibi" -srcfolder "$DMG_ROOT" -ov -format UDZO -quiet "$DMG"
rm -rf "$DMG_ROOT"
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
