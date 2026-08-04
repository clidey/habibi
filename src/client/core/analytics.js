// Product analytics is deliberately tiny and opt-in. This module never sends
// user content: callers provide only bucketed, low-cardinality product data.
const consentKey = 'habibi.product-analytics.consent.v1';
const distinctIdKey = 'habibi.product-analytics.distinct-id.v1';

export function analyticsEnabled() {
  return localStorage.getItem(consentKey) === 'granted';
}

export function setAnalyticsEnabled(enabled) {
  localStorage.setItem(consentKey, enabled ? 'granted' : 'denied');
}

function distinctId() {
  let value = localStorage.getItem(distinctIdKey);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(distinctIdKey, value);
  }
  return value;
}

export function lengthBucket(value) {
  const length = String(value || '').length;
  if (!length) return '0';
  if (length <= 20) return '1-20';
  if (length <= 80) return '21-80';
  if (length <= 240) return '81-240';
  return '241+';
}

export function countBucket(value) {
  const count = Number(value) || 0;
  if (!count) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 10) return '4-10';
  return '11+';
}

export function track(event, properties = {}) {
  if (!analyticsEnabled()) return;
  // Do not queue raw interactions locally. A failed event simply disappears.
  fetch('/api/analytics/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ event, distinctId: distinctId(), properties }),
  }).catch(() => {});
}
