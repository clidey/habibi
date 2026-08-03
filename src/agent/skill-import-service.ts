import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';

export type ImportedSkillSource = 'codex' | 'claude' | 'mcp';
export type ImportedSkillKind = 'instruction' | 'command' | 'mcp-server';

export interface ImportedSkill {
  id: string;
  source: ImportedSkillSource;
  kind: ImportedSkillKind;
  name: string;
  description: string;
  location: string;
  executable: boolean;
  transport?: 'stdio' | 'http';
}

interface InternalImportedSkill extends ImportedSkill {
  prompt?: string;
  commandName?: string;
  mcp?: Record<string, unknown>;
}

interface Preview {
  ok: true;
  skill: ImportedSkill;
  action: string;
  prompt?: string;
  tools?: Array<{ name:string; description:string; inputSchema:unknown; readOnly:boolean }>;
}

interface AuditEvent {
  at: string;
  skillId: string;
  source: ImportedSkillSource;
  kind: ImportedSkillKind;
  action: 'launch_agent' | 'call_mcp';
  outcome: 'started' | 'failed';
}

type Spawn = typeof spawnChild;
const ignoredFolders = new Set(['node_modules', '.git', 'dist', 'build', '.openwa']);
const maxFileBytes = 128 * 1024;

function safeRead(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxFileBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function idFor(source: ImportedSkillSource, kind: ImportedSkillKind, location: string): string {
  return `imported-${source}-${kind}-${crypto.createHash('sha256').update(location).digest('hex').slice(0, 16)}`;
}

function walk(root: string, matcher: (file:string) => boolean, depth = 0): string[] {
  if (depth > 4) return [];
  try {
    return fs.readdirSync(root, { withFileTypes:true }).flatMap(entry => {
      if (ignoredFolders.has(entry.name)) return [];
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return walk(target, matcher, depth + 1);
      return matcher(target) ? [target] : [];
    });
  } catch { return []; }
}

function parseInstruction(file: string, source: ImportedSkillSource, kind: ImportedSkillKind): InternalImportedSkill | null {
  const raw = safeRead(file);
  if (!raw) return null;
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const metadata = frontmatter?.[1] || '';
  const title = metadata.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]
    || raw.match(/^#\s+(.+)$/m)?.[1]
    || path.basename(file, path.extname(file));
  const description = metadata.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]
    || raw.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#') && !line.startsWith('---'))
    || 'Local agent instruction';
  const prompt = raw.slice(0, maxFileBytes);
  const commandName = kind === 'command' ? path.basename(file, '.md') : undefined;
  return { id:idFor(source, kind, file), source, kind, name:title.trim(), description:description.trim(), location:file, executable:true, prompt, commandName };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const content = safeRead(file);
    const parsed = content ? JSON.parse(content) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function mcpEntries(file: string, sourceLabel: string): InternalImportedSkill[] {
  const config = readJson(file);
  const servers = config?.mcpServers || config?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.entries(servers as Record<string, unknown>).flatMap(([name, definition]) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return [];
    const value = definition as Record<string, unknown>;
    const transport = typeof value.url === 'string' ? 'http' : 'stdio';
    return [{ id:idFor('mcp', 'mcp-server', `${file}:${name}`), source:'mcp' as const, kind:'mcp-server' as const, name, description:`${sourceLabel} MCP server · ${transport === 'http' ? 'HTTP' : 'local stdio'}`, location:file, executable:true, transport, mcp:value }];
  });
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export function createSkillImportService({ root, stateRoot, home = os.homedir(), spawn = spawnChild }: { root:string; stateRoot:string; home?:string; spawn?: typeof spawnChild }) {
  const auditFile = path.join(stateRoot, '.habibi', 'imported-skill-audit.jsonl');
  // Discovery is intentionally bounded to the current workspace and known
  // per-user agent folders. Never recursively crawl Documents/Home for skills.
  const roots = [root];

  const discover = (): InternalImportedSkill[] => {
    const codexSkills = [path.join(home, '.codex', 'skills'), ...roots.map(item => path.join(item, '.codex', 'skills'))]
      .flatMap(folder => walk(folder, file => path.basename(file).toLowerCase() === 'skill.md'))
      .map(file => parseInstruction(file, 'codex', 'instruction')).filter((skill): skill is InternalImportedSkill => Boolean(skill));
    const claudeSkills = [path.join(home, '.claude', 'skills'), ...roots.map(item => path.join(item, '.claude', 'skills'))]
      .flatMap(folder => walk(folder, file => path.basename(file).toLowerCase() === 'skill.md'))
      .map(file => parseInstruction(file, 'claude', 'instruction')).filter((skill): skill is InternalImportedSkill => Boolean(skill));
    const claudeCommands = [path.join(home, '.claude', 'commands'), ...roots.map(item => path.join(item, '.claude', 'commands'))]
      .flatMap(folder => walk(folder, file => file.toLowerCase().endsWith('.md')))
      .map(file => parseInstruction(file, 'claude', 'command')).filter((skill): skill is InternalImportedSkill => Boolean(skill));
    const mcp = [
      ...roots.map(item => path.join(item, '.mcp.json')).flatMap(file => mcpEntries(file, 'Project')),
      ...roots.map(item => path.join(item, '.habibi', 'mcp-servers.json')).flatMap(file => mcpEntries(file, 'Habibi')),
      ...mcpEntries(path.join(home, '.claude.json'), 'Claude')
    ];
    const seen = new Set<string>();
    return [...codexSkills, ...claudeSkills, ...claudeCommands, ...mcp]
      .filter(skill => !seen.has(skill.id) && Boolean(seen.add(skill.id)))
      .sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name));
  };

  const publicSkill = (skill: InternalImportedSkill): ImportedSkill => {
    const { prompt:_, commandName:__, mcp:___, ...publicValue } = skill;
    return publicValue;
  };
  const find = (id: string): InternalImportedSkill | undefined => discover().find(skill => skill.id === id);
  const audit = (event: AuditEvent): void => {
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive:true, mode:0o700 });
      fs.appendFileSync(auditFile, `${JSON.stringify(event)}\n`, { encoding:'utf8', mode:0o600 });
    } catch { /* Audit is best effort; an unavailable disk must not widen permissions. */ }
  };

  const withMcpClient = async <T>(skill: InternalImportedSkill, run: (client: any) => Promise<T>): Promise<T> => {
    const definition = skill.mcp || {};
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const transport = skill.transport === 'http'
      ? new (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')).StreamableHTTPClientTransport(new URL(String(definition.url)))
      : new (await import('@modelcontextprotocol/sdk/client/stdio.js')).StdioClientTransport({ command:String(definition.command || ''), args:Array.isArray(definition.args) ? definition.args.map(String) : [], env:definition.env && typeof definition.env === 'object' ? definition.env as Record<string, string> : undefined });
    if (skill.transport === 'stdio' && !String(definition.command || '').trim()) throw new Error('This MCP server has no local command.');
    const client = new Client({ name:'habibi', version:'0.1.0' });
    try { await client.connect(transport); return await run(client); }
    finally { await client.close?.().catch(() => {}); }
  };

  const preview = async (id: string): Promise<Preview | { ok:false; error:string }> => {
    const skill = find(id);
    if (!skill) return { ok:false, error:'That imported skill is no longer available.' };
    if (skill.kind !== 'mcp-server') return { ok:true, skill:publicSkill(skill), action:`Open ${skill.source === 'codex' ? 'Codex' : 'Claude Code'} with this local instruction`, prompt:skill.prompt?.slice(0, 1200) || '' };
    try {
      const response = await withMcpClient<{ tools?: Array<{ name:unknown; description?:unknown; inputSchema?:unknown; annotations?:{ readOnlyHint?:boolean } }> }>(skill, client => client.listTools());
      const tools = (response.tools || []).map((tool: any) => ({ name:String(tool.name), description:String(tool.description || 'MCP tool'), inputSchema:tool.inputSchema || {}, readOnly:tool.annotations?.readOnlyHint !== false }));
      return { ok:true, skill:publicSkill(skill), action:'Choose an MCP tool and review its JSON input', tools };
    } catch (error) { return { ok:false, error:error instanceof Error ? error.message : 'Could not inspect this MCP server.' }; }
  };

  const execute = async ({ id, toolName, toolInput }: { id:string; toolName?:string; toolInput?: unknown }): Promise<{ ok:boolean; error?:string; result?:unknown }> => {
    const skill = find(id);
    if (!skill) return { ok:false, error:'That imported skill is no longer available.' };
    try {
      if (skill.kind === 'mcp-server') {
        if (!toolName || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return { ok:false, error:'Provide an MCP tool and a JSON object input.' };
        const result = await withMcpClient(skill, client => client.callTool({ name:toolName, arguments:toolInput }));
        audit({ at:new Date().toISOString(), skillId:skill.id, source:skill.source, kind:skill.kind, action:'call_mcp', outcome:'started' });
        return { ok:true, result };
      }
      const agent = skill.source === 'codex' ? 'codex' : 'claude';
      const instruction = skill.kind === 'command'
        ? `/${skill.commandName || skill.name}`
        : `Use the local instruction at ${skill.location}.`;
      const prompt = `${instruction}${typeof toolInput === 'string' && toolInput.trim() ? `\n\nUser request: ${toolInput.trim()}` : ''}`;
      const terminal = `tell application "Terminal" to activate\ntell application "Terminal" to do script "cd ${shellQuote(root)}; ${agent} ${shellQuote(prompt)}"`;
      const process = spawn('osascript', ['-e', terminal], { detached:true, stdio:'ignore' });
      process.unref();
      audit({ at:new Date().toISOString(), skillId:skill.id, source:skill.source, kind:skill.kind, action:'launch_agent', outcome:'started' });
      return { ok:true };
    } catch (error) {
      audit({ at:new Date().toISOString(), skillId:skill.id, source:skill.source, kind:skill.kind, action:skill.kind === 'mcp-server' ? 'call_mcp' : 'launch_agent', outcome:'failed' });
      return { ok:false, error:error instanceof Error ? error.message : 'Could not run this imported skill.' };
    }
  };

  return { list:(): ImportedSkill[] => discover().map(publicSkill), preview, execute };
}
