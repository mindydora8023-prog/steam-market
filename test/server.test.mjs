import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app/app.mjs';
import { MarketError } from '../app/steam.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'public');

const SEARCH_RESULT = {
  name: 'Clutch Case',
  hashName: 'Clutch Case',
  type: 'Base Grade Container',
  iconUrl: 'https://community.cloudflare.steamstatic.com/economy/image/abc/64fx64f',
  appId: 730,
  appName: 'Counter-Strike 2',
  sellListings: 59352,
};

function historyPoints() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { time: now - 200 * 86400, price: 100, volume: 10 },
    { time: now - 120 * 86400, price: 95, volume: 10 },
    { time: now - 60 * 86400, price: 88, volume: 10 },
    { time: now - 30 * 86400, price: 85, volume: 10 },
    { time: now, price: 86.67, volume: 10 },
  ];
}

function fakeSteam(overrides = {}) {
  return {
    proxyLabel: 'http://127.0.0.1:7890',
    async search() {
      return { results: [SEARCH_RESULT], fetchedAt: new Date().toISOString(), cached: false };
    },
    async price() {
      return {
        ok: true,
        lowest: 361,
        median: 356,
        volume: 6159,
        fetchedAt: new Date().toISOString(),
        cached: false,
      };
    },
    async history() {
      return {
        points: historyPoints(),
        currency: 8,
        fetchedAt: new Date().toISOString(),
        cached: false,
      };
    },
    ...overrides,
  };
}

async function start(steam) {
  const app = createApp({ steam, version: '0.2.0', publicDir: PUBLIC_DIR });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function json(url, options) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  return { res, body: await res.json() };
}

test('serves health, static assets, and the locale file', async () => {
  const app = await start(fakeSteam());
  try {
    const health = await json(`${app.base}/api/health`);
    assert.equal(health.res.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.version, '0.2.0');
    assert.equal(health.body.proxy, 'http://127.0.0.1:7890');

    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Steam \u5E02\u573A\u4EF7\u683C\u52A9\u624B/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

    const locale = await json(`${app.base}/locale/zh.json`);
    assert.equal(locale.res.status, 200);
    assert.equal(locale.body.appTitle, 'Steam \u5E02\u573A\u4EF7\u683C\u52A9\u624B');
  } finally {
    await app.close();
  }
});

test('searches and quotes an item', async () => {
  const app = await start(fakeSteam());
  try {
    const search = await json(`${app.base}/api/search?appid=730&q=Clutch`);
    assert.equal(search.res.status, 200);
    assert.equal(search.body.ok, true);
    assert.equal(search.body.results[0].hashName, 'Clutch Case');

    const quote = await json(
      `${app.base}/api/quote?appid=730&name=${encodeURIComponent('Clutch Case')}&currency=23`,
    );
    assert.equal(quote.res.status, 200);
    assert.equal(quote.body.ok, true);
    assert.equal(quote.body.item.hashName, 'Clutch Case');
    assert.equal(quote.body.market.lowest, 361);
    assert.equal(quote.body.market.lowestText, '\u00a53.61');
    assert.equal(quote.body.recommendation.buyerPays, 360);
    assert.equal(quote.body.recommendation.buyerPaysText, '\u00a53.60');
    assert.equal(quote.body.recommendation.receive, 314);
    assert.equal(quote.body.recommendation.deltaVsLowest, -1);
    assert.equal(quote.body.currencyCode, 'CNY');
    assert.match(quote.body.item.marketUrl, /market\/listings\/730\/Clutch%20Case/);
  } finally {
    await app.close();
  }
});

test('quotes a cheap card with the CNY minimum fee', async () => {
  const app = await start(
    fakeSteam({
      async price() {
        return {
          ok: true,
          lowest: 30,
          median: 21,
          volume: 10,
          fetchedAt: new Date().toISOString(),
          cached: false,
        };
      },
    }),
  );
  try {
    const result = await json(
      `${app.base}/api/quote?appid=753&name=${encodeURIComponent('Gronald The Clown')}&currency=23`,
    );
    assert.equal(result.body.ok, true);
    assert.equal(result.body.recommendation.strategyUsed, 'undercut');
    assert.equal(result.body.recommendation.buyerPays, 29);
    assert.equal(result.body.recommendation.receive, 15);
    assert.equal(result.body.recommendation.deltaVsLowest, -1);
    assert.equal(result.body.recommendation.deltaVsMedian, 8);
    assert.equal(result.body.recommendation.deltaVsMedianText, '\u00a50.08');
    assert.equal(result.body.alternatives.minFeasible.buyerPays, 21);
    assert.ok(result.body.recommendation.warnings.includes('lowest-above-median'));
    assert.ok(result.body.recommendation.warnings.includes('high-fee-share'));
  } finally {
    await app.close();
  }
});

test('returns a converted history series and range stats', async () => {
  const app = await start(fakeSteam());
  try {
    const result = await json(
      `${app.base}/api/history?appid=730&name=${encodeURIComponent('Clutch Case')}&currency=23&current=356`,
    );
    assert.equal(result.res.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.currencyCode, 'CNY');
    assert.equal(result.body.historyCurrency, 8);
    assert.equal(result.body.historyCurrencyCode, 'JPY');
    assert.equal(result.body.converted, true);
    assert.equal(result.body.conversion.method, 'current-price-anchor');
    assert.equal(result.body.conversion.estimated, true);
    assert.deepEqual(result.body.warnings, ['estimated-conversion-not-fx']);
    assert.equal(result.body.decimals, 2);
    assert.equal(result.body.points.length, 5);
    assert.equal(result.body.points[result.body.points.length - 1].value, 356);
    assert.equal(result.body.ranges[90].count, 3);
    assert.equal(result.body.ranges[90].min, 349);
    assert.equal(result.body.ranges[90].max, 361);
    assert.equal(result.body.ranges[90].percentile, 67);
    assert.equal(result.body.ranges[30].verdict, 'high');
  } finally {
    await app.close();
  }
});

test('returns a history-unavailable error when Steam has no series', async () => {
  const app = await start(
    fakeSteam({
      async history() {
        return { points: [], currency: 8, fetchedAt: new Date().toISOString(), cached: false };
      },
    }),
  );
  try {
    const result = await json(
      `${app.base}/api/history?appid=730&name=${encodeURIComponent('Clutch Case')}&currency=23&current=356`,
    );
    assert.equal(result.res.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'history-unavailable');
  } finally {
    await app.close();
  }
});

test('returns suggestions when a name is not exact', async () => {  const app = await start(
    fakeSteam({
      async price() {
        return { ok: false, code: 'no-market-data', fetchedAt: new Date().toISOString() };
      },
    }),
  );
  try {
    const result = await json(`${app.base}/api/quote?appid=730&name=Clutch&currency=23`);
    assert.equal(result.res.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'needs-selection');
    assert.equal(result.body.suggestions.length, 1);
  } finally {
    await app.close();
  }
});

test('returns not-found when nothing matches', async () => {
  const app = await start(
    fakeSteam({
      async price() {
        return { ok: false, code: 'no-market-data', fetchedAt: new Date().toISOString() };
      },
      async search() {
        return { results: [], fetchedAt: new Date().toISOString(), cached: false };
      },
    }),
  );
  try {
    const result = await json(`${app.base}/api/quote?appid=730&name=Nothing&currency=23`);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'not-found');
  } finally {
    await app.close();
  }
});

test('maps rate limits to HTTP 429', async () => {
  const app = await start(
    fakeSteam({
      async price() {
        throw new MarketError('rate-limited', 'slow down', { status: 429, retryAfterMs: 60000 });
      },
    }),
  );
  try {
    const result = await json(`${app.base}/api/quote?appid=730&name=Clutch%20Case&currency=23`);
    assert.equal(result.res.status, 429);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'rate-limited');
    assert.equal(result.body.error.retryAfterMs, 60000);
  } finally {
    await app.close();
  }
});

test('rejects fractional identifiers and currencies without a known format', async () => {
  const app = await start(fakeSteam());
  try {
    for (const query of ['appid=730.5&name=x', 'name=x&currency=99', 'name=x&currency=23.1', 'name=x&undercut=0.5']) {
      const result = await json(`${app.base}/api/quote?${query}`);
      assert.equal(result.res.status, 400, query);
      assert.equal(result.body.error.code, 'bad-request');
    }
  } finally { await app.close(); }
});

test('starts metadata and price lookups concurrently', { timeout: 2000 }, async () => {
  let searchStarted = false;
  let priceStarted = false;
  const app = await start(fakeSteam({
    async search() {
      searchStarted = true;
      await Promise.resolve();
      assert.equal(priceStarted, true);
      return { results: [SEARCH_RESULT] };
    },
    async price() {
      priceStarted = true;
      assert.equal(searchStarted, true);
      return { ok: true, lowest: 361, median: 356, volume: 100, fetchedAt: new Date().toISOString() };
    },
  }));
  try {
    const result = await json(`${app.base}/api/quote?appid=730&name=Clutch%20Case`);
    assert.equal(result.body.ok, true);
  } finally { await app.close(); }
});

test('rejects invalid query parameters', async () => {
  const app = await start(fakeSteam());
  try {
    const result = await json(`${app.base}/api/quote?appid=0&name=x`);
    assert.equal(result.res.status, 400);
    assert.equal(result.body.error.code, 'bad-request');

    const search = await json(`${app.base}/api/search?appid=730&q=`);
    assert.equal(search.res.status, 400);
  } finally {
    await app.close();
  }
});

test('rejects unsupported methods and unknown API routes', async () => {
  const app = await start(fakeSteam());
  try {
    const post = await json(`${app.base}/api/quote`, { method: 'POST' });
    assert.equal(post.res.status, 405);
    assert.equal(post.res.headers.get('allow'), 'GET');
    assert.equal(post.body.error.code, 'method-not-allowed');

    const missing = await json(`${app.base}/api/nope`);
    assert.equal(missing.res.status, 404);
    assert.equal(missing.body.error.code, 'not-found');
  } finally {
    await app.close();
  }
});

test('blocks path traversal', async () => {
  const app = await start(fakeSteam());
  try {
    const res = await fetch(`${app.base}/..%2Fpackage.json`);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /steam-market-price/);
  } finally {
    await app.close();
  }
});

test('supports HEAD requests for static files', async () => {
  const app = await start(fakeSteam());
  try {
    const res = await fetch(`${app.base}/styles.css`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
    assert.match(res.headers.get('content-type'), /text\/css/);
  } finally {
    await app.close();
  }
});

test('strategy comparisons reuse one price snapshot and format every recommendation', async () => {
  let calls = 0;
  const original = fakeSteam();
  const app = await start(fakeSteam({ async price(...args) { calls++; return original.price(...args); } }));
  try {
    const { body } = await json(app.base + '/api/quote?name=Clutch%20Case&currency=23&steamFee=1&publisherFee=0');
    assert.equal(calls, 1);
    assert.deepEqual(body.compareStrategies.map((entry) => entry.strategy), ['smart', 'undercut', 'match', 'median']);
    for (const entry of body.compareStrategies) {
      assert.equal(entry.ok, true);
      assert.equal(entry.code, null);
      assert.equal(typeof entry.recommendation.buyerPaysText, 'string');
      assert.equal(typeof entry.recommendation.receiveText, 'string');
      assert.equal(typeof entry.recommendation.feesText, 'string');
      assert.equal(entry.recommendation.publisherFee, 0);
      assert.equal(entry.recommendation.steamFee, 7);
    }
    assert.deepEqual(body.recommendation, body.compareStrategies[0].recommendation);
  } finally { await app.close(); }
});

test('comparisons include successful alternatives when the requested strategy fails', async () => {
  const app = await start(fakeSteam({ async price() {
    return { ok: true, lowest: 2, median: 100, volume: 10 };
  } }));
  try {
    const { body } = await json(app.base + '/api/quote?name=x&currency=23&strategy=match');
    assert.equal(body.ok, false);
    const match = body.compareStrategies.find((entry) => entry.strategy === 'match');
    assert.deepEqual(match, { strategy: 'match', ok: false, recommendation: null, code: 'below-fee-floor' });
    assert.equal(body.compareStrategies.find((entry) => entry.strategy === 'median').ok, true);
  } finally { await app.close(); }
});

test('native history preserves historical prices regardless of current price', async () => {
  const now = Math.floor(Date.now() / 1000);
  const app = await start(fakeSteam({ async history() {
    return { currency: 23, points: [
      { time: now - 2 * 86400, price: 2, volume: 1 },
      { time: now - 86400, price: 3, volume: 2 },
    ] };
  } }));
  try {
    const { body } = await json(app.base + '/api/history?name=x&currency=23&current=999');
    assert.equal(body.ok, true);
    assert.equal(body.converted, false);
    assert.deepEqual(body.points.map((point) => point.value), [200, 300]);
    assert.equal(body.conversion.method, 'native');
    assert.equal(body.conversion.rate, 1);
    assert.deepEqual(body.warnings, []);
    assert.equal(body.ranges[30].changePct, null);
    assert.equal(body.ranges[30].complete, false);
    assert.equal(body.ranges[30].coveredDays, 1);
    assert.equal(body.ranges[30].sampleCount, 2);
  } finally { await app.close(); }
});

test('history daily aggregation is volume weighted, bounded by observed samples', async () => {
  const day = Math.floor(Date.now() / 86400000) * 86400 - 86400;
  const app = await start(fakeSteam({ async history() {
    return { currency: 23, points: [
      { time: day + 200, price: 3, volume: 3 },
      { time: day + 100, price: 1, volume: 1 },
      { time: day + 300, price: 99, volume: 0 },
      { time: day + 999999, price: 100, volume: 2 },
    ] };
  } }));
  try {
    const { body } = await json(app.base + '/api/history?name=x&currency=23&current=1000');
    assert.equal(body.points.length, 1);
    assert.equal(body.points[0].value, 250);
    assert.equal(body.points[0].volume, 4);
    assert.equal(body.points[0].sampleCount, 3);
    assert.equal(body.sampleCount, 3);
    assert.equal(body.ranges[30].count, 1);
    assert.equal(body.ranges[30].sampleCount, 3);
    assert.equal(body.ranges[30].changePct, null);
    assert.equal(body.aggregation, 'utc-day-volume-weighted-mean-of-medians');
  } finally { await app.close(); }
});
