import type { WhoDbDataset } from '../../contracts/whodb';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 8000) => typeof value === 'string' ? value.slice(0, limit) : '';

export function unwrapWhoDbResult(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.isError) throw new Error('WhoDB tool failed.');
  let data = record(result.structuredContent);
  if (!Object.keys(data).length && Array.isArray(result.content)) {
    for (const content of result.content.slice(0, 8)) {
      const part = record(content);
      if (part.type !== 'text' || typeof part.text !== 'string' || part.text.length > 2_000_000) continue;
      try { data = record(JSON.parse(part.text)); break; } catch { /* Only typed JSON results enter the UI. */ }
    }
  }
  if (!Object.keys(data).length || data.error || data.ok === false) throw new Error('WhoDB returned an invalid or unsuccessful result.');
  return data;
}

export function normalizeWhoDbResult(value: unknown, project: string): WhoDbDataset {
  const wrapper = record(value);
  const data = Object.keys(record(wrapper.data)).length ? record(wrapper.data) : wrapper;
  const raw = Array.isArray(data.rows) ? data.rows : Array.isArray(data.items) ? data.items : Array.isArray(wrapper.data) ? wrapper.data : [];
  let columns = Array.isArray(data.columns) ? data.columns.slice(0, 40).map((column) => typeof column === 'string' ? column : text(record(column).name || record(column).Name, 160)) : [];
  if (!columns.length && raw[0] && !Array.isArray(raw[0])) columns = Object.keys(record(raw[0])).slice(0, 40);
  if (!columns.length && Array.isArray(raw[0])) columns = raw[0].slice(0, 40).map((_cell, index) => `Column ${index + 1}`);
  const cell = (value: unknown) => value == null ? '' : typeof value === 'string' ? value.slice(0, 2000) : typeof value === 'number' || typeof value === 'boolean' ? value : (JSON.stringify(value) || '').slice(0, 2000);
  const rows = raw.slice(0, 100).map((row) => columns.map((column, index) => cell(Array.isArray(row) ? row[index] : record(row)[column])));
  const provenance = Array.isArray(data.provenance) ? data.provenance.slice(0, 20).map((item) => typeof item === 'string' ? item.slice(0, 160) : text(record(item).name || record(item).source, 160)).filter(Boolean) : [];
  const warnings = [...(Array.isArray(wrapper.warnings) ? wrapper.warnings : []), ...(Array.isArray(data.warnings) ? data.warnings : [])].slice(0, 8).map((item) => text(item, 1000)).filter(Boolean);
  const partial = wrapper.truncated === true || data.partial === true || raw.length > 100;
  return { project: text(project, 160), title: text(data.title || data.name, 200) || 'WhoDB result', columns, rows, sql: text(data.sql || data.query || wrapper.sql, 20000), provenance, warnings, partial, text: !rows.length ? JSON.stringify(data, null, 2).slice(0, 20000) : '' };
}
