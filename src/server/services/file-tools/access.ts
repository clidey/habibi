import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { FileEntry, FileGrant } from '../../../contracts/file-tools';
export class FileToolsError extends Error {}
export const deniedPart =
  /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.gnupg|\.habibi|\.openwa|\.wwebjs_auth|\.codex|\.claude|\.npmrc|\.netrc|Keychains|Cookies|Login Data|History|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx|keychain-db))$/i;
export function permitted(target: string): boolean {
  return (
    !target.split(path.sep).some((part) => deniedPart.test(part)) &&
    !/^\/(?:System|usr|bin|sbin|etc|private\/etc|Library|Applications)(?:\/|$)/.test(target)
  );
}
export function safeRelative(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 500 ||
    /[\x00-\x1f\\]/.test(value) ||
    path.isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || deniedPart.test(part))
  )
    throw new FileToolsError(
      'Choose a relative name without private folders or parent-directory segments.',
    );
  return value;
}
export function createFileAccess() {
  const grants = new Map<string, FileGrant>();
  function sweep() {
    for (const [id, grant] of grants) if (grant.expiresAt < Date.now()) grants.delete(id);
  }
  async function grant(value: unknown): Promise<FileGrant> {
    sweep();
    if (grants.size >= 40)
      throw new FileToolsError('Too many selected paths. Reopen Ask to start a fresh selection.');
    if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f]/.test(value))
      throw new FileToolsError('Choose a file or folder.');
    const requested = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
    if (
      !path.isAbsolute(requested) ||
      !permitted(path.resolve(requested)) ||
      path.resolve(requested) === path.parse(requested).root
    )
      throw new FileToolsError(
        'Choose a personal file or folder, outside private app data and system locations.',
      );
    const stat = await fs.lstat(requested).catch(() => null);
    if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new FileToolsError(
        'This path is unavailable or is a symbolic link. Choose its original location.',
      );
    const canonical = await fs.realpath(requested);
    if (!permitted(canonical))
      throw new FileToolsError('This path contains private or system data.');
    const result = {
      id: crypto.randomUUID(),
      path: canonical,
      name: path.basename(canonical),
      directory: stat.isDirectory(),
      expiresAt: Date.now() + 30 * 60_000,
    };
    grants.set(result.id, result);
    return result;
  }
  async function get(id: string): Promise<FileGrant> {
    sweep();
    const value = grants.get(id);
    if (
      !value ||
      (await fs.realpath(value.path).catch(() => '')) !== value.path ||
      (await fs.lstat(value.path)).isSymbolicLink()
    )
      throw new FileToolsError('Select this path again; its access has expired or changed.');
    return value;
  }
  async function destination(grant: FileGrant, relative: string): Promise<string> {
    const root = grant.directory ? grant.path : path.dirname(grant.path);
    if (!grant.directory && relative.includes('/'))
      throw new FileToolsError('Choose a folder to create nested destinations.');
    const target = path.join(root, safeRelative(relative));
    if (!permitted(target)) throw new FileToolsError('This destination is protected.');
    let parent = path.dirname(target);
    while (parent !== root) {
      const stat = await fs.lstat(parent).catch(() => null);
      if (
        stat &&
        (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(parent)) !== parent)
      )
        throw new FileToolsError('A destination folder changed or is a symbolic link.');
      parent = path.dirname(parent);
    }
    await get(grant.id);
    return target;
  }
  async function inventory(ids: string[]) {
    const entries: FileEntry[] = [];
    const seen = new Set<string>();
    let visited = 0;
    let limited = false;
    for (const id of ids) {
      const selected = await get(id);
      async function visit(target: string, depth: number): Promise<void> {
        if (++visited > 8000 || entries.length >= 2500) {
          limited = true;
          return;
        }
        if (!permitted(target)) return;
        const stat = await fs.lstat(target).catch(() => null);
        if (!stat || stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          if (depth >= 8) {
            limited = true;
            return;
          }
          const names = (await fs.readdir(target).catch(() => [])).sort();
          for (const name of names) {
            if (entries.length >= 2500 || visited > 8000) {
              limited = true;
              break;
            }
            await visit(path.join(target, name), depth + 1);
          }
        } else if (stat.isFile() && !seen.has(target)) {
          seen.add(target);
          entries.push({
            id: crypto.randomUUID(),
            grantId: id,
            relative: selected.directory ? path.relative(selected.path, target) : selected.name,
            path: target,
            size: stat.size,
            modified: stat.mtimeMs,
            device: stat.dev,
            inode: stat.ino,
          });
        }
      }
      await visit(selected.path, 0);
    }
    return { entries, limited };
  }
  async function verify(entry: FileEntry): Promise<void> {
    const grant = await get(entry.grantId);
    if (entry.path !== grant.path && !entry.path.startsWith(grant.path + path.sep))
      throw new FileToolsError('A file is outside the selected path.');
    const stat = await fs.lstat(entry.path).catch(() => null);
    if (
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(entry.path)) !== entry.path ||
      stat.size !== entry.size ||
      stat.mtimeMs !== entry.modified ||
      stat.dev !== entry.device ||
      stat.ino !== entry.inode
    )
      throw new FileToolsError('A file changed after preview. Prepare a fresh plan.');
  }
  return { grant, get, destination, inventory, verify };
}
