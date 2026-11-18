import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWallet } from '../lib/fees.js';
import { buildQuote } from '../lib/quote.js';

const wallet = normalizeWallet({
  wallet_currency: 23,
  wallet_fee_percent: 5,
  wallet_publisher_fee_percent_default: 10,
  wallet_market_minimum: 1,
  wallet_currency_increment: 1,
});

const cnyWallet = normalizeWallet({
  wallet_currency: 23,
  wallet_fee_percent: 5,
  wallet_publisher_fee_percent_default: 10,
  wallet_market_minimum: 7,
  wallet_currency_increment: 1,
});

function quote(lowest, median, overrides = {}) {
  return buildQuote({
    lowest,
    median,
    volume: 100,
    wallet,
    strategy: 'smart',
    undercut: 1,
    currency: 23,
    ...overrides,
  });
}

test('undercuts the lowest buyer price by one unit', () => {
  const result = quote(361, 356);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 360);
  assert.equal(result.recommendation.receive, 314);
  assert.equal(result.recommendation.fees, 46);
  assert.equal(result.recommendation.deltaVsLowest, -1);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.deepEqual(result.recommendation.warnings, []);
});

test('falls back to the median when the lowest ask is an outlier', () => {
  const result = quote(100, 500);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.strategyUsed, 'median-guard');
  assert.equal(result.recommendation.buyerPays, 499);
  assert.ok(result.recommendation.warnings.includes('lowest-far-below-median'));
  assert.ok(result.recommendation.warnings.includes('median-guard'));
  assert.ok(result.recommendation.warnings.includes('above-lowest'));
  assert.equal(result.recommendation.outlier, true);
});

test('warns about a high ask without forcing seller proceeds down', () => {
  const result = quote(30, 21);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.equal(result.recommendation.buyerPays, 29);
  assert.equal(result.recommendation.deltaVsLowest, -1);
  assert.ok(result.recommendation.warnings.includes('lowest-above-median'));
  assert.ok(!result.recommendation.warnings.includes('median-guard'));
  assert.equal(result.recommendation.outlier, true);
});

test('still undercuts when the lowest ask is close to the median', () => {
  const result = quote(30, 28);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.equal(result.recommendation.buyerPays, 29);
  assert.equal(result.recommendation.outlier, false);
});

test('plain undercut mode ignores an outlier median', () => {
  const result = quote(100, 500, { strategy: 'undercut' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 99);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.equal(result.recommendation.outlier, false);
});

test('median strategy can price above the lowest ask', () => {
  const result = quote(5000, 4000, { strategy: 'median' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 3999);
  assert.equal(result.recommendation.strategyUsed, 'median');
  assert.equal(result.recommendation.deltaVsLowest, -1001);
});

test('match strategy stays at the lowest price', () => {
  const result = quote(361, 356, { strategy: 'match' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 361);
  assert.equal(result.recommendation.strategyUsed, 'match');
  assert.equal(result.recommendation.deltaVsLowest, 0);
});

test('uses the median when there are no active listings', () => {
  const result = quote(null, 500);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 499);
  assert.ok(result.recommendation.warnings.includes('no-active-listings'));
  assert.equal(result.recommendation.deltaVsLowest, null);
});

test('reports no data when both prices are missing', () => {
  const result = quote(null, null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-price-data');
});

test('reports a fee floor for very cheap items', () => {
  const result = quote(2, 2);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'below-fee-floor');
  assert.equal(result.minBuyer, 3);
});

test('matches the fee floor when the lowest is exactly listable', () => {
  const result = quote(3, 3);
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.buyerPays, 3);
  assert.equal(result.recommendation.receive, 1);
  assert.ok(result.recommendation.warnings.includes('fee-floor'));
  assert.ok(result.recommendation.warnings.includes('match-only'));
});

test('warns when volume is thin', () => {
  const result = quote(361, 356, { volume: 5 });
  assert.ok(result.recommendation.warnings.includes('thin-volume'));
});

test('warns when fee rounding undercuts by more than requested', () => {
  const result = quote(115, 115);
  assert.equal(result.ok, true);
  assert.ok(result.recommendation.target - result.recommendation.buyerPays >= 2);
  assert.ok(result.recommendation.warnings.includes('fee-step'));
});

test('returns alternatives only when they are listable', () => {
  const result = quote(361, 356);
  assert.equal(result.alternatives.matchLowest.buyerPays, 361);
  assert.equal(result.alternatives.median.buyerPays, 356);
  assert.equal(result.alternatives.minFeasible.buyerPays, 3);
});

test('uses the CNY minimum fee for cheap cards', () => {
  const result = buildQuote({
    lowest: 30,
    median: 28,
    volume: 10,
    wallet: cnyWallet,
    strategy: 'smart',
    undercut: 1,
    currency: 23,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.equal(result.recommendation.buyerPays, 29);
  assert.equal(result.recommendation.receive, 15);
  assert.equal(result.recommendation.fees, 14);
  assert.equal(result.recommendation.steamFee, 7);
  assert.equal(result.recommendation.publisherFee, 7);
  assert.equal(result.alternatives.minFeasible.buyerPays, 21);
  assert.ok(result.recommendation.warnings.includes('high-fee-share'));
});

test('CNY smart warns without capping the ask at the median', () => {
  const result = buildQuote({
    lowest: 30,
    median: 21,
    volume: 10,
    wallet: cnyWallet,
    strategy: 'smart',
    undercut: 1,
    currency: 23,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.strategyUsed, 'undercut');
  assert.equal(result.recommendation.buyerPays, 29);
  assert.equal(result.recommendation.receive, 15);
  assert.ok(result.recommendation.warnings.includes('lowest-above-median'));
  assert.ok(result.recommendation.warnings.includes('high-fee-share'));
});

test('alternatives expose actual fee-step prices rather than unreachable targets', () => {
  const result = quote(114, 114, { strategy: 'match' });
  assert.deepEqual(result.alternatives.matchLowest, {
    buyerPays: 112, receive: 99, target: 114, exact: false,
  });
  assert.equal(result.alternatives.median.buyerPays, 112);
  assert.ok(result.recommendation.warnings.includes('fee-step'));
});

test('explicit strategies survive high and low market discrepancies', () => {
  for (const [low, med] of [[100, 500], [500, 100]]) {
    assert.equal(quote(low, med, { strategy: 'match' }).recommendation.target, low);
    assert.equal(quote(low, med, { strategy: 'median' }).recommendation.target, med);
    assert.equal(quote(low, med, { strategy: 'undercut' }).recommendation.target, low - 1);
  }
});
