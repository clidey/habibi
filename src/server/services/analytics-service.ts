export type AnalyticsPayload = {
  event?: unknown;
  distinctId?: unknown;
  properties?: unknown;
};

const allowedEvents = new Set([
  'habibi.launcher.opened', 'habibi.settings.opened', 'habibi.search.submitted',
  'habibi.result.opened', 'habibi.chat.opened', 'habibi.chat.sent',
  'habibi.connector.connected', 'habibi.system-action.confirmed',
  'habibi.file-investigation.started', 'habibi.file-investigation.completed',
]);
const allowedProperties = new Set([
  'surface', 'result_type', 'connector_type', 'provider_type', 'action', 'outcome',
  'query_length_bucket', 'query_word_count_bucket', 'message_length_bucket',
  'attachment_count_bucket', 'has_attachments', 'file_candidate_count_bucket',
  'trace_step_count_bucket', 'app_type', 'app_version',
]);

function safeProperties(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const safe: Record<string, string | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedProperties.has(key)) continue;
    if (typeof item === 'boolean') safe[key] = item;
    else if (typeof item === 'string' && item.length <= 64 && /^[a-zA-Z0-9 _+.-]+$/.test(item)) safe[key] = item;
  }
  return safe;
}

/** Server-side PostHog proxy: enforces the privacy event contract centrally. */
export function createAnalyticsService({
  host = process.env.HABIBI_POSTHOG_HOST || 'https://z.clidey.com',
  apiKey = process.env.HABIBI_POSTHOG_KEY || 'phc_hbXcCoPTdxm5ADL8PmLSYTIUvS6oRWFM2JAK8SMbfnH',
  send = globalThis.fetch,
}: { host?: string; apiKey?: string; send?: typeof fetch } = {}) {
  async function capture(payload: AnalyticsPayload): Promise<boolean> {
    const event = typeof payload.event === 'string' ? payload.event : '';
    const distinctId = typeof payload.distinctId === 'string' ? payload.distinctId : '';
    if (!allowedEvents.has(event) || !/^[a-f0-9-]{36}$/i.test(distinctId) || !apiKey) return false;
    const properties = safeProperties(payload.properties);
    try {
      await send(`${host.replace(/\/$/, '')}/capture/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, event, properties: { distinct_id: distinctId, product: 'habibi', ...properties } }),
      });
      return true;
    } catch (_) { return false; }
  }
  return { capture };
}
