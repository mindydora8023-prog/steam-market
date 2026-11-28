import { batchAmount, batchCsv, estimateBatch } from './shared/batch.js';
import { currencyCode } from './shared/currency.js';
import { inventoryBatchRow, inventoryTier, parseSteamProfile } from './shared/inventory.js';
import { fetchJson } from './ui-utils.js';

const QUOTE_INTERVAL_MS = 1250;
const TIER_LABELS = { review: 'inventoryReview', regular: 'inventoryRegular', thin: 'inventoryThin' };
const TYPE_LABELS = {
  card: 'inventoryCard', background: 'inventoryBackground',
  emoticon: 'inventoryEmoticon', other: 'inventoryOther',
};
const NO_PRICE_CODES = new Set(['not-found', 'no-price-data', 'no-valid-price', 'below-fee-floor']);

export function createInventory({ t, batch, downloadCsv, requestQuote, getSettings }) {
  const byId = (name) => document.getElementById('inventory-' + name);
  const dialog = byId('dialog');
  const opener = byId('open');
  const profile = byId('profile');
  const list = byId('items');
  const game = byId('game');
  const foil = byId('foil');
  const selectVisible = byId('select-visible');
  const loadButton = byId('load');
  const importButton = byId('import');
  const start = byId('start');
  const pause = byId('pause');
  const cancel = byId('cancel');
  const mode = byId('mode');
  const loadStatus = byId('load-status');
  const runStatus = byId('run-status');
  const transferStatus = byId('transfer-status');
  const quotes = new Map();
  const selected = new Set();
  const imported = new Set();
  const visibleRows = new Map();
  let items = [];
  let settings;
  let loading = false;
  let active = false;
  let job;
  let inFlight;
  let nextQuoteAt = 0;
  let rateUntil = 0;
  let rateTimer;
  let loadController;

  const nameOf = (item) => item.hashName;
  const selectedItems = () => items.filter((item) => selected.has(nameOf(item)));
  const quoteOf = (item) => quotes.get(nameOf(item));
  const tierOf = (item) => inventoryTier(item, quoteOf(item), settings.currency);
  const visibleItems = () => items.filter((item) =>
    (!foil.checked || item.foil) && (game.value === 'all' || game.value === 'game:' + item.gameKey));
  const textAmount = (minor) => batchAmount(minor, settings.currency) + ' ' + currencyCode(settings.currency);
  const snapshot = (item) => inventoryBatchRow(item, quoteOf(item), settings);

  function eligible(item, scope) {
    if (scope === 'all') return true;
    if (scope === 'priced') return quoteOf(item)?.ok === true;
    return item.type === 'card' && tierOf(item) === scope;
  }

  function readyToImport(chosen) {
    return chosen.filter((item) => !imported.has(nameOf(item)) && eligible(item, mode.value));
  }

  function renderProgress() {
    const chosen = selectedItems();
    const queued = job?.phase === 'running' || job?.phase === 'paused';
    const checked = queued ? job.items : chosen;
    const done = checked.filter((item) => quotes.has(nameOf(item))).length;
    let net = 0n;
    let hasPrice = false;
    for (const item of chosen) {
      const quote = quoteOf(item);
      if (!quote?.ok) continue;
      net += BigInt(quote.recommendation.receive) * BigInt(item.count);
      hasPrice = true;
    }
    const progress = byId('progress');
    progress.max = checked.length || 1;
    progress.value = done;
    byId('progress-label').textContent = t('inventoryProgress', { done, total: checked.length });
    byId('net').textContent = hasPrice ? t('inventoryNet', { amount: textAmount(net) }) : '';

    const waiting = rateUntil > Date.now();
    const remaining = job?.phase === 'paused' ? checked : chosen;
    loadButton.disabled = loading || active || waiting;
    const hasPending = remaining.some((item) => !quotes.has(nameOf(item)));
    const finished = job?.phase === 'complete' && !hasPending;
    progress.hidden = finished;
    start.hidden = job?.phase === 'running' || finished;
    start.disabled = loading || active || waiting || !hasPending;
    start.textContent = t(job?.phase === 'paused' ? 'inventoryResume' : 'inventoryStart');
    pause.hidden = job?.phase !== 'running';
    cancel.hidden = job?.phase !== 'running' && job?.phase !== 'paused';
    const hasNewImports = readyToImport(chosen).length > 0;
    importButton.disabled = loading || (!hasNewImports && imported.size === 0);
    importButton.textContent = t(!hasNewImports && imported.size ? 'inventoryViewBatch' : 'inventoryImport');
    byId('export').disabled = loading || !chosen.some((item) => eligible(item, 'priced'));
    const readyToTransfer = finished && !importButton.disabled;
    loadButton.classList.toggle('primary', !readyToTransfer);
    loadButton.classList.toggle('ghost', readyToTransfer);
    importButton.classList.toggle('primary', readyToTransfer);
    importButton.classList.toggle('ghost', !readyToTransfer);
  }

  function renderSelection() {
    const chosen = selectedItems();
    const visible = visibleItems();
    const checked = visible.filter((item) => selected.has(nameOf(item))).length;
    selectVisible.disabled = !visible.length;
    selectVisible.checked = visible.length > 0 && checked === visible.length;
    selectVisible.indeterminate = checked > 0 && checked < visible.length;
    const hidden = chosen.filter((item) => !visibleRows.has(nameOf(item)));
    const quantity = (rows) => rows.reduce((sum, item) => sum + item.count, 0);
    const summary = t('inventorySelection', { kinds: chosen.length, quantity: quantity(chosen) });
    byId('selection').textContent = hidden.length
      ? summary + t('inventorySelectionHidden', { kinds: hidden.length, quantity: quantity(hidden) })
      : summary;
    renderProgress();
  }

  function renderPrice(item) {
    const row = visibleRows.get(nameOf(item));
    if (!row) return;
    const tier = tierOf(item);
    const quote = quoteOf(item);
    const label = row.querySelector('.inventory-tier');
    const status = inFlight === item ? 'inventoryPricing' :
      !quote ? 'inventoryUnquoted' :
      NO_PRICE_CODES.has(quote.error?.code) ? 'inventoryNoPrice' : 'inventoryPriceFailed';
    label.dataset.tier = tier || 'pending';
    label.textContent = t(TIER_LABELS[tier] || status);
    row.querySelector('.inventory-unit').textContent = quote?.ok
      ? t('inventoryPriceEach', { amount: textAmount(quote.recommendation.receive) })
      : tier ? t(status) : '';
  }

  function renderRows() {
    visibleRows.clear();
    const fragment = document.createDocumentFragment();
    for (const item of visibleItems()) {
      const row = byId('item-template').content.firstElementChild.cloneNode(true);
      const input = row.querySelector('.inventory-pick');
      input.checked = selected.has(nameOf(item));
      input.addEventListener('change', () => {
        if (input.checked) selected.add(nameOf(item));
        else selected.delete(nameOf(item));
        transferStatus.textContent = '';
        renderSelection();
      });
      row.querySelector('.inventory-name').textContent = item.name;
      row.querySelector('.inventory-item-meta').textContent = [
        item.gameName || t('inventoryUnknownGame'),
        t(item.foil ? 'inventoryFoil' : TYPE_LABELS[item.type]),
        'x' + item.count.toLocaleString('zh-CN'),
      ].join(' \u00b7 ');
      if (item.iconUrl) {
        const icon = row.querySelector('.inventory-icon');
        icon.addEventListener('error', () => { icon.hidden = true; }, { once: true });
        icon.src = item.iconUrl;
        icon.hidden = false;
      }
      visibleRows.set(nameOf(item), row);
      renderPrice(item);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    byId('no-match').hidden = visibleRows.size > 0;
    renderSelection();
  }

  function setCooldown(error, target) {
    rateUntil = Date.now() + Math.max(1, Number(error.retryAfterMs) || 60000);
    clearInterval(rateTimer);
    const tick = () => {
      const seconds = Math.ceil((rateUntil - Date.now()) / 1000);
      target.textContent = t(seconds > 0 ? 'inventoryRate' : 'inventoryRateReady', { seconds });
      if (seconds <= 0) clearInterval(rateTimer);
      renderProgress();
    };
    rateTimer = setInterval(tick, 1000);
    tick();
  }

  async function load(event) {
    event.preventDefault();
    if (loading || active || rateUntil > Date.now()) return;
    const input = profile.value.trim();
    if (!parseSteamProfile(input)) {
      profile.setAttribute('aria-invalid', 'true');
      loadStatus.textContent = t('inventoryBadRequest');
      profile.focus();
      return;
    }
    profile.removeAttribute('aria-invalid');
    const onlyCards = !byId('other').checked;
    const controller = new AbortController();
    loadController = controller;
    loading = true;
    job = null;
    byId('results').hidden = byId('actions').hidden = byId('currency').hidden = true;
    byId('help').hidden = false;
    items = [];
    selected.clear();
    quotes.clear();
    imported.clear();
    loadStatus.textContent = t('inventoryLoading');
    runStatus.textContent = transferStatus.textContent = '';
    renderProgress();
    try {
      const params = new URLSearchParams({ steamId: input, onlyCards: onlyCards ? '1' : '0' });
      const data = await fetchJson('./api/inventory?' + params, {
        signal: controller.signal, timeoutMs: 65000, credentials: 'omit',
      });
      if (controller.signal.aborted) return;
      if (!data.ok) {
        const code = data.error?.code;
        if (code === 'rate-limited') setCooldown(data.error, loadStatus);
        else {
          loadStatus.textContent = t({
            'bad-request': 'inventoryBadRequest',
            'inventory-private': 'inventoryPrivate',
            'inventory-profile-unavailable': 'inventoryProfileUnavailable',
            'inventory-empty': onlyCards ? 'inventoryEmptyCards' : 'inventoryEmptyAll',
          }[code] || 'inventoryUpstream');
        }
        return;
      }
      const { currency, undercut, steamFee, publisherFee } = getSettings();
      settings = { currency, undercut, steamFee, publisherFee, strategy: 'smart' };
      byId('currency').textContent = t('inventoryCurrency', { currency: currencyCode(currency) });
      for (const [field, value] of Object.entries({
        quantity: data.totalCount, kinds: data.kindCount, foils: data.foilCount, games: data.gameCount,
      })) byId(field).textContent = value.toLocaleString('zh-CN');
      const note = byId('truncated');
      note.hidden = !data.truncated;
      note.textContent = data.truncated ? t('inventoryTruncated', { pages: data.pages }) : '';
      game.replaceChildren(new Option(t('inventoryAllGames'), 'all'));
      const games = [...data.games].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of games) {
        game.add(new Option(entry.name || t('inventoryUnknownGame'), 'game:' + entry.key));
      }
      foil.checked = false;
      items = data.items;
      for (const item of items) selected.add(nameOf(item));
      loadStatus.textContent = '';
      renderRows();
      byId('results').hidden = byId('actions').hidden = byId('currency').hidden = false;
      byId('help').hidden = true;
    } catch {
      loadStatus.textContent = controller.signal.aborted ? '' : t('inventoryUpstream');
    } finally {
      loadController = null;
      loading = false;
      renderProgress();
    }
  }

  async function run() {
    if (active || loading || rateUntil > Date.now()) return;
    if (job?.phase !== 'paused') job = { items: selectedItems() };
    const current = job;
    const pendingBatchPrices = [];
    job.phase = 'running';
    active = true;
    runStatus.textContent = '';
    renderProgress();
    pause.focus({ preventScroll: true });
    try {
      for (const item of current.items) {
        if (current.phase !== 'running') break;
        if (quotes.has(nameOf(item))) continue;
        const delay = nextQuoteAt - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (current.phase !== 'running') break;
        inFlight = item;
        renderPrice(item);
        nextQuoteAt = Date.now() + QUOTE_INTERVAL_MS;
        let quote;
        try {
          quote = await requestQuote({ ...settings, appId: item.appId, name: nameOf(item) }, { exact: true });
        } catch {
          quote = { ok: false };
        }
        inFlight = null;
        if (current.phase === 'cancelled') {
          renderPrice(item);
          break;
        }
        if (!quote.ok && !NO_PRICE_CODES.has(quote.error?.code)) {
          const restoreFocus = document.activeElement === pause;
          current.phase = 'paused';
          renderPrice(item);
          if (quote.error?.code === 'rate-limited') setCooldown(quote.error, runStatus);
          else {
            runStatus.textContent = t('inventoryQuoteRetry');
            renderProgress();
          }
          if (restoreFocus) cancel.focus({ preventScroll: true });
          break;
        }
        quotes.set(nameOf(item), quote);
        if (quote.ok && imported.has(nameOf(item))) pendingBatchPrices.push(snapshot(item));
        renderPrice(item);
        renderProgress();
      }
      if (current.items.every((item) => quotes.has(nameOf(item)))) {
        current.phase = 'complete';
        runStatus.textContent = '';
      }
    } finally {
      const restoreFocus = document.activeElement === pause && current.phase === 'complete';
      active = false;
      if (pendingBatchPrices.length) {
        const kinds = batch.fillPrices(pendingBatchPrices);
        if (kinds) transferStatus.textContent = t('inventoryBatchUpdated', { kinds });
      }
      renderProgress();
      if (restoreFocus) {
        const next = start.hidden ? (importButton.disabled ? byId('close') : importButton) : start;
        next.focus({ preventScroll: true });
      }
    }
  }

  function pauseJob() {
    if (job?.phase !== 'running') return;
    const restoreFocus = document.activeElement === pause;
    job.phase = 'paused';
    runStatus.textContent = t('inventoryPaused');
    renderProgress();
    if (restoreFocus && dialog.open) cancel.focus({ preventScroll: true });
  }

  opener.addEventListener('click', () => dialog.showModal());
  byId('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    loadController?.abort();
    pauseJob();
    if (!document.getElementById('batch-dialog').open) opener.focus({ preventScroll: true });
  });
  byId('form').addEventListener('submit', load);
  profile.addEventListener('input', () => profile.removeAttribute('aria-invalid'));
  game.addEventListener('change', renderRows);
  foil.addEventListener('change', renderRows);
  selectVisible.addEventListener('change', () => {
    for (const item of visibleItems()) {
      if (selectVisible.checked) selected.add(nameOf(item));
      else selected.delete(nameOf(item));
      visibleRows.get(nameOf(item)).querySelector('.inventory-pick').checked = selectVisible.checked;
    }
    transferStatus.textContent = '';
    renderSelection();
  });
  start.addEventListener('click', run);
  pause.addEventListener('click', pauseJob);
  cancel.addEventListener('click', () => {
    job.phase = 'cancelled';
    if (rateUntil <= Date.now()) runStatus.textContent = t('inventoryCancelled');
    renderProgress();
  });
  mode.addEventListener('change', () => {
    transferStatus.textContent = '';
    renderProgress();
  });
  importButton.addEventListener('click', () => {
    const chosen = readyToImport(selectedItems());
    if (!chosen.length) {
      if (imported.size) {
        dialog.close();
        batch.open(opener);
      }
      return;
    }
    const error = batch.importRows(chosen.map(snapshot), opener, () => dialog.close());
    if (error) {
      transferStatus.textContent = t({
        'row-limit': 'batchRowLimit', 'quantity-limit': 'batchQuantityLimit',
      }[error] || 'inventoryTransferInvalid');
      return;
    }
    for (const item of chosen) imported.add(nameOf(item));
    renderProgress();
  });
  byId('export').addEventListener('click', () => {
    const rows = selectedItems().filter((item) => eligible(item, 'priced')).map(snapshot);
    const report = estimateBatch({ rows, strategy: settings.strategy });
    if (report.lines.length !== rows.length || report.unpricedQuantity) {
      transferStatus.textContent = t('inventoryExportUnavailable');
      return;
    }
    downloadCsv(batchCsv(report), 'steam-market-inventory.csv');
    transferStatus.textContent = t('inventoryExported');
  });
}
