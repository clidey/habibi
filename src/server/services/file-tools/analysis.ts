import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FileEntry } from '../../../contracts/file-tools';
export async function fileEvidence(
  entries: FileEntry[],
  contents: boolean,
  native: (value: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  let remaining = 48_000;
  for (const entry of entries.slice(0, 80)) {
    if (!contents || remaining <= 0 || entry.size > 24 * 1024 * 1024) continue;
    const extension = path.extname(entry.path).toLowerCase();
    try {
      if (/^\.(?:txt|md|csv|json|log|html)$/.test(extension)) {
        const handle = await fs.open(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(Math.min(entry.size, 3000, remaining));
          await handle.read(buffer, 0, buffer.length, 0);
          entry.excerpt = buffer.toString('utf8').replace(/<[^>]*>/g, '');
        } finally {
          await handle.close();
        }
      } else if (/^\.(?:pdf|png|jpg|jpeg|heic|tiff?)$/.test(extension)) {
        const inspected = await native({ action: 'inspect', path: entry.path });
        entry.excerpt =
          typeof inspected.text === 'string'
            ? inspected.text.slice(0, Math.min(3000, remaining))
            : '';
        if (typeof inspected.pages === 'number') entry.pages = inspected.pages;
      }
      remaining -= entry.excerpt?.length || 0;
    } catch {
      entry.excerpt = '[Content unavailable]';
    }
  }
}
export async function duplicateGroups(
  entries: FileEntry[],
  verify: (entry: FileEntry) => Promise<void>,
) {
  const sizes = new Map<number, FileEntry[]>();
  for (const entry of entries)
    if (entry.size) sizes.set(entry.size, [...(sizes.get(entry.size) || []), entry]);
  const groups: { hash: string; ids: string[]; bytes: number }[] = [];
  let read = 0;
  let limited = false;
  for (const [size, candidates] of sizes) {
    if (candidates.length < 2) continue;
    const hashes = new Map<string, FileEntry[]>();
    for (const entry of candidates) {
      if (size > 256 * 1024 * 1024 || read + size > 512 * 1024 * 1024) {
        limited = true;
        continue;
      }
      await verify(entry);
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(entry.path)) hash.update(chunk);
      await verify(entry);
      read += size;
      const digest = hash.digest('hex');
      hashes.set(digest, [...(hashes.get(digest) || []), entry]);
    }
    for (const [hash, files] of hashes)
      if (files.length > 1)
        groups.push({ hash, ids: files.map((file) => file.id), bytes: size * (files.length - 1) });
  }
  return { groups, limited };
}
export function storageSummary(entries: FileEntry[]) {
  const categories = new Map<string, number>();
  for (const entry of entries) {
    const extension = path.extname(entry.path).toLowerCase() || 'no extension';
    categories.set(extension, (categories.get(extension) || 0) + entry.size);
  }
  return {
    totalBytes: entries.reduce((sum, file) => sum + file.size, 0),
    files: entries.length,
    categories: [...categories]
      .sort((a, b) => b[1] - a[1])
      .map(([extension, bytes]) => ({ extension, bytes })),
    largest: [...entries]
      .sort((a, b) => b.size - a.size)
      .slice(0, 20)
      .map(({ id, relative, size }) => ({ id, relative, size })),
  };
}
