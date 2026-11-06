import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { FilePlan, FileTask } from '../../../contracts/file-tools';
import { createFileAccess, FileToolsError, permitted } from './access';
import { createNativeFileTools } from './native';
import { fileEvidence, duplicateGroups, storageSummary } from './analysis';
import { FILE_TASKS, filePlanningPrompt, validateFileProposal } from './planner';
import { createFileExecutor } from './execution';
import { dailyPlanningPrompt, normalizeDailyPlan } from './daily-plan';
interface Completion {
  ok: boolean;
  text?: string;
  error?: string;
  provider?: string;
  model?: string;
}
interface Model {
  complete(value: {
    messages: { role: string; text: string }[];
    systemPrompt: string;
  }): Promise<Completion>;
}
export function createFileToolsService({
  root,
  llm,
  native = createNativeFileTools(),
}: {
  root: string;
  llm: Model;
  native?: ReturnType<typeof createNativeFileTools>;
}) {
  const access = createFileAccess();
  const executor = createFileExecutor(root, access, native);
  const inventories = new Map<string, Awaited<ReturnType<typeof access.inventory>>>();
  const plans = new Map<
    string,
    { plan: FilePlan; previews: Awaited<ReturnType<typeof executor.prepare>>; busy: boolean }
  >();
  function sweep() {
    for (const [id, value] of plans)
      if (value.plan.expiresAt < Date.now() && value.plan.status === 'preview' && !value.busy)
        plans.delete(id);
    while (plans.size > 20) {
      const key = [...plans].find(([, value]) => !value.busy)?.[0];
      if (!key) break;
      plans.delete(key);
    }
  }
  async function paths(query: string) {
    const requested = query.startsWith('~/') ? path.join(os.homedir(), query.slice(2)) : query;
    const full = path.isAbsolute(requested);
    const base = full ? (query.endsWith('/') ? requested : path.dirname(requested)) : os.homedir();
    const needle = (
      full && !query.endsWith('/') ? path.basename(requested) : full ? '' : query
    ).toLowerCase();
    if (!permitted(base)) return [];
    const names = await fs.readdir(base).catch(() => []);
    const values = [];
    for (const name of names.sort()) {
      if (!name.toLowerCase().includes(needle) || name.startsWith('.')) continue;
      const target = path.join(base, name);
      if (!permitted(target)) continue;
      const stat = await fs.lstat(target).catch(() => null);
      if (stat && !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()))
        values.push({ path: target, name, directory: stat.isDirectory() });
      if (values.length >= 12) break;
    }
    return values;
  }
  async function inspect(ids: string[]) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 8 ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new FileToolsError('Mention up to eight files or folders first.');
    const inventory = await access.inventory([...new Set(ids)]);
    const id = crypto.randomUUID();
    if (inventories.size >= 20) inventories.delete(inventories.keys().next().value!);
    inventories.set(id, inventory);
    return { id, ...inventory, storage: storageSummary(inventory.entries) };
  }
  async function prepare(value: {
    grants: string[];
    task: FileTask;
    request: string;
    shareContents?: boolean;
    allowCleanup?: boolean;
    allowModel?: boolean;
  }) {
    sweep();
    if (
      !FILE_TASKS.includes(value.task) ||
      typeof value.request !== 'string' ||
      !value.request.trim() ||
      value.request.length > 4000
    )
      throw new FileToolsError('Choose a supported file task and a short request.');
    const scan = await inspect(value.grants);
    const entries = scan.entries;
    const cleanup = value.allowCleanup === true;
    const duplicates =
      value.task === 'duplicates' ? await duplicateGroups(entries, access.verify) : undefined;
    let proposal: { summary: string; changes: unknown[]; findings: unknown[] } = {
      summary: 'Local scan complete. No files have changed.',
      changes: [],
      findings: [],
    };
    let provider = 'local',
      model = '';
    if (value.allowModel) {
      for (const entry of entries.slice(0, 100)) await access.verify(entry);
      await fileEvidence(entries, value.shareContents === true, native);
      for (const entry of entries.slice(0, 100)) await access.verify(entry);
      const evidence = entries
        .slice(0, 100)
        .map(({ id, relative, size, modified, excerpt, pages }) => ({
          id,
          name: relative,
          bytes: size,
          modified: new Date(modified).toISOString(),
          ...(value.shareContents ? { excerpt, pages } : {}),
        }));
      const result = await llm.complete({
        systemPrompt: filePlanningPrompt(value.task, cleanup),
        messages: [
          {
            role: 'user',
            text: JSON.stringify({
              request: value.request,
              permissions: {
                cleanupEnabled: cleanup,
                phase: 'preview_only',
                executionRequiresUserApproval: true,
              },
              files: evidence,
              storage: scan.storage,
              duplicates,
              truncated: scan.limited || entries.length > 100,
            }),
          },
        ],
      });
      if (!result.ok)
        throw new FileToolsError(
          'The configured model could not prepare this plan. Check model settings and try again.',
        );
      try {
        proposal = JSON.parse((result.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      } catch {
        throw new FileToolsError(
          'The model returned an unreadable plan. Try a more specific request.',
        );
      }
      provider = result.provider || 'configured model';
      model = result.model || '';
    } else if (!['storage', 'duplicates'].includes(value.task))
      throw new FileToolsError('Review what will be shared, then choose Prepare with AI.');
    const validated = validateFileProposal(proposal, entries, value.task, cleanup);
    const plan: FilePlan = {
      ...validated,
      id: crypto.randomUUID(),
      task: value.task,
      entries,
      cleanup,
      createdAt: Date.now(),
      expiresAt: Date.now() + 20 * 60_000,
      status: 'preview',
      ...(scan.limited || entries.length > 100
        ? {
            warning:
              'This is a bounded scan. AI received at most 100 file records; a scan can contain at most 2,500 files across eight directory levels.',
          }
        : {}),
    };
    if (
      duplicates &&
      plan.changes.some(
        (change) =>
          change.kind === 'trash' &&
          !duplicates.groups.some(
            (group) =>
              group.ids.includes(change.sources[0]!) &&
              group.ids.some(
                (id) =>
                  !plan.changes.some(
                    (other) => other.kind === 'trash' && other.sources.includes(id),
                  ),
              ),
          ),
      )
    )
      throw new FileToolsError(
        'Cleanup must retain at least one verified identical copy of every duplicate group.',
      );
    // Planning is read-only: conversion starts only in an approved preview/apply path.
    const previews: Awaited<ReturnType<typeof executor.prepare>> = [];
    // Check destination paths and collisions during preview, as well as at execution.
    for (let index = 0; index < plan.changes.length; index++)
      if (plan.changes[index]!.kind !== 'trash') {
        const target = await executor.target(plan, index);
        if (
          await fs.lstat(target).then(
            () => true,
            () => false,
          )
        )
          throw new FileToolsError(
            'A proposed destination already exists. Ask for unique output names.',
          );
      }
    plans.set(plan.id, { plan, previews, busy: false });
    return { plan, previews, storage: scan.storage, duplicates, provider, model };
  }
  function get(id: string) {
    const value = plans.get(id);
    if (!value) throw new FileToolsError('This preview is no longer available. Prepare a new one.');
    return value;
  }
  function validateSelection(plan: FilePlan, selected: number[]) {
    if (plan.status !== 'preview' || plan.expiresAt < Date.now())
      throw new FileToolsError('Prepare a fresh plan before confirming an action.');
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((index) => !Number.isInteger(index) || !plan.changes[index])
    )
      throw new FileToolsError('Choose valid changes from the plan.');
  }
  async function generatePreviews(value: ReturnType<typeof get>, selected: number[]) {
    const missing = selected.filter(
      (index) => !value.previews.some((preview) => preview.index === index),
    );
    const generated = await executor.prepare(value.plan, missing);
    value.previews.push(...generated);
    return value.previews;
  }
  async function preview(id: string, selected: number[]) {
    const value = get(id);
    if (value.busy) throw new FileToolsError('This plan is already running.');
    validateSelection(value.plan, selected);
    if (
      !selected.some((index) => ['image', 'pdf', 'csv'].includes(value.plan.changes[index]!.kind))
    )
      throw new FileToolsError('Choose an output conversion to preview.');
    value.busy = true;
    try {
      return { previews: await generatePreviews(value, selected) };
    } finally {
      value.busy = false;
    }
  }
  async function apply(id: string, selected: number[], cleanupAcknowledged: boolean) {
    const value = get(id);
    if (value.busy) throw new FileToolsError('This plan is already running.');
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((index) => !Number.isInteger(index) || !value.plan.changes[index])
    )
      throw new FileToolsError('Choose valid changes from the preview.');
    if (
      selected.some((index) => value.plan.changes[index]!.kind === 'trash') &&
      (!value.plan.cleanup || !cleanupAcknowledged)
    )
      throw new FileToolsError('Confirm the selected Trash operations before applying cleanup.');
    validateSelection(value.plan, selected);
    value.busy = true;
    try {
      await generatePreviews(value, selected);
      const result = await executor.apply(value.plan, selected, value.previews);
      return { ...result, previews: value.previews };
    } finally {
      value.busy = false;
    }
  }
  async function undo(id: string) {
    const value = get(id);
    if (value.busy) throw new FileToolsError('This plan is already running.');
    value.busy = true;
    try {
      return await executor.undo(value.plan);
    } finally {
      value.busy = false;
    }
  }
  async function daily(request: unknown) {
    if (typeof request !== 'string' || !request.trim() || request.length > 4000)
      throw new FileToolsError('Describe the task and time.');
    const result = await llm.complete({
      systemPrompt: dailyPlanningPrompt(),
      messages: [{ role: 'user', text: request }],
    });
    if (!result.ok)
      throw new FileToolsError(
        'The configured model could not prepare this utility. Check model settings.',
      );
    try {
      return normalizeDailyPlan(
        JSON.parse((result.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()),
      );
    } catch (error) {
      if (error instanceof FileToolsError) throw error;
      throw new FileToolsError('The model returned an unreadable utility plan.');
    }
  }
  return { paths, daily, grant: access.grant, inspect, prepare, preview, apply, undo, get };
}
