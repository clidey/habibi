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
  tools?: readonly Readonly<{ name:string; description:string; readOnly:boolean }> [];
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

function pluginTools(value: unknown, manifestId: string): ReadonlyArray<Readonly<{ name:string; description:string; readOnly:boolean }>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error(`Invalid skill manifest ${manifestId}: tools must be a non-empty array`);
  const seen = new Set<string>();
  return Object.freeze(value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid skill manifest ${manifestId}: tool must be an object`);
    const candidate = item as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    if (!identifier.test(name) || !description || typeof candidate.readOnly !== 'boolean' || seen.has(name)) throw new Error(`Invalid skill manifest ${manifestId}: invalid tool declaration`);
    seen.add(name); return Object.freeze({ name, description, readOnly:candidate.readOnly });
  }));
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
  const tools = pluginTools(candidate.tools, id);
  const requiresConfirmation = candidate.requiresConfirmation === undefined
    ? undefined
    : nonEmptyStrings(candidate.requiresConfirmation, 'requiresConfirmation', id);
  return Object.freeze({ id, name, version:manifestVersion, kind:kind as SkillKind, permissions, commands, ...(tools ? { tools } : {}), ...(requiresConfirmation ? { requiresConfirmation } : {}) });
}
