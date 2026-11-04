#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/habibi-prompter-test.XXXXXX")"
trap 'rm -rf "$SMOKE_ROOT"' EXIT
SMOKE_APP="$SMOKE_ROOT/TeleprompterSmoke.app/Contents"
mkdir -p "$SMOKE_APP/MacOS" "$SMOKE_APP/Resources/service/assets/styles"
SWIFT_SDK="${HABIBI_SWIFT_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk}"
if [[ ! -d "$SWIFT_SDK" ]]; then SWIFT_SDK="$(xcrun --sdk macosx --show-sdk-path)"; fi
swiftc -sdk "$SWIFT_SDK" -module-cache-path "${TMPDIR:-/tmp}/habibi-ux-swift-module-cache" \
  native/Teleprompter.swift native/TeleprompterSpeech.swift native/smoke-test-teleprompter.swift \
  -o "$SMOKE_APP/MacOS/smoke" -framework AppKit -framework WebKit -framework Speech -framework AVFoundation
cat > "$SMOKE_APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>smoke</string><key>CFBundleIdentifier</key><string>com.clidey.habibi.prompter-smoke</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
# Copy real resources into a bundle: source-only tests miss Bundle URL base differences.
cp assets/teleprompter-overlay.html assets/ux.bundle.js "$SMOKE_APP/Resources/service/assets/"
cp assets/styles/ux.css assets/styles/teleprompter-overlay.css "$SMOKE_APP/Resources/service/assets/styles/"
"$SMOKE_APP/MacOS/smoke"
