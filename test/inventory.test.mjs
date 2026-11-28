import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateInventory, inventoryBatchRow, inventoryCursor, inventoryTier, parseSteamProfile,
  parseVanitySteamId, summarizeInventory,
} from '../lib/inventory.js';
import { addBatchRows, batchCsv, cleanBatch, estimateBatch, fillBatchPrices, MAX_BATCH_QUANTITY } from '../lib/batch.js';
import { marketMinimumFor, normalizeWallet } from '../lib/fees.js';
import { buildQuote } from '../lib/quote.js';

const steamId = '76561198000000001';
const asset = (assetid, classid, amount = '1', instanceid = '0') => ({ assetid, classid, amount, instanceid });
const desc = (classid, name, { marketable = 1, type = 2, border = 0, instanceid = '0', icon = 'hash-_1' } = {}) => ({
  classid, instanceid, market_hash_name: name, name, marketable, icon_url: icon,
  tags: [
    { category: 'item_class', internal_name: 'item_class_' + type },
    { category: 'cardborder', internal_name: 'cardborder_' + border },
    { category: 'Game', internal_name: 'app_42', localized_tag_name: 'Example Game' },
  ],
});

test('Steam profiles preserve 64-bit IDs and accept bare, numeric and vanity links', () => {
  for (const input of [
    ' ' + steamId + ' ', 'steamcommunity.com/profiles/' + steamId,
    'http://steamcommunity.com/profiles/' + steamId + '/',
    'https://STEAMCOMMUNITY.COM/profiles/' + steamId + '/inventory/#753_6',
    'https://steamcommunity.com/profiles/' + steamId + '/inventory/753/6?l=english',
  ]) assert.deepEqual(parseSteamProfile(input), { steamId });
  assert.deepEqual(parseSteamProfile('steamcommunity.com/id/Card-Fan_42/inventory#753_6'), { vanity: 'Card-Fan_42' });
  for (const rejected of [Number(steamId), '123', steamId + '0', '', 'https://steamcommunity.com/profiles/Alice']) {
    assert.equal(parseSteamProfile(rejected), null);
  }
});

test('rejects untrusted origins, credentials, nonstandard ports and path injection', () => {
  for (const input of [
    'https://steamcommunity.com.evil.test/id/cards', 'https://evil.test/steamcommunity.com/id/cards',
    'https://steamcommunity.com@evil.test/id/cards', 'https://evil.test@steamcommunity.com/id/cards',
    'https://steamcommunity.com:443/id/cards', 'http://127.0.0.1/id/cards',
    'file://steamcommunity.com/id/cards', '//steamcommunity.com/id/cards',
    'https://steamcommunity.com./id/cards', 'https://steamcommunity.com\\evil.test/id/cards',
    'https://steamcommunity.com/id/%2f%2e%2e', 'https://steamcommunity.com/id/a/../b',
    'https://steamcommunity.com/id/a\nb', 'https://steamcommunity.com/id/' + 'x'.repeat(65),
  ]) assert.equal(parseSteamProfile(input), null, input);
});

test('reads only a profile SteamID64 value from plain or CDATA XML', () => {
  assert.equal(parseVanitySteamId('<?xml version="1.0"?><profile><steamID64>' + steamId + '</steamID64></profile>'), steamId);
  assert.equal(parseVanitySteamId('<profile><steamID64><![CDATA[' + steamId + ']]></steamID64></profile>'), steamId);
  assert.equal(parseVanitySteamId('<profile><steamID64>&entity;</steamID64></profile>'), null);
  assert.equal(parseVanitySteamId('<html><steamID64>' + steamId + '</steamID64></html>'), null);
  assert.equal(parseVanitySteamId('<profile><steamID64>123</steamID64></profile>'), null);
  assert.equal(inventoryCursor('18446744073709551615'), '18446744073709551615');
  for (const value of [42, null, '4e5', '1&count=80000', '1'.repeat(21)]) assert.equal(inventoryCursor(value), null);
});

test('aggregates by market name and class instance across pages, with a marketable-only view', () => {
  const pages = [
    { assets: [asset('1', '10', '2'), asset('2', '11'), asset('3', '12'), asset('4', '13'),
      asset('5', '10', '3', '1'), asset('6', '15'), asset('7', '16'), asset('8', '17'), asset('9', '18', 'Infinity')],
    descriptions: [desc('10', 'Base card'), desc('12', 'Unmarketable', { marketable: 0 }),
      desc('13', 'Background', { type: 3, icon: 'https://external.invalid/image' }),
      desc('10', 'Same class, other instance', { instanceid: '1' }), desc('15', 'Emoticon', { type: 4 }),
      desc('16', 'Other', { type: 5 }), desc('18', 'Bad amount')] },
    { assets: [asset('1', '10', '2'), asset('10', '14'), asset('11', '11', '2')],
      descriptions: [desc('11', 'Foil card', { border: 1 }), desc('14', 'Base card')] },
  ];
  const items = aggregateInventory(pages);
  assert.deepEqual(items.map(({ hashName, count, type, foil }) => [hashName, count, type, foil]), [
    ['Base card', 3, 'card', false], ['Foil card', 3, 'card', true], ['Background', 1, 'background', false],
    ['Same class, other instance', 3, 'card', false], ['Emoticon', 1, 'emoticon', false], ['Other', 1, 'other', false],
  ]);
  assert.equal(items[2].iconUrl, '');
  assert.match(items[0].iconUrl, /^https:\/\/community\.cloudflare\.steamstatic\.com\/economy\/image\/hash-_1\//);
  const cards = summarizeInventory(items);
  assert.deepEqual([cards.totalCount, cards.cardCount, cards.kindCount, cards.foilCount, cards.gameCount], [9, 9, 3, 3, 1]);
  assert.deepEqual(cards.games, [{ key: 'app_42', name: 'Example Game', count: 9, kinds: 3 }]);
  assert.equal(summarizeInventory(items, false).totalCount, 12);
});

test('liquidation tiers use exact net, currency floor, active asks and recent volume', () => {
  const quote = (currency, lowest, volume, median = lowest) => buildQuote({
    currency, lowest, median, volume, wallet: normalizeWallet({ wallet_market_minimum: marketMinimumFor(currency) }),
  });
  const regular = { foil: false };
  assert.equal(inventoryTier({ foil: true }, null, 23), 'review');
  assert.equal(inventoryTier(regular, quote(23, 810, 0), 23), 'review');
  assert.equal(inventoryTier(regular, quote(23, 100, 10), 23), 'regular');
  assert.equal(inventoryTier(regular, quote(23, 100, 9), 23), 'thin');
  assert.equal(inventoryTier(regular, quote(23, null, 100, 100), 23), 'thin');
  assert.equal(inventoryTier(regular, quote(23, 21, 100), 23), 'thin');
  assert.equal(inventoryTier(regular, quote(8, 180, 10), 8), 'review');
  assert.equal(inventoryTier(regular, quote(10, 180, 10), 10), 'regular');
  assert.equal(inventoryTier(regular, { error: { code: 'below-fee-floor' } }, 23), 'thin');
  assert.equal(inventoryTier(regular, { ok: false }, 23), null);
});

test('imports priced and pending rows atomically without mixing currencies or losing quantities', () => {
  const card = { hashName: 'Example card', count: 3 };
  const pending = { hashName: 'Pending card', count: 2 };
  const settings = { currency: 23, undercut: 1, steamFee: 5, publisherFee: 10 };
  const market = { market: { lowest: 30, median: 27 } };
  const cny = inventoryBatchRow(card, market, settings);
  const jpy = inventoryBatchRow(card, market, { ...settings, currency: 8 });
  const noQuote = inventoryBatchRow(pending, null, settings);
  const original = cleanBatch({ rows: [{ ...cny, quantity: 1, priceOverride: 29 }] }).rows;
  const added = addBatchRows(original, [cny, jpy, noQuote]);
  assert.equal(added.ok, true);
  const saved = cleanBatch(JSON.parse(JSON.stringify({ rows: added.rows })));
  const report = estimateBatch(saved);
  assert.equal(report.quantity, 9);
  assert.equal(report.unpricedQuantity, 2);
  assert.deepEqual(report.groups.map(({ currency, quantity }) => [currency, quantity]), [[23, 6], [8, 3]]);
  assert.equal(report.lines[0].price.buyerPays, 29);
  assert.equal(report.lines[0].subtotal.receive, 60);
  assert.throws(() => batchCsv(report), RangeError);
  saved.rows[2].priceOverride = 29;
  assert.match(batchCsv(estimateBatch(saved)), /"Pending card","753","CNY","2"/);
  const withPendingDuplicate = addBatchRows(original, [inventoryBatchRow(card, null, settings)]);
  assert.equal(withPendingDuplicate.rows[0].lowest, 30);
  assert.equal(withPendingDuplicate.rows[0].quantity, 4);
  const pricedPending = inventoryBatchRow(pending, market, settings);
  const updated = fillBatchPrices(saved.rows, [
    inventoryBatchRow(pending, market, { ...settings, currency: 8 }),
    pricedPending,
  ]);
  assert.equal(updated.updated, 1);
  assert.equal(updated.rows[2].quantity, 2);
  assert.equal(updated.rows[2].currency, 23);
  assert.equal(updated.rows[2].lowest, 30);
  assert.equal(updated.rows[2].priceOverride, 29);
  assert.equal(estimateBatch({ rows: updated.rows }).quantity, 9);
  assert.equal(fillBatchPrices(updated.rows, [pricedPending]).updated, 0);
  const tooMany = { ...cny, quantity: MAX_BATCH_QUANTITY };
  assert.deepEqual(addBatchRows(original, [jpy, tooMany]), { ok: false, code: 'quantity-limit' });
  assert.equal(original.length, 1);
  assert.equal(original[0].quantity, 1);
});
