import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/http.js';
import {
  findExactSearchResult,
  MarketError,
  SteamMarket,
} from '../app/steam.mjs';

test('coalesces concurrent search, price and history requests and clears failures', async () => {
  let calls = 0;
  const market = new SteamMarket({
    searchIntervalMs: 0, priceIntervalMs: 0, historyIntervalMs: 0,
    http: {
      async getJson(url) {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 200, json: url.includes('search') ? searchPayload() : pricePayload() };
      },
      async request() {
        calls++;
        throw new MarketError('history-unavailable', 'missing');
      },
    },
  });
  await Promise.all(Array.from({ length: 10 }, () => market.search(730, 'case')));
  await Promise.all(Array.from({ length: 10 }, () => market.price(730, 'case', 23)));
  const history = await Promise.allSettled(Array.from({ length: 10 }, () => market.history(730, 'case')));
  assert.equal(calls, 3);
  assert.ok(history.every((result) => result.status === 'rejected'));
  assert.equal(market.inflight.size, 0);
  await assert.rejects(market.history(730, 'case'));
  assert.equal(calls, 4);
});

test('history refresh bypasses a same-turn cached read', async () => {
  let calls = 0;
  const market = new SteamMarket({ historyIntervalMs: 0, http: {
    async request() {
      calls++;
      return { status: 200, text: '...\\"ecurrency\\":23,\\"prices\\":[{\\"time\\":100,\\"price_median\\":1,\\"purchases\\":1}]...' };
    },
  } });
  await market.history(730, 'case');
  const [cached, fresh] = await Promise.all([market.history(730, 'case'), market.history(730, 'case', { refresh: true })]);
  assert.equal(cached.cached, true);
  assert.equal(fresh.cached, false);
  assert.equal(calls, 2);
});

test('search cache separates normalized limits', async () => {
  const counts = [];
  const market = new SteamMarket({ searchIntervalMs: 0, http: {
    async getJson(url) {
      counts.push(new URL(url).searchParams.get('count'));
      return { status: 200, json: searchPayload() };
    },
  } });
  assert.equal((await market.search(730, 'case', { limit: 1 })).results.length, 1);
  assert.equal((await market.search(730, 'case', { limit: 2 })).results.length, 2);
  assert.equal((await market.search(730, 'case', { limit: 2 })).cached, true);
  await market.search(730, 'other', { limit: NaN });
  assert.deepEqual(counts, ['1', '2', '8']);
});

test('refresh of a full cache preserves other keys', async () => {
  const market = new SteamMarket({ priceIntervalMs: 0, http: {
    async getJson() { return { status: 200, json: pricePayload() }; },
  } });
  market.priceCache.max = 2;
  await market.price(730, 'first', 23);
  await market.price(730, 'second', 23);
  await market.price(730, 'second', 23, { refresh: true });
  assert.equal((await market.price(730, 'first', 23)).cached, true);
});

test('429 cools all endpoints while cached data remains available', async () => {
  let calls = 0;
  const market = new SteamMarket({ priceIntervalMs: 0, searchIntervalMs: 0, http: {
    async getJson() {
      calls++;
      if (calls === 1) return { status: 200, json: pricePayload() };
      throw new HttpError('slow down', { status: 429, retryAfterMs: 1000 });
    },
  } });
  await market.price(730, 'cached', 23);
  await assert.rejects(market.price(730, 'limited', 23), { code: 'rate-limited' });
  await assert.rejects(market.search(730, 'other'), { code: 'rate-limited' });
  assert.equal((await market.price(730, 'cached', 23)).cached, true);
  assert.equal(calls, 2);
  market.cooldownUntil = Date.now() - 1;
  await assert.rejects(market.search(730, 'other'));
  assert.equal(calls, 3);
});

test('a stalled injected HTTP client has a finite deadline', { timeout: 1000 }, async () => {
  const market = new SteamMarket({ requestTimeoutMs: 20, http: {
    getJson() { return new Promise(() => {}); },
  } });
  await assert.rejects(market.search(730, 'case'), /timed out/);
  assert.equal(market.inflight.size, 0);
});

function searchPayload() {
  return {
    success: true,
    results: [
      {
        name: 'Clutch Case',
        hash_name: 'Clutch Case',
        sell_listings: 59352,
        app_name: 'Counter-Strike 2',
        asset_description: {
          appid: 730,
          icon_url: 'abc123',
          type: 'Base Grade Container',
        },
      },
      {
        name: 'Clutch Case Key',
        hash_name: 'Clutch Case Key',
        sell_listings: 110,
        app_name: 'Counter-Strike 2',
        asset_description: {
          appid: 730,
          icon_url: 'def456',
          type: 'Key',
        },
      },
    ],
  };
}

function pricePayload() {
  return {
    success: true,
    lowest_price: '\u00a5 3.61',
    median_price: '\u00a5 3.56',
    volume: '6,159',
  };
}

test('parses search results and builds the icon URL', async () => {
  let calls = 0;
  const http = {
    async getJson() {
      calls++;
      return { status: 200, json: searchPayload() };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  const result = await market.search(730, 'Clutch');
  assert.equal(calls, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].hashName, 'Clutch Case');
  assert.equal(result.results[0].type, 'Base Grade Container');
  assert.match(result.results[0].iconUrl, /abc123/);
  assert.equal(result.results[0].sellListings, 59352);
});

test('caches search results', async () => {
  let calls = 0;
  const http = {
    async getJson() {
      calls++;
      return { status: 200, json: searchPayload() };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  await market.search(730, 'Clutch');
  const second = await market.search(730, 'clutch');
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test('parses and caches a price', async () => {
  let calls = 0;
  const http = {
    async getJson() {
      calls++;
      return { status: 200, json: pricePayload() };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  const first = await market.price(730, 'Clutch Case', 23);
  assert.equal(first.ok, true);
  assert.equal(first.lowest, 361);
  assert.equal(first.median, 356);
  assert.equal(first.volume, 6159);
  assert.equal(first.cached, false);

  const second = await market.price(730, 'Clutch Case', 23);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('refresh bypasses the price cache', async () => {
  let calls = 0;
  const http = {
    async getJson() {
      calls++;
      return { status: 200, json: pricePayload() };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  await market.price(730, 'Clutch Case', 23);
  await market.price(730, 'Clutch Case', 23, { refresh: true });
  assert.equal(calls, 2);
});

test('returns no-market-data when Steam has no price', async () => {
  const http = {
    async getJson() {
      return { status: 200, json: { success: false } };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  const result = await market.price(730, 'Missing Item', 23);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-market-data');
});

test('returns no-price-data when both prices are absent', async () => {
  const http = {
    async getJson() {
      return { status: 200, json: { success: true, volume: '0' } };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  const result = await market.price(730, 'Clutch Case', 23);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-price-data');
});

test('maps HTTP 429 to a rate-limit error', async () => {
  const http = {
    async getJson() {
      return { status: 429, headers: { 'retry-after': '60' }, json: null };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  await assert.rejects(
    () => market.price(730, 'Clutch Case', 23),
    (err) => err instanceof MarketError && err.code === 'rate-limited' && err.status === 429,
  );
});

test('maps transport failures to upstream errors', async () => {
  const http = {
    async getJson() {
      throw new HttpError('socket closed', { code: 'network' });
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  await assert.rejects(
    () => market.search(730, 'Clutch'),
    (err) => err instanceof MarketError && err.code === 'upstream' && err.status === 502,
  );
});

test('rejects an unsuccessful search response', async () => {
  const http = {
    async getJson() {
      return { status: 200, json: { success: false } };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0 });
  await assert.rejects(() => market.search(730, 'Clutch'), /invalid response/);
});

test('finds an exact result by hash name or display name', () => {
  const results = [
    { hashName: 'Clutch Case', name: 'Clutch Case' },
    { hashName: 'Clutch Case Key', name: 'Clutch Case Key' },
  ];
  assert.equal(findExactSearchResult(results, 'clutch case').hashName, 'Clutch Case');
  assert.equal(findExactSearchResult(results, 'Clutch Case Key').hashName, 'Clutch Case Key');
  assert.equal(findExactSearchResult(results, 'Clutch'), null);
});

test('parses and caches the embedded market history', async () => {
  const html = [
    '...\\"ecurrency\\":8,\\"prices\\":[',
    '{\\"time\\":100,\\"price_median\\":1.5,\\"purchases\\":2},',
    '{\\"time\\":200,\\"price_median\\":2.5,\\"purchases\\":3}',
    ']...',
  ].join('');
  let calls = 0;
  const http = {
    async request() {
      calls++;
      return { status: 200, headers: {}, text: html };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0, historyIntervalMs: 0 });
  const first = await market.history(730, 'Clutch Case');
  assert.equal(first.currency, 8);
  assert.equal(first.points.length, 2);
  assert.equal(first.points[0].price, 1.5);
  const second = await market.history(730, 'Clutch Case');
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('throws history-unavailable for a page without a series', async () => {
  const http = {
    async request() {
      return { status: 200, headers: {}, text: '<html></html>' };
    },
  };
  const market = new SteamMarket({ http, searchIntervalMs: 0, priceIntervalMs: 0, historyIntervalMs: 0 });
  await assert.rejects(
    () => market.history(730, 'Clutch Case'),
    (err) => err instanceof MarketError && err.code === 'history-unavailable',
  );
});