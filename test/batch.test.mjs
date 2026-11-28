import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addBatchRow, batchAmount, batchCsv, batchKey, batchMarkdown, cleanBatch, estimateBatch,
  MAX_BATCH_QUANTITY, MAX_BATCH_ROWS, parseBatchPrice,
} from '../lib/batch.js';
import { marketMinimumFor, normalizeWallet } from '../lib/fees.js';
import { buildQuote, QUOTE_STRATEGIES } from '../lib/quote.js';

const row = (overrides = {}) => ({
  appId: 730, name: 'Clutch Case', currency: 23, quantity: 1,
  lowest: 361, median: 356, undercut: 1, steamFee: 5, publisherFee: 10,
  priceOverride: null, ...overrides,
});

test('batch groups money by currency and rounds fees per item before multiplying', () => {
  const report = estimateBatch({ rows: [
    row({ quantity: 3, priceOverride: 29 }),
    row({ name: 'Other Case', quantity: 2, priceOverride: 21 }),
    row({ currency: 8, quantity: 2, priceOverride: 14 }),
  ] });
  assert.equal(report.quantity, 7);
  assert.equal(report.unpricedQuantity, 0);
  assert.equal(report.buyerPays, undefined);
  assert.deepEqual(report.groups, [
    { currency: 23, quantity: 5, pricedQuantity: 5, buyerPays: 129, receive: 59, totalFees: 70, steamFee: 35, publisherFee: 35 },
    { currency: 8, quantity: 2, pricedQuantity: 2, buyerPays: 28, receive: 20, totalFees: 8, steamFee: 4, publisherFee: 4 },
  ]);
  assert.deepEqual(report.lines[0].subtotal, { buyerPays: 87, receive: 45, totalFees: 42, steamFee: 21, publisherFee: 21 });
});

test('all four global strategies use the same integer decisions as single-item quote', () => {
  const snapshot = row({ lowest: 150, median: 450, undercut: 3, steamFee: 29, publisherFee: 0 });
  const wallet = normalizeWallet({
    wallet_currency: 23, wallet_market_minimum: marketMinimumFor(23),
    wallet_fee_percent: 0.29, wallet_publisher_fee_percent_default: 0,
  });
  const amounts = [];
  for (const strategy of QUOTE_STRATEGIES) {
    const report = estimateBatch({ strategy, rows: [snapshot, row({ name: 'Manual', priceOverride: 29 })] });
    const expected = buildQuote({ ...snapshot, strategy, wallet }).recommendation;
    const [market, manual] = report.lines;
    assert.equal(market.strategy, strategy);
    assert.equal(market.price.buyerPays, expected.buyerPays);
    assert.equal(market.price.receive, expected.receive);
    assert.equal(market.price.steamFee, expected.steamFee);
    assert.equal(market.price.publisherFee, 0);
    assert.equal(manual.strategy, 'custom');
    assert.equal(manual.price.buyerPays, 29);
    amounts.push(market.price.buyerPays);
  }
  assert.equal(new Set(amounts).size, 4);
});

test('custom price uses the attainable buyer amount and exact decimal fee floors', () => {
  const [gap, decimal] = estimateBatch({ rows: [
    row({ currency: 1, priceOverride: 12, steamFee: 30, publisherFee: 0 }),
    row({ priceOverride: 139, steamFee: 29 }),
  ] }).lines;
  assert.deepEqual(gap.price, { receive: 9, publisherFee: 0, steamFee: 2, totalFees: 2, buyerPays: 11 });
  assert.deepEqual(decimal.price, { receive: 100, publisherFee: 10, steamFee: 29, totalFees: 39, buyerPays: 139 });
});

test('unavailable strategy and below-floor overrides count items without misreporting prices', () => {
  const report = estimateBatch({ strategy: 'match', rows: [
    row({ name: 'Low ask', lowest: 3, median: 25, quantity: 2 }),
    row({ name: 'Low override', priceOverride: 20, quantity: 3 }),
    row({ name: 'Valid', priceOverride: 21 }),
  ] });
  assert.equal(report.quantity, 6);
  assert.equal(report.unpricedQuantity, 5);
  assert.equal(report.groups[0].pricedQuantity, 1);
  assert.equal(report.groups[0].buyerPays, 21);
  assert.equal(report.lines[0].price, null);
  assert.equal(report.lines[0].subtotal, null);
  assert.equal(report.lines[1].minimum, 21);
  assert.throws(() => batchCsv(report), RangeError);
  assert.throws(() => batchMarkdown(report), RangeError);
  assert.equal(estimateBatch({ strategy: 'median', rows: [row({ lowest: 3, median: 25 })] }).unpricedQuantity, 0);
});

test('price inputs validate currency precision, bounds and blank strategy fallback', () => {
  assert.equal(parseBatchPrice('  ', 23), null);
  assert.equal(parseBatchPrice('0.29', 23), 29);
  assert.equal(parseBatchPrice('.29', 23), 29);
  assert.ok(Number.isNaN(parseBatchPrice(null, 23)));
  assert.equal(parseBatchPrice('12', 8), 12);
  assert.equal(parseBatchPrice('1.005', 38), 1005);
  assert.equal(parseBatchPrice('10000000', 23), 1000000000);
  for (const [price, currency] of [
    ['0', 23], ['-1', 23], ['1.001', 23], ['12.0', 8], ['1,000', 23],
    ['1e2', 23], ['10000000.01', 23], ['99999999999999999', 8],
  ]) assert.ok(Number.isNaN(parseBatchPrice(price, currency)), price);
  assert.equal(batchAmount(5, 38), '0.005');
  assert.equal(batchAmount(8, 8), '8');
});

test('malformed stored values are sanitized and a valid snapshot round trips', () => {
  assert.deepEqual(cleanBatch(null), { strategy: 'smart', rows: [] });
  const restored = cleanBatch({
    strategy: 'unknown',
    rows: [null, row({ appId: '730' }), row({ name: '' }), row({ currency: 99 }), row({ quantity: 1.2 }),
      row({ undercut: -1 }), row({ steamFee: 31 }), row({ lowest: -1, median: 0 }),
      row({ priceOverride: '29', lowest: -1, extra: true }), row({ quantity: 9 })],
  });
  assert.deepEqual(restored, { strategy: 'smart', rows: [row({ lowest: null })] });
  assert.deepEqual(cleanBatch(JSON.parse(JSON.stringify(restored))), restored);
});

test('adding a duplicate updates the snapshot, retains its manual price and adds quantity', () => {
  const original = [row({ quantity: 2, priceOverride: 29 })];
  const updated = addBatchRow(original, row({ lowest: 400, quantity: 3 }));
  assert.deepEqual(updated, { ok: true, rows: [row({ lowest: 400, quantity: 5, priceOverride: 29 })] });
  assert.equal(original[0].quantity, 2);
  assert.equal(original[0].lowest, 361);
  assert.notEqual(batchKey(row()), batchKey(row({ currency: 8 })));
  assert.notEqual(batchKey(row()), batchKey(row({ appId: 570 })));
  assert.equal(addBatchRow(updated.rows, row({ currency: 8 })).rows.length, 2);
  assert.equal(addBatchRow(original, row({ quantity: MAX_BATCH_QUANTITY })).code, 'quantity-limit');
  assert.equal(addBatchRow(original, { ...row(), currency: 0 }).code, 'invalid');
});

test('large portfolio bounds keep every currency sum and serialized amount exact', () => {
  const rows = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, index) => row({
    name: 'Case ' + index, quantity: MAX_BATCH_QUANTITY, priceOverride: 1000000000,
    steamFee: 0, publisherFee: 0,
  }));
  const clean = cleanBatch({ strategy: 'match', rows });
  assert.equal(clean.rows.length, MAX_BATCH_ROWS);
  assert.equal(addBatchRow(clean.rows, rows.at(-1)).code, 'row-limit');
  const report = estimateBatch(clean);
  assert.equal(report.groups[0].receive, 1000000000000000);
  assert.equal(batchAmount(report.groups[0].receive, 23), '10000000000000.00');
});

test('CSV escapes embedded delimiters and newlines, and neutralizes spreadsheet formulas', () => {
  const report = estimateBatch({ rows: [
    row({ name: 'Case, "\u6d4b\u8bd5"\r\n(Factory New)', quantity: 2, priceOverride: 29 }),
    row({ name: ' =SUM(1,2)', currency: 8, priceOverride: 14 }),
    row({ name: '\t@formula', currency: 8, priceOverride: 14 }),
  ] });
  const csv = batchCsv(report);
  assert.match(csv, /^"Item","App ID","Currency","Quantity","Listing price","Net per item"/);
  assert.ok(csv.includes('"Case, ""\u6d4b\u8bd5""\r\n(Factory New)","730","CNY","2","0.29","0.15","0.30","0.14","0.14","0.28","custom"\r\n'));
  assert.ok(csv.includes('"\' =SUM(1,2)","730","JPY","1","14","10"'));
  assert.ok(csv.includes('"\'\t@formula"'));
});

test('Markdown escapes market names and reports each currency separately', () => {
  const report = estimateBatch({ rows: [
    row({ name: 'Item \\| **[x](https://e.test)** <b>&\r\nNext', quantity: 2, priceOverride: 29 }),
    row({ name: 'JPY item', currency: 8, priceOverride: 14 }),
  ] });
  const markdown = batchMarkdown(report);
  assert.match(markdown, /Total items: 3/);
  assert.match(markdown, /\| CNY \| 2 \| 0\.58 \| 0\.14 \| 0\.14 \| 0\.28 \| 0\.30 \|/);
  assert.match(markdown, /\| JPY \| 1 \| 14 \| 2 \| 2 \| 4 \| 10 \|/);
  assert.ok(markdown.includes('Item &#92;&#124; &#42;&#42;&#91;x&#93;&#40;https://e.test&#41;&#42;&#42; &#60;b&#62;&#38; Next'));
  assert.doesNotMatch(markdown, /<b>|\[x\]|\r/);
});
