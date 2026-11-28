import {
  parseMarketInput,
  priceNumber,
  cleanEntries,
  nearestPoint,
  fetchJson,
  queryParams,
  decimalPlaces,
  quoteByBuyerPays,
  quoteByReceive,
  parseMajorToMinor,
  movingAverage,
  marketMinimumFor,
} from './ui-utils.js';
import { createBatch } from './batch-ui.js';

const $ = (id) => document.getElementById(id);

const STORAGE = {
  settings: 'steam-price-settings-v1',
  history: 'steam-price-history-v1',
  favorites: 'steam-price-favorites-v1',
};

const DEFAULTS = {
  appId: 730,
  currency: 23,
  strategy: 'smart',
  undercut: 1,
  steamFee: 5,
  publisherFee: 10,
  quantity: 1,
  historyDays: 180,
};

const ERROR_KEYS = {
  'not-found': 'errorNotFound',
  'needs-selection': 'errorNeedsSelection',
  'rate-limited': 'errorRateLimited',
  upstream: 'errorUpstream',
  blocked: 'errorUpstream',
  timeout: 'errorUpstream',
  'no-price-data': 'errorNoPrice',
  'below-fee-floor': 'errorBelowFee',
  'no-valid-price': 'errorNoValid',
  'bad-request': 'errorBadRequest',
};

const WARNING_KEYS = {
  'lowest-far-below-median': 'warningLowestFar',
  'lowest-above-median': 'warningLowestAbove',
  'no-active-listings': 'warningNoListings',
  'thin-volume': 'warningThin',
  'fee-step': 'warningFeeStep',
  'fee-floor': 'warningFeeFloor',
  'high-fee-share': 'warningHighFeeShare',
  'match-only': 'warningMatchOnly',
  'above-lowest': 'warningAboveLowest',
  'median-guard': 'warningMedianGuard',
};

const state = {
  locale: {},
  appId: DEFAULTS.appId,
  currency: DEFAULTS.currency,
  strategy: DEFAULTS.strategy,
  undercut: DEFAULTS.undercut,
  steamFee: DEFAULTS.steamFee,
  publisherFee: DEFAULTS.publisherFee,
  quote: null,
  suggestions: [],
  activeIndex: -1,
  searchTimer: null,
  searchAbort: null,
  quoteAbort: null,
  toastTimer: null,
  recalcTimer: null,
  history: null,
  historyDays: 180,
  historyAbort: null,
  historyLoading: false,
  quantity: 1,
  composing: false,
  quoteContext: null,
  historyKey: null,
  cooldownUntil: 0,
  lastCleared: null,
  showMa: true,
  showVolume: true,
  favFilter: 'all',
  customQuote: null,
};

let batch;

function t(key, vars = {}) {
  let text = state.locale[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.split('{' + name + '}').join(String(value));
  }
  return text;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fmtFee(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function firstChar(value) {
  const text = String(value || '').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

async function loadLocale() {
  try {
    state.locale = await fetchJson('./locale/zh.json', { timeoutMs: 8000 });
  } catch {
    state.locale = {};
  }
}

function optionHas(select, value) {
  return [...select.options].some((option) => option.value === String(value));
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE.settings) || '{}') || {};
  } catch {
    saved = {};
  }
  const settings = { ...DEFAULTS, ...saved };

  const appSelect = $('app-select');
  const currencySelect = $('currency-select');
  const strategySelect = $('strategy-select');
  const undercutSelect = $('undercut-select');

  state.appId = num(settings.appId, DEFAULTS.appId);
  if (!optionHas(appSelect, state.appId)) state.appId = DEFAULTS.appId;
  appSelect.value = String(state.appId);

  state.currency = num(settings.currency, DEFAULTS.currency);
  if (!optionHas(currencySelect, state.currency)) state.currency = DEFAULTS.currency;
  currencySelect.value = String(state.currency);

  state.strategy = String(settings.strategy || DEFAULTS.strategy);
  if (!optionHas(strategySelect, state.strategy)) state.strategy = DEFAULTS.strategy;
  strategySelect.value = state.strategy;

  state.undercut = num(settings.undercut, DEFAULTS.undercut);
  if (!optionHas(undercutSelect, state.undercut)) state.undercut = DEFAULTS.undercut;
  undercutSelect.value = String(state.undercut);

  state.steamFee = clamp(num(settings.steamFee, DEFAULTS.steamFee), 0, 30);
  state.publisherFee = clamp(num(settings.publisherFee, DEFAULTS.publisherFee), 0, 30);
  $('steam-fee').value = String(state.steamFee);
  $('publisher-fee').value = String(state.publisherFee);
  state.quantity = clamp(Math.trunc(num(settings.quantity, 1)), 1, 10000);
  state.historyDays = [30, 90, 180, 365].includes(Number(settings.historyDays)) ? Number(settings.historyDays) : 180;
  state.showMa = settings.showMa !== false;
  state.showVolume = settings.showVolume !== false;
  $('quantity').value = state.quantity;
  if ($('toggle-ma')) $('toggle-ma').setAttribute('aria-pressed', String(state.showMa));
  if ($('toggle-vol')) $('toggle-vol').setAttribute('aria-pressed', String(state.showVolume));
  updateFeeSummary();
}

function saveSettings() {
  try {
    localStorage.setItem(
      STORAGE.settings,
      JSON.stringify({
        appId: state.appId,
        currency: state.currency,
        strategy: state.strategy,
        undercut: state.undercut,
        steamFee: state.steamFee,
        publisherFee: state.publisherFee,
        quantity: state.quantity,
        historyDays: state.historyDays,
        showMa: state.showMa,
        showVolume: state.showVolume,
      }),
    );
  } catch {
    // Storage can be unavailable in private mode; the app still works.
  }
}

function updateFeeSummary() {
  const text = state.locale.feeSummary
    ? t('feeSummary', { steam: fmtFee(state.steamFee), publisher: fmtFee(state.publisherFee) })
    : `${fmtFee(state.steamFee)}% + ${fmtFee(state.publisherFee)}%`;
  $('fee-summary').textContent = text;
}

function updateStrategyControls() {
  const field = $('undercut-field');
  if (!field) return;
  field.hidden = $('strategy-select').value === 'match';
}

function setBusy(busy) {
  const button = $('calculate');
  button.disabled = busy || state.cooldownUntil > Date.now();
  button.querySelector('.btn-label').textContent = busy ? t('calculating') : t('calculate');
  button.querySelector('.spinner').hidden = !busy;
  $('quote-form').setAttribute('aria-busy', busy ? 'true' : 'false');
  $('query-status').hidden = !busy;
  $('refresh-quote').disabled = busy || state.cooldownUntil > Date.now();
  $('batch-add-quote').disabled = !quoteIsCurrent();
  $('query-status-text').textContent = t('loadingQuote');
  for (const id of ['copy-price', 'copy-receive', 'share-quote', 'favorite-quote', 'copy-custom-buyer', 'copy-custom-receive']) {
    if ($(id)) $(id).setAttribute('aria-disabled', String(!quoteIsCurrent()));
  }
}

function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2000);
}

function hideSuggestions() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  if (state.searchAbort) {
    state.searchAbort.abort();
    state.searchAbort = null;
  }
  const box = $('suggestions');
  box.hidden = true;
  box.replaceChildren();
  $('item-name').setAttribute('aria-expanded', 'false');
  $('item-name').removeAttribute('aria-activedescendant');
  state.suggestions = [];
  state.activeIndex = -1;
}

function showSuggestionPlaceholder(text) {
  const box = $('suggestions');
  box.replaceChildren();
  state.suggestions = [];
  state.activeIndex = -1;
  const empty = document.createElement('div');
  empty.className = 'suggestion-empty';
  empty.textContent = text;
  box.appendChild(empty);
  box.hidden = false;
  $('item-name').setAttribute('aria-expanded', 'true');
}

function suggestionButton(result, onSelect) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'suggestion';
  button.setAttribute('role', 'option');

  const icon = document.createElement('span');
  icon.className = 'suggestion-icon';
  icon.textContent = firstChar(result.name || result.hashName);

  if (result.iconUrl) {
    const image = document.createElement('img');
    image.src = result.iconUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.hidden = true;
    icon.hidden = false;
    image.addEventListener('error', () => {
      image.hidden = true;
      icon.hidden = false;
    });
    image.addEventListener('load', () => {
      image.hidden = false;
      icon.hidden = true;
    });
    button.appendChild(image);
  }
  button.appendChild(icon);

  const main = document.createElement('span');
  main.className = 'suggestion-main';
  const name = document.createElement('span');
  name.className = 'suggestion-name';
  name.textContent = result.name || result.hashName;
  const meta = document.createElement('span');
  meta.className = 'suggestion-meta';
  const parts = [result.appName, result.type].filter(Boolean);
  if (result.sellListings > 0) {
    parts.push(t('listingsCount', { count: Number(result.sellListings).toLocaleString('en-US') }));
  }
  meta.textContent = parts.join(' / ');
  main.appendChild(name);
  if (meta.textContent) main.appendChild(meta);
  button.appendChild(main);

  button.addEventListener('click', () => onSelect(result));
  return button;
}

function renderSuggestions(results, { main = true } = {}) {
  const box = main ? $('suggestions') : $('error-suggestions');
  box.replaceChildren();
  if (!results || results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'suggestion-empty';
    empty.textContent = t('noResults');
    box.appendChild(empty);
    box.hidden = false;
    if (main) {
      state.suggestions = [];
      state.activeIndex = -1;
      $('item-name').setAttribute('aria-expanded', 'true');
    }
    return;
  }

  if (main) {
    state.suggestions = results;
    state.activeIndex = -1;
  }

  for (const [index, result] of results.entries()) {
    const button = suggestionButton(result, selectSuggestion);
    button.id = (main ? 'suggestion-' : 'error-suggestion-') + index;
    button.tabIndex = main ? -1 : 0;
    button.setAttribute('aria-selected', 'false');
    box.appendChild(button);
  }
  box.hidden = false;
  if (main) $('item-name').setAttribute('aria-expanded', 'true');
}

function selectSuggestion(result) {
  $('item-name').value = result.hashName;
  hideSuggestions();
  calculate();
}

async function runSearch(query) {
  if (state.cooldownUntil > Date.now()) { showSuggestionPlaceholder(t('retryAfter', { seconds: Math.ceil((state.cooldownUntil - Date.now()) / 1000) })); return; }
  if (query.length < 2) {
    hideSuggestions();
    return;
  }
  if (state.searchAbort) state.searchAbort.abort();
  const controller = new AbortController();
  state.searchAbort = controller;
  const appId = state.appId;

  showSuggestionPlaceholder(t('searching'));
  try {
    const params = new URLSearchParams({
      appid: String(state.appId),
      q: query,
      limit: '8',
    });
    const data = await fetchJson(`./api/search?${params.toString()}`, { signal: controller.signal });
    if (controller.signal.aborted || state.searchAbort !== controller || state.appId !== appId) return;
    if ($('item-name').value.trim() !== query) return;
    if (data && data.ok) {
      renderSuggestions(data.results || []);
    } else {
      const code = data && data.error ? data.error.code : '';
      if (code === 'rate-limited') beginCooldown(Number(data.error.retryAfterMs) || 60000);
      showSuggestionPlaceholder(
        code === 'rate-limited' ? t('errorRateLimited') : t('errorGeneric'),
      );
    }
  } catch (err) {
    if (controller.signal.aborted || state.searchAbort !== controller || state.appId !== appId) return;
    if ($('item-name').value.trim() === query) {
      showSuggestionPlaceholder(t('errorUpstream'));
    }
  }
}

function hideError() {
  const box = $('error-box');
  box.hidden = true;
  $('error-suggestions').replaceChildren();
  $('error-suggestions').hidden = true;
}

function showError(message, suggestions = []) {
  hideSuggestions();
  if (state.historyAbort) {
    state.historyAbort.abort();
    state.historyAbort = null;
  }
  state.historyLoading = false;
  $('empty-state').hidden = true;
  $('result').hidden = !state.quote;
  if (state.quote) { $('result-stale').hidden = false; $('result-stale').textContent = t('staleFailed'); $('result').classList.add('stale'); }
  const box = $('error-box');
  $('error-title').textContent = t('errorTitle');
  $('error-text').textContent = message;
  const suggestionBox = $('error-suggestions');
  suggestionBox.replaceChildren();
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    renderSuggestions(suggestions, { main: false });
  } else {
    suggestionBox.hidden = true;
  }
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let cooldownTimer;
function beginCooldown(delay) {
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + delay);
  clearTimeout(cooldownTimer);
  const tick = () => {
    const remaining = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    $('cooldown-note').hidden = remaining <= 0;
    if (remaining > 0) {
      $('cooldown-note').textContent = t('retryAfter', { seconds: remaining });
      cooldownTimer = setTimeout(tick, 1000);
    }
    setBusy(Boolean(state.quoteAbort));
  };
  tick();
}

function showApiError(data) {
  const error = (data && data.error) || {};
  const code = error.code || (data && data.code) || 'generic';
  const key = ERROR_KEYS[code];
  let message = key ? t(key) : error.message || t('errorGeneric');
  if (code === 'rate-limited') {
    const delay = Math.max(1000, Number(error.retryAfterMs) || 60000);
    beginCooldown(delay);
    message = t('retryAfter', { seconds: Math.ceil(delay / 1000) });
  }
  showError(message, (data && data.suggestions) || []);
  const alternatives = (data?.compareStrategies || []).filter((entry) => entry.ok);
  if (alternatives.length) {
    const box = $('error-suggestions');
    box.hidden = false;
    const hint = document.createElement('p'); hint.textContent = t('strategyUnavailable'); box.appendChild(hint);
    for (const alternative of alternatives) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost';
      button.textContent = t('strategy' + alternative.strategy[0].toUpperCase() + alternative.strategy.slice(1)) + ' ' + alternative.recommendation.buyerPaysText + ' / ' + t('strategyReceive', { price: alternative.recommendation.receiveText });
      button.addEventListener('click', () => { state.strategy = alternative.strategy; $('strategy-select').value = alternative.strategy; updateStrategyControls(); saveSettings(); calculate(); });
      box.appendChild(button);
    }
  }
}

function priceSubText(quote) {
  const market = quote.market || {};
  const rec = quote.recommendation || {};
  const parts = [];
  if (market.lowest === null || market.lowest === undefined) {
    parts.push(t('noActiveListings'));
  } else {
    const delta = rec.deltaVsLowest;
    if (delta < 0) parts.push(t('undercutBy', { amount: rec.deltaText }));
    else if (delta === 0) parts.push(t('matchLowest'));
    else if (delta > 0) parts.push(t('aboveLowest', { amount: rec.deltaText }));
  }
  if (rec.deltaVsMedian !== null && rec.deltaVsMedian !== undefined) {
    if (rec.deltaVsMedian < 0) parts.push(t('vsMedianBelow', { amount: rec.deltaVsMedianText }));
    else if (rec.deltaVsMedian > 0) parts.push(t('vsMedianAbove', { amount: rec.deltaVsMedianText }));
    else parts.push(t('vsMedianEven'));
  }
  return parts.join(' \u00b7 ');
}

function itemIcon(quote) {
  const image = $('item-icon');
  const fallback = $('item-icon-fallback');
  const url = quote.item && quote.item.iconUrl;
  fallback.textContent = firstChar(quote.item && (quote.item.name || quote.item.hashName));
  image.onerror = () => {
    image.hidden = true;
    fallback.hidden = false;
  };
  image.onload = () => {
    image.hidden = false;
    fallback.hidden = true;
  };
  if (url) {
    image.hidden = true;
    fallback.hidden = false;
    image.src = url;
  } else {
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
  }
}

function renderQuote(quote, options = {}) {
  const rec = quote.recommendation || {};
  const market = quote.market || {};

  $('result').hidden = false;
  $('empty-state').hidden = true;
  hideError();

  $('item-name-result').textContent = quote.item.name || quote.item.hashName;
  const type = $('item-type');
  const app = $('item-app');
  type.textContent = quote.item.type || '';
  type.hidden = !quote.item.type;
  app.textContent = quote.item.appName || '';
  app.hidden = !quote.item.appName;
  itemIcon(quote);

  $('big-price').textContent = rec.buyerPaysText || '';
  $('price-sub').textContent = priceSubText(quote);
  $('receive-price').textContent = rec.receiveText || '-';
  $('fee-share').textContent = rec.buyerPays > 0 ? t('feeShare', { percent: (rec.fees / rec.buyerPays * 100).toFixed(1) }) : '';
  $('result-stale').hidden = true;
  $('result').classList.remove('stale');
  renderStrategyOptions(quote);
  renderQuantity();
  renderFavorites();

  $('stat-lowest').textContent = market.lowestText || '-';
  $('stat-median').textContent = market.medianText || '-';
  $('stat-volume').textContent = market.volumeText || '0';

  $('bd-buyer').textContent = rec.buyerPaysText || '-';
  $('bd-steam').textContent = rec.steamFeeText || '-';
  $('bd-publisher').textContent = rec.publisherFeeText || '-';
  $('bd-receive').textContent = rec.receiveText || '-';
  renderFeeBar(rec);
  syncCustomCalcFromQuote(quote);

  const warningBox = $('warnings');
  warningBox.replaceChildren();
  const warnings = [...new Set(rec.warnings || [])];
  const visibleWarnings = warnings.filter(
    (code) => !(code === 'median-guard' && (warnings.includes('lowest-far-below-median') || warnings.includes('lowest-above-median'))),
  );
  for (const code of visibleWarnings) {
    const key = WARNING_KEYS[code];
    if (!key) continue;
    const line = document.createElement('p');
    line.textContent = t(key);
    warningBox.appendChild(line);
  }
  warningBox.hidden = warningBox.childElementCount === 0;

  $('cache-badge').hidden = !quote.cached;
  const time = quote.fetchedAt ? new Date(quote.fetchedAt) : null;
  $('updated').textContent =
    time && !Number.isNaN(time.getTime())
      ? t('updated', { time: time.toLocaleTimeString('zh-CN', { hour12: false }) })
      : '';

  $('quote-provenance').textContent = t('quoteProvenance', { currency: quote.currencyCode, time: time && !Number.isNaN(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '-', source: t(quote.cached ? 'quoteCached' : 'quoteLive') });
  const link = $('market-link');
  link.href = quote.item.marketUrl;
  $('copy-price').dataset.price = rec.buyerPaysText || '';

  if (!options.skipHistory) loadPriceHistory(quote, Boolean(options.refresh));
  setBusy(Boolean(state.quoteAbort));

  const rect = $('result').getBoundingClientRect();
  if (rect.top > window.innerHeight * 0.65 || rect.bottom < 0) {
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function requestQuote({ appId, name, currency, strategy, undercut, steamFee, publisherFee }, { signal, refresh = false } = {}) {
  const params = new URLSearchParams({
    appid: String(appId), name, currency: String(currency), strategy,
    undercut: String(undercut), steamFee: String(steamFee), publisherFee: String(publisherFee),
    refresh: refresh ? '1' : '0',
  });
  return fetchJson(`./api/quote?${params.toString()}`, { signal, timeoutMs: 65000 });
}

async function calculate({ refresh = false } = {}) {
  if (state.cooldownUntil > Date.now()) {
    toast(t('retryAfter', { seconds: Math.ceil((state.cooldownUntil - Date.now()) / 1000) }));
    return;
  }
  if (state.recalcTimer) { clearTimeout(state.recalcTimer); state.recalcTimer = null; }
  const input = parseMarketInput($('item-name').value);
  if (input.appId) {
    ensureAppOption(input.appId);
    state.appId = input.appId;
    $('app-select').value = String(input.appId);
    $('item-name').value = input.name;
    saveSettings();
  }
  const name = $('item-name').value.trim();
  if (!name || name.length > 200) {
    $('name-error').textContent = t(name ? 'invalidNameLength' : 'invalidName');
    $('name-error').hidden = false;
    $('item-name').setAttribute('aria-invalid', 'true');
    $('item-name').setAttribute('aria-describedby', 'name-error');
    $('item-name').focus();
    return;
  }
  $('name-error').hidden = true;
  $('item-name').removeAttribute('aria-invalid');
  $('item-name').removeAttribute('aria-describedby');

  hideSuggestions();
  hideError();
  if (state.quoteAbort) state.quoteAbort.abort();
  if (state.historyAbort) { state.historyAbort.abort(); state.historyAbort = null; state.historyLoading = false; }
  if (state.quote) { $('result-stale').hidden = false; $('result-stale').textContent = t('staleUpdating'); $('result').classList.add('stale'); }
  const requestContext = contextKey();
  const controller = new AbortController();
  state.quoteAbort = controller;
  setBusy(true);

  try {
    const data = await requestQuote({ ...state, name }, { signal: controller.signal, refresh });
    if (controller.signal.aborted || state.quoteAbort !== controller || contextKey() !== requestContext) return;

    if (data && data.ok) {
      state.quote = data;
      state.quoteContext = requestContext;
      $('item-name').value = data.item.hashName;
      state.quoteContext = contextKey();
      updateQueryUrl();
      renderQuote(data, { refresh });
      remember(data);
    } else {
      showApiError(data);
    }
  } catch (err) {
    if (controller.signal.aborted || state.quoteAbort !== controller) return;
    showError(t(err.name === 'TimeoutError' ? 'requestTimeout' : 'errorUpstream'));
  } finally {
    if (state.quoteAbort === controller) {
      state.quoteAbort = null;
      setBusy(false);
    }
  }
}

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE.history) || '[]');
    return cleanEntries(value);
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  try {
    localStorage.setItem(STORAGE.history, JSON.stringify(cleanEntries(entries, 20)));
  } catch {
    // Ignore storage failures.
  }
}

const APP_SHORT_NAMES = {
  730: 'CS2',
  570: 'Dota 2',
  440: 'TF2',
  252490: 'Rust',
  753: 'Steam',
};

function appShortName(appId, fallback = '') {
  return APP_SHORT_NAMES[Number(appId)] || fallback || ('App ' + appId);
}

function currencySymbol(code) {
  try {
    const part = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: code || 'CNY' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part ? part.value : (code || '');
  } catch {
    return code || '';
  }
}

function formatQuoteMoney(minor, quote = state.quote) {
  if (!quote || !Number.isFinite(Number(minor))) return '-';
  const decimals = decimalPlaces(quote.currency);
  const code = quote.currencyCode || 'CNY';
  const value = Number(minor) / (10 ** decimals);
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return value.toFixed(decimals);
  }
}

function renderFeeBar(rec) {
  const total = Number(rec?.buyerPays) || 0;
  if (total <= 0) return;
  const rPct = clamp((Number(rec.receive) / total) * 100, 0, 100);
  const sPct = clamp((Number(rec.steamFee) / total) * 100, 0, 100);
  const pPct = clamp(100 - rPct - sPct, 0, 100);
  if ($('fee-seg-receive')) $('fee-seg-receive').style.width = rPct.toFixed(2) + '%';
  if ($('fee-seg-steam')) $('fee-seg-steam').style.width = sPct.toFixed(2) + '%';
  if ($('fee-seg-pub')) $('fee-seg-pub').style.width = pPct.toFixed(2) + '%';
  if ($('fee-pct-receive')) $('fee-pct-receive').textContent = rPct.toFixed(1) + '%';
  if ($('fee-pct-steam')) $('fee-pct-steam').textContent = sPct.toFixed(1) + '%';
  if ($('fee-pct-pub')) $('fee-pct-pub').textContent = pPct.toFixed(1) + '%';
}

function syncCustomCalcFromQuote(quote) {
  if (!quote || !$('custom-buyer')) return;
  const rec = quote.recommendation;
  const sym = currencySymbol(quote.currencyCode);
  $('custom-buyer-prefix').textContent = sym;
  $('custom-receive-prefix').textContent = sym;
  const minFloor = marketMinimumFor(quote.currency);
  const anchor = quote.market.lowest || quote.market.median || rec.buyerPays || 100;
  const minBuyer = Math.max(minFloor * 3, Math.floor(anchor * 0.6));
  const maxBuyer = Math.max(minBuyer + 20, Math.ceil(anchor * 1.4));
  const slider = $('custom-slider');
  slider.min = String(minBuyer);
  slider.max = String(maxBuyer);
  slider.step = '1';
  slider.value = String(clamp(rec.buyerPays || anchor, minBuyer, maxBuyer));
  $('custom-buyer').value = priceNumber(rec.buyerPays, quote.currency);
  $('custom-receive').value = priceNumber(rec.receive, quote.currency);
  state.customQuote = {
    ok: true,
    exact: true,
    buyerPays: rec.buyerPays,
    receive: rec.receive,
    steamFee: rec.steamFee,
    publisherFee: rec.publisherFee,
    totalFees: rec.fees,
  };
  renderCustomFeedback(state.customQuote, false);
}

function makeIconSvg(kind, filled = false) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  if (kind === 'pin') {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M9.8 2.2 13.8 6.2 12.4 7.6 11.4 6.6 8.9 9.1 9.4 11.6 8 13 5.5 10.5 2.5 13.5 2 13 5 10 2.5 7.5 3.9 6.1 6.4 6.6 8.9 4.1 7.9 3.1Z');
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.3');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  } else if (kind === 'close') {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }
  return svg;
}

function applyBreakdownPreview(rec, isCustom = false) {
  const quote = state.quote;
  if (!quote || !rec) return;
  const fees = rec.fees !== undefined ? rec.fees : rec.totalFees;
  $('bd-buyer').textContent = rec.buyerPaysText || formatQuoteMoney(rec.buyerPays, quote);
  $('bd-steam').textContent = rec.steamFeeText || formatQuoteMoney(rec.steamFee, quote);
  $('bd-publisher').textContent = rec.publisherFeeText || formatQuoteMoney(rec.publisherFee, quote);
  $('bd-receive').textContent = rec.receiveText || formatQuoteMoney(rec.receive, quote);
  if ($('bd-custom-badge')) $('bd-custom-badge').hidden = !isCustom;
  renderFeeBar({ buyerPays: rec.buyerPays, receive: rec.receive, steamFee: rec.steamFee, publisherFee: rec.publisherFee });
  renderQuantity({ buyerPays: rec.buyerPays, receive: rec.receive, fees });
}

function renderCustomFeedback(res, isCustom) {
  const quote = state.quote;
  const badge = $('custom-badge');
  const diffEl = $('custom-diff');
  const fb = $('custom-feedback');
  if (!quote || !fb) return;
  badge.hidden = !isCustom;
  fb.classList.remove('warn', 'err');
  if (!res || !res.ok) {
    fb.classList.add('err');
    fb.textContent = t('customBelowMin', {
      minBuyer: formatQuoteMoney(res?.minBuyerPays || marketMinimumFor(quote.currency) * 3, quote),
      minReceive: formatQuoteMoney(res?.minReceive || marketMinimumFor(quote.currency), quote),
    });
    diffEl.textContent = '';
    applyBreakdownPreview(quote.recommendation, false);
    return;
  }
  applyBreakdownPreview(isCustom ? res : quote.recommendation, isCustom);
  const share = res.buyerPays > 0 ? ((res.totalFees / res.buyerPays) * 100).toFixed(1) : '0.0';
  let line = t('customSummary', {
    steam: formatQuoteMoney(res.steamFee, quote),
    publisher: formatQuoteMoney(res.publisherFee, quote),
    share,
  });
  if (res.exact === false) {
    fb.classList.add('warn');
    line = t('customFeeStepNote', { actual: formatQuoteMoney(res.buyerPays, quote) }) + ' / ' + line;
  }
  fb.textContent = line;

  const lowest = quote.market.lowest;
  if (lowest && Number.isInteger(lowest)) {
    const delta = res.buyerPays - lowest;
    if (delta === 0) diffEl.textContent = t('customDiffMatch');
    else if (delta < 0) diffEl.textContent = t('customDiffBelow', { amount: formatQuoteMoney(Math.abs(delta), quote) });
    else diffEl.textContent = t('customDiffAbove', { amount: formatQuoteMoney(delta, quote) });
  } else {
    diffEl.textContent = '';
  }
}

function updateCustomFromBuyer(source = 'input') {
  if (!state.quote) return;
  const minor = source === 'slider'
    ? Math.trunc(Number($('custom-slider').value) || 0)
    : parseMajorToMinor($('custom-buyer').value, state.quote.currency);
  if (minor === null) {
    state.customQuote = null;
    renderCustomFeedback({ ok: false }, true);
    return;
  }
  const res = quoteByBuyerPays(minor, {
    currency: state.quote.currency,
    steamFee: state.steamFee,
    publisherFee: state.publisherFee,
  });
  state.customQuote = res;
  if (res.ok) {
    if (source === 'slider') $('custom-buyer').value = priceNumber(res.buyerPays, state.quote.currency);
    $('custom-receive').value = priceNumber(res.receive, state.quote.currency);
    const slider = $('custom-slider');
    if (source !== 'slider') slider.value = String(clamp(res.buyerPays, Number(slider.min), Number(slider.max)));
  }
  const isCustom = !res.ok || res.buyerPays !== state.quote.recommendation.buyerPays;
  renderCustomFeedback(res, isCustom);
}

function updateCustomFromReceive() {
  if (!state.quote) return;
  const minor = parseMajorToMinor($('custom-receive').value, state.quote.currency);
  if (minor === null) {
    state.customQuote = null;
    renderCustomFeedback({ ok: false }, true);
    return;
  }
  const res = quoteByReceive(minor, {
    currency: state.quote.currency,
    steamFee: state.steamFee,
    publisherFee: state.publisherFee,
  });
  state.customQuote = res;
  if (res.ok) {
    $('custom-buyer').value = priceNumber(res.buyerPays, state.quote.currency);
    const slider = $('custom-slider');
    slider.value = String(clamp(res.buyerPays, Number(slider.min), Number(slider.max)));
  }
  const isCustom = !res.ok || res.buyerPays !== state.quote.recommendation.buyerPays;
  renderCustomFeedback(res, isCustom);
}

function copyCustomPrice(kind = 'buyerPays') {
  if (!state.quote || !quoteIsCurrent()) { toast(t('staleCopy')); return; }
  if (!state.customQuote || !state.customQuote.ok) { toast(t('errorNoValid')); return; }
  copyText(priceNumber(state.customQuote[kind], state.quote.currency));
}

function remember(quote) {
  const entries = loadHistory();
  const entry = {
    appId: quote.item.appId,
    hashName: quote.item.hashName,
    name: quote.item.name,
    appName: quote.item.appName || '',
    iconUrl: quote.item.iconUrl || '',
    priceText: quote.recommendation.buyerPaysText,
    currency: quote.currency,
    at: Date.now(),
    strategy: state.strategy,
    undercut: state.undercut,
    steamFee: state.steamFee,
    publisherFee: state.publisherFee,
  };
  const filtered = entries.filter(
    (item) => !(item.appId === entry.appId && item.hashName === entry.hashName && item.currency === entry.currency),
  );
  filtered.unshift(entry);
  saveHistory(filtered);
  renderHistory();
}

function makeSideThumb(entry) {
  const thumb = document.createElement('span');
  thumb.className = 'side-thumb';
  if (entry.iconUrl) {
    const img = document.createElement('img');
    img.src = entry.iconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.remove(); thumb.textContent = firstChar(entry.name || entry.hashName); });
    thumb.appendChild(img);
  } else {
    thumb.textContent = firstChar(entry.name || entry.hashName);
  }
  return thumb;
}

function removeHistoryEntry(entry) {
  const entries = loadHistory().filter(
    (item) => !(item.appId === entry.appId && item.hashName === entry.hashName && item.currency === entry.currency),
  );
  saveHistory(entries);
  renderHistory();
  toast(t('itemRemoved'));
}

function renderHistory() {
  const list = $('history-list');
  const entries = loadHistory();
  $('clear-history').disabled = entries.length === 0 && !state.lastCleared;
  $('history-count').textContent = entries.length ? String(entries.length) : '';
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = t('emptyHistory');
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'side-item-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    button.title = (entry.name || entry.hashName) + ' - ' + new Date(entry.at).toLocaleString('zh-CN', { hour12: false });

    const info = document.createElement('span');
    info.className = 'side-item-info';
    const name = document.createElement('span');
    name.className = 'side-item-name';
    name.textContent = entry.name || entry.hashName;
    const sub = document.createElement('span');
    sub.className = 'side-item-sub';
    sub.textContent = appShortName(entry.appId, entry.appName);
    info.append(name, sub);

    const price = document.createElement('strong');
    price.textContent = entry.priceText || '';
    button.append(makeSideThumb(entry), info, price);
    button.addEventListener('click', () => restoreEntry(entry));

    const actions = document.createElement('span');
    actions.className = 'side-item-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'side-action side-action-del';
    del.appendChild(makeIconSvg('close'));
    del.title = t('removeItem');
    del.setAttribute('aria-label', t('removeItem') + ' ' + (entry.name || entry.hashName));
    del.addEventListener('click', (event) => { event.stopPropagation(); removeHistoryEntry(entry); });
    actions.appendChild(del);

    row.append(button, actions);
    list.appendChild(row);
  }
}

async function copyText(text, message, { container = document.body, notice = toast } = {}) {
  if (!text) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Use fallback');
    await navigator.clipboard.writeText(text);
  } catch {
    const active = document.activeElement;
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.className = 'copy-helper';
    container.appendChild(helper);
    helper.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Report below. */ }
    helper.remove();
    active?.focus({ preventScroll: true });
    if (!copied) { notice(t('copyFailed')); return; }
  }
  notice(message || t('copiedToast', { price: text }));
}

function copyPrice(kind = 'buyerPays') {
  if (!state.quote || !quoteIsCurrent()) { toast(t('staleCopy')); return; }
  copyText(priceNumber(state.quote.recommendation[kind], state.quote.currency));
}

function ensureAppOption(appId) {
  if (optionHas($('app-select'), appId)) return;
  const option = document.createElement('option');
  option.value = String(appId);
  option.textContent = 'Steam App ' + appId;
  $('app-select').appendChild(option);
}

function contextKey() {
  return JSON.stringify([$('item-name').value.trim(), state.appId, state.currency, state.strategy, state.undercut, state.steamFee, state.publisherFee]);
}

function quoteIsCurrent() {
  return Boolean(state.quote && state.quoteContext === contextKey() && !state.quoteAbort && $('result-stale').hidden);
}

function invalidateQuote() {
  if (state.quoteAbort) { state.quoteAbort.abort(); state.quoteAbort = null; setBusy(false); }
  if (state.historyAbort) { state.historyAbort.abort(); state.historyAbort = null; state.historyLoading = false; }
  if (state.recalcTimer) { clearTimeout(state.recalcTimer); state.recalcTimer = null; }
  if (state.quote) {
    const stale = state.quoteContext !== contextKey() || !$('result-stale').hidden;
    $('result-stale').hidden = !stale;
    $('result-stale').textContent = t('staleChanged');
    $('result').classList.toggle('stale', stale);
  }
  setBusy(Boolean(state.quoteAbort));
}

function updateQueryUrl() {
  if (!state.quote || state.quoteContext !== contextKey()) return;
  const url = new URL(window.location.href);
  url.search = queryParams(state, state.quote.item.hashName).toString();
  window.history.replaceState(null, '', url);
}

function renderStrategyOptions(quote) {
  const box = $('strategy-options');
  box.replaceChildren();
  const options = Array.isArray(quote.compareStrategies) ? quote.compareStrategies : [];
  $('strategy-card').hidden = options.length === 0;
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'strategy-option';
    const selected = quote.recommendation.strategyRequested === option.strategy;
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !option.ok;
    const title = document.createElement('span');
    title.className = 'strategy-title';
    title.textContent = t('strategy' + option.strategy[0].toUpperCase() + option.strategy.slice(1));
    const buyer = document.createElement('strong');
    buyer.textContent = option.ok ? option.recommendation.buyerPaysText : t('notListable');
    const receive = document.createElement('span');
    receive.className = 'muted small';
    receive.textContent = option.ok ? t('strategyReceive', { price: option.recommendation.receiveText }) : t(ERROR_KEYS[option.code] || 'errorNoValid');
    button.append(title, buyer, receive);
    button.addEventListener('click', () => {
      if (!quoteIsCurrent()) { toast(t('staleCopy')); return; }
      state.strategy = option.strategy;
      $('strategy-select').value = option.strategy;
      updateStrategyControls(); saveSettings();
      const next = { ...state.quote, recommendation: option.recommendation };
      state.quote = next;
      state.quoteContext = contextKey();
      renderQuote(next, { skipHistory: true });
      updateQueryUrl(); remember(next);
    });
    box.appendChild(button);
  }
}

function renderQuantity(overrideRec = null) {
  for (const btn of document.querySelectorAll('.qty-btn')) {
    btn.classList.toggle('active', Number(btn.dataset.qty) === state.quantity);
  }
  if (!state.quote) return;
  const activeCustom = state.customQuote && state.customQuote.ok && state.customQuote.buyerPays !== state.quote.recommendation.buyerPays
    ? { buyerPays: state.customQuote.buyerPays, receive: state.customQuote.receive, fees: state.customQuote.totalFees }
    : null;
  const rec = overrideRec || activeCustom || state.quote.recommendation;
  const currency = state.quote.currencyCode || 'CNY';
  const money = (minor) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(minor * state.quantity / 10 ** decimalPlaces(state.quote.currency));
  $('quantity-total').textContent = t('quantityTotal', { quantity: state.quantity, buyer: money(rec.buyerPays), receive: money(rec.receive), fees: money(rec.fees) });
}

function readFavorites() {
  try { return cleanEntries(JSON.parse(localStorage.getItem(STORAGE.favorites) || '[]'), 30); }
  catch { return []; }
}

function sameItem(a, b) {
  return Number(a.appId) === Number(b.appId) && a.hashName === b.hashName;
}

function restoreEntry(entry) {
  ensureAppOption(entry.appId);
  state.appId = Number(entry.appId);
  $('app-select').value = String(entry.appId);
  if (optionHas($('currency-select'), entry.currency)) { state.currency = Number(entry.currency); $('currency-select').value = String(entry.currency); }
  if (optionHas($('strategy-select'), entry.strategy)) { state.strategy = entry.strategy; $('strategy-select').value = entry.strategy; }
  if (optionHas($('undercut-select'), entry.undercut)) { state.undercut = Number(entry.undercut); $('undercut-select').value = String(entry.undercut); }
  for (const key of ['steamFee', 'publisherFee']) {
    if (Number.isFinite(Number(entry[key])) && entry[key] !== null && entry[key] !== undefined) state[key] = clamp(Number(entry[key]), 0, 30);
  }
  $('steam-fee').value = state.steamFee; $('publisher-fee').value = state.publisherFee;
  $('item-name').value = entry.hashName;
  $('clear-input').hidden = false;
  updateStrategyControls(); updateFeeSummary(); saveSettings(); calculate();
}

function writeFavorites(entries) {
  try {
    localStorage.setItem(STORAGE.favorites, JSON.stringify(entries.slice(0, 30)));
    return true;
  } catch {
    toast(t('storageFailed'));
    return false;
  }
}

function toggleFavorite() {
  if (!quoteIsCurrent()) { toast(t('staleCopy')); return; }
  const item = state.quote.item;
  const favorites = readFavorites();
  const exists = favorites.some((entry) => sameItem(entry, item));
  if (!exists && favorites.length >= 30) { toast(t('favoriteLimit')); return; }
  const next = exists
    ? favorites.filter((entry) => !sameItem(entry, item))
    : [{
      appId: item.appId,
      hashName: item.hashName,
      name: item.name,
      appName: item.appName || '',
      iconUrl: item.iconUrl || '',
      currency: state.quote.currency,
      pinned: false,
    }, ...favorites].slice(0, 30);
  if (!writeFavorites(next)) return;
  renderFavorites();
  toast(t(exists ? 'favoriteRemoved' : 'favoriteAdded'));
}

function togglePinFavorite(target) {
  const favorites = readFavorites();
  let pinned = false;
  const next = favorites.map((entry) => {
    if (!sameItem(entry, target)) return entry;
    pinned = !entry.pinned;
    return { ...entry, pinned };
  });
  if (!writeFavorites(next)) return;
  renderFavorites();
  toast(t(pinned ? 'favPinned' : 'favUnpinned'));
}

function removeFavoriteEntry(target) {
  const next = readFavorites().filter((entry) => !sameItem(entry, target));
  if (!writeFavorites(next)) return;
  renderFavorites();
  toast(t('favoriteRemoved'));
}

async function addFavoriteToBatch(entry, button) {
  if (button.getAttribute('aria-disabled') === 'true') return;
  if (state.cooldownUntil > Date.now()) {
    toast(t('retryAfter', { seconds: Math.ceil((state.cooldownUntil - Date.now()) / 1000) }));
    return;
  }
  const settings = {
    appId: entry.appId,
    name: entry.hashName,
    currency: optionHas($('currency-select'), entry.currency) ? Number(entry.currency) : state.currency,
    strategy: 'median',
    undercut: state.undercut,
    steamFee: state.steamFee,
    publisherFee: state.publisherFee,
  };
  button.setAttribute('aria-disabled', 'true');
  toast(t('batchFavoriteLoading'));
  try {
    const quote = await requestQuote(settings);
    if (quote?.ok) {
      batch.add(quote, settings, 1, button);
    } else {
      const error = quote?.error;
      if (error?.code === 'rate-limited') {
        const delay = Math.max(1000, Number(error.retryAfterMs) || 60000);
        beginCooldown(delay);
        toast(t('retryAfter', { seconds: Math.ceil(delay / 1000) }));
      } else {
        toast(t(ERROR_KEYS[error?.code] || 'batchNoQuote'));
      }
    }
  } catch (error) {
    toast(t(error.name === 'TimeoutError' ? 'requestTimeout' : 'errorUpstream'));
  } finally {
    button.removeAttribute('aria-disabled');
  }
}

function renderFavorites() {
  const raw = readFavorites();
  const entries = raw.slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const box = $('favorites-list');
  const filterBox = $('favorites-filter');
  box.replaceChildren();
  $('favorites-panel').hidden = !entries.length;
  $('favorites-count').textContent = entries.length ? String(entries.length) : '';

  const appIds = [...new Set(entries.map((entry) => Number(entry.appId)))];
  if (state.favFilter !== 'all' && !appIds.includes(Number(state.favFilter))) {
    state.favFilter = 'all';
  }
  if (filterBox) {
    filterBox.replaceChildren();
    filterBox.hidden = appIds.length < 2;
    if (appIds.length >= 2) {
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'filter-chip' + (state.favFilter === 'all' ? ' active' : '');
      allBtn.textContent = t('filterAllGames');
      allBtn.addEventListener('click', () => { state.favFilter = 'all'; renderFavorites(); });
      filterBox.appendChild(allBtn);
      for (const appId of appIds) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-chip' + (String(state.favFilter) === String(appId) ? ' active' : '');
        chip.textContent = appShortName(appId);
        chip.addEventListener('click', () => { state.favFilter = String(appId); renderFavorites(); });
        filterBox.appendChild(chip);
      }
    }
  }

  const visible = state.favFilter === 'all'
    ? entries
    : entries.filter((entry) => String(entry.appId) === String(state.favFilter));

  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = 'side-item-row favorite-row' + (entry.pinned ? ' pinned' : '');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-item';
    button.title = entry.name || entry.hashName;

    const info = document.createElement('span');
    info.className = 'side-item-info';
    const name = document.createElement('span');
    name.className = 'side-item-name';
    name.textContent = entry.name || entry.hashName;
    const sub = document.createElement('span');
    sub.className = 'side-item-sub';
    if (entry.pinned) {
      const pinTag = document.createElement('span');
      pinTag.className = 'pin-badge';
      pinTag.appendChild(makeIconSvg('pin', true));
      sub.appendChild(pinTag);
    }
    const appSpan = document.createElement('span');
    appSpan.textContent = appShortName(entry.appId, entry.appName);
    sub.appendChild(appSpan);
    info.append(name, sub);

    button.append(makeSideThumb(entry), info);
    button.addEventListener('click', () => restoreEntry(entry));

    const actions = document.createElement('span');
    actions.className = 'side-item-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'side-action side-action-pin';
    pinBtn.appendChild(makeIconSvg('pin', Boolean(entry.pinned)));
    pinBtn.setAttribute('aria-pressed', String(Boolean(entry.pinned)));
    pinBtn.title = t(entry.pinned ? 'unpinItem' : 'pinItem');
    pinBtn.setAttribute('aria-label', t(entry.pinned ? 'unpinItem' : 'pinItem') + ' ' + (entry.name || entry.hashName));
    pinBtn.addEventListener('click', (event) => { event.stopPropagation(); togglePinFavorite(entry); });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'side-action side-action-del';
    delBtn.appendChild(makeIconSvg('close'));
    delBtn.title = t('removeItem');
    delBtn.setAttribute('aria-label', t('removeItem') + ' ' + (entry.name || entry.hashName));
    delBtn.addEventListener('click', (event) => { event.stopPropagation(); removeFavoriteEntry(entry); });

    const batchBtn = document.createElement('button');
    batchBtn.type = 'button';
    batchBtn.className = 'side-action side-action-batch';
    batchBtn.textContent = '+';
    batchBtn.title = t('batchFavoriteAdd');
    batchBtn.setAttribute('aria-label', t('batchFavoriteAdd') + ' ' + (entry.name || entry.hashName));
    batchBtn.addEventListener('click', () => addFavoriteToBatch(entry, batchBtn));

    actions.append(batchBtn, pinBtn, delBtn);
    row.append(button, actions);
    box.appendChild(row);
  }
  const active = state.quote && entries.some((entry) => sameItem(entry, state.quote.item));
  $('favorite-quote').setAttribute('aria-pressed', String(Boolean(active)));
  $('favorite-quote').textContent = t(active ? 'unfavorite' : 'favorite');
}

function chartPoints() {
  const cutoff = Date.now() / 1000 - state.historyDays * 86400;
  return (state.history?.points || []).filter((point) => point.time >= cutoff);
}

function renderChartTable() {
  const body = $('chart-table');
  body.replaceChildren();
  for (const point of chartPoints().slice().reverse()) {
    const row = document.createElement('tr');
    for (const value of [new Date(point.time * 1000).toLocaleDateString('zh-CN'), formatMoney(point.value), Number(point.volume || 0).toLocaleString('zh-CN')]) {
      const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
    }
    body.appendChild(row);
  }
}

function downloadCsv(text, filename) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportHistory() {
  const points = chartPoints();
  if (!points.length || !state.history) return;
  const rows = [['date', 'price', 'currency', 'volume', 'estimated'], ...points.map((point) => [new Date(point.time * 1000).toISOString().slice(0, 10), priceNumber(point.value, state.history.currency), state.history.currencyCode, point.volume || 0, Boolean(state.history.converted)])];
  downloadCsv(rows.map((row) => row.join(',')).join('\r\n'), 'steam-market-' + state.historyDays + 'd.csv');
}

function scheduleRecalc() {
  invalidateQuote();
  if (!state.quote) return;
  if (state.recalcTimer) clearTimeout(state.recalcTimer);
  state.recalcTimer = setTimeout(() => {
    if ($('item-name').value.trim()) calculate();
  }, 450);
}

function readFees() {
  state.steamFee = clamp(num($('steam-fee').value, DEFAULTS.steamFee), 0, 30);
  state.publisherFee = clamp(num($('publisher-fee').value, DEFAULTS.publisherFee), 0, 30);
  $('steam-fee').value = String(state.steamFee);
  $('publisher-fee').value = String(state.publisherFee);
  updateFeeSummary();
}

function formatMoney(minor) {
  const decimals = state.history ? state.history.decimals : 2;
  const code = state.history ? state.history.currencyCode : 'CNY';
  const value = Number(minor) / 10 ** decimals;
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return value.toFixed(decimals);
  }
}

function formatPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(1)}%`;
}

function shortDate(time, days) {
  const date = new Date(time * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', days > 300
    ? { year: '2-digit', month: '2-digit' }
    : { month: '2-digit', day: '2-digit' });
}

function showChartEmpty(text, { retry = false } = {}) {
  const empty = $('chart-empty');
  empty.replaceChildren();
  const message = document.createElement('div');
  message.textContent = text;
  empty.appendChild(message);
  if (retry && state.quote) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = t('chartRetry');
    button.addEventListener('click', () => loadPriceHistory(state.quote, true));
    empty.appendChild(button);
  }
  empty.hidden = false;
  $('price-chart').replaceChildren();
  $('price-chart').onpointermove = null;
  $('price-chart').onkeydown = null;
  $('chart-selection').textContent = '';
  $('chart-table').replaceChildren();
  $('export-history').disabled = true;
  $('chart-stats').replaceChildren();
  $('chart-note').textContent = '';
}

function chartErrorMessage(data) {
  const code = data && data.error ? data.error.code : data && data.code;
  if (code === 'rate-limited') return t('errorRateLimited');
  if (code === 'upstream' || code === 'timeout') return t('errorUpstream');
  return t('chartError');
}

async function loadPriceHistory(quote, refresh = false) {
  if (!quote || !quote.item) return;
  const key = [quote.item.appId, quote.item.hashName, quote.currency, quote.market.median || quote.market.lowest].join(':');
  if (!refresh && state.history && state.historyKey === key) { renderHistoryChart(); return; }
  state.historyKey = key;
  if (state.historyAbort) state.historyAbort.abort();
  const controller = new AbortController();
  state.historyAbort = controller;
  state.history = null;
  state.historyLoading = true;

  $('chart-card').hidden = false;
  $('chart-subtitle').textContent = '';
  $('chart-note').textContent = '';
  showChartEmpty(t('chartLoading'));

  const current = quote.market.median || quote.market.lowest || 0;
  if (!current) {
    state.historyLoading = false;
    state.historyAbort = null;
    showChartEmpty(t('chartError'), { retry: true });
    return;
  }

  try {
    const params = new URLSearchParams({
      appid: String(quote.item.appId),
      name: quote.item.hashName,
      currency: String(quote.currency),
      current: String(current),
      refresh: refresh ? '1' : '0',
    });
    const data = await fetchJson(`./api/history?${params.toString()}`, { signal: controller.signal, timeoutMs: 65000 });
    if (controller.signal.aborted || state.historyAbort !== controller) return;
    if (data && data.ok && Array.isArray(data.points) && data.points.length >= 2) {
      state.history = data;
      if (!data.ranges[state.historyDays]) {
        const available = [30, 90, 180, 365].find((days) => data.ranges[days]);
        if (available) state.historyDays = available;
      }
      renderHistoryChart();
    } else {
      state.history = null;
      showChartEmpty(chartErrorMessage(data), { retry: true });
    }
  } catch (err) {
    if (controller.signal.aborted || state.historyAbort !== controller) return;
    state.history = null;
    showChartEmpty(t('errorUpstream'), { retry: true });
  } finally {
    if (state.historyAbort === controller) {
      state.historyAbort = null;
      state.historyLoading = false;
    }
  }
}

function renderHistoryChart() {
  const data = state.history;
  if (!data) return;
  const days = state.historyDays;
  const stats = data.ranges[days];
  $('chart-card').hidden = false;

  for (const button of $('chart-ranges').querySelectorAll('button')) {
    button.classList.toggle('active', Number(button.dataset.days) === days);
    button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days));
    button.disabled = !data.ranges[button.dataset.days];
  }

  const converted = data.converted ? t('chartConverted') : '';
  $('chart-subtitle').textContent = t('chartSubtitle', {
    days,
    currency: data.currencyCode,
    converted,
  });
  $('chart-note').textContent = data.converted ? t('chartNote') : t('chartNoteDirect');

  const statsBox = $('chart-stats');
  statsBox.replaceChildren();
  if (stats) {
    const verdictKey =
      stats.verdict === 'high' ? 'chartHigh' : stats.verdict === 'low' ? 'chartLow' : 'chartMid';
    const percentile = document.createElement('span');
    percentile.className = `chart-stat ${stats.verdict}`;
    percentile.textContent = `${t('chartPercentile', {
      days,
      percentile: stats.percentile,
    })} / ${t(verdictKey)}`;
    statsBox.appendChild(percentile);

    const change = document.createElement('span');
    const changeDir = stats.changePct === null ? '' : Number(stats.changePct) > 0 ? ' up' : Number(stats.changePct) < 0 ? ' down' : '';
    change.className = 'chart-stat' + changeDir;
    change.textContent = stats.changePct === null ? t('chartChangeMissing') : t('chartChange', { days, change: formatPct(stats.changePct) });
    statsBox.appendChild(change);

    const range = document.createElement('span');
    range.className = 'chart-stat';
    range.textContent = t('chartRange', {
      min: formatMoney(stats.min),
      max: formatMoney(stats.max),
    });
    statsBox.appendChild(range);
    const coverage = document.createElement('span'); coverage.className = 'chart-stat';
    coverage.textContent = t('chartCoverage', { count: stats.count, days: Math.round(stats.coveredDays || 0) });
    statsBox.appendChild(coverage);
    if (!stats.complete) $('chart-note').textContent += ' ' + t('chartIncomplete');
    if (data.converted) $('chart-note').textContent += ' ' + t('chartConvertedSource', { currency: data.historyCurrencyCode });
  }

  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const points = data.points.filter((point) => point.time >= cutoff);
  if (points.length < 2) {
    showChartEmpty(t('chartEmpty'));
    return;
  }
  drawPriceChart(points, data.current, days);
  $('export-history').disabled = false;
  if ($('chart-table-details').open) renderChartTable();
}

function drawPriceChart(points, current, days) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('price-chart');
  const empty = $('chart-empty');
  svg.replaceChildren();
  empty.hidden = true;
  svg.setAttribute('aria-label', t('chartAria', { days }));

  const width = Math.max(180, Math.min(1600, svg.getBoundingClientRect().width || 800));
  const showVol = Boolean(state.showVolume);
  const showMa = Boolean(state.showMa) && points.length >= 7;
  const height = width < 500 ? (showVol ? 300 : 260) : (showVol ? 348 : 300);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const margin = { left: width < 500 ? 62 : 76, right: 16, top: 20, bottom: 30 };
  const innerWidth = width - margin.left - margin.right;
  const totalInnerHeight = height - margin.top - margin.bottom;
  const volGap = showVol ? 14 : 0;
  const volHeight = showVol ? Math.round(totalInnerHeight * 0.22) : 0;
  const priceHeight = totalInnerHeight - volHeight - volGap;
  const priceBottom = margin.top + priceHeight;
  const volTop = priceBottom + volGap;
  const volBottom = margin.top + totalInnerHeight;

  const make = (tag, attrs = {}, text = null) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== null) node.textContent = text;
    return node;
  };

  let min = Math.min(current, ...points.map((point) => point.value));
  let max = Math.max(current, ...points.map((point) => point.value));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padding = (max - min) * 0.09;
  min = Math.max(0, min - padding);
  max += padding;

  const minTime = points[0].time;
  const maxTime = points[points.length - 1].time;
  const timeSpan = Math.max(1, maxTime - minTime);

  const x = (time) => margin.left + ((time - minTime) / timeSpan) * innerWidth;
  const y = (value) => margin.top + ((max - value) / (max - min)) * priceHeight;

  const defs = make('defs');
  const gradient = make('linearGradient', { id: 'chart-area', x1: '0', y1: '0', x2: '0', y2: '1' });
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#38bdf8';
  gradient.appendChild(make('stop', { offset: '0%', 'stop-color': accent, 'stop-opacity': '0.26' }));
  gradient.appendChild(make('stop', { offset: '100%', 'stop-color': accent, 'stop-opacity': '0.01' }));
  defs.appendChild(gradient);
  svg.appendChild(defs);

  for (let index = 0; index <= 4; index++) {
    const lineY = margin.top + (priceHeight * index) / 4;
    svg.appendChild(
      make('line', {
        class: 'grid-line',
        x1: margin.left,
        x2: width - margin.right,
        y1: lineY,
        y2: lineY,
      }),
    );
    const value = max - ((max - min) * index) / 4;
    svg.appendChild(
      make(
        'text',
        {
          class: 'axis-label',
          x: margin.left - 8,
          y: lineY + 4,
          'text-anchor': 'end',
        },
        formatMoney(Math.round(value)),
      ),
    );
  }

  const volBars = [];
  if (showVol) {
    svg.appendChild(
      make('line', {
        class: 'vol-divider',
        x1: margin.left,
        x2: width - margin.right,
        y1: volTop - Math.round(volGap / 2),
        y2: volTop - Math.round(volGap / 2),
      }),
    );
    const maxVol = Math.max(1, ...points.map((point) => Number(point.volume || 0)));
    const barW = Math.max(1.5, Math.min(8, (innerWidth / Math.max(points.length, 1)) * 0.68));
    const volGroup = make('g', { class: 'vol-bars' });
    for (let i = 0; i < points.length; i++) {
      const vol = Number(points[i].volume || 0);
      const barH = Math.max(1, (vol / maxVol) * volHeight);
      const bar = make('rect', {
        class: 'vol-bar',
        x: (x(points[i].time) - barW / 2).toFixed(2),
        y: (volBottom - barH).toFixed(2),
        width: barW.toFixed(2),
        height: barH.toFixed(2),
        rx: 1,
      });
      volGroup.appendChild(bar);
      volBars.push(bar);
    }
    svg.appendChild(volGroup);
    svg.appendChild(
      make(
        'text',
        {
          class: 'axis-label',
          x: margin.left - 8,
          y: volTop + 10,
          'text-anchor': 'end',
        },
        maxVol.toLocaleString('en-US'),
      ),
    );
  }

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.time).toFixed(2)} ${y(point.value).toFixed(2)}`)
    .join(' ');
  const firstX = x(points[0].time).toFixed(2);
  const lastX = x(points[points.length - 1].time).toFixed(2);
  const bottom = priceBottom.toFixed(2);
  svg.appendChild(
    make('path', {
      class: 'price-area',
      d: `M ${firstX} ${bottom} L ${linePath.replace(/^M /, '')} L ${lastX} ${bottom} Z`,
    }),
  );
  svg.appendChild(make('path', { class: 'price-line', d: linePath }));

  const maMap = new Map();
  if (showMa) {
    const maPoints = movingAverage(points, 7);
    if (maPoints.length >= 2) {
      for (const mp of maPoints) maMap.set(mp.time, mp.value);
      const maPath = maPoints
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.time).toFixed(2)} ${y(point.value).toFixed(2)}`)
        .join(' ');
      svg.appendChild(make('path', { class: 'ma-line', d: maPath }));
    }
  }

  let hiPt = points[0];
  let loPt = points[0];
  for (const pt of points) {
    if (pt.value > hiPt.value) hiPt = pt;
    if (pt.value < loPt.value) loPt = pt;
  }
  if (hiPt !== loPt) {
    const hiX = x(hiPt.time);
    const hiY = y(hiPt.value);
    const loX = x(loPt.time);
    const loY = y(loPt.value);
    svg.appendChild(make('circle', { class: 'extreme-dot-high', cx: hiX.toFixed(2), cy: hiY.toFixed(2), r: '3' }));
    svg.appendChild(make('circle', { class: 'extreme-dot-low', cx: loX.toFixed(2), cy: loY.toFixed(2), r: '3' }));
    const hiAnchor = hiX > width - 90 ? 'end' : hiX < margin.left + 70 ? 'start' : 'middle';
    const loAnchor = loX > width - 90 ? 'end' : loX < margin.left + 70 ? 'start' : 'middle';
    svg.appendChild(make('text', { class: 'extreme-label', x: hiX.toFixed(2), y: Math.max(margin.top + 10, hiY - 7).toFixed(2), 'text-anchor': hiAnchor }, t('chartHighPoint', { price: formatMoney(hiPt.value) })));
    svg.appendChild(make('text', { class: 'extreme-label', x: loX.toFixed(2), y: Math.min(priceBottom - 4, loY + 14).toFixed(2), 'text-anchor': loAnchor }, t('chartLowPoint', { price: formatMoney(loPt.value) })));
  }

  const currentY = y(current);
  svg.appendChild(
    make('line', {
      class: 'current-line',
      x1: margin.left,
      x2: width - margin.right,
      y1: currentY,
      y2: currentY,
    }),
  );
  svg.appendChild(
    make(
      'text',
      {
        class: 'current-label',
        x: margin.left + 6,
        y: currentY - 5,
        'text-anchor': 'start',
      },
      t(state.quote?.market.median ? 'chartBaselineMedian' : 'chartBaselineLowest', { price: formatMoney(current) }),
    ),
  );

  const tickCount = width >= 680 ? 5 : width >= 420 ? 4 : 3;
  const labels = [];
  for (let i = 0; i < tickCount; i++) {
    const ratio = i / (tickCount - 1);
    labels.push({
      time: Math.round(minTime + timeSpan * ratio),
      anchor: i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle',
      x: margin.left + innerWidth * ratio,
    });
  }
  for (const label of labels) {
    svg.appendChild(
      make(
        'text',
        {
          class: 'axis-label',
          x: label.x,
          y: height - 8,
          'text-anchor': label.anchor,
        },
        shortDate(label.time, days),
      ),
    );
  }

  const hover = make('g', { class: 'chart-hover', visibility: 'hidden' });
  const hoverLine = make('line', {
    class: 'hover-line',
    y1: margin.top,
    y2: volBottom,
  });
  const hoverHLine = make('line', {
    class: 'hover-hline',
    x1: margin.left,
    x2: width - margin.right,
  });
  const hoverDot = make('circle', { class: 'hover-dot', r: '4.5' });
  const yPillBg = make('rect', { class: 'axis-pill-bg', width: margin.left - 6, height: 18, rx: 3, ry: 3, x: 2 });
  const yPillText = make('text', { class: 'axis-pill-text', x: margin.left - 8, 'text-anchor': 'end' });
  const tooltipBg = make('rect', {
    class: 'tooltip-bg',
    width: 196,
    height: 76,
    rx: 7,
    ry: 7,
  });
  const tooltipDate = make('text', { class: 'tooltip-muted' });
  const tooltipPrice = make('text', { class: 'tooltip-price' });
  const tooltipMeta = make('text', { class: 'tooltip-text' });
  const tooltipVolume = make('text', { class: 'tooltip-muted' });
  hover.append(hoverLine, hoverHLine, hoverDot, yPillBg, yPillText, tooltipBg, tooltipDate, tooltipPrice, tooltipMeta, tooltipVolume);
  svg.appendChild(hover);

  let activePoint = points.length - 1;
  let lastBarIndex = -1;
  const clearBarHighlight = () => {
    if (lastBarIndex >= 0 && volBars[lastBarIndex]) volBars[lastBarIndex].classList.remove('active');
    lastBarIndex = -1;
  };

  const showPoint = (index) => {
    activePoint = clamp(index, 0, points.length - 1);
    const nearest = points[activePoint];
    const maVal = maMap.get(nearest.time);
    let selText = new Date(nearest.time * 1000).toLocaleDateString('zh-CN') + ' / ' + formatMoney(nearest.value) + ' / ' + t('chartVolume', { count: Number(nearest.volume || 0).toLocaleString('zh-CN') });
    if (maVal !== undefined) selText += ' / ' + t('chartMaLabel', { price: formatMoney(Math.round(maVal)) });
    $('chart-selection').textContent = selText;

    const pointX = x(nearest.time);
    const pointY = y(nearest.value);
    hover.setAttribute('visibility', 'visible');
    hoverLine.setAttribute('x1', String(pointX));
    hoverLine.setAttribute('x2', String(pointX));
    hoverHLine.setAttribute('y1', String(pointY));
    hoverHLine.setAttribute('y2', String(pointY));
    hoverDot.setAttribute('cx', String(pointX));
    hoverDot.setAttribute('cy', String(pointY));
    yPillBg.setAttribute('y', String(clamp(pointY - 9, margin.top, priceBottom - 18)));
    yPillText.setAttribute('y', String(clamp(pointY + 4, margin.top + 13, priceBottom - 5)));
    yPillText.textContent = formatMoney(nearest.value);

    clearBarHighlight();
    if (volBars[activePoint]) {
      volBars[activePoint].classList.add('active');
      lastBarIndex = activePoint;
    }

    const tipWidth = 196;
    const tipHeight = maVal !== undefined ? 76 : 62;
    tooltipBg.setAttribute('height', String(tipHeight));
    let tipX = pointX + 14;
    if (tipX + tipWidth > width - 6) tipX = pointX - tipWidth - 14;
    if (tipX < margin.left + 4) tipX = margin.left + 4;
    let tipY = pointY - tipHeight - 10;
    if (tipY < 6) tipY = pointY + 12;
    if (tipY + tipHeight > height - 6) tipY = height - tipHeight - 6;

    tooltipBg.setAttribute('x', String(tipX));
    tooltipBg.setAttribute('y', String(tipY));
    tooltipDate.setAttribute('x', String(tipX + 10));
    tooltipDate.setAttribute('y', String(tipY + 16));
    tooltipDate.textContent = new Date(nearest.time * 1000).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    tooltipPrice.setAttribute('x', String(tipX + 10));
    tooltipPrice.setAttribute('y', String(tipY + 34));
    const diffPct = current > 0 ? ((nearest.value - current) / current) * 100 : null;
    tooltipPrice.textContent = formatMoney(nearest.value) + (diffPct === null ? '' : ' (' + formatPct(diffPct) + ')');

    if (maVal !== undefined) {
      tooltipMeta.setAttribute('x', String(tipX + 10));
      tooltipMeta.setAttribute('y', String(tipY + 50));
      tooltipMeta.textContent = t('chartMaLabel', { price: formatMoney(Math.round(maVal)) });
      tooltipVolume.setAttribute('x', String(tipX + 10));
      tooltipVolume.setAttribute('y', String(tipY + 65));
    } else {
      tooltipMeta.textContent = '';
      tooltipVolume.setAttribute('x', String(tipX + 10));
      tooltipVolume.setAttribute('y', String(tipY + 51));
    }
    tooltipVolume.textContent = t('chartVolume', {
      count: Number(nearest.volume || 0).toLocaleString('en-US'),
    });
  };
  svg.onpointermove = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const target = minTime + ((localX - margin.left) / innerWidth) * timeSpan;
    showPoint(nearestPoint(points, target));
  };
  svg.onpointerleave = () => { hover.setAttribute('visibility', 'hidden'); clearBarHighlight(); };
  svg.onfocus = () => showPoint(activePoint);
  svg.onblur = () => { hover.setAttribute('visibility', 'hidden'); clearBarHighlight(); };
  svg.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { hover.setAttribute('visibility', 'hidden'); clearBarHighlight(); return; }
    showPoint(event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : activePoint + (event.key === 'ArrowLeft' ? -1 : 1));
  };
}

function moveSuggestion(delta) {
  if (state.suggestions.length === 0) return;
  state.activeIndex =
    (state.activeIndex + delta + state.suggestions.length) % state.suggestions.length;
  const buttons = [...$('suggestions').querySelectorAll('.suggestion')];
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === state.activeIndex);
    button.setAttribute('aria-selected', String(index === state.activeIndex));
  });
  const active = buttons[state.activeIndex];
  if (active) {
    $('item-name').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
}

function bind() {
  $('quote-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!state.composing) calculate();
  });

  const onNameInput = () => {
    invalidateQuote();
    hideSuggestions();
    const query = $('item-name').value.trim();
    $('name-error').hidden = true;
    $('item-name').removeAttribute('aria-invalid');
    $('item-name').removeAttribute('aria-describedby');
    $('clear-input').hidden = !query;
    if (state.composing || parseMarketInput(query).appId) return;
    if (query.length < 2) {
      hideSuggestions();
      return;
    }
    state.searchTimer = setTimeout(() => runSearch(query), 350);
  };
  $('item-name').addEventListener('input', onNameInput);
  $('item-name').addEventListener('compositionstart', () => { state.composing = true; hideSuggestions(); });
  $('item-name').addEventListener('compositionend', () => { state.composing = false; onNameInput(); });
  $('clear-input').addEventListener('click', () => { $('item-name').value = ''; onNameInput(); $('item-name').focus(); });

  $('item-name').addEventListener('keydown', (event) => {
    if (event.isComposing || state.composing || event.keyCode === 229) return;
    const open = !$('suggestions').hidden;
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      moveSuggestion(1);
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      moveSuggestion(-1);
    } else if (event.key === 'Enter' && open && state.activeIndex >= 0) {
      event.preventDefault();
      const result = state.suggestions[state.activeIndex];
      if (result) selectSuggestion(result);
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });

  $('app-select').addEventListener('change', () => {
    state.appId = Number($('app-select').value) || DEFAULTS.appId;
    saveSettings();
    hideSuggestions();
    scheduleRecalc();
  });

  $('currency-select').addEventListener('change', () => {
    state.currency = Number($('currency-select').value) || DEFAULTS.currency;
    saveSettings();
    scheduleRecalc();
  });

  $('strategy-select').addEventListener('change', () => {
    state.strategy = $('strategy-select').value;
    updateStrategyControls();
    saveSettings();
    scheduleRecalc();
  });

  $('undercut-select').addEventListener('change', () => {
    state.undercut = Number($('undercut-select').value) || 0;
    saveSettings();
    scheduleRecalc();
  });

  for (const id of ['steam-fee', 'publisher-fee']) {
    $(id).addEventListener('change', () => {
      readFees();
      saveSettings();
      scheduleRecalc();
    });
  }

  $('reset-fees').addEventListener('click', () => {
    $('steam-fee').value = String(DEFAULTS.steamFee);
    $('publisher-fee').value = String(DEFAULTS.publisherFee);
    readFees();
    saveSettings();
    scheduleRecalc();
  });

  $('copy-price').addEventListener('click', () => copyPrice());
  $('copy-receive').addEventListener('click', () => copyPrice('receive'));
  $('retry-quote').addEventListener('click', () => calculate());
  $('cancel-query').addEventListener('click', () => { invalidateQuote(); toast(t('queryCancelled')); });
  $('share-quote').addEventListener('click', () => {
    if (!quoteIsCurrent()) { toast(t('staleCopy')); return; }
    updateQueryUrl();
    copyText(window.location.href, t('linkCopied'));
  });
  $('favorite-quote').addEventListener('click', toggleFavorite);
  $('batch-add-quote').addEventListener('click', (event) => {
    if (!quoteIsCurrent()) { toast(t('staleCopy')); return; }
    batch.add(state.quote, state, state.quantity, event.currentTarget);
  });
  $('quantity').addEventListener('input', () => {
    state.quantity = clamp(Math.trunc(num($('quantity').value, 1)), 1, 10000);
    renderQuantity(); saveSettings(); updateQueryUrl();
  });
  $('quantity').addEventListener('change', () => { $('quantity').value = state.quantity; });
  for (const btn of document.querySelectorAll('.qty-btn')) {
    btn.addEventListener('click', () => {
      state.quantity = clamp(Math.trunc(num(btn.dataset.qty, 1)), 1, 10000);
      $('quantity').value = String(state.quantity);
      renderQuantity(); saveSettings(); updateQueryUrl();
    });
  }

  if ($('custom-buyer')) {
    $('custom-buyer').addEventListener('input', () => updateCustomFromBuyer('input'));
    $('custom-receive').addEventListener('input', () => updateCustomFromReceive());
    $('custom-slider').addEventListener('input', () => updateCustomFromBuyer('slider'));
    $('copy-custom-buyer').addEventListener('click', () => copyCustomPrice('buyerPays'));
    $('copy-custom-receive').addEventListener('click', () => copyCustomPrice('receive'));
    $('reset-custom').addEventListener('click', () => { if (state.quote) syncCustomCalcFromQuote(state.quote); });
  }

  if ($('toggle-ma')) {
    $('toggle-ma').addEventListener('click', () => {
      state.showMa = !state.showMa;
      $('toggle-ma').setAttribute('aria-pressed', String(state.showMa));
      saveSettings();
      if (state.history) renderHistoryChart();
    });
  }
  if ($('toggle-vol')) {
    $('toggle-vol').addEventListener('click', () => {
      state.showVolume = !state.showVolume;
      $('toggle-vol').setAttribute('aria-pressed', String(state.showVolume));
      saveSettings();
      if (state.history) renderHistoryChart();
    });
  }

  for (const chip of document.querySelectorAll('.quick-chip')) {
    chip.addEventListener('click', () => {
      const appId = Number(chip.dataset.app);
      const name = chip.dataset.name || '';
      if (!name) return;
      if (Number.isSafeInteger(appId) && appId > 0) {
        ensureAppOption(appId);
        state.appId = appId;
        $('app-select').value = String(appId);
      }
      $('item-name').value = name;
      $('clear-input').hidden = false;
      saveSettings();
      calculate();
    });
  }

  $('export-history').addEventListener('click', exportHistory);
  $('chart-table-details').addEventListener('toggle', () => { if ($('chart-table-details').open) renderChartTable(); });
  $('refresh-quote').addEventListener('click', () => calculate({ refresh: true }));

  for (const button of $('chart-ranges').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      const days = Number(button.dataset.days);
      if (![30, 90, 180, 365].includes(days)) return;
      state.historyDays = days;
      saveSettings(); updateQueryUrl();
      if (state.history) renderHistoryChart();
    });
  }

  $('clear-history').addEventListener('click', () => {
    if (state.lastCleared) {
      saveHistory(state.lastCleared); state.lastCleared = null;
      $('clear-history').textContent = t('clearHistory');
    } else {
      state.lastCleared = loadHistory(); saveHistory([]);
      $('clear-history').textContent = t('undoClear');
    }
    renderHistory();
  });
  document.addEventListener('keydown', (event) => {
    const editing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === '/' && !$('batch-dialog').open && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); $('item-name').focus(); }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE.history) renderHistory();
    if (event.key === STORAGE.favorites) renderFavorites();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkHealth(); });
  let resizeTimer;
  let previousWidth = 0;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      if (width === previousWidth) return;
      previousWidth = width;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.history) renderHistoryChart(); }, 80);
    }).observe($('chart-card'));
  }

  document.addEventListener('click', (event) => {
    const wrap = $('item-name').parentElement;
    if (wrap && !wrap.contains(event.target)) hideSuggestions();
  });

  updateStrategyControls();
}

async function checkHealth() {
  const network = $('network');
  const text = $('network-text');
  try {
    const data = await fetchJson('./api/health', { timeoutMs: 8000 });
    if (!data || !data.ok) throw new Error('offline');
    const proxy = data.proxy && data.proxy !== 'direct' ? data.proxy : '';
    network.classList.remove('offline', 'online', 'proxy');
    network.classList.add(proxy ? 'proxy' : 'online');
    text.textContent = proxy ? t('networkProxy') : t('networkDirect');
    network.title = proxy || t('networkDirect');
    network.setAttribute('aria-label', text.textContent);
    $('version').textContent = t('versionLabel', { version: data.version });
  } catch {
    network.classList.remove('online', 'proxy');
    network.classList.add('offline');
    text.textContent = t('serverOffline');
    network.title = text.textContent;
    network.setAttribute('aria-label', text.textContent);
  }
}

function renderQuickExamples() {
  const container = $('quick-examples');
  if (!container) return;
  const defaults = [
    { appId: 730, name: 'Clutch Case', label: 'Clutch Case' },
    { appId: 730, name: 'AK-47 | Redline (Field-Tested)', label: 'AK-47 | Redline (FT)' },
    { appId: 440, name: 'Mann Co. Supply Crate Key', label: 'Mann Co. Key' },
    { appId: 730, name: 'Kilowatt Case', label: 'Kilowatt Case' },
  ];
  const combined = [];
  const seen = new Set();
  const push = (entry) => {
    const key = entry.appId + ':' + entry.name;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push(entry);
  };
  for (const fav of readFavorites().slice(0, 2)) push({ appId: Number(fav.appId), name: fav.hashName, label: fav.name || fav.hashName });
  for (const h of loadHistory().slice(0, 2)) push({ appId: Number(h.appId), name: h.hashName, label: h.name || h.hashName });
  for (const def of defaults) push(def);

  const labelEl = container.querySelector('.quick-label');
  container.replaceChildren();
  if (labelEl) container.appendChild(labelEl);
  for (const item of combined.slice(0, 4)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-chip';
    btn.dataset.app = String(item.appId);
    btn.dataset.name = item.name;
    btn.append(document.createTextNode(item.label + ' '));
    const tag = document.createElement('span');
    tag.className = 'chip-tag';
    tag.textContent = appShortName(item.appId);
    btn.appendChild(tag);
    btn.addEventListener('click', () => {
      ensureAppOption(item.appId);
      state.appId = item.appId;
      $('app-select').value = String(item.appId);
      $('item-name').value = item.name;
      $('clear-input').hidden = false;
      saveSettings();
      calculate();
    });
    container.appendChild(btn);
  }
}

async function init() {
  await loadLocale();
  loadSettings();
  batch = createBatch({ t, toast, copyText, downloadCsv });
  bind();
  renderHistory();
  renderFavorites();
  renderQuickExamples();
  checkHealth();

  const params = new URLSearchParams(window.location.search);
  const name = params.get('name');
  if (name) {
    const appId = Number(params.get('app'));
    if (Number.isSafeInteger(appId) && appId > 0 && appId <= 1000000) ensureAppOption(appId);
    if (params.has('app') && optionHas($('app-select'), appId)) {
      state.appId = appId;
      $('app-select').value = String(appId);
    }
    const currency = Number(params.get('currency'));
    if (params.has('currency') && optionHas($('currency-select'), currency)) {
      state.currency = currency;
      $('currency-select').value = String(currency);
    }
    const strategy = params.get('strategy');
    if (strategy && optionHas($('strategy-select'), strategy)) {
      state.strategy = strategy;
      $('strategy-select').value = strategy;
    }
    const undercut = Number(params.get('undercut'));
    if (params.has('undercut') && params.get('undercut') !== '' && optionHas($('undercut-select'), undercut)) {
      state.undercut = undercut;
      $('undercut-select').value = String(undercut);
    }
    for (const key of ['steamFee', 'publisherFee']) {
      if (params.has(key)) { state[key] = clamp(num(params.get(key), DEFAULTS[key]), 0, 30); $('steam-fee').value = state.steamFee; $('publisher-fee').value = state.publisherFee; }
    }
    if (params.has('days') && [30, 90, 180, 365].includes(Number(params.get('days')))) state.historyDays = Number(params.get('days'));
    if (params.has('quantity')) state.quantity = clamp(Math.trunc(num(params.get('quantity'), 1)), 1, 10000);
    $('quantity').value = state.quantity;
    updateFeeSummary();
    $('item-name').value = name;
    $('clear-input').hidden = false;
    updateStrategyControls();
    saveSettings();
    calculate();
  }
}

init();