import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerPaysWithFees,
  feeBreakdown,
  marketMinimumFor,
  normalizeFeePercent,
  normalizeWallet,
  receiveForBuyerPays,
  toValidMarketPrice,
} from '../lib/fees.js';

function wallet(overrides = {}) {
  return normalizeWallet({
    wallet_currency: 23,
    wallet_market_minimum: 1,
    wallet_currency_increment: 1,
    wallet_fee_percent: 5,
    wallet_publisher_fee_percent_default: 10,
    ...overrides,
  });
}

test('normalizes percent fields that are either 5 or 0.05', () => {
  assert.equal(normalizeFeePercent(5, 0), 0.05);
  assert.equal(normalizeFeePercent(0.05, 0), 0.05);
  assert.equal(normalizeFeePercent('10', 0), 0.1);
  assert.equal(normalizeFeePercent(undefined, 0.07), 0.07);
});

test('normalizes a wallet', () => {
  const w = wallet();
  assert.equal(w.steamFeePercent, 0.05);
  assert.equal(w.publisherFeePercent, 0.1);
  assert.equal(w.marketMinimum, 1);
  assert.equal(w.currencyIncrement, 1);
});

test('computes buyer pays with both fees', () => {
  const w = wallet();
  assert.equal(buyerPaysWithFees(100, w), 115);
  assert.equal(buyerPaysWithFees(1, w), 3);
});

test('inverts the fee calculation', () => {
  const w = wallet();
  assert.equal(receiveForBuyerPays(115, w), 100);
  assert.equal(receiveForBuyerPays(100, w), 88);
  assert.equal(receiveForBuyerPays(3, w), 1);
  assert.equal(receiveForBuyerPays(2, w), null);
});

test('applies the market minimum and increment', () => {
  const w = wallet({ wallet_market_minimum: 5, wallet_currency_increment: 5 });
  assert.equal(toValidMarketPrice(1, w), 5);
  assert.equal(toValidMarketPrice(7, w), 5);
  assert.equal(toValidMarketPrice(8, w), 10);
  assert.equal(receiveForBuyerPays(4, w), null);
});

test('supports a zero publisher fee', () => {
  const w = wallet({ wallet_publisher_fee_percent_default: 0 });
  assert.equal(w.publisherFeePercent, 0);
  assert.equal(buyerPaysWithFees(100, w), 105);
});

test('fee breakdown is internally consistent', () => {
  const w = wallet();
  const breakdown = feeBreakdown(100, w);
  assert.equal(breakdown.receive, 100);
  assert.equal(breakdown.buyerPays, 115);
  assert.equal(breakdown.totalFees, 15);
  assert.equal(breakdown.publisherFee, 10);
  assert.equal(breakdown.steamFee, 5);
});

test('uses the currency-specific minimum fee', () => {
  assert.equal(marketMinimumFor(23), 7);
  assert.equal(marketMinimumFor(8), 2);
  assert.equal(marketMinimumFor(1), 1);
  assert.equal(marketMinimumFor(999), 1);

  const cny = wallet({ wallet_market_minimum: 7 });
  assert.equal(buyerPaysWithFees(7, cny), 21);
  assert.equal(buyerPaysWithFees(15, cny), 29);
  assert.equal(receiveForBuyerPays(21, cny), 7);
  assert.equal(receiveForBuyerPays(29, cny), 15);
  assert.deepEqual(feeBreakdown(15, cny), {
    receive: 15,
    steamFee: 7,
    publisherFee: 7,
    totalFees: 14,
    buyerPays: 29,
  });
});

test('zero, one percent and explicit units are unambiguous', () => {
  assert.equal(normalizeFeePercent(0, 0.05), 0);
  assert.equal(normalizeFeePercent(1, 0.05), 0.01);
  assert.equal(normalizeFeePercent(0.01, 0.05), 0.01);
  assert.equal(normalizeFeePercent(1, 0, 'fraction'), 1);
  assert.equal(normalizeFeePercent(0.5, 0, 'percent'), 0.005);
  const w = wallet({ wallet_fee_percent: 1, wallet_publisher_fee_percent_default: 0 });
  assert.equal(buyerPaysWithFees(10000, w), 10100);
});

test('decimal fees round down exactly and use normalized receive amounts', () => {
  const w = wallet({ wallet_fee_percent: 29, wallet_publisher_fee_percent_default: 0 });
  assert.equal(feeBreakdown(100, w).steamFee, 29);
  assert.equal(feeBreakdown(200, w).steamFee, 58);
  const stepped = wallet({ wallet_currency_increment: 5 });
  assert.deepEqual(feeBreakdown(198, stepped), feeBreakdown(200, stepped));
});

test('bounded exhaustive inverse returns the greatest affordable receive', () => {
  for (const w of [wallet(), wallet({ wallet_market_minimum: 7 }), wallet({ wallet_currency_increment: 5 })]) {
    for (let target = 1; target <= 300; target++) {
      const receive = receiveForBuyerPays(target, w);
      let expected = null;
      for (let n = 1; n <= target; n++) {
        const base = toValidMarketPrice(n, w);
        if (buyerPaysWithFees(base, w) <= target) expected = Math.max(expected || 0, base);
      }
      assert.equal(receive, expected);
    }
  }
});
