import {
  buyerPaysWithFees,
  feeAmount,
  receiveForBuyerPays,
} from './fees.js';

export const QUOTE_STRATEGIES = ['smart', 'undercut', 'match', 'median'];

function asPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function unique(items) {
  return [...new Set(items)];
}

export function buildQuote({
  lowest = null,
  median = null,
  volume = 0,
  wallet,
  strategy = 'smart',
  undercut = 1,
  currency = 0,
} = {}) {
  const mode = QUOTE_STRATEGIES.includes(strategy) ? strategy : 'smart';
  const low = asPrice(lowest);
  const med = asPrice(median);
  const vol = Math.max(0, Math.trunc(Number(volume) || 0));
  const cut = Math.max(0, Math.trunc(Number(undercut) || 0));
  const floor = Math.max(1, wallet.marketMinimum);
  const minBuyer = buyerPaysWithFees(floor, wallet);
  const warnings = [];

  if (low === null && med === null) {
    return { ok: false, code: 'no-price-data', lowest: low, median: med, volume: vol };
  }

  let base = low !== null ? low : med;
  let target;
  let strategyUsed = 'undercut';

  if (mode === 'match') {
    target = base;
    strategyUsed = 'match';
  } else if (mode === 'median') {
    target = med !== null ? med : low;
    base = target;
    strategyUsed = 'median';
  } else if (
    mode === 'smart' &&
    low !== null &&
    med !== null &&
    low < med * 0.5
  ) {
    // Preserve the existing low-ask guard; a higher ask alone is no price cap.
    warnings.push('lowest-far-below-median', 'median-guard');
    target = med - cut;
    base = med;
    strategyUsed = 'median-guard';
  } else {
    target = base - cut;
    strategyUsed = 'undercut';
  }

  // This diagnostic threshold does not override an explicit pricing strategy.
  if (mode === 'smart' && low !== null && med !== null && low > med * 1.15) {
    warnings.push('lowest-above-median');
  }
  if (low === null) warnings.push('no-active-listings');
  if (vol > 0 && vol < 10) warnings.push('thin-volume');

  target = Math.max(1, Math.trunc(target));

  if (target < minBuyer) {
    target = minBuyer;
    warnings.push('fee-floor');
  }

  let receive = receiveForBuyerPays(target, wallet);
  if (receive === null) {
    if (low !== null && minBuyer >= low) {
      receive = floor;
      warnings.push('match-only');
    } else {
      return {
        ok: false,
        code: 'no-valid-price',
        lowest: low,
        median: med,
        volume: vol,
        minBuyer,
      };
    }
  }

  let buyerPays = buyerPaysWithFees(receive, wallet);
  const aboveLowestAllowed = strategyUsed === 'median-guard' || mode === 'median';
  if (low !== null && buyerPays > low && !aboveLowestAllowed) {
    return {
      ok: false,
      code: 'below-fee-floor',
      lowest: low,
      median: med,
      volume: vol,
      minBuyer,
    };
  }
  if (low !== null && buyerPays > low) warnings.push('above-lowest');
  if (low !== null && buyerPays === low && mode !== 'match') warnings.push('match-only');
  if (target !== buyerPays) warnings.push('fee-step');

  const steamFee = feeAmount(receive, wallet.steamFeePercent, wallet);
  const publisherFee = feeAmount(receive, wallet.publisherFeePercent, wallet);
  const fees = buyerPays - receive;
  if (buyerPays > 0 && fees / buyerPays >= 0.3) warnings.push('high-fee-share');
  const deltaVsLowest = low !== null ? buyerPays - low : null;

  const alternatives = {};
  for (const [name, requested] of [['matchLowest', low], ['median', med], ['minFeasible', minBuyer]]) {
    if (requested === null) continue;
    const net = receiveForBuyerPays(requested, wallet);
    if (net === null) continue;
    const actual = buyerPaysWithFees(net, wallet);
    alternatives[name] = {
      buyerPays: actual,
      receive: net,
      target: requested,
      exact: actual === requested,
    };
  }

  return {
    ok: true,
    currency,
    market: { lowest: low, median: med, volume: vol },
    recommendation: {
      buyerPays,
      receive,
      fees: buyerPays - receive,
      steamFee,
      publisherFee,
      target,
      strategyUsed,
      strategyRequested: mode,
      deltaVsLowest,
      warnings: unique(warnings),
      outlier:
        warnings.includes('lowest-far-below-median') ||
        warnings.includes('lowest-above-median'),
    },
    alternatives,
  };
}