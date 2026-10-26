import { escapeHtml, icon } from '../../core/view-helpers.js';

const value = (item) => typeof item === 'string' ? item : JSON.stringify(item);
function chartMarkup(dataset) {
  if (dataset.rows.length < 2 || dataset.rows.length > 24 || dataset.columns.length < 2) return '';
  const numeric = dataset.columns.findIndex((_column, index) => dataset.rows.every((row) => row[index] !== '' && Number.isFinite(Number(row[index]))));
  const category = dataset.columns.findIndex((_column, index) => index !== numeric);
  if (numeric < 0 || category < 0 || dataset.rows.some((row) => Number(row[numeric]) < 0)) return '';
  const maximum = Math.max(...dataset.rows.map((row) => Math.abs(Number(row[numeric]))));
  if (!maximum) return '';
  return `<section class="whodb-result-card"><div class="whodb-card-heading"><span><b>${escapeHtml(dataset.title)}</b><small>VIEW · ${escapeHtml(dataset.columns[numeric])}</small></span><span class="result-badge">${dataset.partial ? 'Partial' : 'Returned rows'}</span></div><div class="whodb-bar-chart" role="img" aria-label="${escapeHtml(dataset.columns[numeric])} by ${escapeHtml(dataset.columns[category])}">${dataset.rows.map((row) => `<div class="whodb-bar-column"><span>${escapeHtml(row[numeric])}</span><i style="height:${Math.max(1, Math.abs(Number(row[numeric])) / maximum * 160)}px"></i><small>${escapeHtml(row[category])}</small></div>`).join('')}</div></section>`;
}
function metricsMarkup(dataset) {
  if (!dataset || dataset.rows.length < 2) return '';
  const numeric = dataset.columns.findIndex((_column, index) => dataset.rows.every((row) => row[index] !== '' && Number.isFinite(Number(row[index])) && Number(row[index]) >= 0));
  const category = dataset.columns.findIndex((_column, index) => index !== numeric);
  if (numeric < 0 || category < 0) return '';
  const total = dataset.rows.reduce((sum, row) => sum + Number(row[numeric]), 0);
  const top = dataset.rows.reduce((best, row) => Number(row[numeric]) > Number(best[numeric]) ? row : best);
  return `<div class="whodb-metric-grid"><div><small>${escapeHtml(dataset.columns[numeric])} · RETURNED TOTAL</small><b>${escapeHtml(total.toLocaleString())}</b><span>${dataset.partial ? 'Partial result' : 'Sum of returned groups'}</span></div><div><small>${escapeHtml(top[category])}</small><b>${total ? Math.round(Number(top[numeric]) / total * 100) : 0}%</b><span>Share of returned total</span></div><div><small>GROUPS RETURNED</small><b>${dataset.rows.length}</b><span>${escapeHtml(dataset.columns[category])}</span></div></div>`;
}
export function whoDbResultMarkup(result) {
  const datasets = Array.isArray(result.datasets) ? result.datasets : [];
  return `<div class="whodb-tool-trace"><span>${icon('check')} Used ${(result.trace || []).length} tools</span><details><summary>Details</summary><ol>${(result.trace || []).map((step) => `<li><code>${escapeHtml(step.tool)}</code><small>${escapeHtml(step.project)}</small></li>`).join('')}</ol></details></div><p class="whodb-answer">${escapeHtml(result.answer)}</p>${result.budgetLimited ? '<p class="link-warning">The tool budget was reached. Select a project or narrow your question to continue.</p>' : ''}${result.partial ? '<p class="link-warning">This answer covers the first 12 projects. Select a project for a complete answer within that project.</p>' : ''}${metricsMarkup(datasets.find((dataset) => dataset.rows.length > 1))}${datasets.map((dataset) => `${chartMarkup(dataset)}<section class="whodb-result-card"><div class="whodb-card-heading"><span><b>${escapeHtml(dataset.title)}</b><small>${escapeHtml(dataset.project)} · DATASET</small></span><span class="result-badge">${dataset.rows.length} rows${dataset.partial ? ' · Partial' : ''}</span></div>${dataset.rows.length ? `<div class="whodb-table-scroll"><table><thead><tr>${dataset.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${dataset.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(value(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<pre class="whodb-metadata">${escapeHtml(dataset.text || '')}</pre>`}${dataset.warnings?.length ? `<p class="link-warning">${dataset.warnings.map((warning) => escapeHtml(warning)).join('<br>')}</p>` : ''}${dataset.partial ? '<p class="link-warning">WhoDB marked this result as partial. These rows are not a complete total.</p>' : ''}${dataset.sql ? `<details class="whodb-sql"><summary>${icon('database')} Read-only query <span>Show SQL</span></summary><pre>${escapeHtml(dataset.sql)}</pre></details>` : ''}${dataset.provenance?.length ? `<div class="whodb-provenance">Provenance ${dataset.provenance.map((source) => `<code>${escapeHtml(source)}</code>`).join('')}</div>` : ''}</section>`).join('')}<div class="whodb-result-actions"><button class="secondary" id="copy-whodb-results">${icon('copy')} Copy results</button>${datasets.some((dataset) => dataset.sql) ? '<button class="secondary" id="copy-whodb-sql">Copy SQL</button>' : ''}<span>READ-ONLY</span></div>`;
}
