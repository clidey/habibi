/**
 * Public, versioned contract for a Habibi capability.
 *
 * Skill manifests are deliberately data-only. A manifest grants no authority;
 * the host maps its declared permissions to an implementation and still asks
 * for approval before every write.
 */
export type SkillKind = 'native' | 'extension' | 'local-service' | 'oauth';

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  kind: SkillKind;
  permissions: readonly string[];
  commands: readonly string[];
  requiresConfirmation?: readonly string[];
}

const kinds = new Set<SkillKind>(['native', 'extension', 'local-service', 'oauth']);
const identifier = /^[a-z][a-z0-9-]{1,63}$/;
const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

function nonEmptyStrings(value: unknown, field: string, manifestId: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Invalid skill manifest ${manifestId}: ${field} must be a non-empty string array`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

/** Parse untrusted JSON into the stable skill manifest contract. */
export function parseSkillManifest(value: unknown): Readonly<SkillManifest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid skill manifest: expected an object');
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const manifestVersion = typeof candidate.version === 'string' ? candidate.version.trim() : '';
  const kind = candidate.kind;
  if (!identifier.test(id)) throw new Error(`Invalid skill manifest ${id || 'unknown'}: id must be kebab-case`);
  if (!name) throw new Error(`Invalid skill manifest ${id}: name is required`);
  if (!version.test(manifestVersion)) throw new Error(`Invalid skill manifest ${id}: version must be semantic versioning`);
  if (typeof kind !== 'string' || !kinds.has(kind as SkillKind)) throw new Error(`Invalid skill manifest ${id}: unsupported kind`);
  const permissions = nonEmptyStrings(candidate.permissions, 'permissions', id);
  const commands = nonEmptyStrings(candidate.commands, 'commands', id);
  const requiresConfirmation = candidate.requiresConfirmation === undefined
    ? undefined
    : nonEmptyStrings(candidate.requiresConfirmation, 'requiresConfirmation', id);
  return Object.freeze({ id, name, version:manifestVersion, kind:kind as SkillKind, permissions, commands, ...(requiresConfirmation ? { requiresConfirmation } : {}) });
}
