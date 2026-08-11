const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { loadSkills } = require('./src/core/skill-registry');
const { createOpenwaClient } = require('./src/connectors/openwa-client');
const { createWhatsAppService } = require('./src/server/services/whatsapp-service');
const { createLlmService } = require('./src/server/services/llm-service');
const { createKubernetesPlugin } = require('./src/plugins/kubernetes');
const { createAgentSessionsPlugin } = require('./src/plugins/agent-sessions');
const { createMcpBridge } = require('./src/agent/mcp-bridge');
const { createApprovalService } = require('./src/core/approval-service');
const { createMailService } = require('./src/server/services/mail-service');
const { HOST, PORT, applySecurityHeaders, isBrowserOrigin, isTrustedLocalRequest } = require('./src/core/http-security');
const { resolveStaticAsset, staticContentType } = require('./src/core/static-assets');
const { createSkillImportService } = require('./src/agent/skill-import-service');
const { createAnalyticsService } = require('./src/server/services/analytics-service');

// `HABIBI_ROOT` keeps filesystem-backed local integrations anchored to the
// workspace when this file runs from the compiled `dist/` production artifact.
const root = path.resolve(process.env.HABIBI_ROOT || __dirname);
const stateRoot = path.resolve(process.env.HABIBI_DATA_ROOT || root);
const builtInSkills = loadSkills(path.join(root, 'skills'));
const openwaClient = createOpenwaClient({ workspace:stateRoot });
let quickLookProcess = null;
let applicationIndex = { loadedAt:0, apps:[] };
const whatsappService = createWhatsAppService({ root:stateRoot, fs, spawn, openwaClient });
const llmService = createLlmService({ root:stateRoot, fs, spawn });
const kubernetesPlugin = createKubernetesPlugin({ llmService });
const skills = [...builtInSkills, kubernetesPlugin].sort((left, right) => left.name.localeCompare(right.name));
const agentSessions = createAgentSessionsPlugin({ fs });
const mcpBridge = createMcpBridge({ root:stateRoot, fs });
const approvals = createApprovalService();
const mailService = createMailService({ root:stateRoot, fs, spawn });
const importedSkills = createSkillImportService({ root, stateRoot, spawn });
const analytics = createAnalyticsService();

// Connector failures are reported to the local console but must never terminate
// the launcher. A failure to acquire the port is different: the process would
// keep running while serving nothing, so the launcher would appear to start and
// then silently do nothing. Those must exit loudly instead.
const fatalStartupCodes = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
process.on('unhandledRejection', error => console.error('[Habibi connector rejection]', error?.message || error));
process.on('uncaughtException', error => {
  if (fatalStartupCodes.has(error?.code)) {
    console.error(`[Habibi] cannot listen on ${HOST}:${PORT}: ${error.code}. Another Habibi or a development server is probably already running.`);
    process.exit(1);
  }
  console.error('[Habibi connector error]', error?.message || error);
});

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  if (!isTrustedLocalRequest(request)) return response.writeHead(403, { 'Content-Type':'application/json' }).end('{"ok":false,"error":"Local requests only"}');
  const url = new URL(request.url, 'http://127.0.0.1');
  const vendor = {
    '/vendor/xterm.js': 'assets/vendor/xterm.js',
    '/vendor/xterm.css': 'assets/vendor/xterm.css',
    '/vendor/xterm-fit.js': 'assets/vendor/xterm-fit.js',
    // Served locally rather than from a CDN: allowing a third-party script
    // origin in the CSP would defeat its no-inline-script protection.
    '/vendor/lucide.js': 'assets/vendor/lucide.js'
  };
  if (vendor[url.pathname]) {
    const file = path.join(root, vendor[url.pathname]);
    return fs.readFile(file, (error, data) => {
      if (error) return response.writeHead(404).end('Not found');
      response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      response.end(data);
    });
  }
  if (await whatsappService.handle({ request, response, url, json, safeJsonValue, requiresApproval:payload => approvals.consume(payload) })) return;
  if (url.pathname === '/api/analytics/capture' && request.method === 'POST') return readJson(request, response, body => {
    // Intentionally acknowledge immediately; product analytics must never delay the launcher.
    analytics.capture(body).catch(() => {});
    return json(response, { ok:true });
  });
  if (url.pathname === '/api/mail/status' && request.method === 'GET') return json(response, await mailService.status());
  if (url.pathname === '/api/mail/open' && request.method === 'POST') return readJson(request, response, body => {
    const target = mailService.webUrl(body);
    if (!target) return json(response, { ok:false, error:'That mail provider cannot be opened.' });
    spawn('open', [target], { detached:true, stdio:'ignore' }).unref();
    return json(response, { ok:true, provider:body.provider });
  });
  if (url.pathname === '/api/mail/configure' && request.method === 'POST') return readJson(request, response, body => json(response, mailService.configure(body)));
  if (url.pathname === '/api/mail/imap' && request.method === 'POST') return readJson(request, response, async body => json(response, await mailService.configureImap(body)));
  if (url.pathname === '/api/mail/remove' && request.method === 'POST') return readJson(request, response, async body => json(response, await mailService.remove(body.provider)));
  if (url.pathname === '/api/mail/threads' && request.method === 'GET') return json(response, await mailService.threads(url.searchParams.get('provider')));
  if (url.pathname === '/api/mail/search' && request.method === 'GET') {
    const query = String(url.searchParams.get('q') || '').trim();
    if (!query) return json(response, { ok:true, threads:[], plan:{ terms:[] } });
    const plan = await llmService.mailSearchPlan(query);
    return json(response, await mailService.search({ query, provider:url.searchParams.get('provider') || 'all', plan }));
  }
  if (url.pathname === '/api/mail/recent' && request.method === 'GET') return json(response, await mailService.recent({ provider:url.searchParams.get('provider'), hours:url.searchParams.get('hours') }));
  if (url.pathname === '/api/mail/message' && request.method === 'GET') return json(response, await mailService.message({ provider:url.searchParams.get('provider'), uid:url.searchParams.get('uid') }));
  if (url.pathname === '/api/mail/authorize' && request.method === 'POST') return readJson(request, response, body => json(response, mailService.authorize(body.provider)));
  if (url.pathname === '/api/mail/oauth/callback' && request.method === 'GET') {
    const result = await mailService.callback({ code:url.searchParams.get('code'), state:url.searchParams.get('state') });
    response.writeHead(result.ok ? 200 : 400, { 'Content-Type':'text/html; charset=utf-8' });
    return response.end(`<title>Habibi Mail</title><body style="font-family:-apple-system,sans-serif;padding:40px">${result.ok ? 'Mail connected. You can close this tab and return to Habibi.' : `Mail connection failed: ${String(result.error || 'Unknown error').replace(/</g, '&lt;')}`}</body>`);
  }
  if (url.pathname === '/api/mail/send' && request.method === 'POST') return readJson(request, response, async body => {
    const payload = { provider:String(body.provider || ''), to:String(body.to || ''), subject:String(body.subject || ''), body:String(body.body || '') };
    if (!approvals.consume({ token:body.approvalToken, action:'mail.send', payload })) return json(response, { ok:false, error:'Sending needs explicit approval' });
    return json(response, await mailService.send(payload));
  });
  if (url.pathname === '/api/approvals' && request.method === 'POST') return readJson(request, response, body => {
    const action = String(body.action || '');
    if (!/^(?:whatsapp\.send|mail\.send|calendar\.(?:create|update)|agent-skill\.execute|running-app\.(?:quit|force)|system\.(?:sleep|restart|shutdown|lock|darkMode|emptyTrash))$/.test(action)) return json(response, { ok:false, error:'Unsupported approval action' });
    // The token is bound to this exact payload. The consuming route re-derives
    // the fingerprint from its own request body, so a token issued for one
    // message, event or skill call cannot authorize a different one.
    return json(response, { ok:true, approval:approvals.issue(action, body.payload) });
  });
  if (url.pathname === '/api/llm/status' && request.method === 'GET') return json(response, await llmService.configured());
  if (url.pathname === '/api/agent-skills' && request.method === 'GET') return json(response, { ok:true, skills:importedSkills.list() });
  if (url.pathname === '/api/agent-skills/preview' && request.method === 'POST') return readJson(request, response, async body => json(response, await importedSkills.preview(String(body.id || ''))));
  if (url.pathname === '/api/agent-skills/execute' && request.method === 'POST') return readJson(request, response, async body => {
    const id = String(body.id || '');
    const toolName = body.toolName ? String(body.toolName) : undefined;
    if (!approvals.consume({ token:body.approvalToken, action:'agent-skill.execute', payload:{ id, toolName:toolName ?? null, toolInput:body.toolInput ?? null } })) return json(response, { ok:false, error:'Running an imported skill needs explicit approval.' });
    return json(response, await importedSkills.execute({ id, toolName, toolInput:body.toolInput }));
  });
  if (url.pathname === '/api/mcp/servers' && request.method === 'GET') return json(response, { ok:true, servers:mcpBridge.list() });
  if (url.pathname === '/api/mcp/tools' && request.method === 'GET') return json(response, await mcpBridge.discover(url.searchParams.get('server')));
  if (url.pathname === '/api/llm/models' && request.method === 'GET') return json(response, await llmService.models({ provider:url.searchParams.get('provider'), endpoint:url.searchParams.get('endpoint') }));
  if (url.pathname === '/api/llm/models' && request.method === 'POST') return readJson(request, response, async body => json(response, await llmService.models({ provider:body.provider, endpoint:body.endpoint, apiKey:body.apiKey })));
  if (url.pathname === '/api/llm/configure' && request.method === 'POST') return readJson(request, response, async body => json(response, await llmService.configure(body)));
  if (url.pathname === '/api/llm/chat' && request.method === 'POST') return readJson(request, response, async body => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return json(response, await llmService.complete({ messages }));
  });
  if (url.pathname === '/api/agent/files/investigate' && request.method === 'POST') return readJson(request, response, async body => {
    const history = Array.isArray(body.history) ? body.history
      .filter(turn => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.text === 'string')
      .slice(-8).map(turn => ({ role:turn.role, text:turn.text.slice(0, 1200) })) : [];
    const plan = await llmService.planFileInvestigation({ history });
    if (plan.phase === 'not_applicable') return json(response, { ok:true, phase:'not_applicable' });
    if (plan.phase === 'clarify') return json(response, { ok:true, phase:'clarify', question:plan.question, trace:[{ tool:'Local file planner', detail:'Need one detail before searching accurately.' }] });
    const window = relativeFileWindow(history.filter(turn => turn.role === 'user').at(-1)?.text || '');
    const searches = await Promise.all((plan.queries || []).slice(0, 3).map(query => findLocalFiles(query, 10, { window })));
    const seen = new Set();
    const candidates = searches.flat().filter(file => {
      if (seen.has(file.path)) return false;
      seen.add(file.path); return true;
    }).slice(0, 18);
    const ranked = await llmService.rankFileCandidates({ history, candidates });
    const order = new Map((ranked.ids || []).map((id, index) => [id, index]));
    candidates.sort((a, b) => (order.get(a.path) ?? 999) - (order.get(b.path) ?? 999) || b.score - a.score);
    const files = candidates.slice(0, 8).map(({ score, ...file }) => file);
    const summary = files.length ? (ranked.ids?.length ? (ranked.summary || `I found ${files.length} likely local file${files.length === 1 ? '' : 's'} to review.`) : `I found ${files.length} likely local file${files.length === 1 ? '' : 's'} to review.`) : (ranked.summary || 'I did not find a close match yet. What country, year, or document name should I try?');
    return json(response, { ok:true, phase:'results', summary, files, searched:plan.queries || [], trace:[
      { tool:'Local file planner', detail:`Prepared ${(plan.queries || []).length} focused filename search${(plan.queries || []).length === 1 ? '' : 'es'}.` },
      { tool:'Filename search', detail:files.length ? `Found ${files.length} candidate${files.length === 1 ? '' : 's'} locally.` : 'No close filename candidates yet.' },
      { tool:'Local ranker', detail:files.length ? 'Ranked candidates using names and locations.' : 'Suggested the next refinement.' },
    ] });
  });
  if (url.pathname === '/api/agent/route' && request.method === 'POST') return readJson(request, response, async body => json(response, await llmService.route({ text:String(body.text || ''), context:String(body.context || '') })));
  if (url.pathname === '/api/file' && request.method === 'GET') {
    const requested = url.searchParams.get('path') || '';
    const home = path.resolve(process.env.HOME || '/');
    const target = path.resolve(requested);
    if (!target.startsWith(`${home}${path.sep}`) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return response.writeHead(404).end('Not found');
    const mime = { '.pdf':'application/pdf', '.txt':'text/plain; charset=utf-8', '.md':'text/markdown; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.heic':'image/heic' }[path.extname(target).toLowerCase()] || 'application/octet-stream';
    // Node rejects a header value containing CR or LF by throwing, which the
    // uncaughtException handler would swallow and leave the request hanging. Keep
    // only characters that are safe unquoted, and fall back to a generic name.
    const filename = path.basename(target).replace(/[^\w .-]/g, '_').slice(0, 200) || 'file';
    response.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${filename}"` });
    fs.createReadStream(target).pipe(response);
    return;
  }
  if (url.pathname === '/api/open-file' && request.method === 'POST') return readJson(request, response, body => {
    const target = homePath(body.path);
    if (!target) return json(response, { ok:false });
    spawn('open', [target], { detached:true, stdio:'ignore' }).unref();
    return json(response, { ok:true });
  });
  if (url.pathname === '/api/open-app' && request.method === 'POST') return readJson(request, response, body => {
    const target = path.resolve(String(body.path || ''));
    const allowedRoots = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', path.join(process.env.HOME || '/', 'Applications/')];
    if (!target.endsWith('.app') || !allowedRoots.some(prefix => target.startsWith(prefix)) || !fs.existsSync(target)) return json(response, { ok:false });
    // Wait until Launch Services has accepted the request. This gives the UI a
    // truthful “Opening…” state instead of immediately claiming success while
    // macOS is still doing the launch work in the background.
    const task = spawn('open', [target], { stdio:'ignore' });
    task.once('error', () => json(response, { ok:false }));
    task.once('close', code => json(response, { ok:code === 0 }));
    return;
  });
  if (url.pathname === '/api/app-icon' && request.method === 'GET') {
    const target = path.resolve(url.searchParams.get('path') || '');
    const allowedRoots = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', path.join(process.env.HOME || '/', 'Applications/')];
    if (!target.endsWith('.app') || !allowedRoots.some(prefix => target.startsWith(prefix)) || !fs.existsSync(target)) return response.writeHead(404).end('Not found');
    const cacheDir = path.join(stateRoot, 'app-icons');
    const cacheFile = path.join(cacheDir, `${Buffer.from(target).toString('base64url')}.png`);
    const sendIcon = () => fs.readFile(cacheFile, (error, data) => {
      if (error) return response.writeHead(404).end('Not found');
      response.writeHead(200, { 'Content-Type':'image/png', 'Cache-Control':'private, max-age=86400' }); response.end(data);
    });
    if (fs.existsSync(cacheFile)) return sendIcon();
    const resourceDir = path.join(target, 'Contents', 'Resources');
    const icon = fs.existsSync(resourceDir) ? fs.readdirSync(resourceDir).find(file => file.toLowerCase().endsWith('.icns')) : null;
    if (!icon) return response.writeHead(404).end('Not found');
    fs.mkdirSync(cacheDir, { recursive:true });
    const converter = spawn('sips', ['-s', 'format', 'png', path.join(resourceDir, icon), '--out', cacheFile]);
    converter.on('error', () => response.writeHead(404).end('Not found'));
    converter.on('close', code => code === 0 ? sendIcon() : response.writeHead(404).end('Not found'));
    return;
  }
  if (url.pathname === '/api/open-folder' && request.method === 'POST') {
    return readJson(request, response, body => {
      const home = process.env.HOME || '';
      const folders = { Downloads:path.join(home, 'Downloads'), Documents:path.join(home, 'Documents'), Desktop:path.join(home, 'Desktop'), Home:home };
      const target = folders[String(body.folder || '')];
      if (!target || !fs.existsSync(target)) return json(response, { ok:false });
      spawn('open', [target], { detached:true, stdio:'ignore' }).unref();
      return json(response, { ok:true });
    });
  }
  if (url.pathname === '/api/apps' && request.method === 'GET') return applications(url.searchParams.get('q') || '').then(apps => json(response, { ok:true, apps }));
  if (url.pathname === '/api/kubernetes/query' && request.method === 'POST') return readJson(request, response, async body => json(response, await runKubernetesReadQuery(String(body.query || ''), String(body.context || ''), String(body.namespace || ''))));
  if (url.pathname === '/api/kubernetes/plan' && request.method === 'POST') return readJson(request, response, async body => json(response, await planKubernetesNaturalQuery(String(body.query || ''), String(body.context || ''), String(body.namespace || ''))));
  if (url.pathname === '/api/kubernetes/diagnose' && request.method === 'POST') return readJson(request, response, async body => json(response, await diagnoseKubernetes(String(body.query || ''), String(body.context || ''), String(body.namespace || ''))));
  if (url.pathname === '/api/kubernetes/resources' && request.method === 'POST') return readJson(request, response, async body => json(response, await kubernetesResourceList(body)));
  if (url.pathname === '/api/kubernetes/detail' && request.method === 'POST') return readJson(request, response, async body => json(response, await kubernetesResourceDetail(body)));
  if (url.pathname === '/api/kubernetes/logs' && request.method === 'POST') return readJson(request, response, async body => json(response, await kubernetesPodLogs(body)));
  if (url.pathname === '/api/kubernetes/overview' && request.method === 'GET') return json(response, await kubernetesOverview(url.searchParams.get('context') || '', url.searchParams.get('namespace') || ''));
  if (url.pathname === '/api/running-apps' && request.method === 'GET') return runningApplications().then(apps => json(response, { ok:true, apps })).catch(() => json(response, { ok:false, apps:[] }));
  if (url.pathname === '/api/running-apps/action' && request.method === 'POST') return readJson(request, response, async body => {
    const mode = body.mode === 'force' ? 'force' : body.mode === 'quit' ? 'quit' : null;
    const pids = [...new Set((Array.isArray(body.pids) ? body.pids : []).map(Number).filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid))].slice(0, 64);
    const app = String(body.app || '').slice(0, 160);
    const payload = { app, mode, pids };
    if (!mode || !app || !pids.length) return json(response, { ok:false, error:'Choose an open application first.' });
    if (!approvals.consume({ token:body.approvalToken, action:`running-app.${mode}`, payload })) return json(response, { ok:false, error:'Quitting an app needs explicit approval.' });
    const current = await runningApplications();
    const target = current.find(item => item.name === app && item.pids.length === pids.length && item.pids.every(pid => pids.includes(pid)));
    if (!target) return json(response, { ok:false, error:'That app is no longer running. Refresh the list and try again.' });
    let stopped = 0;
    for (const pid of pids) {
      try { process.kill(pid, mode === 'force' ? 'SIGKILL' : 'SIGTERM'); stopped += 1; } catch (_) { /* A process may exit between listing and action. */ }
    }
    return json(response, { ok:stopped > 0, stopped });
  });
  if (url.pathname === '/api/open-url' && request.method === 'POST') {
    return readJson(request, response, body => {
      try {
        const target = new URL(String(body.url || ''));
        const host = target.hostname.toLowerCase();
        const allowed = target.protocol === 'https:' && (host === 'google.com' || host.endsWith('.google.com') || host === 'airbnb.com' || host.endsWith('.airbnb.com') || host === 'airbnb.co.uk' || host.endsWith('.airbnb.co.uk'));
        if (!allowed) return json(response, { ok:false });
        spawn('open', [target.toString()], { detached:true, stdio:'ignore' }).unref();
        return json(response, { ok:true });
      } catch (_) { return json(response, { ok:false }); }
    });
  }
  if (url.pathname === '/api/system/action' && request.method === 'POST') return readJson(request, response, body => {
    const action = String(body.action || '');
    const openActions = { applications:['open', ['/Applications']], settings:['open', ['-a', 'System Settings']] };
    if (openActions[action]) { const [command, args] = openActions[action]; spawn(command, args, { detached:true, stdio:'ignore' }).unref(); return json(response, { ok:true }); }
    if (!['sleep','restart','shutdown','lock','darkMode','emptyTrash'].includes(action)) return json(response, { ok:false, error:'Unknown system action' });
    if (!approvals.consume({ token:body.approvalToken, action:`system.${action}`, payload:{ action } })) return json(response, { ok:false, error:'This system action needs explicit approval.' });
    const commands = {
      sleep:['osascript', ['-e', 'tell application "System Events" to sleep']], restart:['osascript', ['-e', 'tell application "System Events" to restart']], shutdown:['osascript', ['-e', 'tell application "System Events" to shut down']], lock:['/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']], darkMode:['osascript', ['-e', 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode']], emptyTrash:['osascript', ['-e', 'tell application "Finder" to empty the trash']]
    };
    const [command, args] = commands[action]; spawn(command, args, { detached:true, stdio:'ignore' }).unref(); return json(response, { ok:true });
  });
  if (url.pathname === '/api/preview-file' && request.method === 'POST') return readJson(request, response, body => {
    const target = homePath(body.path);
    if (!target) return json(response, { ok:false });
    spawn('qlmanage', ['-p', target], { detached:true, stdio:'ignore' }).unref();
    return json(response, { ok:true });
  });
  if (url.pathname === '/api/quick-look' && request.method === 'POST') return readJson(request, response, body => {
    if (quickLookProcess && quickLookProcess.exitCode === null) {
      quickLookProcess.kill('SIGTERM');
      quickLookProcess = null;
      return json(response, { ok:true, state:'closed' });
    }
    const target = homePath(body.path);
    if (!target) return json(response, { ok:false });
    quickLookProcess = spawn('qlmanage', ['-p', target], { stdio:'ignore' });
    quickLookProcess.on('error', () => { quickLookProcess = null; });
    quickLookProcess.on('close', () => { quickLookProcess = null; });
    return json(response, { ok:true, state:'opened' });
  });
  if (url.pathname === '/api/files') {
    const query = url.searchParams.get('q') || '';
    // Keep natural timing words in the request. `findLocalFiles` removes them
    // from the filename predicate but uses them to prefer the files a person
    // just created, downloaded, or viewed—rather than an old project folder.
    return findLocalFiles(query, 8, { window: relativeFileWindow(query) }).then(files => json(response, files));
    return;
  }
  if (url.pathname === '/api/calendars' && request.method === 'GET') {
    return runJxa('function run(argv){ return JSON.stringify(Application("Calendar").calendars.name()); }', [], (error, output) => {
      if (error) return json(response, { ok: false, calendars: [] });
      try { json(response, { ok: true, calendars: JSON.parse(output) }); } catch (_) { json(response, { ok: false, calendars: [] }); }
    });
  }
  if (url.pathname === '/api/calendar/event' && request.method === 'POST') return readJson(request, response, event => {
    const payload = { title:String(event.title || ''), calendar:String(event.calendar || ''), start:String(event.start || ''), end:String(event.end || '') };
    if (!approvals.consume({ token:event.approvalToken, action:'calendar.create', payload })) return json(response, { ok:false, error:'Calendar creation needs explicit approval' });
    const script = 'function run(argv){ const app=Application("Calendar"); const calendar=app.calendars.byName(argv[0]); const item=app.Event({summary:argv[1],startDate:new Date(argv[2]),endDate:new Date(argv[3])}); calendar.events.push(item); }';
    return runJxa(script, [payload.calendar, payload.title, payload.start, payload.end], error => json(response, { ok: !error }));
  });
  // Reading the calendar goes through EventKit in the native app, which is the
  // only supported client. There is deliberately no HTTP route for it: the
  // previous one shelled out to a helper binary that was never committed, and
  // querying Calendar over AppleEvents took 90+ seconds to return a 14-day
  // window.
  if (url.pathname === '/api/calendar/event/update' && request.method === 'POST') return readJson(request, response, event => {
    const payload = { id:String(event.id || ''), title:String(event.title || ''), calendar:String(event.calendar || ''), start:String(event.start || ''), end:String(event.end || '') };
    if (!approvals.consume({ token:event.approvalToken, action:'calendar.update', payload })) return json(response, { ok:false, error:'Calendar changes need explicit approval' });
    const script = 'function run(argv){ const app=Application("Calendar"); const calendar=app.calendars.whose({name:argv[0]})[0]; const item=calendar.events.byId(argv[1]); item.summary=argv[2]; item.startDate=new Date(argv[3]); item.endDate=new Date(argv[4]); }';
    return runJxa(script, [payload.calendar, payload.id, payload.title, payload.start, payload.end], error => json(response, { ok: !error }));
  });
  if (url.pathname === '/api/agents' && request.method === 'GET') {
    const processes = spawn('ps', ['-axo', 'pid=,etime=,command=']);
    let output = '';
    processes.stdout.on('data', chunk => { output += chunk; });
    processes.on('error', () => json(response, { ok: false, agents: [] }));
    processes.on('close', () => {
      const agents = output.split('\n').map(line => line.trim()).filter(Boolean)
        .filter(line => /(?:^|\s)(codex|claude)(?:\s|$|[-_])/i.test(line))
        .slice(0, 20)
        .map(line => {
          const [, pid, elapsed, command] = line.match(/^(\d+)\s+(\S+)\s+(.+)$/) || [];
          return { pid, elapsed, command };
        }).filter(agent => agent.pid);
      Promise.all(agents.map(async agent => ({ ...agent, cwd: await agentWorkingDirectory(agent.pid) })))
        .then(items => json(response, { ok: true, agents: items }));
    });
    return;
  }
  if (url.pathname === '/api/agent-sessions' && request.method === 'GET') return json(response, agentSessions.list({ kind:url.searchParams.get('kind') || '', query:url.searchParams.get('q') || '' }));
  if (url.pathname === '/api/agent-sessions/detail' && request.method === 'POST') return readJson(request, response, body => json(response, agentSessions.detail({ id:String(body.id || ''), kind:String(body.kind || '') })));
  if (url.pathname === '/api/skills' && request.method === 'GET') return json(response, { ok:true, skills });
  if (url.pathname === '/api/agents/open-project' && request.method === 'POST') {
    return handleAgentAction(request, response, cwd => spawn('open', [cwd], { detached: true, stdio: 'ignore' }).unref());
  }
  if (url.pathname === '/api/agents/resume' && request.method === 'POST') {
    return handleAgentAction(request, response, (cwd, kind) => {
      const command = kind === 'claude' ? 'claude --resume' : 'codex resume';
      spawn('osascript', ['-e', resumeScript, cwd, command], { detached: true, stdio: 'ignore' }).unref();
    });
  }
  const file = resolveStaticAsset(url.pathname, root);
  if (!file) return response.writeHead(404).end('Not found');
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Content-Type': staticContentType(file), 'Cache-Control':'no-store' });
    response.end(data);
  });
});

const ptyServer = new WebSocket.Server({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (!isTrustedLocalRequest(request)) return socket.destroy();
  // This endpoint hands out a login shell, so it is held to a stricter standard
  // than the HTTP routes: an absent Origin is tolerated there for non-browser
  // callers, but every browser sends one when opening a WebSocket. Requiring it
  // means another local process cannot claim a terminal by omitting the header.
  if (!isBrowserOrigin(request)) return socket.destroy();
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname !== '/pty') return socket.destroy();
  ptyServer.handleUpgrade(request, socket, head, ws => ptyServer.emit('connection', ws));
});
ptyServer.on('connection', ws => {
  let session = null;
  ws.on('message', payload => {
    try {
      const message = JSON.parse(payload.toString());
      if (message.type === 'start' && !session) {
        // Loading the native PTY binding is unnecessary for ordinary launcher,
        // mail, file, and chat use. Initialize it only for an interactive agent
        // terminal and retain Node's module cache afterward.
        const pty = require('node-pty');
        const home = path.resolve(process.env.HOME || '/');
        if (typeof message.cwd !== 'string') return ws.send(JSON.stringify({ type:'error', message:'Project directory unavailable' }));
        const cwd = path.resolve(message.cwd);
        if (!cwd.startsWith(`${home}${path.sep}`) || !fs.existsSync(cwd)) return ws.send(JSON.stringify({ type:'error', message:'Project directory unavailable' }));
        const kind = message.kind === 'claude' ? 'claude' : 'codex';
        const sessionId = typeof message.sessionId === 'string' && /^[0-9a-f-]{16,80}$/i.test(message.sessionId) ? message.sessionId : '';
        const command = kind === 'claude' ? ['claude', '--resume', ...(sessionId ? [sessionId] : [])] : ['codex', 'resume', ...(sessionId ? [sessionId] : [])];
        session = pty.spawn(process.env.SHELL || '/bin/zsh', ['-lc', command.map(value => `'${value.replace(/'/g, "'\\\"'\\\"")}'`).join(' ')], { name:'xterm-256color', cols:120, rows:32, cwd, env:process.env });
        session.onData(data => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type:'data', data })));
        session.onExit(({ exitCode }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'exit', exitCode })); });
        ws.send(JSON.stringify({ type:'started', kind }));
      }
      // Anything below is written straight into a live shell or handed to the
      // pty's own resize call, so the shapes are checked rather than trusted:
      // a non-string write or a NaN dimension reaches native code.
      if (message.type === 'input' && session && typeof message.data === 'string') session.write(message.data);
      if (message.type === 'resize' && session) {
        const cols = Number(message.cols);
        const rows = Number(message.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          session.resize(Math.min(1000, Math.max(20, Math.trunc(cols))), Math.min(1000, Math.max(5, Math.trunc(rows))));
        }
      }
    } catch (_) { ws.send(JSON.stringify({ type:'error', message:'Invalid terminal message' })); }
  });
  ws.on('close', () => { if (session) session.kill(); });
});
server.on('error', error => {
  if (!fatalStartupCodes.has(error?.code)) throw error;
  console.error(`[Habibi] cannot listen on ${HOST}:${PORT}: ${error.code}. Another Habibi or a development server is probably already running.`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`Habibi running at http://${HOST}:${PORT}`));

function json(response, payload) {
  try {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  } catch (_) {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type':'application/json' });
    response.end('{"ok":false,"error":"Could not serialize local response"}');
  }
}

function readJson(request, response, handler) {
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
  request.on('end', async () => {
    try { await handler(JSON.parse(body || '{}')); }
    catch (_) { json(response, { ok:false, error:'Invalid request.' }); }
  });
}

function safeJsonValue(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
}

function isNoisePath(file) {
  return ['/node_modules/', '/.git/', '/Library/', '/.Trash/', '/.cache/', '/vendor/', '/venv/', '/.venv/', '/site-packages/', '/__pycache__/'].some(part => file.includes(part));
}

function matchesFileIntent(file, query) {
  const typeQueries = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md']);
  const tokens = query.toLowerCase().split(/[\s._-]+/).filter(token => token.length >= 2);
  const name = path.basename(file).toLowerCase();
  return (!typeQueries.has(query.toLowerCase()) || name.endsWith(`.${query.toLowerCase()}`)) && tokens.every(token => name.includes(token));
}

function makeFileResult(file, query) {
  // Spotlight has already produced this filename. Do not stat it again:
  // `stat` on Documents/Downloads is enough for TCC to present a protected
  // folder prompt, even though Habibi only needs metadata to rank the row.
  const name = path.basename(file);
  const lowerName = name.toLowerCase();
  const queryTokens = query.toLowerCase().split(/[\s._-]+/).filter(token => token.length >= 2);
  const lowerQuery = query.toLowerCase();
  const folder = primaryFolder(file);
  const folderRank = { Documents: 90, Desktop: 75, Downloads: 60, Projects: 35, Home: 15 }[folder] || 5;
  const stem = lowerName.replace(/\.[^.]+$/, '');
  const extension = path.extname(lowerName);
  const isImage = /\.(?:avif|gif|heic|jpe?g|png|webp)$/.test(extension);
  const screenshotIntent = /(?:screenshot|screen[ ._-]?shot)/i.test(query);
  const exact = stem === lowerQuery || lowerName === lowerQuery;
  const starts = stem.startsWith(lowerQuery) || queryTokens.every(token => stem.startsWith(token));
  const nameRank = exact ? 120 : starts ? 80 : queryTokens.reduce((score, token) => score + (stem.includes(token) ? 22 : 0), 0);
  const shallowRank = Math.max(0, 20 - path.relative(process.env.HOME || '/', file).split(path.sep).length * 2);
  // A query for “screenshots” should surface the recent screenshot images on
  // Desktop before similarly named source folders. This stays entirely local
  // and uses filename metadata only, so ranking does not trigger a TCC read
  // prompt for every candidate.
  const kindRank = screenshotIntent ? (isImage ? 95 : extension ? 0 : -95) : extension ? 4 : 0;
  const timestamp = fileNameTimestamp(file);
  const age = timestamp ? Math.max(0, Date.now() - timestamp) : Infinity;
  const recencyRank = age < 48 * 60 * 60 * 1000 ? 65
    : age < 7 * 24 * 60 * 60 * 1000 ? 42
      : age < 31 * 24 * 60 * 60 * 1000 ? 18 : 0;
  return {
    path: file,
    name,
    folder,
    directory: path.dirname(file).replace(process.env.HOME || '', '~'),
    score: folderRank + nameRank + shallowRank + kindRank + recencyRank,
    fileTimestamp: timestamp
  };
}

function primaryFolder(file) {
  const home = process.env.HOME || '';
  const relative = path.relative(home, file);
  const first = relative.split(path.sep)[0];
  if (first === 'Documents') return 'Documents';
  if (first === 'Desktop') return 'Desktop';
  if (first === 'Downloads') return 'Downloads';
  if (['Developer', 'Projects', 'Code'].includes(first)) return 'Projects';
  return 'Home';
}

function uniqueFileName() {
  const seen = new Set();
  return file => {
    const key = file.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function relativeFileWindow(request) {
  const text = String(request || '').toLowerCase();
  const now = new Date();
  if (/\b(?:last night|yesterday(?: evening| night)?)\b/.test(text)) return { after:new Date(now.getTime() - 36 * 60 * 60 * 1000), before:now };
  if (/\b(?:latest|recent|newest)\b/.test(text)) return { after:new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), before:now };
  return null;
}

function normalizedFileQuery(query) {
  return String(query || '').replace(/\b(?:last|night|yesterday|today|latest|recent|newest|from|the|ones?|files?)\b/gi, ' ').replace(/\b(\w{4,})s\b/g, '$1').replace(/[^a-zA-Z0-9 ._\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function findLocalFiles(query, limit = 8, { window = null } = {}) {
  const safeQuery = normalizedFileQuery(query);
  if (safeQuery.length < 2) return Promise.resolve([]);
  const tokens = safeQuery.split(/[\s._-]+/).filter(token => token.length >= 2).slice(0, 5);
  if (!tokens.length) return Promise.resolve([]);
  const terms = tokens.map(token => `kMDItemFSName == "*${token.replace(/"/g, '')}*"cd`);
  if (window?.after instanceof Date) terms.push(`kMDItemFSContentChangeDate >= $time.iso(${window.after.toISOString()})`);
  if (window?.before instanceof Date) terms.push(`kMDItemFSContentChangeDate <= $time.iso(${window.before.toISOString()})`);
  const predicate = terms.join(' && ');
  return new Promise(resolve => {
    const finder = spawn('mdfind', ['-onlyin', process.env.HOME || '/', predicate]);
    let output = '';
    finder.stdout.on('data', chunk => { output += chunk; });
    // Spotlight metadata searches do not require Habibi to enumerate protected
    // user folders. Never silently fall back to `find ~/Documents` et al:
    // that makes macOS repeatedly display a folder-access prompt, especially
    // while a local build is using an ad-hoc signing identity.
    finder.on('error', () => resolve(findLocalFilesFallback(safeQuery, limit, window)));
    finder.on('close', () => {
      const spotlight = output.split('\n').filter(Boolean)
      .filter(file => !isNoisePath(file) && matchesFileIntent(file, safeQuery))
      .map(file => makeFileResult(file, safeQuery))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .filter(uniqueFileName())
      .slice(0, limit);
      const fallback = findLocalFilesFallback(safeQuery, limit, window);
      const seen = new Set();
      resolve([...fallback, ...spotlight].filter(file => {
        if (seen.has(file.path)) return false;
        seen.add(file.path); return true;
      }).sort((left, right) => right.score - left.score || right.fileTimestamp - left.fileTimestamp).slice(0, limit));
    });
  });
}

function fileNameMatchesWindow(file, window) {
  if (!window?.after) return true;
  // macOS screenshots encode their capture time in the filename. Using that
  // metadata avoids reading file contents or recursively walking a protected
  // directory just to answer a recent-screenshot request.
  const match = path.basename(file).match(/(20\d{2}-\d{2}-\d{2})\s+(?:at\s+)?(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)/i);
  if (!match) return true;
  const candidate = new Date(`${match[1]}T${match[2].replace(/\./g, ':')}`);
  return !Number.isNaN(candidate.getTime()) && candidate >= window.after && (!window.before || candidate <= window.before);
}

function fileNameTimestamp(file) {
  const match = path.basename(file).match(/(20\d{2}-\d{2}-\d{2})\s+(?:at\s+)?(\d{1,2}[.:]\d{2}(?:[.:]\d{2})?)/i);
  if (!match) return 0;
  const value = new Date(`${match[1]}T${match[2].replace(/\./g, ':')}`).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function findLocalFilesFallback(query, limit, window) {
  const home = process.env.HOME || '';
  const directories = ['Desktop', 'Documents', 'Downloads'].map(folder => path.join(home, folder));
  const files = directories.flatMap(directory => {
    try { return fs.readdirSync(directory, { withFileTypes:true }).filter(entry => entry.isFile() && matchesFileIntent(entry.name, query) && fileNameMatchesWindow(path.join(directory, entry.name), window)).map(entry => path.join(directory, entry.name)); }
    catch (_) { return []; }
  });
  return files.sort((left, right) => fileNameTimestamp(right) - fileNameTimestamp(left)).map(file => ({ ...makeFileResult(file, query), fileTimestamp:fileNameTimestamp(file) })).filter(Boolean).sort((left, right) => right.score - left.score || right.fileTimestamp - left.fileTimestamp).filter(uniqueFileName()).slice(0, limit);
}


function applications(query) {
  // A global Spotlight application query can take minutes while its index is
  // cold, which left the launcher with an empty app list. The normal macOS
  // application roots are tiny and deterministic; scan those synchronously
  // and keep the result warm. Spotlight remains the file index, not an
  // interactive dependency for opening an app.
  const refresh = () => {
    const roots = [
      '/Applications',
      '/System/Applications',
      '/System/Library/CoreServices',
      path.join(process.env.HOME || '/', 'Applications'),
    ];
    const seen = new Set();
    const discoverBundles = (root, depth = 0) => {
      // Terminal and the rest of macOS Utilities live below
      // /System/Applications. Walk only a few directory levels, stop at every
      // .app bundle, and never crawl its Contents — comprehensive discovery
      // without turning an interactive launcher query into a filesystem crawl.
      if (depth > 3) return [];
      let entries;
      try { entries = fs.readdirSync(root, { withFileTypes:true }); } catch (_) { return []; }
      return entries.flatMap(entry => {
        const candidate = path.join(root, entry.name);
        const isBundle = entry.name.endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink());
        if (isBundle) return [candidate];
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) return [];
        return discoverBundles(candidate, depth + 1);
      });
    };
    const apps = roots.flatMap(root => discoverBundles(root)).filter(pathname => {
      const key = pathname.toLowerCase();
      if (seen.has(key) || !fs.existsSync(pathname)) return false;
      seen.add(key);
      return true;
    }).map(pathname => ({ path:pathname, name:path.basename(pathname, '.app') }))
      // System bundles include many invisible menu extras and support agents.
      // They are not launchable apps a person expects from a Spotlight-style
      // query, and most expose macOS's generic question-mark icon.
      .filter(app => !/(?:agent|assistant|daemon|service|helper|server|launcher|messenger|url handler|authwarn|accesscontrol|mac)$/i.test(app.name));
    // CoreServices is mostly implementation plumbing (text input switchers,
    // preview shells, background UI helpers). Only retain its two familiar
    // user-facing entry points; everything else belongs to macOS, not search.
    const visibleApps = apps.filter(app => !app.path.startsWith('/System/Library/CoreServices/') || ['Finder', 'Time Machine'].includes(app.name));
    applicationIndex = { loadedAt:Date.now(), apps:visibleApps };
    return visibleApps;
  };
  const source = Date.now() - applicationIndex.loadedAt < 5 * 60_000 ? applicationIndex.apps : refresh();
  const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  return Promise.resolve(source).then(items => items.filter(item => {
    const compactName = item.name.toLowerCase();
    const nameWords = item.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s._-]+/).filter(Boolean);
    // Keep the unsplit name too: `WhatsApp` should match both `whatsapp`
    // and `whats app`, while camel-case app names remain easy to discover.
    return words.every(word => compactName.startsWith(word) || nameWords.some(nameWord => nameWord.startsWith(word)));
  }).sort((a, b) => {
    const aName = a.name.toLowerCase(); const bName = b.name.toLowerCase(); const needle = words.join(' ');
    return Number(bName === needle) - Number(aName === needle) || Number(bName.startsWith(needle)) - Number(aName.startsWith(needle)) || aName.localeCompare(bName);
  }).slice(0, 8));
}

function runningApplications() {
  return applications('').then(() => new Promise(resolve => {
    const byPath = new Map();
    for (const app of applicationIndex.apps) {
      byPath.set(app.path, app);
      try { byPath.set(fs.realpathSync(app.path), app); } catch (_) { /* A removed app is ignored on refresh. */ }
    }
    const task = spawn('ps', ['-axo', 'pid=,pcpu=,rss=,command=']);
    let stdout = '';
    task.stdout.on('data', chunk => { stdout += chunk; });
    task.on('error', () => resolve([]));
    task.on('close', () => {
      const groups = new Map();
      for (const line of stdout.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        const [, pidValue, cpuValue, rssValue, command] = match;
        // The process command can point at a symlink target in the sealed
        // system volume. Match both the discovered path and its real path.
        const bundleMatch = command.match(/(\/(?:Applications|System\/Applications|System\/Cryptexes\/App\/System\/Applications|Users\/[^/]+\/Applications)\/.*?\.app)(?:\/|$)/);
        if (!bundleMatch) continue;
        const bundlePath = bundleMatch[1];
        let app = byPath.get(bundlePath);
        if (!app) { try { app = byPath.get(fs.realpathSync(bundlePath)); } catch (_) { /* Unknown bundle. */ } }
        if (!app || app.name === 'Habibi') continue;
        const group = groups.get(app.path) || { name:app.name, path:app.path, pids:[], cpu:0, memoryMb:0 };
        group.pids.push(Number(pidValue));
        group.cpu += Number(cpuValue) || 0;
        group.memoryMb += (Number(rssValue) || 0) / 1024;
        groups.set(app.path, group);
      }
      resolve([...groups.values()].map(item => ({ ...item, cpu:Number(item.cpu.toFixed(1)), memoryMb:Math.max(1, Math.round(item.memoryMb)) })).sort((a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb || a.name.localeCompare(b.name)));
    });
  }));
}

function parseKubernetesReadQuery(input, preferredContext = '') {
  const query = String(input || '').trim().replace(/^(?:k8s|kubernetes)\s+/i, '').replace(/^kubectl\s+/i, '');
  const parts = query.split(/\s+/).filter(Boolean);
  const verb = (parts.shift() || '').toLowerCase();
  const values = [];
  let namespace = '';
  let context = preferredContext;
  let container = '';
  let allNamespaces = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '-n' || part === '--namespace') { namespace = parts[++index] || ''; continue; }
    if (part === '--context') { context = parts[++index] || ''; continue; }
    if (part === '-c' || part === '--container') { container = parts[++index] || ''; continue; }
    if (part === '-A' || part === '--all-namespaces') { allNamespaces = true; continue; }
    if (part.startsWith('-')) throw new Error(`Flag ${part} is not available in Habibi's read-only Kubernetes plugin.`);
    values.push(part);
  }
  const resourceAliases = { po:'pods', pod:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', ns:'namespaces', no:'nodes' };
  const resource = resourceAliases[(values[0] || '').toLowerCase()] || (values[0] || '').toLowerCase();
  const allowedResources = new Set(['pods', 'deployments', 'services', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs', 'configmaps', 'secrets', 'ingresses', 'namespaces', 'nodes', 'events']);
  const withScope = args => [...args, ...(allNamespaces ? ['--all-namespaces'] : namespace ? ['--namespace', namespace] : []), ...(context ? ['--context', context] : [])];
  if (verb === 'events' || (verb === 'get' && resource === 'events')) return { action:'events', args:withScope(['get', 'events']), namespace, context };
  if (verb === 'logs') {
    const pod = values[0];
    if (!pod) throw new Error('Say “logs <pod> -n <namespace>”, for example: logs api-7c9d -n production.');
    return { action:'logs', args:[...withScope(['logs', pod]), ...(container ? ['--container', container] : []), '--tail', '200'], namespace, context };
  }
  if (!allowedResources.has(resource)) throw new Error('Use a read-only query such as “get pods”, “describe deployment api”, “logs api-pod -n production”, or “events -n production”.');
  if (verb === 'get') return { action:'get', args:withScope(['get', resource, ...(values[1] ? [values[1]] : []), '--output', 'wide']), namespace, context };
  if (verb === 'describe') {
    if (!values[1]) throw new Error('Describe needs a resource and name, for example: describe deployment api -n production.');
    return { action:'describe', args:withScope(['describe', resource, values[1]]), namespace, context };
  }
  throw new Error('Habibi only runs read-only Kubernetes commands: get, describe, logs, and events.');
}

function appendKubernetesAudit({ action, namespace, context, exitCode }) {
  try {
    const directory = path.join(stateRoot, 'kubernetes');
    fs.mkdirSync(directory, { recursive:true, mode:0o700 });
    fs.appendFileSync(path.join(directory, 'audit.jsonl'), `${JSON.stringify({ at:new Date().toISOString(), action, namespace:namespace || null, context:context || null, exit:exitCode })}\n`, { mode:0o600 });
  } catch (_) { /* Auditing must never make a read-only inspection unavailable. */ }
}

function runKubectlRead(args, audit, { maxOutputBytes = 500_000 } = {}) {
  return new Promise(resolve => {
    const task = spawn('kubectl', args);
    let stdout = ''; let stderr = ''; let settled = false; let outputTooLarge = false;
    const finish = (payload, exitCode) => {
      if (settled) return; settled = true;
      appendKubernetesAudit({ ...audit, exitCode });
      resolve(payload);
    };
    const timer = setTimeout(() => { task.kill('SIGTERM'); finish({ ok:false, error:'kubectl timed out after 10 seconds.' }, 124); }, 10_000);
    task.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > maxOutputBytes) { outputTooLarge = true; task.kill('SIGTERM'); } });
    task.stderr.on('data', chunk => { stderr += chunk; });
    task.on('error', error => { clearTimeout(timer); finish({ ok:false, error:error.code === 'ENOENT' ? 'kubectl is not installed or not on Habibi’s PATH.' : 'Could not start kubectl.' }, 127); });
    task.on('close', code => { clearTimeout(timer); finish(outputTooLarge ? { ok:false, error:'This Kubernetes response is too large to display safely. Narrow the namespace or resource.' } : code === 0 ? { ok:true, output:stdout } : { ok:false, error:(stderr || 'kubectl failed.').trim().slice(0, 4_000) }, code ?? 1); });
  });
}

function runKubernetesReadQuery(input, preferredContext = '', preferredNamespace = '') {
  let parsed;
  try { parsed = parseKubernetesReadQuery(input, preferredContext); } catch (error) { return Promise.resolve({ ok:false, error:error.message }); }
  // A command that already names a scope always wins. Otherwise the explorer's
  // namespace selector provides the safe default scope for a read.
  if (preferredNamespace && !parsed.namespace && !parsed.args.includes('--all-namespaces')) {
    const insertion = parsed.args.findIndex(value => value === '--context');
    parsed.args.splice(insertion < 0 ? parsed.args.length : insertion, 0, '--namespace', preferredNamespace);
    parsed.namespace = preferredNamespace;
  }
  return runKubectlRead(parsed.args, parsed).then(result => ({ ...result, action:parsed.action }));
}

async function kubernetesOverview(requestedContext, requestedNamespace = '') {
  const contextsResult = await runKubectlRead(['config', 'get-contexts', '-o', 'name'], { action:'contexts', namespace:'', context:'' });
  if (!contextsResult.ok) return { ok:false, error:contextsResult.error, contexts:[], resources:[] };
  const contexts = contextsResult.output.split('\n').map(item => item.trim()).filter(Boolean).slice(0, 100);
  const currentResult = await runKubectlRead(['config', 'current-context'], { action:'current-context', namespace:'', context:'' });
  const current = currentResult.ok ? currentResult.output.trim() : '';
  const context = contexts.includes(requestedContext) ? requestedContext : (contexts.includes(current) ? current : contexts[0] || '');
  if (requestedNamespace && !validKubernetesName(requestedNamespace, 62)) return { ok:false, error:'That namespace is not valid.', contexts, resources:[] };
  const scoped = args => [...args, ...(context ? ['--context', context] : [])];
  const namespacesResult = await runKubectlRead(scoped(['get', 'namespaces', '--output', 'json']), { action:'namespaces', namespace:'', context }, { maxOutputBytes:1_000_000 });
  const namespaces = namespacesResult.ok ? (() => { try { return JSON.parse(namespacesResult.output).items.map(item => item.metadata?.name).filter(Boolean).sort(); } catch (_) { return []; } })() : [];
  const namespace = namespaces.includes(requestedNamespace) ? requestedNamespace : '';
  const scope = namespace ? ['--namespace', namespace] : ['--all-namespaces'];
  const specs = [['pods', ['get', 'pods', ...scope, '--output', 'json']], ['deployments', ['get', 'deployments', ...scope, '--output', 'json']], ['services', ['get', 'services', ...scope, '--output', 'json']]];
  const resources = await Promise.all(specs.map(async ([kind, args]) => {
    // The overview needs enough of a list response to parse and compact it,
    // then exposes only the first 80 rows. Arbitrary user queries retain the
    // much smaller default output limit above.
    const result = await runKubectlRead(scoped(args), { action:`overview-${kind}`, namespace, context }, { maxOutputBytes:4_000_000 });
    if (!result.ok) return { kind, ...result, items:[] };
    try { return { kind, ok:true, items:kubernetesOverviewItems(kind, JSON.parse(result.output).items || []) }; }
    catch (_) { return { kind, ok:false, error:`Could not read ${kind} returned by kubectl.`, items:[] }; }
  }));
  return { ok:true, contexts, context, namespaces, namespace, resources };
}

function kubernetesOverviewItems(kind, items) {
  return items.slice(0, 80).map(item => {
    const metadata = item.metadata || {};
    const status = item.status || {};
    const spec = item.spec || {};
    const base = { namespace:metadata.namespace || 'default', name:metadata.name || 'Unnamed resource', createdAt:metadata.creationTimestamp || '' };
    if (kind === 'pods') {
      const containers = status.containerStatuses || [];
      const ready = containers.filter(container => container.ready).length;
      return { ...base, primary:status.phase || 'Unknown', secondary:`${ready}/${containers.length || 0} ready`, badge:containers.reduce((total, container) => total + (container.restartCount || 0), 0) ? `${containers.reduce((total, container) => total + (container.restartCount || 0), 0)} restarts` : '' };
    }
    if (kind === 'deployments') return { ...base, primary:`${status.readyReplicas || 0}/${spec.replicas || 0} ready`, secondary:status.availableReplicas ? `${status.availableReplicas} available` : 'No available replicas', badge:'' };
    if (kind === 'services') return { ...base, primary:spec.type || 'ClusterIP', secondary:(spec.ports || []).map(port => `${port.port}${port.name ? `/${port.name}` : ''}`).join(' · ') || 'No ports', badge:spec.clusterIP && spec.clusterIP !== 'None' ? spec.clusterIP : '' };
    const conditions = status.conditions || [];
    const ready = conditions.find(condition => condition.type === 'Ready') || conditions.find(condition => condition.status === 'True');
    return { ...base, primary:ready ? `${ready.type}: ${ready.status}` : (status.phase || item.kind || 'Resource'), secondary:metadata.creationTimestamp ? `Created ${new Date(metadata.creationTimestamp).toLocaleDateString()}` : 'Cluster resource', badge:'' };
  });
}

const kubernetesKinds = new Set(['pods', 'deployments', 'services', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs', 'configmaps', 'secrets', 'ingresses', 'namespaces', 'nodes', 'events']);
function normalizedKubernetesKind(value) {
  const aliases = { pod:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', ds:'daemonsets', sts:'statefulsets', rs:'replicasets', job:'jobs', cronjob:'cronjobs', ns:'namespaces', node:'nodes' };
  const kind = aliases[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
  return kubernetesKinds.has(kind) ? kind : '';
}
function validKubernetesName(value, max = 252) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(String(value || '')) && String(value).length <= max; }
function kubernetesScope(kind, namespace, context, allNamespaces = false) {
  return [...(allNamespaces && !['nodes', 'namespaces'].includes(kind) ? ['--all-namespaces'] : namespace && !['nodes', 'namespaces'].includes(kind) ? ['--namespace', namespace] : []), ...(context ? ['--context', context] : [])];
}
async function kubernetesResourceList(payload = {}) {
  const kind = normalizedKubernetesKind(payload.kind);
  const context = String(payload.context || '').trim();
  const namespace = String(payload.namespace || '').trim();
  if (!kind) return { ok:false, error:'That Kubernetes resource is not available in the read-only explorer.' };
  if (namespace && !validKubernetesName(namespace, 62)) return { ok:false, error:'That namespace is not valid.' };
  const result = await runKubectlRead(['get', kind, ...kubernetesScope(kind, namespace, context, !namespace), '--output', 'json'], { action:`browse-${kind}`, namespace, context }, { maxOutputBytes:4_000_000 });
  if (!result.ok) return result;
  try { return { ok:true, kind, items:kubernetesOverviewItems(kind, JSON.parse(result.output).items || []).slice(0, 150) }; }
  catch (_) { return { ok:false, error:`Could not read ${kind} returned by kubectl.` }; }
}

async function kubernetesResourceDetail(payload = {}) {
  const kind = normalizedKubernetesKind(payload.kind);
  const name = String(payload.name || '').trim();
  const namespace = String(payload.namespace || '').trim();
  const context = String(payload.context || '').trim();
  if (!kind || !validKubernetesName(name)) return { ok:false, error:'That resource is not available for inspection.' };
  if (namespace && !validKubernetesName(namespace, 62)) return { ok:false, error:'That namespace is not valid.' };
  const args = ['get', kind, name, ...kubernetesScope(kind, namespace, context), '--output', 'json'];
  const result = await runKubectlRead(args, { action:`detail-${kind}`, namespace, context });
  if (!result.ok) return result;
  try {
    const value = JSON.parse(result.output);
    const detail = formatKubernetesDetail(kind, value);
    const selector = Object.entries(value.spec?.selector?.matchLabels || {}).map(([key, label]) => `${key}=${label}`).join(',');
    if (selector && ['deployments', 'jobs', 'statefulsets', 'daemonsets', 'replicasets'].includes(kind) && namespace) {
      const pods = await runKubectlRead(['get', 'pods', '--namespace', namespace, '--selector', selector, '--output', 'json', ...(context ? ['--context', context] : [])], { action:`related-pods-${kind}`, namespace, context }, { maxOutputBytes:1_500_000 });
      if (pods.ok) detail.relatedPods = kubernetesOverviewItems('pods', JSON.parse(pods.output).items || []).slice(0, 50);
    }
    return { ok:true, detail };
  }
  catch (_) { return { ok:false, error:'kubectl returned a resource Habibi could not read.' }; }
}

async function kubernetesPodLogs(payload = {}) {
  const pod = String(payload.pod || '').trim();
  const namespace = String(payload.namespace || '').trim();
  const context = String(payload.context || '').trim();
  const container = String(payload.container || '').trim();
  if (!validKubernetesName(pod) || !validKubernetesName(namespace, 62) || (container && !validKubernetesName(container))) return { ok:false, error:'Choose a valid pod and namespace to read logs.' };
  const result = await runKubectlRead(['logs', pod, '--namespace', namespace, ...(container ? ['--container', container] : []), '--tail', '200', ...(context ? ['--context', context] : [])], { action:'logs', namespace, context }, { maxOutputBytes:1_000_000 });
  return result.ok ? { ok:true, output:result.output, pod, namespace, container } : result;
}

function formatKubernetesDetail(kind, value) {
  const metadata = value.metadata || {};
  const status = value.status || {};
  const spec = value.spec || {};
  const statuses = status.containerStatuses || [];
  const containers = (spec.containers || []).slice(0, 30).map(container => {
    const runtime = statuses.find(item => item.name === container.name) || {};
    const state = runtime.state || {};
    return { name:container.name || 'container', image:container.image || '', state:Object.keys(state)[0] || (runtime.ready ? 'Running' : 'Unknown'), ready:Boolean(runtime.ready), restarts:runtime.restartCount || 0 };
  });
  const conditions = (status.conditions || []).slice(0, 12).map(condition => ({ type:condition.type || 'Condition', status:condition.status || 'Unknown', reason:condition.reason || '', message:condition.message || '' }));
  const facts = [];
  if (kind === 'pods') facts.push(['Phase', status.phase || 'Unknown'], ['Node', spec.nodeName || 'Pending'], ['IP', status.podIP || '—']);
  if (kind === 'deployments') facts.push(['Ready', `${status.readyReplicas || 0}/${spec.replicas || 0}`], ['Available', String(status.availableReplicas || 0)], ['Updated', String(status.updatedReplicas || 0)]);
  if (kind === 'services') facts.push(['Type', spec.type || 'ClusterIP'], ['Cluster IP', spec.clusterIP || '—'], ['Ports', (spec.ports || []).map(port => `${port.port}/${port.protocol || 'TCP'}`).join(' · ') || '—']);
  if (!facts.length) facts.push(['Created', metadata.creationTimestamp || '—'], ['Labels', String(Object.keys(metadata.labels || {}).length)], ['Annotations', String(Object.keys(metadata.annotations || {}).length)]);
  return { kind, name:metadata.name || 'Unnamed resource', namespace:metadata.namespace || '', facts, containers, conditions, labels:Object.entries(metadata.labels || {}).slice(0, 16).map(([key, label]) => ({ key, value:String(label) })) };
}

async function planKubernetesNaturalQuery(query, preferredContext, preferredNamespace = '') {
  const plan = await kubernetesPlugin.plan({ request:query });
  if (!plan.ok) return plan;
  const result = await runKubernetesReadQuery(plan.query, preferredContext, preferredNamespace);
  return { ...result, plannedQuery:plan.query, summary:plan.summary, trace:[
    { tool:'Local intent planner', detail:'Translated your request into a constrained read-only query.' },
    { tool:'kubectl read', detail:result.ok ? 'Read completed using your selected context.' : 'The read was rejected or could not complete.' },
  ] };
}

async function diagnoseKubernetes(query, preferredContext, preferredNamespace = '') {
  try {
    return await kubernetesPlugin.diagnose({
      request:query,
      context:preferredContext,
      namespace:preferredNamespace,
      tools:{
        overview:(context, namespace) => kubernetesOverview(context, namespace),
        detail:payload => kubernetesResourceDetail(payload),
        logs:payload => kubernetesPodLogs(payload)
      }
    });
  } catch (error) {
    console.error('[Habibi Kubernetes diagnosis]', error?.stack || error?.message || error);
    return { ok:false, error:'The Kubernetes investigation could not complete. Check the selected context and try again.' };
  }
}

function runJxa(script, args, callback) {
  const process = spawn('osascript', ['-l', 'JavaScript', '-e', script, ...args]);
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  process.on('error', error => callback(error));
  process.on('close', code => callback(code === 0 ? null : new Error(stderr), stdout.trim()));
}


function agentWorkingDirectory(pid) {
  return new Promise(resolve => {
    const process = spawn('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
    let output = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.on('error', () => resolve(null));
    process.on('close', () => resolve(output.split('\n').find(line => line.startsWith('n'))?.slice(1) || null));
  });
}

function handleAgentAction(request, response, action) {
  return readJson(request, response, body => {
    const target = homePath(body.cwd);
    if (!target) return json(response, { ok:false });
    action(target, body.kind);
    return json(response, { ok:true });
  });
}

/**
 * Resolves a caller-supplied path, returning it only when it names an existing
 * file or directory inside the user's home. Returns null otherwise, so callers
 * cannot reach the rest of the filesystem.
 */
function homePath(value) {
  if (typeof value !== 'string' || !value) return null;
  const home = path.resolve(process.env.HOME || '/');
  const target = path.resolve(value);
  if (target !== home && !target.startsWith(`${home}${path.sep}`)) return null;
  return fs.existsSync(target) ? target : null;
}

// A project path is untrusted data and must not become AppleScript source. It
// arrives as `argv`; `quoted form of` escapes it for the shell that `do script`
// starts. See the matching script in src/agent/skill-import-service.ts.
const resumeScript = `on run argv
  set command to "cd " & quoted form of (item 1 of argv) & "; " & (item 2 of argv)
  tell application "Terminal"
    activate
    do script command
  end tell
end run`;
