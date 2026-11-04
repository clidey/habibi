import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RecentFile } from '../../contracts/daily-utilities';

/** A bounded metadata index; original documents are never copied or scanned. */
export function createRecentFiles(root: string, home = process.env.HOME || '') {
  const directory = path.join(root, '.habibi', 'recent');
  const file = path.join(directory, 'files.json');
  let pending: Promise<unknown> = Promise.resolve();
  async function read(): Promise<RecentFile[]> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 512 * 1024) throw new Error('Invalid history');
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some(
          (item) =>
            !item ||
            typeof item.id !== 'string' ||
            !/^[a-f0-9]{32}$/.test(item.id) ||
            typeof item.size !== 'number' ||
            !Number.isSafeInteger(item.size) ||
            item.size < 0 ||
            typeof item.path !== 'string' ||
            !path.isAbsolute(item.path) ||
            typeof item.name !== 'string' ||
            !['file', 'folder'].includes(item.kind) ||
            typeof item.pinned !== 'boolean' ||
            !Number.isFinite(Date.parse(item.openedAt)),
        )
      )
        throw new Error('Invalid history');
      return value as RecentFile[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read recent files.');
    }
  }
  async function write(items: RecentFile[]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(items), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  function mutate<T>(run: (items: RecentFile[]) => Promise<T>) {
    const task = pending.then(async () => {
      const items = await read();
      const result = await run(items);
      await write(items);
      return result;
    });
    pending = task.catch(() => {});
    return task;
  }
  async function approvedPath(value: unknown) {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.length > 4096 ||
      value.includes('\0') ||
      !home
    )
      return null;
    try {
      const [target, base] = await Promise.all([fs.realpath(value), fs.realpath(home)]);
      if (!target.startsWith(`${base}${path.sep}`)) return null;
      if (
        target
          .slice(base.length)
          .split(path.sep)
          .some(
            (part) =>
              ['.habibi', '.openwa', '.ssh', '.aws', '.gnupg'].includes(part) ||
              part === '.env' ||
              part.startsWith('.env.'),
          )
      )
        return null;
      const stat = await fs.stat(target);
      return stat.isFile() || stat.isDirectory() ? { target, stat } : null;
    } catch {
      return null;
    }
  }
  return {
    async record(value: unknown) {
      const resolved = await approvedPath(value);
      if (!resolved) return;
      const { target, stat } = resolved;
      return mutate(async (items) => {
        const id = createHash('sha256').update(target).digest('hex').slice(0, 32);
        const old = items.find((item) => item.id === id);
        const item: RecentFile = {
          id,
          path: target,
          name: path.basename(target),
          kind: stat.isDirectory() ? 'folder' : 'file',
          size: stat.size,
          openedAt: new Date().toISOString(),
          pinned: old?.pinned || false,
        };
        const next = [item, ...items.filter((entry) => entry.id !== id)]
          .sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt.localeCompare(a.openedAt),
          )
          .slice(0, 100);
        items.splice(0, items.length, ...next);
      });
    },
    async list() {
      await pending;
      return Promise.all(
        (await read())
          .sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || b.openedAt.localeCompare(a.openedAt),
          )
          .map(async (item) => ({ ...item, available: Boolean(await approvedPath(item.path)) })),
      );
    },
    update(id: unknown, pinned: unknown) {
      return mutate(async (items) => {
        const item = items.find((entry) => entry.id === id);
        if (!item || typeof pinned !== 'boolean') throw new Error('Choose an existing item.');
        if (pinned && items.filter((entry) => entry.pinned).length >= 20 && !item.pinned)
          throw new Error('You can pin up to 20 files.');
        item.pinned = pinned;
      });
    },
    remove(id?: unknown) {
      return mutate(async (items) => {
        if (id === undefined) items.splice(0);
        else {
          const index = items.findIndex((item) => item.id === id);
          if (index >= 0) items.splice(index, 1);
        }
      });
    },
  };
}
