import fs from 'node:fs';
import path from 'node:path';
import { parseSkillManifest, type SkillManifest } from '../contracts/skill';

/** Load manifests deterministically, failing closed on malformed declarations. */
export function loadSkills(skillsDirectory: string): ReadonlyArray<Readonly<SkillManifest>> {
  if (!fs.existsSync(skillsDirectory)) return [];
  return fs
    .readdirSync(skillsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(skillsDirectory, entry.name, 'manifest.json')),
    )
    .map((entry) => {
      const manifestPath = path.join(skillsDirectory, entry.name, 'manifest.json');
      try {
        return parseSkillManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown validation error';
        throw new Error(`Could not load ${manifestPath}: ${message}`);
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Kept as a named public helper for hosts that load one manifest at a time. */
export const validateSkill = parseSkillManifest;
