import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMinor, parsePriceToMinor } from '../lib/currency.js';

test('parses CNY prices', () => {
  assert.equal(parsePriceToMinor('\u00a5 0.03', 23), 3);
  assert.equal(parsePriceToMinor('\u00a5 1.23', 23), 123);
  assert.equal(parsePriceToMinor('\u00a5 1,234.56', 23), 123456);
});

test('parses USD prices', () => {
  assert.equal(parsePriceToMinor('$1.23', 1), 123);
  assert.equal(parsePriceToMinor('$1,234.56', 1), 123456);
  assert.equal(parsePriceToMinor('$0.03', 1), 3);
});

test('parses EUR prices with swapped separators', () => {
  assert.equal(parsePriceToMinor('1,23\u20ac', 3), 123);
  assert.equal(parsePriceToMinor('1.234,56\u20ac', 3), 123456);
  assert.equal(parsePriceToMinor('0,03\u20ac', 3), 3);
});

test('parses RUB prices with spaces', () => {
  assert.equal(parsePriceToMinor('1 234,56 pyb.', 5), 123456);
  assert.equal(parsePriceToMinor('0,03 pyb.', 5), 3);
});

test('parses BRL prices', () => {
  assert.equal(parsePriceToMinor('R$ 1.234,56', 7), 123456);
});

test('parses zero-decimal currencies', () => {
  assert.equal(parsePriceToMinor('\u00a5 1,234', 8), 1234);
  assert.equal(parsePriceToMinor('\u00a5 3', 8), 3);
});

test('infers separators for unknown currencies', () => {
  assert.equal(parsePriceToMinor('1,234.56', 999), 123456);
  assert.equal(parsePriceToMinor('1.234,56', 999), 123456);
});

test('treats a three-digit trailing group as thousands', () => {
  assert.equal(parsePriceToMinor('$1.234', 1), 123400);
});

test('rejects non-prices', () => {
  assert.equal(parsePriceToMinor('', 23), null);
  assert.equal(parsePriceToMinor('free', 23), null);
  assert.equal(parsePriceToMinor(null, 23), null);
  assert.equal(parsePriceToMinor('1.2.3', 1), null);
});

test('formats minor units', () => {
  assert.equal(formatMinor(3, 23), '\u00a50.03');
  assert.equal(formatMinor(123456, 3), '1.234,56 \u20ac');
  assert.equal(formatMinor(1234, 8), '\u00a51,234');
  assert.equal(formatMinor(12345, 1), '$123.45');
});