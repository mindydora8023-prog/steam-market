import { CURRENCIES, currencyCode, currencyInfo, formatMinor } from '../lib/currency.js';
import { marketMinimumFor, normalizeWallet } from '../lib/fees.js';
import { buildQuote, QUOTE_STRATEGIES } from '../lib/quote.js';
import { findExactSearchResult, MarketError } from './steam.mjs';

const STRATEGIES = new Set(['smart', 'undercut', 'match', 'median']);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function badRequest(message) {
  return new MarketError('bad-request', message, { status: 400 });
}

function intParam(url, key, { min, max, fallback }) {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw badRequest(`Invalid "${key}".`);
  }
  return n;
}

function numberParam(url, key, { min, max, fallback }) {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`Invalid "${key}".`);
  }
  return n;
}

function stringParam(url, key, { min = 1, max = 200, fallback = '' } = {}) {
  const raw = url.searchParams.get(key);
  const text = raw === null ? fallback : raw.trim();
  if (text.length < min || text.length > max) {
    throw badRequest(`Invalid "${key}".`);
  }
  return text;
}

function boolParam(url, key) {
  const raw = url.searchParams.get(key);
  return raw === '1' || raw === 'true';
}

function marketUrl(appId, hashName) {
  return `https://steamcommunity.com/market/listings/${appId}/${encodeURIComponent(hashName)}`;
}

function makeItem({ appId, hashName, result }) {
  return {
    appId,
    hashName,
    name: result ? result.name : hashName,
    type: result ? result.type : '',
    iconUrl: result ? result.iconUrl : '',
    appName: result ? result.appName : '',
    marketUrl: marketUrl(appId, hashName),
  };
}

function text(value, currency) {
  return value === null || value === undefined ? '' : formatMinor(value, currency);
}

function enrichQuote(quote, { item, currency, price, resolvedFromSearch }) {
  const out = {
    ...quote,
    item,
    currency,
    currencyCode: currencyCode(currency),
    fetchedAt: price.fetchedAt,
    cached: Boolean(price.cached),
    resolvedFromSearch: Boolean(resolvedFromSearch),
  };

  out.market.lowestText = text(out.market.lowest, currency);
  out.market.medianText = text(out.market.median, currency);
  out.market.volumeText = Number(out.market.volume || 0).toLocaleString('en-US');

  const rec = out.recommendation;
  rec.buyerPaysText = text(rec.buyerPays, currency);
  rec.receiveText = text(rec.receive, currency);
  rec.feesText = text(rec.fees, currency);
  rec.steamFeeText = text(rec.steamFee, currency);
  rec.publisherFeeText = text(rec.publisherFee, currency);
  rec.targetText = text(rec.target, currency);
  rec.deltaText =
    rec.deltaVsLowest === null || rec.deltaVsLowest === undefined
      ? ''
      : text(Math.abs(rec.deltaVsLowest), currency);
  rec.deltaVsMedian =
    out.market.median === null || out.market.median === undefined
      ? null
      : rec.buyerPays - out.market.median;
  rec.deltaVsMedianText =
    rec.deltaVsMedian === null ? '' : text(Math.abs(rec.deltaVsMedian), currency);

  for (const value of Object.values(out.alternatives || {})) {
    if (value && Number.isInteger(value.buyerPays)) {
      value.buyerPaysText = text(value.buyerPays, currency);
    }
  }

  return out;
}

function errorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra };
}

function aggregateDaily(points) {
  const byDay = new Map();
  for (const point of points) {
    const day = Math.floor(point.time / 86400);
    const entry = byDay.get(day);
    if (!entry) {
      byDay.set(day, {
        time: point.time,
        sum: point.value,
        weightedSum: point.value * (point.volume || 0),
        count: 1,
        volume: Number.isFinite(point.volume) && point.volume > 0 ? point.volume : 0,
      });
    } else {
      entry.time = point.time;
      entry.sum += point.value;
      entry.weightedSum += point.value * (point.volume || 0);
      entry.count += 1;
      entry.volume += point.volume || 0;
    }
  }
  return [...byDay.values()]
    .sort((a, b) => a.time - b.time)
    .map((entry) => ({
      time: entry.time,
      value: Math.round(entry.volume > 0 ? entry.weightedSum / entry.volume : entry.sum / entry.count),
      volume: entry.volume,
      sampleCount: entry.count,
    }));
}

function rangeStats(points, current, days, now) {
  const cutoff = now - days * 86400;
  const subset = points.filter((point) => point.time >= cutoff && point.time <= now);
  if (subset.length === 0) return null;
  const values = subset.map((point) => point.value);
  const sum = values.reduce((total, value) => total + value, 0);
  const avg = Math.round(sum / values.length);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const below = values.filter((value) => value <= current).length;
  const percentile = Math.round((below / values.length) * 100);
  // A period change needs a sample at the period boundary, not just the
  // first available observation from an arbitrarily short recent series.
  const baseline = points.find((point) => Math.abs(point.time - cutoff) <= 86400);
  const changePct = baseline && baseline.value > 0
    ? Number((((current - baseline.value) / baseline.value) * 100).toFixed(1))
    : null;
  return {
    days,
    count: values.length,
    sampleCount: subset.reduce((total, point) => total + point.sampleCount, 0),
    volume: subset.reduce((total, point) => total + point.volume, 0),
    firstTime: subset[0].time,
    lastTime: subset[subset.length - 1].time,
    coveredDays: Number(((subset[subset.length - 1].time - subset[0].time) / 86400).toFixed(2)),
    complete: Boolean(baseline) && now - subset[subset.length - 1].time <= 86400,
    avg,
    min,
    max,
    percentile,
    changePct,
    verdict: percentile >= 75 ? 'high' : percentile <= 25 ? 'low' : 'mid',
  };
}

export function createApi({ steam, version }) {
  async function quoteHandler(url, res) {
    const appId = intParam(url, 'appid', { min: 1, max: 1000000, fallback: 730 });
    const name = stringParam(url, 'name', { min: 1, max: 200 });
    const currency = intParam(url, 'currency', { min: 1, max: 100, fallback: 23 });
    if (!CURRENCIES[currency]) throw badRequest('Unsupported "currency".');
    const strategy = stringParam(url, 'strategy', { min: 1, max: 20, fallback: 'smart' });
    if (!STRATEGIES.has(strategy)) throw badRequest('Invalid "strategy".');
    const undercut = intParam(url, 'undercut', { min: 0, max: 1000, fallback: 1 });
    const steamFee = numberParam(url, 'steamFee', { min: 0, max: 30, fallback: 5 });
    const publisherFee = numberParam(url, 'publisherFee', { min: 0, max: 30, fallback: 10 });
    const refresh = boolParam(url, 'refresh');

    const wallet = normalizeWallet({
      wallet_currency: currency,
      wallet_market_minimum: marketMinimumFor(currency),
      wallet_currency_increment: 1,
      wallet_fee_percent: steamFee / 100,
      wallet_publisher_fee_percent_default: publisherFee / 100,
    });

    // Start independent lookups together; optional metadata failures do not hide a valid quote.
    const searchPromise = steam.search(appId, name, { limit: 8, refresh })
      .then((value) => ({ value }), (error) => ({ error }));
    let price = await steam.price(appId, name, currency, { refresh });
    let searchResults = [];
    let exact = null;

    if (!price.ok) {
      const outcome = await searchPromise;
      if (outcome.error) throw outcome.error;
      searchResults = outcome.value.results;
      exact = findExactSearchResult(searchResults, name);
      if (exact && exact.hashName.toLowerCase() !== name.toLowerCase()) {
        price = await steam.price(appId, exact.hashName, currency, { refresh });
      }
      if (!price.ok) {
        if (exact) {
          return sendJson(
            res,
            200,
            errorBody('not-found', 'Steam has no price data for this exact item.', {
              suggestions: searchResults,
              item: makeItem({ appId, hashName: exact.hashName, result: exact }),
            }),
          );
        }
        const code = searchResults.length > 0 ? 'needs-selection' : 'not-found';
        return sendJson(
          res,
          200,
          errorBody(
            code,
            code === 'needs-selection'
              ? 'Multiple market items match this name; choose one suggestion.'
              : 'No Steam market data was found for this item.',
            { suggestions: searchResults },
          ),
        );
      }
    } else {
      try {
        const outcome = await searchPromise;
        if (outcome.error) throw outcome.error;
        searchResults = outcome.value.results;
        exact = findExactSearchResult(searchResults, name);
      } catch {
        searchResults = [];
      }
    }

    const canonical = exact ? exact.hashName : name;
    const item = makeItem({ appId, hashName: canonical, result: exact });
    const quote = buildQuote({
      lowest: price.lowest,
      median: price.median,
      volume: price.volume,
      wallet,
      strategy,
      undercut,
      currency,
    });

    const context = {
      item, currency, price,
      resolvedFromSearch: Boolean(exact && exact.hashName.toLowerCase() !== name.toLowerCase()),
    };
    const compareStrategies = QUOTE_STRATEGIES.map((candidate) => {
      const result = candidate === strategy ? quote : buildQuote({
        lowest: price.lowest, median: price.median, volume: price.volume,
        wallet, strategy: candidate, undercut, currency,
      });
      return {
        strategy: candidate,
        ok: result.ok,
        recommendation: result.ok ? enrichQuote(result, context).recommendation : null,
        code: result.ok ? null : result.code,
      };
    });

    if (!quote.ok) {
      const messages = {
        'no-price-data': 'Steam has no usable price for this item.',
        'below-fee-floor': 'The item is too cheap for the current fee model.',
        'no-valid-price': 'No valid listing price can be derived for this item.',
      };
      return sendJson(
        res,
        200,
        errorBody(quote.code, messages[quote.code] || 'No quote is available.', {
          item,
          compareStrategies,
          market: {
            lowest: quote.lowest,
            median: quote.median,
            volume: quote.volume,
            lowestText: text(quote.lowest, currency),
            medianText: text(quote.median, currency),
            volumeText: Number(quote.volume || 0).toLocaleString('en-US'),
          },
        }),
      );
    }

    const enriched = enrichQuote(quote, {
      item,
      currency,
      price,
      resolvedFromSearch: Boolean(exact && exact.hashName.toLowerCase() !== name.toLowerCase()),
    });
    return sendJson(res, 200, { ok: true, ...enriched, compareStrategies });
  }

  async function historyHandler(url, res) {
    const appId = intParam(url, 'appid', { min: 1, max: 1000000, fallback: 730 });
    const name = stringParam(url, 'name', { min: 1, max: 200 });
    const currency = intParam(url, 'currency', { min: 1, max: 100, fallback: 23 });
    if (!CURRENCIES[currency]) throw badRequest('Unsupported "currency".');
    const refresh = boolParam(url, 'refresh');
    let current = intParam(url, 'current', { min: 0, max: 1000000000, fallback: 0 });

    const raw = await steam.history(appId, name, { refresh });
    if (!raw.points || raw.points.length < 2) {
      return sendJson(
        res,
        200,
        errorBody('history-unavailable', 'Not enough price history for this item.'),
      );
    }
    const historyCurrency = Number(raw.currency) || 0;
    if (!historyCurrency) {
      return sendJson(
        res,
        200,
        errorBody('history-currency-unknown', 'Steam did not report the history currency.'),
      );
    }

    if (!current) {
      const price = await steam.price(appId, name, currency, { refresh });
      current = price.ok ? price.median || price.lowest || 0 : 0;
    }
    if (!current) {
      return sendJson(res, 200, errorBody('no-current-price', 'No current price for this item.'));
    }

    const selectedDecimals = currencyInfo(currency).decimals;
    const selectedScale = 10 ** selectedDecimals;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 400 * 86400;
    const samples = [...new Map(raw.points
      .filter((point) => Number.isFinite(point.time) && point.time >= cutoff && point.time <= now &&
        Number.isFinite(point.price) && point.price > 0)
      .map((point) => [point.time, point])).values()].sort((a, b) => a.time - b.time);
    const last = samples[samples.length - 1]?.price;
    if (!(last > 0)) {
      return sendJson(res, 200, errorBody('history-unavailable', 'Invalid price history.'));
    }

    const estimated = historyCurrency !== currency;
    const scale = estimated ? current / selectedScale / last : 1;
    const converted = samples
      .map((point) => ({
        time: point.time,
        value: Math.max(1, Math.round(point.price * scale * selectedScale)),
        volume: Number.isFinite(point.volume) && point.volume > 0 ? point.volume : 0,
      }));

    if (converted.length < 2) {
      return sendJson(
        res,
        200,
        errorBody('history-unavailable', 'Not enough recent price history for this item.'),
      );
    }

    const daily = aggregateDaily(converted);
    const points = daily;

    const ranges = {};
    for (const days of [30, 90, 180, 365]) {
      ranges[days] = rangeStats(points, current, days, now);
    }

    return sendJson(res, 200, {
      ok: true,
      currency,
      currencyCode: currencyCode(currency),
      decimals: selectedDecimals,
      historyCurrency,
      historyCurrencyCode: currencyCode(historyCurrency),
      converted: estimated,
      conversion: {
        method: estimated ? 'current-price-anchor' : 'native',
        estimated,
        rate: scale,
        anchorTime: estimated ? samples[samples.length - 1].time : null,
      },
      warnings: estimated ? ['estimated-conversion-not-fx'] : [],
      aggregation: 'utc-day-volume-weighted-mean-of-medians',
      statisticsBasis: 'daily-observations',
      sampleCount: converted.length,
      current,
      points,
      ranges,
      fetchedAt: raw.fetchedAt,
      cached: Boolean(raw.cached),
    });
  }

  return async function api(req, res, url) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, errorBody('method-not-allowed', 'Use GET.'));
      }

      if (url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          version,
          proxy: steam.proxyLabel,
          time: new Date().toISOString(),
        });
      }

      if (url.pathname === '/api/search') {
        const appId = intParam(url, 'appid', { min: 1, max: 1000000, fallback: 730 });
        const query = stringParam(url, 'q', { min: 1, max: 80 });
        const limit = intParam(url, 'limit', { min: 1, max: 10, fallback: 8 });
        const refresh = boolParam(url, 'refresh');
        const result = await steam.search(appId, query, { limit, refresh });
        return sendJson(res, 200, {
          ok: true,
          results: result.results,
          fetchedAt: result.fetchedAt,
          cached: Boolean(result.cached),
        });
      }

      if (url.pathname === '/api/quote') {
        return await quoteHandler(url, res);
      }

      if (url.pathname === '/api/history') {
        return await historyHandler(url, res);
      }

      return sendJson(res, 404, errorBody('not-found', 'Unknown API route.'));
    } catch (err) {
      const status = err instanceof MarketError ? err.status || 502 : 500;
      const code = err && err.code ? err.code : 'internal';
      const message = err && err.message ? err.message : 'Internal server error.';
      return sendJson(res, status, {
        ok: false,
        error: {
          code,
          message,
          retryAfterMs: err && err.retryAfterMs ? err.retryAfterMs : 0,
        },
      });
    }
  };
}