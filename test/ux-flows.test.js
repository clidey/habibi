const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('F1: a previously-linked WhatsApp session shows reconnecting copy, not the numbered onboarding steps', () => {
  assert.match(app, /function isReconnectingSession\(status\) \{\s*\n\s*return Boolean\(status\.session\?\.phone\) && !status\.qrCode && status\.session\?\.status !== 'ready';/, 'reconnecting must require a real phone on file, no offered QR, and not-yet-ready');
  assert.match(app, /if \(isReconnectingSession\(status\)\) return renderOpenWAReconnectView\(status\);/, 'showOpenWASetup must route reconnecting sessions to the dedicated view before building the onboarding markup');
  assert.match(app, /Reconnecting \$\{name \? `\$\{escapeHtml\(name\)\}.s` : 'your'\} WhatsApp/, 'the reconnect view must use the account pushName when present');
});

test('F2: WhatsApp setup renders immediately instead of a separate "starting session" screen first', () => {
  assert.match(app, /showOpenWASetup\(\{ ok:true, session:null, qrCode:null \}\);/, 'the numbered setup screen must render before /api/openwa/connect resolves, not after');
});

test('F3: first-run WhatsApp slowness gets escalating copy at both the component-check and connect-wait stages', () => {
  const slowMatches = app.match(/Still starting — the first launch can take a bit longer…|Still checking — first-time setup can take a bit longer…/g) || [];
  assert.ok(slowMatches.length >= 2, 'both the component-check stage and the connect-wait stage must escalate their copy after 6s');
  assert.match(app, /whatsappRiskDismissedKey/, 'the ban-risk disclosure dismissal must persist in localStorage');
  assert.match(app, /very low but non-zero risk of account restriction/);
});

test('F4: "Refresh pairing" calls the real force-reset route, not a status re-check dressed up as one', () => {
  assert.match(app, /fetch\('\/api\/openwa\/reset', \{ method:'POST' \}\)/, 'the restart-openwa button must hit the new force-reset endpoint');
  assert.doesNotMatch(
    app.match(/document\.querySelector\('#restart-openwa'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*?\}\);/)?.[0] || '',
    /\/api\/openwa\/status'\)[\s\S]*?\/api\/openwa\/connect/,
    'the old status-then-maybe-connect fallback must be gone from the click handler',
  );
});

test('F5: the shared failure renderer replaces every bare escapeHtml(error.message || fallback) leak site', () => {
  assert.doesNotMatch(app, /escapeHtml\(error(?:\?)?\.message \|\| /, 'no call site should hand a raw error message straight to escapeHtml anymore');
  assert.match(app, /import \{ categorizeError, renderFailure \} from '\.\/src\/client\/core\/failure-view\.js';/);
  const renderFailureCalls = app.match(/renderFailure\(/g) || [];
  assert.ok(renderFailureCalls.length >= 8, 'renderFailure should be reused across Kubernetes, Mail, Agent Dock, and Skills, not reimplemented per call site');
});

test('F6: one approvalNotice helper backs every "needs your approval" disclaimer', () => {
  assert.match(app, /import \{ approvalNotice, /);
  const calls = app.match(/approvalNotice\(/g) || [];
  assert.ok(calls.length >= 6, 'approvalNotice should be used at every previously-inconsistent disclaimer site (WhatsApp, Mail x3, Calendar, Skills x2)');
  assert.doesNotMatch(app, /Every call needs one explicit approval\.|Sending always requires approval|Only sends after approval|Changes save only after you confirm\./, 'the old, inconsistently-phrased strings must be gone');
});

test('F7: calendar save failures reuse the same reason-coded copy as reading the calendar, with a Connect Calendar action', () => {
  assert.match(app, /error\.permissionReason = reasons\[payload\?\.reason\] \? payload\.reason : null;/, 'loadCalendarEvents must expose which reason (if any) was permission-related');
  assert.match(app, /catch \(permissionError\) \{ reasonMessage = permissionError\.message; permissionReason = permissionError\.permissionReason; \}/, 'the save-failure handler must reuse loadCalendarEvents to classify the failure');
  assert.match(app, /id="event-connect-calendar"/);
  assert.doesNotMatch(app, /'Calendar permission or save failed'/, 'the old flat error string must be gone');
});

test('F8: opening a browser search waits for the real result before resetting to Home', () => {
  const fn = app.match(/function openWebSearch\(intent\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /\.finally\(\(\) => showDefault\(\)\)/, 'showDefault must run only after the request settles, not unconditionally beforehand');
  assert.doesNotMatch(fn, /showDefault\(\);\s*\n\}/, 'showDefault must not be called synchronously right after the fetch is kicked off');
});

test('F9: a write-capable MCP tool gets a real second confirmation before it runs', () => {
  assert.match(app, /if \(tool && tool\.readOnly === false\) return renderMcpWriteConfirm\(tool, toolInput, rawInput\);/, 'selecting a write-capable tool must route through a confirm screen instead of running immediately');
  assert.match(app, /class="system-action-confirm is-dangerous"[\s\S]*?MCP TOOL · WRITES/, 'the confirm screen must reuse the exact system-action-confirm pattern that gets keyboard nav for free');
  assert.match(app, /const back = \(\) => renderMcpReview\(tool\.name, rawInput\);/, 'cancelling the confirm screen must return to the review with the same tool and input preserved');
});

test('F10: Mail decides onboarding vs. inbox before the first paint, and offers Reconnect for a failing account', () => {
  const fn = app.match(/function showMailClient\(\{ compose = false \} = \{\}\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.doesNotMatch(fn.slice(0, fn.indexOf("fetch('/api/mail/status')")), /chat-composer/, 'no composer shell must render before /api/mail/status resolves');
  assert.match(app, /function showMailProviderSetup\(provider, existingAccount\) \{/, 'the provider setup screen must accept an existing account to distinguish reconnect from first connect');
  assert.match(app, /existingAccount \? `\$\{existingAccount\.email\} stopped authenticating/);
  assert.match(app, /data-mail-reconnect="\$\{escapeHtml\(account\.id\)\}"/, 'a failing connected account must offer a direct Reconnect action');
});

test('F11: Agent Dock offers a real retry for a failed terminal renderer and a resume for an exited PTY', () => {
  assert.match(app, /id="retry-terminal-assets"/);
  assert.match(app, /document\.querySelector\('#retry-terminal-assets'\)\?\.addEventListener\('click', \(\) => showInteractiveTerminal\(agent, kind, label\)\);/);
  assert.match(app, /id="resume-again-terminal" hidden/);
  assert.match(app, /document\.querySelector\('#resume-again-terminal'\)\?\.removeAttribute\('hidden'\)/);
  // The "runs locally" disclaimer must appear on both entry points into the terminal.
  const disclaimerMatches = app.match(/Starts a Habibi-owned local PTY in this project, then opens the \$\{label\} resume picker\. Your input and output stay on this Mac\./g) || [];
  assert.equal(disclaimerMatches.length, 2, 'the disclaimer must appear on the live-process screen and the transcript-resume screen');
});

test('F12: the getting-started checklist resolves all four checks together before its first real render', () => {
  const fn = app.match(/async function loadGettingStarted\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(fn, /const \[launchAtLogin, mail, whatsapp, llm\] = await Promise\.all\(\[/, 'all four checks must resolve from one Promise.all, not a sequential await followed by a separate Promise.all');
});
