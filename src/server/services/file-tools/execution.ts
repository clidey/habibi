import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileEntry, FilePlan } from '../../../contracts/file-tools';
import { FileToolsError, createFileAccess } from './access';
type Access = ReturnType<typeof createFileAccess>;
interface Stamp {
  size: number;
  modified: number;
  inode: number;
  device: number;
}
interface RecordEntry {
  from?: string;
  to: string;
  stamp: Stamp;
}
const stamp = async (file: string): Promise<Stamp> => {
  const s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || (await fs.realpath(file)) !== file)
    throw new FileToolsError('A file changed or became a symbolic link.');
  return { size: s.size, modified: s.mtimeMs, inode: s.ino, device: s.dev };
};
const unchanged = async (file: string, expected: Stamp) => {
  const value = await stamp(file);
  if (JSON.stringify(value) !== JSON.stringify(expected))
    throw new FileToolsError(
      'A file changed since the operation. Undo was stopped to protect your edits.',
    );
};
async function available(file: string) {
  if (
    await fs.lstat(file).then(
      () => true,
      () => false,
    )
  )
    throw new FileToolsError('A destination already exists. Nothing will be overwritten.');
}
async function relocate(from: string, to: string) {
  await available(to);
  const original = await stamp(from);
  try {
    await fs.link(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
  try {
    await unchanged(from, original);
    await fs.unlink(from);
  } catch (error) {
    await fs.unlink(to).catch(() => {});
    throw error;
  }
}
export function createFileExecutor(
  root: string,
  access: Access,
  native: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const records = new Map<string, RecordEntry[]>();
  const previewRoot = path.join(root, '.habibi/file-tools/previews');
  const artifactRoot = path.join(root, '.habibi/file-tools/undo');
  async function privateDirectory(directory: string) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }
  async function prepare(plan: FilePlan, selected: number[]) {
    await privateDirectory(previewRoot);
    let cachedBytes = 0;
    for (const name of await fs.readdir(previewRoot)) {
      if (!/^[a-f0-9-]{36}-\d+\.[a-z0-9]+$/i.test(name)) continue;
      const file = path.join(previewRoot, name);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (Date.now() - info.mtimeMs > 25 * 60_000) await fs.unlink(file);
      else cachedBytes += info.size;
    }
    let planBytes = 0;
    const previews: {
      index: number;
      path: string;
      beforeBytes: number;
      afterBytes: number;
      targetMet: boolean;
    }[] = [];
    for (const [index, change] of plan.changes.entries()) {
      if (!selected.includes(index)) continue;
      if (!['image', 'pdf', 'csv'].includes(change.kind)) continue;
      const inputs = change.sources.map((id) => plan.entries.find((entry) => entry.id === id)!);
      for (const input of inputs) await access.verify(input);
      const destination = path.join(
        previewRoot,
        `${plan.id}-${index}${path.extname(change.destination!)}`,
      );
      if (change.kind === 'csv')
        await fs.writeFile(destination, change.csv!, { flag: 'wx', mode: 0o600 });
      else
        await native({
          action: change.kind,
          sources: inputs.map((input) => input.path),
          destination,
          pages: change.pages?.map((page) => ({
            path: inputs.find((input) => input.id === page.source)!.path,
            page: page.page,
            rotate: page.rotate || 0,
          })),
          width: change.width,
          quality: change.quality,
          targetBytes: change.targetBytes,
        });
      for (const input of inputs) await access.verify(input);
      await fs.chmod(destination, 0o600);
      const after = await fs.stat(destination);
      planBytes += after.size;
      cachedBytes += after.size;
      if (planBytes > 200 * 1024 * 1024 || cachedBytes > 512 * 1024 * 1024) {
        await fs.unlink(destination);
        for (const preview of previews) await fs.unlink(preview.path).catch(() => {});
        throw new FileToolsError(
          'Preview storage is full. Prepare a smaller batch or wait for older previews to expire.',
        );
      }
      previews.push({
        index,
        path: destination,
        beforeBytes: inputs.reduce((sum, input) => sum + input.size, 0),
        afterBytes: after.size,
        targetMet: !change.targetBytes || after.size <= change.targetBytes,
      });
    }
    return previews;
  }
  async function target(plan: FilePlan, index: number) {
    const change = plan.changes[index]!;
    const input = plan.entries.find((entry) => entry.id === change.sources[0])!;
    return access.destination(await access.get(input.grantId), change.destination!);
  }
  async function journal() {
    while (records.size > 100) records.delete(records.keys().next().value!);
    const dir = path.join(root, '.habibi/file-tools');
    await privateDirectory(dir);
    const file = path.join(dir, 'journal.json');
    const temporary = file + '.' + crypto.randomUUID();
    await fs.writeFile(temporary, JSON.stringify([...records]), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async function apply(
    plan: FilePlan,
    selected: number[],
    previews: Awaited<ReturnType<typeof prepare>>,
  ) {
    if (plan.status !== 'preview' || plan.expiresAt < Date.now())
      throw new FileToolsError('Prepare a fresh preview before applying.');
    const steps = selected.map((index) => ({ index, change: plan.changes[index]! }));
    if (steps.some(({ change }) => !change)) throw new FileToolsError('This selection is invalid.');
    const sources = new Map<string, FileEntry>();
    for (const { change } of steps)
      for (const id of change.sources)
        sources.set(
          id,
          plan.entries.find((entry) => entry.id === id)!,
        );
    for (const entry of sources.values()) await access.verify(entry);
    for (const { index, change } of steps)
      if (change.kind !== 'trash') await available(await target(plan, index));
    const completed: RecordEntry[] = [];
    try {
      for (const { index, change } of steps) {
        const source = plan.entries.find((entry) => entry.id === change.sources[0])!;
        for (const id of change.sources) await access.verify(sources.get(id)!);
        if (change.kind === 'trash') {
          const result = await native({ action: 'trash', path: source.path });
          if (typeof result.path !== 'string')
            throw new FileToolsError('The file could not be moved to Trash.');
          completed.push({ from: source.path, to: result.path, stamp: await stamp(result.path) });
        } else {
          const to = await target(plan, index);
          await fs.mkdir(path.dirname(to), { recursive: true });
          // Recheck all parents after mkdir; never follow a substituted symlink.
          await target(plan, index);
          if (change.kind === 'move') {
            await relocate(source.path, to);
            completed.push({ from: source.path, to, stamp: await stamp(to) });
          } else {
            const preview = previews.find((item) => item.index === index);
            if (!preview) throw new FileToolsError('The output preview is unavailable.');
            await fs.copyFile(preview.path, to, fs.constants.COPYFILE_EXCL);
            await fs.chmod(to, 0o600);
            completed.push({ to, stamp: await stamp(to) });
          }
        }
      }
      records.set(plan.id, completed);
      await journal();
      plan.status = 'applied';
      plan.outputs = completed.map((item) => item.to);
      return { outputs: plan.outputs };
    } catch (error) {
      const failed: RecordEntry[] = [];
      await privateDirectory(artifactRoot);
      for (const item of [...completed].reverse()) {
        try {
          await unchanged(item.to, item.stamp);
          await relocate(
            item.to,
            item.from || path.join(artifactRoot, crypto.randomUUID() + path.extname(item.to)),
          );
        } catch {
          failed.push(item);
        }
      }
      if (failed.length) {
        records.set(plan.id, failed.reverse());
        await journal();
        plan.status = 'applied';
        throw new FileToolsError(
          'The operation stopped. Some changes could not be rolled back; use Undo after checking the files.',
        );
      }
      plan.status = 'failed';
      throw error;
    }
  }
  async function undo(plan: FilePlan) {
    const items = records.get(plan.id);
    if (plan.status !== 'applied' || !items?.length)
      throw new FileToolsError('There is no applied operation to undo in this conversation.');
    // Validate the complete undo before moving anything.
    for (const item of items) {
      await unchanged(item.to, item.stamp);
      if (item.from) await available(item.from);
    }
    await privateDirectory(artifactRoot);
    const remaining = [...items];
    for (const item of [...items].reverse()) {
      await unchanged(item.to, item.stamp);
      if (item.from && (await fs.realpath(path.dirname(item.from))) !== path.dirname(item.from))
        throw new FileToolsError('The original folder changed. Undo was stopped.');
      await relocate(
        item.to,
        item.from || path.join(artifactRoot, crypto.randomUUID() + path.extname(item.to)),
      );
      remaining.pop();
      records.set(plan.id, [...remaining]);
      await journal();
    }
    records.delete(plan.id);
    await journal();
    plan.status = 'undone';
    return { ok: true };
  }
  return { prepare, apply, undo, target };
}
