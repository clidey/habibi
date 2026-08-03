import fs from 'node:fs';
import path from 'node:path';
import { loadSkills } from '../dist/src/core/skill-registry.js';

const root = process.cwd();
const skills = loadSkills(path.join(root, 'skills'));
const ids = new Set();
for (const skill of skills) {
  if (ids.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
  ids.add(skill.id);
}
const documented = fs.readFileSync(path.join(root, 'ARCHITECTURE.md'), 'utf8');
if (!documented.includes('requiresConfirmation')) throw new Error('ARCHITECTURE.md must document skill approval requirements');
console.log(`Validated ${skills.length} Habibi skill manifests.`);
