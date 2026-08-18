const test = require('node:test');
const assert = require('node:assert/strict');
const escapeHtmlReference = require('escape-html');

// The client modules are browser ES modules that read `window`, so give them a
// minimal origin before importing. The launcher is always served from loopback.
globalThis.window = { location: { origin: 'http://127.0.0.1:4173' } };

const loadClient = async () => ({
  helpers: await import('../src/client/core/view-helpers.js'),
  resultButton: await import('../src/client/ui/result-button.js'),
});

const hostile = '"><img src=x onerror=alert(1)>';

// The client is served as native ES modules with no bundler and `escape-html`
// is CommonJS-only, so it cannot be imported at runtime. This test is the
// substitute: it pins our inlined copy to the reference implementation, so any
// divergence fails the build rather than silently weakening escaping.
test('escapeHtml matches the escape-html reference implementation', async () => {
  const { helpers } = await loadClient();
  const cases = [
    hostile,
    "'; alert(1); //",
    '<script>a</script>',
    'a & b',
    'plain',
    '',
    '&amp;',
    '<>&\'"',
    '\n\t\r',
    'ümlaut',
  ];
  for (const value of cases)
    assert.equal(
      helpers.escapeHtml(value),
      escapeHtmlReference(value),
      `differs for ${JSON.stringify(value)}`,
    );
  for (let i = 0; i < 20_000; i++) {
    const value = Array.from({ length: 8 }, () =>
      String.fromCharCode(Math.floor(Math.random() * 200)),
    ).join('');
    assert.equal(
      helpers.escapeHtml(value),
      escapeHtmlReference(value),
      `differs for ${JSON.stringify(value)}`,
    );
  }
});

test('escapeHtml neutralizes every character that can break out of markup', async () => {
  const { helpers } = await loadClient();
  assert.equal(helpers.escapeHtml(hostile), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(helpers.escapeHtml("' onmouseover='x"), '&#39; onmouseover=&#39;x');
  assert.equal(helpers.escapeHtml('a & b'), 'a &amp; b');
  assert.equal(helpers.escapeHtml(null), '');
  assert.equal(helpers.escapeHtml(undefined), '');
  // icon() interpolates into an attribute, so it must escape too.
  assert.equal(helpers.icon(hostile).includes('onerror=alert(1)>'), false);
});

test('image and media sources reject non-image schemes and hostile origins', async () => {
  const { helpers } = await loadClient();
  const { safeImageSrc, safeMediaSrc } = helpers;

  // Blocked: script-bearing and HTML-bearing URLs, and cross-origin http.
  assert.equal(safeImageSrc('javascript:alert(1)'), '');
  assert.equal(safeImageSrc('JaVaScRiPt:alert(1)'), '');
  assert.equal(safeImageSrc(' javascript:alert(1)'), '');
  assert.equal(safeImageSrc('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeImageSrc('http://evil.tld/x.png'), '');
  assert.equal(safeImageSrc('//evil.tld/x.png'), '');

  // Allowed: same-origin paths, https, and well-formed inline images.
  assert.equal(
    safeImageSrc('/api/app-icon?path=%2FApplications%2FMail.app'),
    'http://127.0.0.1:4173/api/app-icon?path=%2FApplications%2FMail.app',
  );
  assert.equal(safeImageSrc('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(
    safeImageSrc('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo=',
  );

  // A quote in the value must never survive into the attribute.
  assert.equal(safeImageSrc(`https://cdn.example/a.png" onerror="alert(1)`).includes('"'), false);

  // Media widens the type list but keeps the same scheme discipline.
  assert.equal(safeMediaSrc('data:video/mp4;base64,AAAA'), 'data:video/mp4;base64,AAAA');
  assert.equal(safeMediaSrc('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.equal(safeMediaSrc('data:image/png;base64,not valid base64!'), '');
});

test('result rows render connector-controlled text as inert content', async () => {
  const { helpers, resultButton } = await loadClient();
  const render = resultButton.createResultButton({
    icon: helpers.icon,
    chatTime: helpers.chatTime,
    iconNames: { whatsapp: 'message-circle' },
  });

  // Mirrors a WhatsApp row: name, preview and avatar all come from whoever
  // messaged the user.
  const markup = render(
    {
      type: 'chat',
      icon: 'whatsapp',
      title: hostile,
      meta: hostile,
      tag: 'CHAT',
      avatar: 'javascript:alert(1)',
      initials: hostile,
      showChatAvatar: true,
    },
    0,
  );

  assert.equal(markup.includes('onerror=alert(1)>'), false);
  assert.equal(markup.includes('javascript:alert(1)'), false);
  assert.equal(markup.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
  // The escaped title must not have closed data-title and added attributes.
  assert.match(markup, /data-title="&quot;&gt;/);

  // A legitimate row still renders its real values.
  const normal = render(
    { type: 'chat', icon: 'whatsapp', title: 'Amina', meta: 'See you soon', tag: 'CHAT' },
    0,
  );
  assert.match(normal, /Amina/);
  assert.match(normal, /See you soon/);
});
