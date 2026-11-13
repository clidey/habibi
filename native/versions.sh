# Every pinned third-party version native/build-whatsapp-component.sh
# downloads into the WhatsApp component, in one place. Bump a version here, not
# inside that script — it only ever reads these variables, never hardcodes a
# version itself.
#
# To bump something:
#
#   NODE_VERSION            — read from .nvmrc (the single source of truth for
#                              the Node version CI and every other tool in this
#                              repo already targets); bump .nvmrc, not this
#                              file, and keep it inside package.json's
#                              "engines.node" range. The component's OpenWA
#                              native modules are installed by this same Node
#                              version, so its ABI always matches.
#
#   OPENWA_VERSION           — a tag from https://github.com/rmyndharis/OpenWA/tags.
#                              After bumping, re-run the PUPPETEER_* steps below —
#                              a new OpenWA release may pull a newer
#                              whatsapp-web.js, which may pin a newer Puppeteer.
#
#   PUPPETEER_CLI_VERSION    — the puppeteer npm version OpenWA's own
#                              whatsapp-web.js dependency resolves to. Check with:
#                                (cd <openwa checkout> && npm ls puppeteer)
#
#   PUPPETEER_CHROME_BUILD_ID — the Chrome-for-Testing build that
#                              PUPPETEER_CLI_VERSION downloads by default (Chrome
#                              for Testing has no "latest" alias worth trusting —
#                              pin the exact build so every build downloads the
#                              same bytes). Find it with:
#                                npx puppeteer@<PUPPETEER_CLI_VERSION> browsers install chrome \
#                                  --path /tmp/chrome-probe
#                              which prints the buildId it resolved without
#                              needing a version filter.
#
# Bump these independently of each other — nothing here assumes they move
# together — but re-verify PUPPETEER_CHROME_BUILD_ID after bumping either
# OPENWA_VERSION or PUPPETEER_CLI_VERSION, since either can change what
# Puppeteer's own default build resolves to.

# $ROOT is set by the caller (native/build-whatsapp-component.sh, a bash script
# that also runs on Windows) before sourcing this file, so this file stays
# plain POSIX-compatible assignments. A Windows checkout may carry CRLF.
NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"

OPENWA_VERSION="v0.14.1"

PUPPETEER_CLI_VERSION="24.38.0"
PUPPETEER_CHROME_BUILD_ID="146.0.7680.31"
