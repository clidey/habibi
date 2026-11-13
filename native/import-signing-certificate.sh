#!/bin/zsh
# Imports the Developer ID certificate into a throwaway keychain on a GitHub
# macOS runner (release.yml). The workflow deletes that keychain afterwards.
#
#   CERTIFICATE_P12_BASE64  base64 of the Developer ID .p12
#   CERTIFICATE_PASSWORD    its password
#   KEYCHAIN_PASSWORD       optional; a random one is used if unset
set -euo pipefail

if [[ -z "${CERTIFICATE_P12_BASE64:-}" || -z "${CERTIFICATE_PASSWORD:-}" ]]; then
  echo "::error::APPLE_CERTIFICATES_P12 and APPLE_CERTIFICATES_PASSWORD are required"
  exit 1
fi
CERT_PATH="${RUNNER_TEMP:?RUNNER_TEMP is required}/certificate.p12"
KEYCHAIN_PATH="$RUNNER_TEMP/app-signing.keychain-db"
KEYCHAIN_PW="${KEYCHAIN_PASSWORD:-$(uuidgen)}"

print -r -- "$CERTIFICATE_P12_BASE64" | base64 --decode -o "$CERT_PATH"
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN_PATH"
security import "$CERT_PATH" -P "$CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"

EXISTING=()
while IFS= read -r keychain; do EXISTING+=("$keychain"); done < <(security list-keychains -d user | sed 's/"//g; s/^[[:space:]]*//')
security list-keychains -d user -s "$KEYCHAIN_PATH" "${EXISTING[@]}"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN_PATH" >/dev/null

rm -f "$CERT_PATH"
# Confirm a usable identity exists without printing the keychain contents into
# a public build log.
security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
  | grep -q "Developer ID Application" \
  || { echo "::error::no Developer ID Application identity in the keychain"; exit 1; }
