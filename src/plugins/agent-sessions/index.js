/**
 * Read-only adapter for the local Codex and Claude Code transcript stores.
 * This plugin owns their on-disk formats; Habibi only consumes its normalized
 * session and transcript contracts. It deliberately never writes either store.
 */
const path = require('path');

const MAX_SESSIONS = 160;
const MAX_TRANSCRIPT_LINES = 700;
const safeId = value => /^[0-9a-f-]{16,80}$/i.test(String(value || ''));
const trim = (value, max = 900) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function walk(fs, directory, { limit = MAX_SESSIONS, include } = {}) {
  const found = [];
  const visit = folder => {
    if (found.length >= limit || !fs.existsSync(folder)) return;
    let entries = []; try { entries = fs.readdirSync(folder, { withFileTypes:true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (!include || include(file))) found.push(file);
    }
  };
  visit(directory); return found;
}

function jsonLines(fs, file, max = MAX_TRANSCRIPT_LINES) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const lines = raw.split('\n');
  return lines.slice(-max).flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
}
function firstJsonLine(fs, file) {
  try { const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0]; return JSON.parse(line); } catch (_) { return {}; }
}

function textFromContent(content) {
  if (typeof content === 'string') return trim(content);
  if (!Array.isArray(content)) return '';
  return trim(content.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').filter(Boolean).join('\n'));
}

function codexSession(fs, file) {
  const lines = jsonLines(fs, file, 90);
  const meta = lines.find(line => line.type === 'session_meta')?.payload || firstJsonLine(fs, file).payload || {};
  const id = meta.id || path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1];
  if (!safeId(id)) return null;
  const prompts = lines.flatMap(line => line.type === 'response_item' && line.payload?.type === 'message' && line.payload?.role === 'user' ? [textFromContent(line.payload.content)] : []).filter(Boolean);
  const updatedAt = fs.statSync(file).mtime.toISOString();
  const lastPrompt = prompts.at(-1) || '';
  const readablePrompt = /^(?:<image|\[image)/i.test(lastPrompt) ? '' : lastPrompt;
  return { id, kind:'codex', title:readablePrompt || 'Codex session', preview:readablePrompt || 'Local Codex transcript', cwd:meta.cwd || '', updatedAt, file };
}

function claudeSession(fs, file) {
  const lines = jsonLines(fs, file, 90).filter(line => !line.isSidechain);
  const first = lines.find(line => safeId(line.sessionId));
  const id = first?.sessionId || path.basename(file, '.jsonl');
  if (!safeId(id)) return null;
  const prompts = lines.flatMap(line => line.type === 'user' ? [textFromContent(line.message?.content)] : []).filter(Boolean);
  const cwd = [...lines].reverse().find(line => line.cwd)?.cwd || '';
  const lastPrompt = prompts.at(-1) || '';
  const readablePrompt = /^(?:<image|\[image)/i.test(lastPrompt) ? '' : lastPrompt;
  return { id, kind:'claude', title:readablePrompt || 'Claude Code session', preview:readablePrompt || 'Local Claude transcript', cwd, updatedAt:fs.statSync(file).mtime.toISOString(), file };
}

function transcript(fs, session) {
  const entries = jsonLines(fs, session.file).flatMap(line => {
    if (session.kind === 'codex') {
      const message = line.type === 'response_item' && line.payload?.type === 'message' ? line.payload : null;
      if (message?.role === 'user' || message?.role === 'assistant') {
        const text = textFromContent(message.content); if (text) return [{ role:message.role, text, at:line.timestamp || '' }];
      }
      if (line.type === 'response_item' && line.payload?.type === 'function_call') return [{ role:'tool', text:`${line.payload.name || 'Tool'} ${trim(line.payload.arguments || '', 240)}`, at:line.timestamp || '' }];
      return [];
    }
    if (line.isSidechain || !['user', 'assistant'].includes(line.type)) return [];
    const text = textFromContent(line.message?.content); return text ? [{ role:line.type, text, at:line.timestamp || '' }] : [];
  });
  return entries.slice(-MAX_TRANSCRIPT_LINES);
}

function createAgentSessionsPlugin({ fs, home = process.env.HOME || '' }) {
  const codexRoot = path.join(home, '.codex', 'sessions');
  const claudeRoot = path.join(home, '.claude', 'projects');
  const all = () => {
    const codex = walk(fs, codexRoot, { include:file => file.endsWith('.jsonl') }).map(file => codexSession(fs, file)).filter(Boolean);
    const claude = walk(fs, claudeRoot, { include:file => file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`) }).map(file => claudeSession(fs, file)).filter(Boolean);
    return [...codex, ...claude].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_SESSIONS);
  };
  return {
    list({ kind = '', query = '' } = {}) {
      const normalizedKind = kind === 'codex' || kind === 'claude' ? kind : '';
      const needle = trim(query, 180).toLowerCase();
      const sessions = all().filter(session => (!normalizedKind || session.kind === normalizedKind) && (!needle || `${session.title} ${session.preview} ${session.cwd}`.toLowerCase().includes(needle)));
      return { ok:true, sessions:sessions.map(({ file, ...session }) => session) };
    },
    detail({ id, kind }) {
      if (!safeId(id) || !['codex', 'claude'].includes(kind)) return { ok:false, error:'That local agent session is not available.' };
      const session = all().find(item => item.id === id && item.kind === kind);
      if (!session) return { ok:false, error:'That session is no longer available locally.' };
      return { ok:true, session:((({ file, ...value }) => value)(session)), transcript:transcript(fs, session) };
    }
  };
}

module.exports = { createAgentSessionsPlugin };
