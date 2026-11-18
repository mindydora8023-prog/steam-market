const FALLBACK = {
  code: 'CUR',
  symbol: '',
  decimals: 2,
  group: ',',
  decimal: '.',
  symbolBefore: true,
};

export const CURRENCIES = {
  1: { code: 'USD', symbol: '$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  2: { code: 'GBP', symbol: '\u00a3', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  3: { code: 'EUR', symbol: '\u20ac', decimals: 2, group: '.', decimal: ',', symbolBefore: false },
  4: { code: 'CHF', symbol: 'CHF', decimals: 2, group: "'", decimal: '.', symbolBefore: true },
  5: { code: 'RUB', symbol: '\u20bd', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  6: { code: 'PLN', symbol: 'z\u0142', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  7: { code: 'BRL', symbol: 'R$', decimals: 2, group: '.', decimal: ',', symbolBefore: true },
  8: { code: 'JPY', symbol: '\u00a5', decimals: 0, group: ',', decimal: '.', symbolBefore: true },
  9: { code: 'NOK', symbol: 'kr', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  10: { code: 'IDR', symbol: 'Rp', decimals: 0, group: '.', decimal: ',', symbolBefore: true },
  11: { code: 'MYR', symbol: 'RM', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  12: { code: 'PHP', symbol: '\u20b1', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  13: { code: 'SGD', symbol: 'S$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  14: { code: 'THB', symbol: '\u0e3f', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  15: { code: 'VND', symbol: '\u20ab', decimals: 0, group: '.', decimal: ',', symbolBefore: false },
  16: { code: 'KRW', symbol: '\u20a9', decimals: 0, group: ',', decimal: '.', symbolBefore: true },
  17: { code: 'TRY', symbol: 'TL', decimals: 2, group: '.', decimal: ',', symbolBefore: false },
  18: { code: 'UAH', symbol: '\u20b4', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  19: { code: 'MXN', symbol: 'MX$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  20: { code: 'CAD', symbol: 'CDN$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  21: { code: 'AUD', symbol: 'A$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  22: { code: 'NZD', symbol: 'NZ$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  23: { code: 'CNY', symbol: '\u00a5', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  24: { code: 'INR', symbol: '\u20b9', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  25: { code: 'CLP', symbol: 'CLP$', decimals: 0, group: '.', decimal: ',', symbolBefore: true },
  26: { code: 'PEN', symbol: 'S/.', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  27: { code: 'COP', symbol: 'COL$', decimals: 0, group: '.', decimal: ',', symbolBefore: true },
  28: { code: 'ZAR', symbol: 'R', decimals: 2, group: ' ', decimal: ',', symbolBefore: true },
  29: { code: 'HKD', symbol: 'HK$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  30: { code: 'TWD', symbol: 'NT$', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  31: { code: 'SAR', symbol: 'SR', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  32: { code: 'AED', symbol: 'AED', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  33: { code: 'SEK', symbol: 'kr', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  34: { code: 'ARS', symbol: 'ARS$', decimals: 2, group: '.', decimal: ',', symbolBefore: true },
  35: { code: 'ILS', symbol: '\u20aa', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  36: { code: 'BYN', symbol: 'Br', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  37: { code: 'KZT', symbol: '\u20b8', decimals: 2, group: ' ', decimal: ',', symbolBefore: false },
  38: { code: 'KWD', symbol: 'KD', decimals: 3, group: ',', decimal: '.', symbolBefore: true },
  39: { code: 'QAR', symbol: 'QR', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
  40: { code: 'CRC', symbol: '\u20a1', decimals: 2, group: ',', decimal: '.', symbolBefore: true },
};

export function currencyInfo(currencyId) {
  const id = Number(currencyId);
  return CURRENCIES[id] || FALLBACK;
}

function stripToNumber(text) {
  const normalized = String(text)
    .replace(/[\u00a0\u2007\u2009\u202f]/g, ' ')
    .replace(/[^0-9.,' ]+/g, '');
  const compact = normalized
    .replace(/[ ']/g, '')
    .replace(/^[.,]+/, '')
    .replace(/[.,]+$/, '');
  return compact;
}

function inferSeparators(compact, info) {
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  let decimal = info.decimal;
  let group = info.group;
  let known = Boolean(CURRENCIES[Number(info.id)]);

  if (!known) {
    if (lastDot !== -1 && lastComma !== -1) {
      decimal = lastDot > lastComma ? '.' : ',';
      group = decimal === '.' ? ',' : '.';
    } else if (lastDot !== -1 || lastComma !== -1) {
      const ch = lastDot !== -1 ? '.' : ',';
      const parts = compact.split(ch);
      const after = parts[parts.length - 1];
      const occurrences = parts.length - 1;
      if (occurrences > 1 || (after.length === 3 && parts[0] !== '0')) {
        decimal = '';
        group = ch;
      } else {
        decimal = ch;
        group = ch === '.' ? ',' : '.';
      }
    } else {
      decimal = '';
      group = ',';
    }
  }

  return { decimal, group };
}

export function parsePriceToMinor(text, currencyId) {
  if (typeof text !== 'string') return null;
  if (text.trim() === '') return null;

  const info = { ...FALLBACK, ...currencyInfo(currencyId), id: currencyId };
  let compact = stripToNumber(text);
  if (compact === '' || !/[0-9]/.test(compact)) return null;

  const { decimal, group } = inferSeparators(compact, info);

  if (group) compact = compact.split(group).join('');

  if (decimal) {
    const parts = compact.split(decimal);
    if (parts.length > 2) return null;
    if (parts.length === 2) {
      let [whole, frac] = parts;
      if (frac.length > info.decimals) {
        if (frac.length === 3 && info.decimals < 3) {
          // Steam's own parser treats a single 3-digit trailing group as
          // thousands, never as a sub-cent amount ("1.147" means 1147).
          whole += frac;
          frac = '';
        } else {
          return null;
        }
      }
      const padded = (frac + '0'.repeat(info.decimals)).slice(0, info.decimals);
      const wholeNumber = whole === '' ? 0 : Number(whole);
      if (!Number.isSafeInteger(wholeNumber)) return null;
      return wholeNumber * 10 ** info.decimals + (info.decimals === 0 ? 0 : Number(padded || 0));
    }
  }

  if (!/^[0-9]+$/.test(compact)) return null;
  const n = Number(compact);
  if (!Number.isSafeInteger(n)) return null;
  return n * 10 ** info.decimals;
}

export function formatMinor(minor, currencyId) {
  const info = currencyInfo(currencyId);
  const n = Math.max(0, Math.trunc(Number(minor) || 0));
  const scale = 10 ** info.decimals;
  const whole = Math.floor(n / scale);
  const frac = info.decimals ? String(n % scale).padStart(info.decimals, '0') : '';
  const wholeText = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, info.group || ',');
  const number = info.decimals ? `${wholeText}${info.decimal}${frac}` : wholeText;
  if (!info.symbol) return number;
  return info.symbolBefore ? `${info.symbol}${number}` : `${number} ${info.symbol}`;
}

export function currencyCode(currencyId) {
  return currencyInfo(currencyId).code;
}
