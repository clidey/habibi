import fs from 'node:fs/promises';
import path from 'node:path';
/** Resolve and snapshot explicitly attached files only after the send approval is consumed. */
export async function readMailAttachments(
  value: unknown,
  home = process.env.HOME || '',
): Promise<{ filename: string; content: Buffer }[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || !home)
    throw new Error('Choose up to five local attachments.');
  const base = await fs.realpath(home);
  let total = 0;
  const result = [];
  for (const item of value) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      !path.isAbsolute(item.path) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 200 ||
      /[\r\n\0/\\]/.test(item.name)
    )
      throw new Error('An attachment is invalid.');
    const target = await fs.realpath(item.path);
    if (!target.startsWith(`${base}${path.sep}`))
      throw new Error('Choose a file inside your home folder.');
    const handle = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      total += stat.size;
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || total > 20 * 1024 * 1024)
        throw new Error('Attachments exceed the size limit.');
      const content = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(content, 0, stat.size, 0);
      if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size)
        throw new Error('An attachment changed. Attach it again.');
      result.push({ filename: item.name, content });
    } finally {
      await handle.close();
    }
  }
  return result;
}
