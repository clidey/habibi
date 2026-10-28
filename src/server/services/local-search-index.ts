import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as yieldToIO } from 'node:timers/promises';

interface Entry { path: string; name: string; lower: string; directory: string; folder: string; isDirectory: boolean }
interface Options { roots?: string[]; maxEntries?: number; maxDirectories?: number; maxDepth?: number; watch?: boolean; watcherFactory?: typeof fs.watch }
const ignored = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'Library', 'Caches', 'DerivedData', 'Pods', '__pycache__']);
const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Filename-only index. No subprocesses, content reads, periodic scans, or per-query disk I/O. */
export function createLocalSearchIndex(options: Options = {}) {
  const home = os.homedir();
  const roots = [...new Set((options.roots || ['Desktop', 'Documents', 'Downloads', 'Projects', 'Developer', 'Code'].map((name) => path.join(home, name))).map((root) => path.resolve(root)))];
  const maxEntries = options.maxEntries ?? 30_000;
  const maxDirectories = options.maxDirectories ?? 4_000;
  const maxDepth = options.maxDepth ?? 8;
  const entries = new Map<string, Entry>();
  const watchers: fs.FSWatcher[] = [];
  const pending = new Set<string>();
  const reconcileRoots = new Set<string>();
  let initialized: Promise<void> | undefined;
  let working: Promise<void> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let truncated = false;
  const unavailableRoots: string[] = [];
  let indexing = false;

  function allowed(file: string) {
    const root = roots.find((candidate) => file === candidate || file.startsWith(candidate + path.sep));
    if (!root) return false;
    return path.relative(root, file).split(path.sep).every((part) => !part.startsWith('.') && !ignored.has(part) && !/\.(?:app|framework|bundle)$/i.test(part));
  }
  async function walk(start: string, recursive: boolean) {
    const root = roots.find((candidate) => start === candidate || start.startsWith(candidate + path.sep));
    if (!root || !allowed(start)) return;
    // A watch filename is untrusted and can have become a symlink since notification.
    try { if (!(await fs.promises.lstat(start)).isDirectory()) return; } catch { return; }
    const queue = [start];
    let directories = 0;
    for (let cursor = 0; cursor < queue.length && !closed; cursor += 1) {
      const directory = queue[cursor]!;
      if (++directories > maxDirectories) { truncated = true; break; }
      let listing: fs.Dir;
      try { listing = await fs.promises.opendir(directory); } catch { continue; }
      let batch = 0;
      for await (const item of listing) {
        if (closed) break;
        const file = path.join(directory, item.name);
        if (!allowed(file) || item.isSymbolicLink()) continue;
        if (entries.size >= maxEntries && !entries.has(file)) { truncated = true; break; }
        entries.set(file, { path: file, name: item.name, lower: normalize(item.name), directory: directory.startsWith(home + path.sep) ? '~' + directory.slice(home.length) : directory, folder: path.basename(root), isDirectory: item.isDirectory() });
        if (recursive && item.isDirectory() && path.relative(root, file).split(path.sep).length < maxDepth && queue.length < maxDirectories) queue.push(file);
        if (++batch % 256 === 0) await yieldToIO();
      }
      if (directories % 16 === 0) await yieldToIO();
    }
  }
  async function update() {
    const changed = [...pending];
    pending.clear();
    for (const directory of changed) {
      if (reconcileRoots.delete(directory)) {
        for (const file of entries.keys()) if (file.startsWith(directory + path.sep)) entries.delete(file);
        await walk(directory, true);
        continue;
      }
      const previousDirectories = new Set<string>();
      for (const [file, entry] of entries) {
        if (path.dirname(file) !== directory) continue;
        if (entry.isDirectory) previousDirectories.add(file);
        entries.delete(file);
      }
      await walk(directory, false);
      for (const removed of previousDirectories) {
        if (!entries.has(removed)) for (const file of entries.keys()) if (file.startsWith(removed + path.sep)) entries.delete(file);
      }
      // Existing children remain indexed. Only discover newly created directories.
      for (const [file, entry] of entries) {
        if (entry.isDirectory && path.dirname(file) === directory && !previousDirectories.has(file)) await walk(file, true);
      }
    }
  }
  function schedule(directory: string) {
    if (closed || !allowed(directory)) return;
    // Coalesce event bursts and parent/child changes. Bound the event queue too.
    if ([...pending].some((parent) => directory === parent || directory.startsWith(parent + path.sep))) return;
    for (const child of pending) if (child.startsWith(directory + path.sep)) pending.delete(child);
    if (pending.size >= 64) return;
    pending.add(directory);
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      working = (working || Promise.resolve()).then(update).catch(() => {});
    }, 750);
    debounce.unref();
  }
  function ready() {
    if (!initialized) initialized = (async () => {
      indexing = true;
      for (const root of roots) {
        if (closed) break;
        try {
          if (!(await fs.promises.lstat(root)).isDirectory()) continue;
          if (options.watch !== false) {
            try {
              const realRoot = await fs.promises.realpath(root);
              const watcher = (options.watcherFactory || fs.watch)(root, { recursive: true, persistent: false }, (_event, filename) => {
                // Coalesced filesystem notifications may omit the filename.
                // Reconcile this watched root once instead of losing the change.
                if (!filename) { reconcileRoots.add(root); schedule(root); return; }
                const notified = path.resolve(root, String(filename));
                // macOS can report canonical /private paths for roots reached
                // through /var aliases. Keep entries under the configured root.
                const file = notified === realRoot || notified.startsWith(realRoot + path.sep)
                  ? path.join(root, path.relative(realRoot, notified)) : notified;
                if (allowed(file)) schedule(file === root ? root : path.dirname(file));
              });
              watcher.on('error', () => { watcher.close(); });
              watchers.push(watcher);
            } catch { /* Unsupported watch hosts can use explicit refresh. No polling fallback. */ }
          }
          const listing = await fs.promises.opendir(root);
          await listing.close();
          await walk(root, true);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailableRoots.push(path.basename(root)); }
      }
      indexing = false;
    })();
    return initialized;
  }
  async function search(query: string, limit = 12) {
    await ready();
    const needle = normalize(String(query).slice(0, 160)).trim();
    const tokens = needle.split(/[\s._-]+/).filter(Boolean).slice(0, 8);
    if (needle.length < 2 || !tokens.length || closed) return [];
    const best: { entry: Entry; score: number }[] = [];
    const count = Math.min(50, Math.max(1, limit));
    for (const entry of entries.values()) {
      if (!tokens.every((token) => entry.lower.includes(token))) continue;
      const stem = entry.lower.replace(/\.[^.]+$/, '');
      const score = entry.lower === needle || stem === needle ? 100 : entry.lower.startsWith(needle) ? 80 : 40 - entry.name.length / 100;
      let at = best.findIndex((item) => score > item.score);
      if (at < 0) at = best.length;
      if (at < count) { best.splice(at, 0, { entry, score }); if (best.length > count) best.pop(); }
    }
    return best.map(({ entry: { lower: _lower, isDirectory: _directory, ...entry }, score }) => ({ ...entry, score }));
  }
  return {
    ready, search,
    status: () => ({ indexed: entries.size, indexing, truncated, unavailableRoots, roots: roots.map((root) => path.basename(root)), watchers: watchers.length }),
    async refresh() { if (!initialized) return ready(); await ready(); working = (working || Promise.resolve()).then(async () => { entries.clear(); truncated = false; for (const root of roots) await walk(root, true); }); await working; },
    close() { closed = true; clearTimeout(debounce); pending.clear(); reconcileRoots.clear(); for (const watcher of watchers) watcher.close(); entries.clear(); },
  };
}
