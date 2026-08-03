const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSkillImportService } = require('../src/agent/skill-import-service');

test('imports Codex skills, Claude commands, and MCP handles without exposing MCP secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'habibi-import-'));
  fs.mkdirSync(path.join(root, '.codex', 'skills', 'review'), { recursive:true });
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive:true });
  fs.writeFileSync(path.join(root, '.codex', 'skills', 'review', 'SKILL.md'), '---\nname: Review PR\ndescription: Review changed files\n---\n# Review\n');
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'ship.md'), '# Ship\nPrepare a release.');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers:{ private:{ command:'npx', args:['server'], env:{ TOKEN:'never-return-this' } } } }));
  const service = createSkillImportService({ root, stateRoot:root, home:path.join(root, 'home') });
  const skills = service.list();
  assert.deepEqual(skills.map(skill => `${skill.source}:${skill.name}`), ['claude:Ship', 'codex:Review PR', 'mcp:private']);
  assert.equal(JSON.stringify(skills).includes('never-return-this'), false);
  const preview = await service.preview(skills[0].id);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.match(preview.action, /Claude Code/);
  fs.rmSync(root, { recursive:true, force:true });
});
