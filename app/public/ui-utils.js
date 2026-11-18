export function parseMarketInput(input) {
  const value = String(input || '').trim();
  if (!/^https?:\/\//i.test(value)) return { name: value };
  try {
    const url = new URL(value);
    if (url.hostname !== 'steamcommunity.com' || !['https:', 'http:'].includes(url.protocol)) return { name: value };
    const match = /^\/market\/listings\/(\d+)\/(.+?)\/?$/.exec(url.pathname);
    if (!match) return { name: value };
    const appId = Number(match[1]);
    if (!Number.isSafeInteger(appId) || appId < 1 || appId > 1000000) return { name: value };
    return { appId, name: decodeURIComponent(match[2]) };
  } catch {
    return { name: value };
  }
}

export function decimalPlaces(currency) {
  return [8, 10, 15, 16, 25, 27].includes(Number(currency)) ? 0 : Number(currency) === 38 ? 3 : 2;
}

export function priceNumber(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0) return '';
  return (minor / 10 ** decimalPlaces(currency)).toFixed(decimalPlaces(currency));
}

export function cleanEntries(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === 'object' &&
    typeof entry.hashName === 'string' && entry.hashName.trim() && entry.hashName.length <= 200 &&
    Number.isSafeInteger(Number(entry.appId)) && Number(entry.appId) > 0 &&
    Number(entry.appId) <= 1000000).slice(0, limit);
}

export function nearestPoint(points, target) {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(points[lo - 1].time - target) <= Math.abs(points[lo].time - target) ? lo - 1 : lo;
}

export async function fetchJson(url, { signal, timeoutMs = 45000, ...options } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok && !data?.error) throw new Error(`HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function queryParams(settings, name) {
  return new URLSearchParams({
    name, app: String(settings.appId), currency: String(settings.currency),
    strategy: settings.strategy, undercut: String(settings.undercut),
    steamFee: String(settings.steamFee), publisherFee: String(settings.publisherFee),
    days: String(settings.historyDays || 180), quantity: String(settings.quantity || 1),
  });
}
