import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceHistoryHtml } from '../app/history.mjs';

function html(prices, currency = 8) {
  return `...\\"ecurrency\\":${currency},\\"prices\\":[${prices}]...`;
}

test('parses the escaped Steam price history array', () => {
  const raw = [
    '{\\"time\\":100,\\"price_median\\":1.5,\\"purchases\\":2}',
    '{\\"time\\":200,\\"price_median\\":2.5,\\"purchases\\":3}',
  ].join(',');
  const result = parsePriceHistoryHtml(html(raw));
  assert.equal(result.currency, 8);
  assert.deepEqual(result.points, [
    { time: 100, price: 1.5, volume: 2 },
    { time: 200, price: 2.5, volume: 3 },
  ]);
});

test('sorts points and deduplicates by time', () => {
  const raw = [
    '{\\"time\\":200,\\"price_median\\":2.5,\\"purchases\\":3}',
    '{\\"time\\":100,\\"price_median\\":1.5,\\"purchases\\":2}',
    '{\\"time\\":200,\\"price_median\\":2.7,\\"purchases\\":4}',
  ].join(',');
  const result = parsePriceHistoryHtml(html(raw));
  assert.deepEqual(result.points, [
    { time: 100, price: 1.5, volume: 2 },
    { time: 200, price: 2.7, volume: 4 },
  ]);
});

test('skips a prices array without price_median', () => {
  const raw = '{\\"time\\":100,\\"price_median\\":1.5,\\"purchases\\":2}';
  const text = `\\"prices\\":[{\\"time\\":1}] then ${html(raw)}`;
  const result = parsePriceHistoryHtml(text);
  assert.equal(result.points.length, 1);
});

test('rejects invalid or missing history', () => {
  assert.equal(parsePriceHistoryHtml(''), null);
  assert.equal(parsePriceHistoryHtml('<html></html>'), null);
  assert.equal(parsePriceHistoryHtml('\\"prices\\":[{\\"time\\":0}]'), null);
});

test('accepts valid observations after a null row and sanitizes volume', () => {
  const raw = 'null,' + JSON.stringify({ time: 100, price_median: 1.5, purchases: 'Infinity' });
  const result = parsePriceHistoryHtml(html(raw));
  assert.deepEqual(result.points, [{ time: 100, price: 1.5, volume: 0 }]);
});

test('keeps a zero volume but drops invalid rows', () => {
  const raw = [
    '{\\"time\\":100,\\"price_median\\":1.5}',
    '{\\"time\\":200,\\"price_median\\":0}',
  ].join(',');
  const result = parsePriceHistoryHtml(html(raw));
  assert.deepEqual(result.points, [{ time: 100, price: 1.5, volume: 0 }]);
});