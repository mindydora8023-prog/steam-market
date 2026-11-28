import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../app/app.mjs';
import { SteamMarket } from '../app/steam.mjs';
import { HttpClient } from '../lib/http.js';

const STEAM_ID = '76561198000000001';
const INV_PATH = '/inventory/' + STEAM_ID + '/753/6';
const VANITY = 'https://steamcommunity.com/id/card-seller';
const PAGE_URL = 'https://steamcommunity.com' + INV_PATH + '?l=english&count=200';
const asset = (assetid, classid) => ({ assetid, classid, amount: '1', instanceid: '0' });
const desc = (classid, market_hash_name, type = 2, marketable = 1, foil = false) => ({
  classid, instanceid: '0', market_hash_name, marketable,
  tags: [
    { category: 'item_class', internal_name: 'item_class_' + type },
    { category: 'cardborder', internal_name: 'cardborder_' + Number(foil) },
    { category: 'Game', internal_name: 'app_100', localized_tag_name: 'Test Game' },
  ],
});
const json = (value, status = 200, headers = {}) => raw(JSON.stringify(value), status, headers);
const raw = (body, status = 200, headers = {}) => ({ status, headers, body: Buffer.from(body) });

async function fixture(t, respond, options = {}) {
  const calls = [];
  const cookies = new Map([['sessionid', 'fixture-only']]);
  const proxy = { label: 'fixture-proxy' };
  const client = new HttpClient({
    cookies, proxy, transport(request) {
      calls.push(request);
      return respond(new URL(request.url));
    },
  });
  const steam = new SteamMarket({ http: client, inventoryIntervalMs: 0, ...options });
  const server = http.createServer(createApp({ steam, version: 'test', publicDir: '.' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, init) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(2000), ...init });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return {
    calls, cookies, proxy, request,
    inventory: (input = STEAM_ID, onlyCards = '1') =>
      request('/api/inventory?' + new URLSearchParams({ steamId: input, onlyCards })),
  };
}

test('reads read-only Steam pages through the proxy, resolves vanity and caches the shared inventory', async (t) => {
  const fixtureApp = await fixture(t, (url) => {
    if (url.pathname === '/id/card-seller/') {
      assert.equal(url.search, '?xml=1');
      return raw('<profile><steamID64>' + STEAM_ID + '</steamID64></profile>', 200, { 'set-cookie': ['sessionid=rejected'] });
    }
    assert.equal(url.pathname, INV_PATH);
    assert.equal(url.searchParams.get('l'), 'english');
    assert.equal(url.searchParams.get('count'), '200');
    if (!url.searchParams.has('start_assetid')) {
      return json({
        success: 1, more_items: 1, last_assetid: '18446744073709551615',
        assets: [asset('1', '10'), asset('2', '11'), asset('3', '12')],
        descriptions: [desc('10', 'Game Card'), desc('11', 'Game Background', 3), desc('12', 'Hidden', 2, 0)],
      });
    }
    assert.equal(url.searchParams.get('start_assetid'), '18446744073709551615');
    return json({ success: 1, assets: [asset('4', '10'), asset('5', '13')],
      descriptions: [desc('13', 'Game Foil', 2, 1, true)] });
  });
  const { body, status, headers } = await fixtureApp.inventory(VANITY + '/inventory?next=https://elsewhere.test/');
  assert.equal(status, 200);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.deepEqual([body.ok, body.steamId, body.totalCount, body.kindCount, body.foilCount, body.gameCount], [true, STEAM_ID, 3, 2, 1, 1]);
  assert.deepEqual(body.items.map(({ hashName, count }) => [hashName, count]), [['Game Card', 2], ['Game Foil', 1]]);
  assert.equal(body.pages, 2);
  assert.equal(body.truncated, false);
  assert.equal(body.cached, false);
  const repeated = (await fixtureApp.inventory(VANITY, '0')).body;
  assert.equal(repeated.cached, true);
  assert.equal(repeated.totalCount, 4);
  assert.equal(repeated.games[0].kinds, 3);
  assert.equal((await fixtureApp.inventory()).body.cached, true);
  assert.equal(fixtureApp.calls.length, 3);
  for (const call of fixtureApp.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(new URL(call.url).origin, 'https://steamcommunity.com');
    assert.equal(call.headers.Cookie, undefined);
    assert.equal(call.proxy, fixtureApp.proxy);
  }
  assert.equal(fixtureApp.cookies.get('sessionid'), 'fixture-only');
});

test('bounds inventory pagination and marks repeated or missing cursors as partial', async (t) => {
  const app = await fixture(t, (url) => {
    const index = Number(url.searchParams.get('start_assetid') || 0) + 1;
    return json({
      success: 1, more_items: 1, last_assetid: String(index),
      assets: Array.from({ length: 200 }, (_, i) => asset(String(index * 200 + i), '10')),
      descriptions: [desc('10', 'Card')],
    });
  });
  const { body } = await app.inventory();
  assert.equal(body.pages, 5);
  assert.equal(body.truncated, true);
  assert.equal(body.totalCount, 1000);
  assert.equal(app.calls.length, 5);

  const loop = await fixture(t, () => json({ success: 1, assets: [], more_items: 1, last_assetid: '10' }));
  assert.equal((await loop.inventory()).body.truncated, true);
  assert.equal(loop.calls.length, 2);
  const malformed = await fixture(t, () => json({ success: 1, assets: [], more_items: 1, last_assetid: '1&count=5000' }));
  assert.equal((await malformed.inventory()).body.truncated, true);
  assert.deepEqual(malformed.calls.map((call) => call.url), [PAGE_URL]);
});

test('distinguishes private, empty, malformed and unavailable vanity results without leaking data', async (t) => {
  for (const [response, status, code] of [
    [raw('internal detail', 403), 403, 'inventory-private'],
    [json(null), 403, 'inventory-private'],
    [raw('private'), 403, 'inventory-private'],
    [json({ success: 0, Error: 'This inventory is private.' }), 403, 'inventory-private'],
    [json({ success: 1, total_inventory_count: 0 }), 200, 'inventory-empty'],
    [json({ success: 1, assets: [asset('1', '10')], descriptions: [desc('10', 'Background', 3)] }), 200, 'inventory-empty'],
    [raw('internal detail'), 502, 'inventory-upstream'],
    [json({ success: 0, error: 'internal detail' }), 502, 'inventory-upstream'],
    [json({ success: 1 }), 502, 'inventory-upstream'],
  ]) {
    const app = await fixture(t, () => response);
    const result = await app.inventory();
    assert.equal(result.status, status);
    assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message', 'retryAfterMs']);
    assert.equal(result.body.error.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /internal detail|stack/);
  }
  const missing = await fixture(t, () => raw('<profile><error>Nothing found</error></profile>'));
  assert.equal((await missing.inventory(VANITY)).body.error.code, 'inventory-profile-unavailable');
  assert.equal(missing.calls.length, 1);
});

test('rejects malformed API parameters and never follows upstream inventory or vanity redirects', async (t) => {
  const app = await fixture(t, () => raw('', 302, { location: 'http://127.0.0.1/private' }));
  for (const query of [
    '', 'steamId=', 'steamId=123', 'steamId=' + STEAM_ID + '&steamId=' + STEAM_ID,
    'steamId=' + STEAM_ID + '&onlyCards=2', 'steamId=' + STEAM_ID + '&onlyCards=true',
    'steamId=' + STEAM_ID + '&onlyCards=', 'steamId=' + STEAM_ID + '&onlyCards=1&onlyCards=0',
    'steamId=' + encodeURIComponent('https://steamcommunity.com.evil.test/id/example'),
  ]) {
    const result = await app.request('/api/inventory?' + query);
    assert.equal(result.status, 400, query);
    assert.equal(result.body.error.code, 'bad-request');
  }
  const post = await app.request('/api/inventory?steamId=' + STEAM_ID, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
  assert.equal(app.calls.length, 0);
  for (const input of [STEAM_ID, VANITY]) {
    const result = await app.inventory(input);
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, 'inventory-upstream');
  }
  assert.deepEqual(app.calls.map((call) => call.url), [PAGE_URL, VANITY + '/?xml=1']);
});

test('shares a 429 cooldown across inventory and canonical price, respecting Retry-After', async (t) => {
  const app = await fixture(t, () => raw('rate limited', 429, { 'retry-after': '12' }));
  const first = await app.inventory();
  const second = await app.request('/api/quote?appid=753&exact=1&name=Card&currency=23');
  assert.equal(first.status, 429);
  assert.equal(first.body.error.code, 'rate-limited');
  assert.equal(first.body.error.retryAfterMs, 12000);
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'rate-limited');
  assert.ok(second.body.error.retryAfterMs > 0 && second.body.error.retryAfterMs <= 12000);
  assert.equal(app.calls.length, 1);
});

test('uses one cached canonical price lookup and never sends session cookies', async (t) => {
  const app = await fixture(t, (url) => {
    assert.equal(url.pathname, '/market/priceoverview/');
    assert.equal(url.searchParams.get('appid'), '753');
    assert.equal(url.searchParams.get('market_hash_name'), '42-Card');
    return json({ success: true, lowest_price: '\u00a50.30', median_price: '\u00a50.28', volume: '10' });
  });
  for (let index = 0; index < 2; index++) {
    const result = await app.request('/api/quote?appid=753&exact=1&name=42-Card&currency=23');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.market.lowest, 30);
    assert.equal(result.body.recommendation.receive, 15);
    assert.equal(result.body.cached, index > 0);
  }
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].headers.Cookie, undefined);
});

test('coalesces simultaneous inventory requests and bounds the total upstream wait', async (t) => {
  const app = await fixture(t, () => new Promise((resolve) => {
    setTimeout(() => resolve(json({ success: 1, total_inventory_count: 0 })), 25);
  }));
  const results = await Promise.all([app.inventory(), app.inventory(STEAM_ID, '0')]);
  assert.deepEqual(results.map((result) => result.body.error.code), ['inventory-empty', 'inventory-empty']);
  assert.equal(app.calls.length, 1);

  const stalled = await fixture(t, () => new Promise(() => {}), { requestTimeoutMs: 30 });
  const result = await stalled.inventory();
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'inventory-upstream');
});
