import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { FileToolsError } from './access';
export function createNativeFileTools(
  helper = process.env.HABIBI_FILE_TOOLS_HELPER ||
    path.resolve(process.env.HABIBI_ROOT || '.', '../../MacOS/HabibiFileTools'),
) {
  return async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    await fs.access(helper).catch(() => {
      throw new FileToolsError('Rebuild Habibi for Mac to enable PDF and image tools.');
    });
    return new Promise((resolve, reject) => {
      const child = execFile(
        helper,
        [],
        { timeout: 90_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error)
            return reject(
              new FileToolsError(
                'This PDF or image could not be processed. Check that it is readable and unlocked.',
              ),
            );
          try {
            const value = JSON.parse(stdout);
            if (!value.ok) throw new Error();
            resolve(value);
          } catch {
            reject(new FileToolsError('This PDF or image could not be processed.'));
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(request));
    });
  };
}
