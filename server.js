const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pty = require('node-pty');
const WebSocket = require('ws');
const { loadSkills } = require('./src/core/skill-registry');
const { createOpenwaClient } = require('./src/connectors/openwa-client');
const { createWhatsAppService } = require('./src/server/services/whatsapp-service');
const { createLlmService } = require('./src/server/services/llm-service');
const { createMcpBridge } = require('./src/agent/mcp-bridge');
const { createApprovalService } = require('./src/core/approval-service');
const { createMailService } = require('./src/server/services/mail-service');
const { applySecurityHeaders, isTrustedLocalRequest } = require('./src/core/http-security');
const { createSkillImportService } = require('./src/agent/skill-import-service');
const { createAnalyticsService } = require('./src/server/services/analytics-service');

// `HABIBI_ROOT` keeps filesystem-backed local integrations anchored to the
// workspace when this file runs from the compiled `dist/` production artifact.
const root = path.resolve(process.env.HABIBI_ROOT || __dirname);
const stateRoot = path.resolve(process.env.HABIBI_DATA_ROOT || root);
const skills = loadSkills(path.join(root, 'skills'));
const openwaClient = createOpenwaClient({ workspace:stateRoot });
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
let quickLookProcess = null;
let applicationIndex = { loadedAt:0, apps:[] };
const whatsappService = createWhatsAppService({ root:stateRoot, fs, spawn, openwaClient });
const llmService = createLlmService({ root:stateRoot, fs, spawn });
const mcpBridge = createMcpBridge({ root:stateRoot, fs });
const approvals = createApprovalService();
const mailService = createMailService({ root:stateRoot, fs, spawn });
const importedSkills = createSkillImportService({ root, stateRoot, spawn });
const analytics = createAnalyticsService();

// Connector failures are reported to the local console but must never terminate the launcher.
process.on('unhandledRejection', error => console.error('[Habibi connector rejection]', error?.message || error));
process.on('uncaughtException', error => console.error('[Habibi connector error]', error?.message || error));

const server = http.createServer(async (request, response) => {
  applySecurityHeaders(response);
  if (!isTrustedLocalRequest(request)) return response.writeHead(403, { 'Content-Type':'application/json' }).end('{"ok":false,"error":"Local requests only"}');
  const url = new URL(request.url, 'http://127.0.0.1');
  const vendor = {
    '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
    '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
    '/vendor/xterm-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js'
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
  if (url.pathname === '/api/approvals' && request.method === 'POST') return readJson(request, response, body => {
    const action = String(body.action || '');
    if (!/^(?:whatsapp\.send|calendar\.(?:create|update)|gmail\.send|agent-skill\.execute|system\.(?:sleep|restart|shutdown|lock|darkMode|emptyTrash))$/.test(action)) return json(response, { ok:false, error:'Unsupported approval action' });
    return json(response, { ok:true, approval:approvals.issue(action) });
  });
  if (url.pathname === '/api/llm/status' && request.method === 'GET') return json(response, await llmService.configured());
  if (url.pathname === '/api/agent-skills' && request.method === 'GET') return json(response, { ok:true, skills:importedSkills.list() });
  if (url.pathname === '/api/agent-skills/preview' && request.method === 'POST') return readJson(request, response, async body => json(response, await importedSkills.preview(String(body.id || ''))));
  if (url.pathname === '/api/agent-skills/execute' && request.method === 'POST') return readJson(request, response, async body => {
    if (!approvals.consume({ token:body.approvalToken, action:'agent-skill.execute' })) return json(response, { ok:false, error:'Running an imported skill needs explicit approval.' });
    return json(response, await importedSkills.execute({ id:String(body.id || ''), toolName:body.toolName ? String(body.toolName) : undefined, toolInput:body.toolInput }));
  });
  if (url.pathname === '/api/mcp/servers' && request.method === 'GET') return json(response, { ok:true, servers:mcpBridge.list() });
  if (url.pathname === '/api/mcp/tools' && request.method === 'GET') return json(response, await mcpBridge.discover(url.searchParams.get('server')));
  if (url.pathname === '/api/llm/models' && request.method === 'GET') return json(response, await llmService.models({ provider:url.searchParams.get('provider'), endpoint:url.searchParams.get('endpoint') }));
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
    const searches = await Promise.all((plan.queries || []).slice(0, 3).map(query => findLocalFiles(query, 10)));
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
    const mime = { '.pdf':'application/pdf', '.txt':'text/plain; charset=utf-8', '.md':'text/markdown; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg' }[path.extname(target).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `inline; filename="${path.basename(target).replace(/"/g, '')}"` });
    fs.createReadStream(target).pipe(response);
    return;
  }
  if (url.pathname === '/api/open-file' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const requested = JSON.parse(body).path;
        const home = path.resolve(process.env.HOME || '/');
        const target = path.resolve(requested);
        if (!target.startsWith(`${home}${path.sep}`) || !fs.existsSync(target)) return json(response, { ok: false });
        spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
        json(response, { ok: true });
      } catch (_) { json(response, { ok: false }); }
    });
    return;
  }
  if (url.pathname === '/api/open-app' && request.method === 'POST') return readJson(request, response, body => {
    const target = path.resolve(String(body.path || ''));
    const allowedRoots = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', path.join(process.env.HOME || '/', 'Applications/')];
    if (!target.endsWith('.app') || !allowedRoots.some(prefix => target.startsWith(prefix)) || !fs.existsSync(target)) return json(response, { ok:false });
    spawn('open', [target], { detached:true, stdio:'ignore' }).unref();
    return json(response, { ok:true });
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
    if (!approvals.consume({ token:body.approvalToken, action:`system.${action}` })) return json(response, { ok:false, error:'This system action needs explicit approval.' });
    const commands = {
      sleep:['osascript', ['-e', 'tell application "System Events" to sleep']], restart:['osascript', ['-e', 'tell application "System Events" to restart']], shutdown:['osascript', ['-e', 'tell application "System Events" to shut down']], lock:['/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']], darkMode:['osascript', ['-e', 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode']], emptyTrash:['osascript', ['-e', 'tell application "Finder" to empty the trash']]
    };
    const [command, args] = commands[action]; spawn(command, args, { detached:true, stdio:'ignore' }).unref(); return json(response, { ok:true });
  });
  if (url.pathname === '/api/preview-file' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const requested = JSON.parse(body).path;
        const home = path.resolve(process.env.HOME || '/');
        const target = path.resolve(requested);
        if (!target.startsWith(`${home}${path.sep}`) || !fs.existsSync(target)) return json(response, { ok: false });
        spawn('qlmanage', ['-p', target], { detached: true, stdio: 'ignore' }).unref();
        json(response, { ok: true });
      } catch (_) { json(response, { ok: false }); }
    });
    return;
  }
  if (url.pathname === '/api/quick-look' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        if (quickLookProcess && quickLookProcess.exitCode === null) {
          quickLookProcess.kill('SIGTERM');
          quickLookProcess = null;
          return json(response, { ok: true, state: 'closed' });
        }
        const requested = JSON.parse(body).path;
        const home = path.resolve(process.env.HOME || '/');
        const target = path.resolve(requested);
        if (!target.startsWith(`${home}${path.sep}`) || !fs.existsSync(target)) return json(response, { ok: false });
        quickLookProcess = spawn('qlmanage', ['-p', target], { stdio: 'ignore' });
        quickLookProcess.on('error', () => { quickLookProcess = null; });
        quickLookProcess.on('close', () => { quickLookProcess = null; });
        json(response, { ok: true, state: 'opened' });
      } catch (_) { json(response, { ok: false }); }
    });
    return;
  }
  if (url.pathname === '/api/files') {
    const query = url.searchParams.get('q') || '';
    return findLocalFiles(query).then(files => json(response, files));
    return;
  }
  if (url.pathname === '/api/calendars' && request.method === 'GET') {
    return runJxa('function run(argv){ return JSON.stringify(Application("Calendar").calendars.name()); }', [], (error, output) => {
      if (error) return json(response, { ok: false, calendars: [] });
      try { json(response, { ok: true, calendars: JSON.parse(output) }); } catch (_) { json(response, { ok: false, calendars: [] }); }
    });
  }
  if (url.pathname === '/api/calendar/event' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const event = JSON.parse(body);
        if (!approvals.consume({ token:event.approvalToken, action:'calendar.create' })) return json(response, { ok:false, error:'Calendar creation needs explicit approval' });
        const script = 'function run(argv){ const app=Application("Calendar"); const calendar=app.calendars.byName(argv[0]); const item=app.Event({summary:argv[1],startDate:new Date(argv[2]),endDate:new Date(argv[3])}); calendar.events.push(item); }';
        runJxa(script, [event.calendar, event.title, event.start, event.end], error => json(response, { ok: !error }));
      } catch (_) { json(response, { ok: false }); }
    });
    return;
  }
  if (url.pathname === '/api/calendar/events' && request.method === 'GET') {
    return runCalendarHelper((error, output) => {
      if (error) return json(response, { ok: false, events: [] });
      try { json(response, { ok: true, events: JSON.parse(output) }); } catch (_) { json(response, { ok: false, events: [] }); }
    });
  }
  if (url.pathname === '/api/calendar/event/update' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        const event = JSON.parse(body);
        if (!approvals.consume({ token:event.approvalToken, action:'calendar.update' })) return json(response, { ok:false, error:'Calendar changes need explicit approval' });
        const script = 'function run(argv){ const app=Application("Calendar"); const calendar=app.calendars.whose({name:argv[0]})[0]; const item=calendar.events.byId(argv[1]); item.summary=argv[2]; item.startDate=new Date(argv[3]); item.endDate=new Date(argv[4]); }';
        runJxa(script, [event.calendar, event.id, event.title, event.start, event.end], error => json(response, { ok: !error }));
      } catch (_) { json(response, { ok: false }); }
    });
    return;
  }
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
  if (url.pathname === '/api/skills' && request.method === 'GET') return json(response, { ok:true, skills });
  if (url.pathname === '/api/agents/open-project' && request.method === 'POST') {
    return handleAgentAction(request, response, cwd => spawn('open', [cwd], { detached: true, stdio: 'ignore' }).unref());
  }
  if (url.pathname === '/api/agents/resume' && request.method === 'POST') {
    return handleAgentAction(request, response, (cwd, kind) => {
      const command = kind === 'claude' ? 'claude --resume' : 'codex resume';
      const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "cd ${shellQuote(cwd)}; ${command}"`;
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    });
  }
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(root, `.${requestPath}`);
  if (!file.startsWith(root)) return response.writeHead(403).end('Forbidden');
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end('Not found');
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    response.end(data);
  });
});

const ptyServer = new WebSocket.Server({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (!isTrustedLocalRequest(request)) return socket.destroy();
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
        const home = path.resolve(process.env.HOME || '/');
        const cwd = path.resolve(message.cwd);
        if (!cwd.startsWith(`${home}${path.sep}`) || !fs.existsSync(cwd)) return ws.send(JSON.stringify({ type:'error', message:'Project directory unavailable' }));
        const kind = message.kind === 'claude' ? 'claude' : 'codex';
        const command = kind === 'claude' ? 'claude --resume' : 'codex resume';
        session = pty.spawn(process.env.SHELL || '/bin/zsh', ['-lc', command], { name:'xterm-256color', cols:120, rows:32, cwd, env:process.env });
        session.onData(data => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type:'data', data })));
        session.onExit(({ exitCode }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'exit', exitCode })); });
        ws.send(JSON.stringify({ type:'started', kind }));
      }
      if (message.type === 'input' && session) session.write(message.data);
      if (message.type === 'resize' && session) session.resize(Math.max(20, message.cols), Math.max(5, message.rows));
    } catch (_) { ws.send(JSON.stringify({ type:'error', message:'Invalid terminal message' })); }
  });
  ws.on('close', () => { if (session) session.kill(); });
});
server.listen(4173, '127.0.0.1', () => console.log('Habibi running at http://127.0.0.1:4173'));

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
  try {
    const stat = fs.statSync(file);
    const name = path.basename(file);
    const lowerName = name.toLowerCase();
    const queryTokens = query.toLowerCase().split(/[\s._-]+/).filter(token => token.length >= 2);
    const lowerQuery = query.toLowerCase();
    const folder = primaryFolder(file);
    const folderRank = { Documents: 90, Desktop: 75, Downloads: 60, Projects: 35, Home: 15 }[folder] || 5;
    const stem = lowerName.replace(/\.[^.]+$/, '');
    const exact = stem === lowerQuery || lowerName === lowerQuery;
    const starts = stem.startsWith(lowerQuery) || queryTokens.every(token => stem.startsWith(token));
    const nameRank = exact ? 120 : starts ? 80 : queryTokens.reduce((score, token) => score + (stem.includes(token) ? 22 : 0), 0);
    const shallowRank = Math.max(0, 20 - path.relative(process.env.HOME || '/', file).split(path.sep).length * 2);
    const recencyRank = Math.max(0, 24 - ((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24 * 14)));
    return {
      path: file,
      name,
      folder,
      directory: path.dirname(file).replace(process.env.HOME || '', '~'),
      score: folderRank + nameRank + shallowRank + recencyRank
    };
  } catch (_) { return null; }
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

function findLocalFiles(query, limit = 8) {
  const safeQuery = String(query || '').replace(/[^a-zA-Z0-9 ._\-]/g, '').trim().slice(0, 80);
  if (safeQuery.length < 2) return Promise.resolve([]);
  const tokens = safeQuery.split(/[\s._-]+/).filter(token => token.length >= 2).slice(0, 5);
  if (!tokens.length) return Promise.resolve([]);
  const predicate = tokens.map(token => `kMDItemFSName == "*${token.replace(/"/g, '')}*"cd`).join(' && ');
  return new Promise(resolve => {
    const finder = spawn('mdfind', ['-onlyin', process.env.HOME || '/', predicate]);
    let output = '';
    finder.stdout.on('data', chunk => { output += chunk; });
    finder.on('error', () => resolve(findLocalFilesFallback(safeQuery, limit)));
    finder.on('close', () => {
      const spotlight = output.split('\n').filter(Boolean)
      .filter(file => !isNoisePath(file) && matchesFileIntent(file, safeQuery))
      .map(file => makeFileResult(file, safeQuery))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .filter(uniqueFileName())
      .slice(0, limit);
      // Spotlight is normally near-instant, but a freshly created archive or
      // a temporarily stale index must not make Habibi deny the file exists.
      // The fallback only reads filenames in normal user folders; it never
      // opens file contents and is bounded by depth/result count.
      if (spotlight.length) return resolve(spotlight);
      findLocalFilesFallback(safeQuery, limit).then(resolve);
    });
  });
}

function findLocalFilesFallback(query, limit) {
  const home = process.env.HOME || '';
  const roots = [path.join(home, 'Downloads'), path.join(home, 'Documents'), path.join(home, 'Desktop')]
    .filter((folder, index, all) => fs.existsSync(folder) && all.indexOf(folder) === index);
  const needle = query.replace(/[^a-zA-Z0-9._ -]/g, '').trim();
  if (needle.length < 2) return Promise.resolve([]);
  return Promise.all(roots.map(root => new Promise(resolve => {
    const finder = spawn('find', [root, '-maxdepth', '7', '-type', 'f', '-iname', `*${needle}*`]);
    let output = '';
    finder.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 200_000) finder.kill('SIGTERM');
    });
    finder.on('error', () => resolve([]));
    finder.on('close', () => resolve(output.split('\n').filter(Boolean)));
  }))).then(paths => paths.flat()
    .filter(file => !isNoisePath(file))
    .map(file => makeFileResult(file, needle))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .filter(uniqueFileName())
    .slice(0, limit));
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
    const apps = roots.flatMap(root => {
      try {
        return fs.readdirSync(root, { withFileTypes:true })
          .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
          .map(entry => path.join(root, entry.name));
      } catch (_) { return []; }
    }).filter(pathname => {
      const key = pathname.toLowerCase();
      if (seen.has(key) || !fs.existsSync(pathname)) return false;
      seen.add(key);
      return true;
    }).map(pathname => ({ path:pathname, name:path.basename(pathname, '.app') }))
      // System bundles include many invisible menu extras and support agents.
      // They are not launchable apps a person expects from a Spotlight-style
      // query, and most expose macOS's generic question-mark icon.
      .filter(app => !/(?:agent|assistant|daemon|service|helper|server|launcher|messenger|authwarn|accesscontrol|mac)$/i.test(app.name));
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

function runJxa(script, args, callback) {
  const process = spawn('osascript', ['-l', 'JavaScript', '-e', script, ...args]);
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  process.on('error', error => callback(error));
  process.on('close', code => callback(code === 0 ? null : new Error(stderr), stdout.trim()));
}

function runCalendarHelper(callback) {
  const helper = path.join(root, 'bin/calendar-events');
  const process = spawn(helper, []);
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
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    try {
      const { cwd, kind } = JSON.parse(body);
      const home = path.resolve(process.env.HOME || '/');
      const target = path.resolve(cwd);
      if (!target.startsWith(`${home}${path.sep}`) || !fs.existsSync(target)) return json(response, { ok: false });
      action(target, kind);
      json(response, { ok: true });
    } catch (_) { json(response, { ok: false }); }
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
