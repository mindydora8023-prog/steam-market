import { toInt } from './util.js';

export const DEFAULT_STEAM_FEE = 0.05;
export const DEFAULT_PUBLISHER_FEE = 0.1;

// Steam's minimum fee is currency-specific; low-priced items are dominated by it.
// CNY: minimum buyer price 0.21 (0.07 base + 0.07 Steam + 0.07 publisher).
// JPY: 2 yen per fee in the observed market listing.
const MARKET_MINIMUM_MINOR = {
  8: 2,
  23: 7,
};

export function marketMinimumFor(currency) {
  return MARKET_MINIMUM_MINOR[Number(currency)] || 1;
}

// Auto accepts fractional rates below 1 and percentage points at or above 1.
// Use an explicit unit when a fractional rate of 1 (100%) is intended.
export function normalizeFeePercent(value, fallback, unit = 'auto') {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return unit === 'fraction' ? n : unit === 'percent' || n >= 1 ? n / 100 : n;
}

export function normalizeWallet(raw, overrides = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const currency = toInt(source.wallet_currency, 0);
  const marketMinimum = Math.max(1, toInt(source.wallet_market_minimum, 1));
  const currencyIncrement = Math.max(1, toInt(source.wallet_currency_increment, 1));
  const steamFeePercent = normalizeFeePercent(
    overrides.steamFeePercent !== undefined ? overrides.steamFeePercent : source.wallet_fee_percent,
    DEFAULT_STEAM_FEE,
  );
  const publisherFeePercent = normalizeFeePercent(
    overrides.publisherFeePercent !== undefined
      ? overrides.publisherFeePercent
      : source.wallet_publisher_fee_percent_default,
    DEFAULT_PUBLISHER_FEE,
  );

  return {
    currency,
    country: source.wallet_country || '',
    state: source.wallet_state || '',
    balance: Math.max(0, toInt(source.wallet_balance, 0)),
    delayedBalance: Math.max(0, toInt(source.wallet_delayed_balance, 0)),
    marketMinimum,
    currencyIncrement,
    steamFeePercent,
    publisherFeePercent,
  };
}

export function toValidMarketPrice(price, wallet) {
  const floor = Math.max(1, toInt(wallet && wallet.marketMinimum, 1));
  const increment = Math.max(1, toInt(wallet && wallet.currencyIncrement, 1));
  const n = Math.trunc(Number(price) || 0);

  if (n <= floor) return floor;
  if (n <= increment) return increment;
  if (increment > 1) return Math.round(n / increment) * increment;
  return n;
}

export function feeAmount(baseAmount, percent, wallet) {
  if (!(percent > 0)) return 0;
  // Decimal integer arithmetic avoids floor(100 * 0.29) becoming 28.
  const [mantissa, exponent = '0'] = String(percent).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const power = Number(exponent) - fraction.length;
  const base = BigInt(Math.max(0, Math.trunc(Number(baseAmount) || 0)));
  const fee = Number(power >= 0
    ? base * digits * (10n ** BigInt(power))
    : base * digits / (10n ** BigInt(-power)));
  return toValidMarketPrice(fee, wallet);
}

export function buyerPaysWithFees(receiveAmount, wallet) {
  const base = toValidMarketPrice(receiveAmount, wallet);
  const publisherFee = feeAmount(base, wallet.publisherFeePercent, wallet);
  const steamFee = feeAmount(base, wallet.steamFeePercent, wallet);
  return base + publisherFee + steamFee;
}

export function receiveForBuyerPays(targetBuyerPays, wallet) {
  const target = Math.trunc(Number(targetBuyerPays) || 0);
  const floor = Math.max(1, toInt(wallet.marketMinimum, 1));
  const increment = Math.max(1, toInt(wallet.currencyIncrement, 1));
  if (target < floor) return null;
  if (buyerPaysWithFees(floor, wallet) > target) return null;

  let lo = floor;
  let hi = target;
  let best = null;
  let guard = 0;

  while (lo <= hi && guard++ < 64) {
    const mid = Math.floor((lo + hi) / 2);
    const base = toValidMarketPrice(mid, wallet);
    if (buyerPaysWithFees(base, wallet) <= target) {
      best = base;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === null) best = toValidMarketPrice(floor, wallet);

  guard = 0;
  while (guard++ < 10000) {
    const next = toValidMarketPrice(best + increment, wallet);
    if (next <= best) break;
    if (buyerPaysWithFees(next, wallet) > target) break;
    best = next;
  }

  guard = 0;
  while (buyerPaysWithFees(best, wallet) > target && guard++ < 10000) {
    if (best <= floor) return null;
    const previous = best - increment;
    best = previous < floor ? floor : toValidMarketPrice(previous, wallet);
    if (best === floor && buyerPaysWithFees(best, wallet) > target) return null;
  }

  if (buyerPaysWithFees(best, wallet) > target) return null;
  return best;
}

export function feeBreakdown(receiveAmount, wallet) {
  const base = toValidMarketPrice(receiveAmount, wallet);
  const publisherFee = feeAmount(base, wallet.publisherFeePercent, wallet);
  const steamFee = feeAmount(base, wallet.steamFeePercent, wallet);
  return {
    receive: base,
    publisherFee,
    steamFee,
    totalFees: publisherFee + steamFee,
    buyerPays: base + publisherFee + steamFee,
  };
}