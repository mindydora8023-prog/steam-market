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

const MARKET_MINIMUM_MINOR = {
  8: 2,
  23: 7,
};

export function marketMinimumFor(currency) {
  return MARKET_MINIMUM_MINOR[Number(currency)] || 1;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function makeWallet({ currency = 23, steamFee = 5, publisherFee = 10 } = {}) {
  const sf = Number(steamFee);
  const pf = Number(publisherFee);
  return {
    currency: Number(currency) || 23,
    marketMinimum: marketMinimumFor(currency),
    currencyIncrement: 1,
    steamFeePercent: Number.isFinite(sf) && sf >= 0 ? sf / 100 : 0.05,
    publisherFeePercent: Number.isFinite(pf) && pf >= 0 ? pf / 100 : 0.1,
  };
}

export function toValidMarketPrice(price, wallet) {
  const floor = Math.max(1, toInt(wallet && wallet.marketMinimum, 1));
  const increment = Math.max(1, toInt(wallet && wallet.currencyIncrement, 1));
  const n = Math.trunc(Number(price) || 0);
  if (n <= floor) return floor;
  if (n <= increment) return increment;
  if (increment > 1) return Math.round(n / increment) * increment;
  return n;
}

export function feeAmount(baseAmount, percent, wallet) {
  if (!(percent > 0)) return 0;
  const [mantissa, exponent = '0'] = String(percent).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const power = Number(exponent) - fraction.length;
  const base = BigInt(Math.max(0, Math.trunc(Number(baseAmount) || 0)));
  const fee = Number(power >= 0
    ? base * digits * (10n ** BigInt(power))
    : base * digits / (10n ** BigInt(-power)));
  return toValidMarketPrice(fee, wallet);
}

export function buyerPaysWithFees(receiveAmount, wallet) {
  const base = toValidMarketPrice(receiveAmount, wallet);
  return base + feeAmount(base, wallet.publisherFeePercent, wallet) + feeAmount(base, wallet.steamFeePercent, wallet);
}

export function receiveForBuyerPays(targetBuyerPays, wallet) {
  const target = Math.trunc(Number(targetBuyerPays) || 0);
  const floor = Math.max(1, toInt(wallet.marketMinimum, 1));
  const increment = Math.max(1, toInt(wallet.currencyIncrement, 1));
  if (target < floor) return null;
  if (buyerPaysWithFees(floor, wallet) > target) return null;

  let lo = floor;
  let hi = target;
  let best = null;
  let guard = 0;

  while (lo <= hi && guard++ < 64) {
    const mid = Math.floor((lo + hi) / 2);
    const base = toValidMarketPrice(mid, wallet);
    if (buyerPaysWithFees(base, wallet) <= target) {
      best = base;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === null) best = toValidMarketPrice(floor, wallet);

  guard = 0;
  while (guard++ < 10000) {
    const next = toValidMarketPrice(best + increment, wallet);
    if (next <= best) break;
    if (buyerPaysWithFees(next, wallet) > target) break;
    best = next;
  }

  guard = 0;
  while (buyerPaysWithFees(best, wallet) > target && guard++ < 10000) {
    if (best <= floor) return null;
    const previous = best - increment;
    best = previous < floor ? floor : toValidMarketPrice(previous, wallet);
    if (best === floor && buyerPaysWithFees(best, wallet) > target) return null;
  }

  return buyerPaysWithFees(best, wallet) > target ? null : best;
}

export function feeBreakdown(receiveAmount, wallet) {
  const base = toValidMarketPrice(receiveAmount, wallet);
  const publisherFee = feeAmount(base, wallet.publisherFeePercent, wallet);
  const steamFee = feeAmount(base, wallet.steamFeePercent, wallet);
  return {
    receive: base,
    publisherFee,
    steamFee,
    totalFees: publisherFee + steamFee,
    buyerPays: base + publisherFee + steamFee,
  };
}

export function quoteByBuyerPays(targetBuyerMinor, opts = {}) {
  const wallet = makeWallet(opts);
  const target = Math.trunc(Number(targetBuyerMinor) || 0);
  const minBuyerPays = buyerPaysWithFees(wallet.marketMinimum, wallet);
  if (target < minBuyerPays) {
    return { ok: false, minBuyerPays, minReceive: wallet.marketMinimum };
  }
  const receive = receiveForBuyerPays(target, wallet);
  if (receive === null) {
    return { ok: false, minBuyerPays, minReceive: wallet.marketMinimum };
  }
  const bd = feeBreakdown(receive, wallet);
  return {
    ok: true,
    targetBuyerPays: target,
    exact: bd.buyerPays === target,
    ...bd,
  };
}

export function quoteByReceive(targetReceiveMinor, opts = {}) {
  const wallet = makeWallet(opts);
  const target = Math.trunc(Number(targetReceiveMinor) || 0);
  const floor = wallet.marketMinimum;
  if (target < floor) {
    return { ok: false, minReceive: floor, minBuyerPays: buyerPaysWithFees(floor, wallet) };
  }
  const bd = feeBreakdown(target, wallet);
  return {
    ok: true,
    targetReceive: target,
    exact: bd.receive === target,
    ...bd,
  };
}

export function parseMajorToMinor(text, currency) {
  const cleaned = String(text ?? '').trim().replace(/,/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const decimals = decimalPlaces(currency);
  const [whole, frac = ''] = cleaned.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const minor = Number(whole) * (10 ** decimals) + (decimals > 0 ? Number(padded) : 0);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return minor;
}

export function movingAverage(points, windowSize = 7) {
  if (!Array.isArray(points) || points.length === 0 || windowSize < 2) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += Number(points[i].value) || 0;
    if (i >= windowSize) sum -= Number(points[i - windowSize].value) || 0;
    if (i >= windowSize - 1) {
      out.push({ time: points[i].time, value: sum / windowSize });
    }
  }
  return out;
}
