import { CURRENCIES, currencyInfo } from './currency.js';
import { buyerPaysWithFees, feeBreakdown, marketMinimumFor, normalizeWallet, receiveForBuyerPays } from './fees.js';
import { buildQuote, QUOTE_STRATEGIES } from './quote.js';

export const MAX_BATCH_ROWS = 1000;
export const MAX_BATCH_QUANTITY = 10000;
const MAX_PRICE = 1000000000;
const MONEY_FIELDS = ['buyerPays', 'receive', 'totalFees', 'steamFee', 'publisherFee'];

function integerIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function feeRate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 30;
}

function cleanRow(row) {
  if (!row || !integerIn(row.appId, 1, 1000000) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 ||
      !integerIn(row.currency, 1, 100) || !Object.hasOwn(CURRENCIES, row.currency) ||
      !integerIn(row.quantity, 1, MAX_BATCH_QUANTITY) || !integerIn(row.undercut, 0, 1000) ||
      !feeRate(row.steamFee) || !feeRate(row.publisherFee)) return null;
  const { appId, name, currency, quantity, undercut, steamFee, publisherFee } = row;
  const lowest = integerIn(row.lowest, 1, MAX_PRICE) ? row.lowest : null;
  const median = integerIn(row.median, 1, MAX_PRICE) ? row.median : null;
  const priceOverride = integerIn(row.priceOverride, 1, MAX_PRICE) ? row.priceOverride : null;
  const snapshot = { appId, name, currency, quantity, undercut, steamFee, publisherFee, lowest, median, priceOverride };
  if (lowest !== null || median !== null) return snapshot;
  return row.unpriced === true && row.lowest === null && row.median === null
    ? { ...snapshot, unpriced: true } : null;
}

export function batchKey(row) {
  return JSON.stringify([row.appId, row.name, row.currency]);
}

export function cleanBatch(value) {
  const strategy = QUOTE_STRATEGIES.includes(value?.strategy) ? value.strategy : 'smart';
  const rows = new Map();
  if (Array.isArray(value?.rows)) {
    for (const raw of value.rows) {
      const row = cleanRow(raw);
      if (!row) continue;
      const key = batchKey(row);
      if (!rows.has(key)) rows.set(key, row);
      if (rows.size === MAX_BATCH_ROWS) break;
    }
  }
  return { strategy, rows: [...rows.values()] };
}

export function addBatchRow(rows, snapshot) {
  const row = cleanRow(snapshot);
  if (!row) return { ok: false, code: 'invalid' };
  const index = rows.findIndex((entry) => batchKey(entry) === batchKey(row));
  if (index < 0) {
    return rows.length < MAX_BATCH_ROWS
      ? { ok: true, rows: [...rows, row] }
      : { ok: false, code: 'row-limit' };
  }
  const previous = rows[index];
  const quantity = previous.quantity + row.quantity;
  if (quantity > MAX_BATCH_QUANTITY) return { ok: false, code: 'quantity-limit' };
  const next = rows.slice();
  const market = row.unpriced && !previous.unpriced ? previous : row;
  next[index] = { ...market, quantity, priceOverride: previous.priceOverride };
  return { ok: true, rows: next };
}

export function addBatchRows(rows, snapshots) {
  let next = rows;
  for (const snapshot of snapshots) {
    const result = addBatchRow(next, snapshot);
    if (!result.ok) return result;
    next = result.rows;
  }
  return { ok: true, rows: next };
}

export function fillBatchPrices(rows, snapshots) {
  const prices = new Map();
  for (const snapshot of snapshots) {
    const row = cleanRow(snapshot);
    if (row && !row.unpriced) prices.set(batchKey(row), row);
  }
  let updated = 0;
  const next = rows.map((row) => {
    if (!row.unpriced) return row;
    const price = prices.get(batchKey(row));
    if (!price) return row;
    updated++;
    return cleanRow({ ...row, lowest: price.lowest, median: price.median });
  });
  return { rows: next, updated };
}

export function parseBatchPrice(text, currency) {
  if (typeof text !== 'string') return NaN;
  const raw = text.trim();
  if (!raw) return null;
  const decimals = currencyInfo(currency).decimals;
  const match = /^(\d*)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[2]?.length ?? 0) > decimals) return NaN;
  const minor = Number(match[1]) * 10 ** decimals + Number((match[2] || '').padEnd(decimals, '0'));
  return integerIn(minor, 1, MAX_PRICE) ? minor : NaN;
}

export function batchAmount(minor, currency) {
  const { decimals } = currencyInfo(currency);
  const digits = String(minor).padStart(decimals + 1, '0');
  return decimals ? digits.slice(0, -decimals) + '.' + digits.slice(-decimals) : digits;
}

function estimateRow(row, strategy) {
  const wallet = normalizeWallet({
    wallet_currency: row.currency,
    wallet_market_minimum: marketMinimumFor(row.currency),
    wallet_fee_percent: row.steamFee / 100,
    wallet_publisher_fee_percent_default: row.publisherFee / 100,
  });
  if (row.priceOverride !== null) {
    const receive = receiveForBuyerPays(row.priceOverride, wallet);
    if (receive === null) {
      return {
        strategy: 'custom', price: null,
        minimum: buyerPaysWithFees(wallet.marketMinimum, wallet),
      };
    }
    return { strategy: 'custom', price: feeBreakdown(receive, wallet) };
  }
  const quote = buildQuote({ ...row, wallet, strategy });
  if (!quote.ok) return { strategy, price: null };
  return { strategy, price: feeBreakdown(quote.recommendation.receive, wallet) };
}

export function estimateBatch(value) {
  const { strategy, rows } = cleanBatch(value);
  const groups = new Map();
  let quantity = 0;
  let unpricedQuantity = 0;
  const lines = rows.map((row) => {
    const estimate = estimateRow(row, strategy);
    let group = groups.get(row.currency);
    if (!group) {
      group = { currency: row.currency, quantity: 0, pricedQuantity: 0 };
      for (const field of MONEY_FIELDS) group[field] = 0n;
      groups.set(row.currency, group);
    }
    quantity += row.quantity;
    group.quantity += row.quantity;
    const subtotal = {};
    if (estimate.price) {
      group.pricedQuantity += row.quantity;
      // A line fits in a safe integer, while a large currency group can exceed it.
      for (const field of MONEY_FIELDS) {
        subtotal[field] = estimate.price[field] * row.quantity;
        group[field] += BigInt(subtotal[field]);
      }
    } else {
      unpricedQuantity += row.quantity;
    }
    return { ...row, ...estimate, subtotal: estimate.price ? subtotal : null };
  });
  for (const group of groups.values()) {
    for (const field of MONEY_FIELDS) {
      if (group[field] <= Number.MAX_SAFE_INTEGER) group[field] = Number(group[field]);
    }
  }
  return { lines, groups: [...groups.values()], quantity, unpricedQuantity };
}

const HEADERS = [
  'Item', 'App ID', 'Currency', 'Quantity', 'Listing price', 'Net per item',
  'Net subtotal', 'Steam fee subtotal', 'Publisher fee subtotal', 'Total fees', 'Strategy',
];

function exportRows(report) {
  if (report.unpricedQuantity) throw new RangeError('All rows must have a valid listing price.');
  return report.lines.map(({ name, appId, currency, quantity, price, subtotal, strategy }) => [
    name, appId, currencyInfo(currency).code, quantity,
    ...[price.buyerPays, price.receive, subtotal.receive, subtotal.steamFee, subtotal.publisherFee, subtotal.totalFees]
      .map((minor) => batchAmount(minor, currency)),
    strategy,
  ]);
}

function csvCell(value) {
  let text = String(value);
  // Quoting alone does not prevent spreadsheet formula evaluation.
  if (/^[\t\r\n]|^\s*[=+@\-\uff1d\uff0b\uff0d\uff20]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function batchCsv(report) {
  return [HEADERS, ...exportRows(report)].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function markdownCell(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|&<>()[\]!*_\x60~]/g, (char) => '&#' + char.charCodeAt(0) + ';');
}

function markdownTable(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows]
    .map((row) => '| ' + row.map(markdownCell).join(' | ') + ' |').join('\n');
}

export function batchMarkdown(report) {
  const lines = markdownTable(HEADERS, exportRows(report));
  const totals = markdownTable(
    ['Currency', 'Quantity', 'Buyer pays', 'Steam fees', 'Publisher fees', 'Total fees', 'Estimated net'],
    report.groups.map((group) => [
      currencyInfo(group.currency).code, group.quantity,
      ...['buyerPays', 'steamFee', 'publisherFee', 'totalFees', 'receive'].map((field) => batchAmount(group[field], group.currency)),
    ]),
  );
  return '# Steam Market batch listing\n\nTotal items: ' + report.quantity + '\n\n' + totals + '\n\n' + lines + '\n';
}
