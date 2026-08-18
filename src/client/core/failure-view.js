import { escapeHtml } from './view-helpers.js';
import { setHtml } from './safe-dom.js';

/**
 * Provider/driver error messages (IMAP, kubectl, node fs errors) leak absolute
 * paths, stack frames, and error codes that mean nothing to a user and were
 * never written to be read by one. Only a message that already looks like
 * plain, human-facing text is shown as-is; anything else falls back to the
 * caller's own copy.
 */
const looksInternal = (message) =>
  /(^Error:|\bat \S+:\d+:\d+|\/Users\/|\/var\/|\/etc\/|ENOENT|ECONNREFUSED|ECONNRESET|EACCES|ETIMEDOUT|errno|node_modules|TypeError|ReferenceError)/i.test(
    message,
  );

export const categorizeError = (error, fallback) => {
  const message = String(error?.message || '').trim();
  if (!message || message.length > 140 || looksInternal(message)) return fallback;
  return message;
};

/**
 * Shared empty/failure state renderer for the "escapeHtml(error.message ||
 * fallback)" pattern repeated across Mail, WhatsApp, Agent Dock, Skills, and
 * Kubernetes. Centralizing it means every call site gets non-leaking text and
 * an optional retry action for free.
 */
export const renderFailure = (
  container,
  error,
  { fallback = 'Something went wrong.', retry } = {},
) => {
  if (!container) return;
  const message = categorizeError(error, fallback);
  setHtml(
    container,
    `<div class="local-files-empty">${escapeHtml(message)}${retry ? '<button type="button" class="link-button failure-retry">Try again</button>' : ''}</div>`,
  );
  if (retry) container.querySelector('.failure-retry')?.addEventListener('click', retry);
};
