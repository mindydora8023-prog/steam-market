import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarketInput, priceNumber, cleanEntries, nearestPoint, queryParams, fetchJson } from '../app/public/ui-utils.js';

test('market links preserve canonical item names and app ids', () => {
  assert.deepEqual(parseMarketInput(' https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20(Field-Tested)?x=1 '), { appId: 730, name: 'AK-47 | Redline (Field-Tested)' });
  assert.deepEqual(parseMarketInput('Clutch Case'), { name: 'Clutch Case' });
  assert.equal(parseMarketInput('https://steamcommunity.com.evil/market/listings/730/item').appId, undefined);
  assert.doesNotThrow(() => parseMarketInput('https://steamcommunity.com/market/listings/730/%XX'));
});

test('clipboard prices use numeric decimal amounts without currency symbols', () => {
  assert.equal(priceNumber(123456, 23), '1234.56');
  assert.equal(priceNumber(1234, 8), '1234');
  assert.equal(priceNumber(1234, 38), '1.234');
  assert.equal(priceNumber(-1, 23), '');
  assert.equal(priceNumber(NaN, 23), '');
});

test('stored history tolerates malformed and oversized local data', () => {
  const valid = { appId: 730, hashName: 'Clutch Case' };
  assert.deepEqual(cleanEntries([null, 3, {}, { appId: 0, hashName: 'x' }, valid]), [valid]);
  assert.equal(cleanEntries(Array(50).fill(valid)).length, 20);
  assert.deepEqual(cleanEntries({}), []);
});

test('chart point lookup handles edges and chooses nearest timestamp', () => {
  const points = [10, 20, 40].map((time) => ({ time }));
  assert.equal(nearestPoint(points, -5), 0);
  assert.equal(nearestPoint(points, 100), 2);
  assert.equal(nearestPoint(points, 29), 1);
  assert.equal(nearestPoint(points, 31), 2);
  assert.equal(nearestPoint([], 10), -1);
});

test('share parameters preserve fee settings and display range', () => {
  const params = queryParams({ appId: 753, currency: 8, strategy: 'match', undercut: 0, steamFee: 0, publisherFee: 1, historyDays: 30, quantity: 12 }, 'A & B');
  assert.equal(params.get('name'), 'A & B');
  assert.equal(params.get('publisherFee'), '1');
  assert.equal(params.get('steamFee'), '0');
  assert.equal(params.get('days'), '30');
  assert.equal(params.get('quantity'), '12');
});

test('JSON requests clean up and preserve structured API errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'rate-limited' } }) });
    const result = await fetchJson('/api/quote');
    assert.equal(result.error.code, 'rate-limited');
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(fetchJson('/api/quote'), /HTTP 500/);
  } finally { globalThis.fetch = original; }
});

test('JSON requests abort hung fetches at their deadline', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await assert.rejects(fetchJson('/api/quote', { timeoutMs: 10 }), (error) => error.name === 'TimeoutError');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchJson('/api/quote', { signal: controller.signal }), (error) => error.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});
