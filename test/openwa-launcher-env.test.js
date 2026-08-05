const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// native/HabibiApp.swift has no test harness (it is compiled directly by
// swiftc, not run under node:test), so this asserts against its source text —
// the same role static-assets.test.js plays for server.js's routing table.
// What matters here is that the three env vars line up EXACTLY with what
// src/connectors/openwa-client.ts and vendor/openwa's own env reading expect:
// a mismatch here is silent at compile time and only surfaces as "WhatsApp
// gateway is not set up" at runtime, which is exactly the bug Phase A2 fixed
// once already for the unbundled path.
// This file compiles to dist/test/, two levels below the repo root.
const swiftSource = fs.readFileSync(path.join(__dirname, '..', '..', 'native/HabibiApp.swift'), 'utf8');

test('the bundled OpenWA launcher points BOOTSTRAP_KEY_FILE at .openwa/data/.api-key under the state root', () => {
  // src/connectors/openwa-client.ts:32 reads `<workspace>/.openwa/data/.api-key`,
  // where workspace is HABIBI_DATA_ROOT (server.js:22) — the per-user
  // Application Support directory, not the read-only bundle. The launcher must
  // write the bootstrap key to that same resolved path or the two processes
  // never agree on where the API key lives.
  assert.match(
    swiftSource,
    /"BOOTSTRAP_KEY_FILE":\s*openwaState\.appendingPathComponent\("data\/\.api-key"\)\.path/,
    'BOOTSTRAP_KEY_FILE must resolve to <stateRoot>/.openwa/data/.api-key'
  );
  assert.match(
    swiftSource,
    /openwaState\s*=\s*stateRoot\.appendingPathComponent\("\.openwa",\s*isDirectory:\s*true\)/,
    'openwaState must be a subdirectory of the same Application Support stateRoot the main service uses'
  );
});

test('the bundled OpenWA launcher persists sessions under the state root, not the bundle', () => {
  // A session tied to the read-only .app bundle would be wiped by every
  // reinstall/update; it must live in Application Support so QR-linking
  // survives an app upgrade.
  assert.match(
    swiftSource,
    /"SESSION_DATA_PATH":\s*openwaState\.appendingPathComponent\("sessions"\)\.path/,
    'SESSION_DATA_PATH must resolve to <stateRoot>/.openwa/sessions'
  );
});

test('the bundled OpenWA launcher points Puppeteer at the bundled Chromium, not a system install', () => {
  // Chrome for Testing has no universal build, so build-app.sh stages exactly
  // one bundled Chromium per DMG at Contents/Resources/openwa/chrome/chrome —
  // PUPPETEER_EXECUTABLE_PATH must resolve there, and only when that path is
  // actually executable (an older or Chromium-less build must not set a
  // dangling env var that breaks whatsapp-web.js's own fallback).
  assert.match(
    swiftSource,
    /let chromePath = root\.appendingPathComponent\("chrome\/chrome"\)\.path/,
    'chromePath must be <openwa service root>/chrome/chrome'
  );
  assert.match(
    swiftSource,
    /if FileManager\.default\.isExecutableFile\(atPath: chromePath\) \{\s*\n\s*env\["PUPPETEER_EXECUTABLE_PATH"\] = chromePath/,
    'PUPPETEER_EXECUTABLE_PATH must only be set when the bundled Chromium binary actually exists and is executable'
  );
});

test('the bundled OpenWA process is torn down alongside the main service on quit', () => {
  assert.match(
    swiftSource,
    /if let openwaProcess, openwaProcess\.isRunning \{ openwaProcess\.terminate\(\) \}/,
    'applicationWillTerminate must terminate openwaProcess the same way it terminates server'
  );
});
