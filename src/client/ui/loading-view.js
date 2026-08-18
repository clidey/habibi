import { escapeHtml } from '../core/view-helpers.js';

/** Renders the shared content skeleton used while a feature workspace loads. */
export function loadingSkeleton(title, detail = '') {
  return `<div class="kubernetes-loading" aria-live="polite"><div class="kubernetes-loading-title"><span class="spinner"></span><span><b>${escapeHtml(title)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span></div><div class="kubernetes-loading-skeleton"><i></i><i></i><i></i><i></i><i></i></div></div>`;
}
