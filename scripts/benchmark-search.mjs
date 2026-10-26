import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLocalSearchIndex } = require('../dist/src/server/services/local-search-index.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'habibi-search-bench-'));
const count = Math.min(30_000, Math.max(100, Number(process.argv[2]) || 20_000));
let index;
try {
  // Synthetic empty files only. Never crawl a real account or private directory.
  for (let directory = 0; directory < 100; directory++) {
    const folder = path.join(root, `project-${directory}`);
    await fs.mkdir(folder);
    for (let offset = directory; offset < count; offset += 100) {
      await fs.writeFile(path.join(folder, `project-${offset}-design-invoice.pdf`), '');
    }
  }
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  index = createLocalSearchIndex({ roots: [root], watch: false });
  const started = performance.now();
  await index.ready();
  const coldMs = performance.now() - started;
  global.gc?.();
  const heapMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  const queries = ['design', 'invoice', 'project-120', 'missing-name', 'pdf'];
  const durations = [];
  for (let run = 0; run < 200; run++) {
    const time = performance.now();
    await index.search(queries[run % queries.length]);
    durations.push(performance.now() - time);
  }
  durations.sort((left, right) => left - right);
  const cpuBefore = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const idleCpu = process.cpuUsage(cpuBefore);
  console.log(JSON.stringify({ files: count, entries: index.status().indexed, coldIndexMs: +coldMs.toFixed(1), warmP50Ms: +durations[100].toFixed(2), warmP95Ms: +durations[190].toFixed(2), heapDeltaMiB: +heapMiB.toFixed(2), idleCpuMsOverOneSecond: +((idleCpu.user + idleCpu.system) / 1000).toFixed(2), note: 'Synthetic filename-index benchmark; excludes browser, connectors, application discovery, and full-app energy use.' }, null, 2));
} finally {
  index?.close();
  await fs.rm(root, { recursive: true, force: true });
}
