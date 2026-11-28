import {
  addBatchRow, batchAmount, batchCsv, batchMarkdown, cleanBatch, estimateBatch,
  MAX_BATCH_QUANTITY, parseBatchPrice,
} from './shared/batch.js';
import { currencyInfo } from './shared/currency.js';

const STORAGE_KEY = 'steam-price-batch-v1';

export function createBatch({ t, toast, copyText, downloadCsv }) {
  const byId = (id) => document.getElementById(id);
  const dialog = byId('batch-dialog');
  const opener = byId('batch-open');
  const strategy = byId('batch-strategy');
  const list = byId('batch-rows');
  const groups = byId('batch-groups');
  const clear = byId('batch-clear');
  const copy = byId('batch-copy');
  const download = byId('batch-download');
  const warning = byId('batch-storage');
  let data = cleanBatch();
  let report;
  let cleared = null;
  let trigger = opener;

  function read() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      warning.hidden = true;
      try { data = cleanBatch(JSON.parse(saved)); }
      catch { data = cleanBatch(); }
    } catch {
      warning.hidden = false;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      warning.hidden = true;
    } catch {
      warning.hidden = false;
    }
  }

  function open(button) {
    if (dialog.open) return;
    trigger = button?.isConnected ? button : opener;
    message('');
    dialog.showModal();
  }

  function message(text) {
    byId('batch-status').textContent = text;
  }

  function priceText(minor, currency) {
    return batchAmount(minor, currency) + ' ' + currencyInfo(currency).code;
  }

  function metric(label, value, tone = '') {
    const block = document.createElement('div');
    const term = document.createElement('dt');
    const amount = document.createElement('dd');
    term.textContent = t(label);
    amount.textContent = value;
    if (tone) amount.className = tone;
    block.append(term, amount);
    return block;
  }

  function renderTotals() {
    report = estimateBatch(data);
    const invalid = Boolean(list.querySelector('[aria-invalid="true"]'));
    const hasRows = report.lines.length > 0;
    const blocked = !hasRows || invalid || report.unpricedQuantity > 0;
    copy.disabled = blocked;
    download.disabled = blocked;
    byId('batch-count').textContent = report.quantity.toLocaleString('zh-CN');
    byId('batch-count').hidden = !hasRows;
    opener.setAttribute('aria-label', t('batchOpenLabel', { quantity: report.quantity }));
    byId('batch-total-count').textContent = t('batchTotalCount', { quantity: report.quantity });
    byId('batch-empty').hidden = hasRows;
    byId('batch-mixed').hidden = report.groups.length <= 1;
    byId('batch-export-note').textContent = invalid ? t('batchInvalidEdits') :
      report.unpricedQuantity ? t('batchUnpriced', { quantity: report.unpricedQuantity }) : '';
    clear.disabled = !hasRows && !cleared;
    clear.textContent = t(cleared ? 'batchUndo' : 'batchClear');

    groups.replaceChildren();
    for (const group of report.groups) {
      const section = document.createElement('section');
      section.className = 'batch-currency';
      const heading = document.createElement('h3');
      heading.textContent = currencyInfo(group.currency).code + ' \u00b7 ' +
        t('batchTotalCount', { quantity: group.quantity });
      const totals = document.createElement('dl');
      totals.className = 'batch-metrics';
      const amount = (field) => group.pricedQuantity ? batchAmount(group[field], group.currency) : '\u2014';
      totals.append(
        metric('batchBuyer', amount('buyerPays'), 'batch-gold'),
        metric('batchFees', amount('totalFees')),
        metric('batchNet', amount('receive'), 'batch-net'),
        metric('batchSteamFee', amount('steamFee')),
        metric('batchPublisherFee', amount('publisherFee')),
      );
      section.append(heading, totals);
      groups.append(section);
    }

    for (const [index, line] of report.lines.entries()) {
      const node = list.children[index];
      const prices = node.querySelector('.batch-line-prices');
      const hint = node.querySelector('.batch-line-note');
      prices.hidden = !line.price;
      if (line.price) {
        const fmt = (value) => priceText(value, line.currency);
        prices.replaceChildren(
          metric('batchBuyerEach', fmt(line.price.buyerPays), 'batch-gold'),
          metric('batchNetEach', fmt(line.price.receive)),
          metric('batchNetSubtotal', fmt(line.subtotal.receive), 'batch-net'),
        );
      }
      hint.textContent = !line.price
        ? line.minimum
          ? t('batchPriceFloor', { price: priceText(line.minimum, line.currency) })
          : t('batchNoStrategyPrice')
        : line.strategy === 'custom' && line.price.buyerPays !== line.priceOverride
          ? t('batchPriceAdjusted', { price: priceText(line.price.buyerPays, line.currency) })
          : '';
      hint.classList.toggle('batch-warning', !line.price);
    }
  }

  function bindField(input, row, field, parse, errorLabel) {
    const error = input.parentElement.querySelector('.batch-field-error');
    input.addEventListener('input', () => {
      const value = parse(input.value);
      const invalid = Number.isNaN(value);
      input.setAttribute('aria-invalid', String(invalid));
      error.textContent = invalid ? t(errorLabel) : '';
      if (!invalid && value !== row[field]) {
        row[field] = value;
        save();
      }
      renderTotals();
    });
  }

  function renderRows() {
    strategy.value = data.strategy;
    list.replaceChildren();
    for (const [index, row] of data.rows.entries()) {
      const node = byId('batch-row-template').content.firstElementChild.cloneNode(true);
      node.querySelector('.batch-item-name').textContent = row.name;
      node.querySelector('.batch-item-meta').textContent = 'App ' + row.appId + ' \u00b7 ' + currencyInfo(row.currency).code;
      const quantity = node.querySelector('.batch-quantity');
      const price = node.querySelector('.batch-price');
      quantity.value = row.quantity;
      quantity.max = MAX_BATCH_QUANTITY;
      price.value = row.priceOverride === null ? '' : batchAmount(row.priceOverride, row.currency);
      for (const [field, input] of [['quantity', quantity], ['price', price]]) {
        const errorId = 'batch-' + field + '-error-' + index;
        input.setAttribute('aria-describedby', errorId);
        input.parentElement.querySelector('.batch-field-error').id = errorId;
      }
      const lineNote = node.querySelector('.batch-line-note');
      lineNote.id = 'batch-line-note-' + index;
      price.setAttribute('aria-describedby', price.getAttribute('aria-describedby') + ' ' + lineNote.id);
      bindField(quantity, row, 'quantity', (raw) => {
        const value = Number(raw);
        return Number.isInteger(value) && value >= 1 && value <= MAX_BATCH_QUANTITY ? value : NaN;
      }, 'batchQuantityInvalid');
      bindField(price, row, 'priceOverride', (raw) => parseBatchPrice(raw, row.currency), 'batchPriceInvalid');

      const remove = node.querySelector('.batch-remove');
      remove.setAttribute('aria-label', t('batchRemoveItem', { name: row.name }));
      remove.addEventListener('click', () => {
        data.rows.splice(index, 1);
        save();
        renderRows();
        const next = list.children[Math.min(index, list.children.length - 1)];
        (next?.querySelector('.batch-remove') || byId('batch-close')).focus();
        message(t('batchRemoved', { name: row.name }));
      });
      list.append(node);
    }
    renderTotals();
  }

  function add(quote, settings, quantity, button) {
    const result = addBatchRow(data.rows, {
      appId: quote.item.appId,
      name: quote.item.hashName,
      currency: quote.currency,
      lowest: quote.market.lowest,
      median: quote.market.median,
      undercut: settings.undercut,
      steamFee: settings.steamFee,
      publisherFee: settings.publisherFee,
      quantity,
    });
    if (!result.ok) {
      const text = t({ 'row-limit': 'batchRowLimit', 'quantity-limit': 'batchQuantityLimit', invalid: 'batchNoQuote' }[result.code]);
      if (dialog.open) message(text);
      else toast(text);
      return;
    }
    data.rows = result.rows;
    cleared = null;
    save();
    renderRows();
    open(button);
    message(t('batchAdded', { name: quote.item.hashName }));
  }

  read();
  renderRows();
  opener.addEventListener('click', () => open(opener));
  byId('batch-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => (trigger.isConnected ? trigger : opener).focus({ preventScroll: true }));
  strategy.addEventListener('change', () => {
    data.strategy = strategy.value;
    save();
    renderTotals();
  });
  clear.addEventListener('click', () => {
    if (cleared) {
      data.rows = cleared;
      cleared = null;
      message(t('batchRestored'));
    } else {
      cleared = data.rows;
      data.rows = [];
      message(t('batchCleared'));
    }
    save();
    renderRows();
  });
  copy.addEventListener('click', () => copyText(batchMarkdown(report), t('batchCopied'), {
    container: dialog, notice: message,
  }));
  download.addEventListener('click', () => {
    downloadCsv(batchCsv(report), 'steam-market-batch.csv');
    message(t('batchExported'));
  });
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage || (event.key !== STORAGE_KEY && event.key !== null)) return;
    cleared = null;
    read();
    renderRows();
  });

  return { add };
}
