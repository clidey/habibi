import { escapeHtml, spinner } from '../core/view-helpers.js';

/** A compact loading state shared by feature workspaces. */
export function loadingSkeleton(title, detail = '') {
  return `<div class="workspace-loading kubernetes-loading" role="status" aria-live="polite"><div class="kubernetes-loading-title">${spinner()}<span><b>${escapeHtml(title)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span></div></div>`;
}
