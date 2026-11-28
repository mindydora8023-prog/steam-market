import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../app/app.mjs';
import { MarketError } from '../app/steam.mjs';
import { summarizeInventory } from '../lib/inventory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright-core/index.mjs');
if (!fs.existsSync(modulePath)) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright-core index.mjs.');
const { chromium } = await import(pathToFileURL(modulePath));
const out = process.env.UI_EVIDENCE_DIR || path.join(root, '.ui-evidence');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });
let quoteCalls = 0;
const item = { appId: 730, name: 'Clutch Case', hashName: 'Clutch Case', appName: 'Counter-Strike 2', type: 'Container', iconUrl: '', sellListings: 100 };
const inventoryQuotes = [];
let activeInventoryQuotes = 0;
let maxInventoryQuotes = 0;
const inventoryItems = [
  ['Regular card', 3, 'card', false],
  ['Foil card', 2, 'card', true],
  ['Fee floor card', 1, 'card', false],
  ['No market card', 1, 'card', false],
  ['Background', 4, 'background', false],
].map(([name, count, type, foil]) => ({
  appId: 753, hashName: name, name, type, foil, count, iconUrl: '',
  gameKey: type === 'card' ? 'app_100' : 'app_101',
  gameName: type === 'card' ? 'A Game with a Long Name' : 'Other Game',
}));
// Keep two distinct games in the default cards-only view.
inventoryItems[3].gameKey = 'app_102';
inventoryItems[3].gameName = 'Another Card Game';

const steam = {
  proxyLabel: 'direct',
  async search(appId, query) { return { results: query === 'none' ? [] : [{ ...item, appId }], fetchedAt: new Date().toISOString() }; },
  async price(appId, name) {
    quoteCalls++;
    const fetchedAt = new Date().toISOString();
    if (appId !== 753) return { ok: true, lowest: 361, median: 356, volume: 6159, fetchedAt };
    inventoryQuotes.push({ name, time: Date.now() });
    activeInventoryQuotes++;
    maxInventoryQuotes = Math.max(maxInventoryQuotes, activeInventoryQuotes);
    try {
      await new Promise((resolve) => setTimeout(resolve, 90));
      if (name === 'Foil card' && inventoryQuotes.filter((call) => call.name === name).length === 1) {
        throw new MarketError('rate-limited', 'Fixture rate limit', { status: 429, retryAfterMs: 1600 });
      }
      if (name === 'Fee floor card' && inventoryQuotes.filter((call) => call.name === name).length === 1) {
        throw new MarketError('upstream', 'Fixture upstream error');
      }
      if (name === 'No market card') return { ok: false, code: 'no-market-data', fetchedAt };
      const lowest = { 'Regular card': 30, 'Foil card': 110, 'Fee floor card': 21 }[name] || 50;
      return { ok: true, lowest, median: lowest, volume: 50, fetchedAt };
    } finally {
      activeInventoryQuotes--;
    }
  },
  async inventory(input, { onlyCards }) {
    if (input.endsWith('/private-fixture')) throw new MarketError('inventory-private', 'Private', { status: 403 });
    return {
      ...summarizeInventory(inventoryItems, onlyCards), steamId: '76561198000000001',
      pages: onlyCards ? 1 : 5, truncated: !onlyCards, cached: false,
    };
  },
  async history() {
    const now = Math.floor(Date.now() / 1000);
    return { currency: 23, fetchedAt: new Date().toISOString(), points: Array.from({ length: 365 }, (_, i) => ({ time: now - (364 - i) * 86400, price: 3.2 + Math.sin(i / 12) * .35 + i / 1000, volume: 100 + i })) };
  },
};
const mount = '/steam/';
const app = createApp({ steam, version, publicDir: path.join(root, 'app/public') });
const server = http.createServer((req, res) => {
  if (!req.url.startsWith(mount)) {
    res.writeHead(404).end();
    return;
  }
  req.url = req.url.slice(mount.length - 1);
  app(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + mount;
let browser;
const errors = [];
const checks = [];
function pass(name) { checks.push(name); console.log('PASS ' + name); }
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined), headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  async function capture(options) {
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
      let badge = document.getElementById('test-evidence-badge');
      if (!badge) {
        badge = document.createElement('div'); badge.id = 'test-evidence-badge';
        badge.textContent = '\u6d4b\u8bd5\u884c\u60c5 \u00b7 \u79bb\u7ebf\u6d4f\u89c8\u5668\u9a8c\u8bc1';
        Object.assign(badge.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '999', color: '#f3d488', background: '#13232f', padding: '6px 10px', border: '1px solid #f3d488', borderRadius: '6px', fontSize: '12px', pointerEvents: 'none' });
        document.body.appendChild(badge);
      }
    });
    await page.screenshot(options);
  }
  const stylesheet = page.waitForResponse(base + 'styles.css');
  await page.goto(base);
  assert.equal((await stylesheet).status(), 200);
  assert.ok(await page.locator('.brand-mark svg').evaluate((svg) => svg.getBoundingClientRect().width < 64));
  await page.waitForFunction((expected) => document.querySelector('#version').textContent.includes(expected), version);
  pass('stylesheet and health load through the reverse proxy prefix');
  await capture({ path: path.join(out, 'desktop-empty.png') });
  await page.click('#calculate');
  assert.equal(await page.getAttribute('#item-name', 'aria-invalid'), 'true');
  assert.equal(await page.isVisible('#name-error'), true);
  pass('empty names show a persistent field error');
  await page.fill('#item-name', 'Clutch');
  await page.waitForSelector('#suggestion-0');
  await page.press('#item-name', 'ArrowDown');
  assert.equal(await page.getAttribute('#item-name', 'aria-activedescendant'), 'suggestion-0');
  await page.press('#item-name', 'Enter');
  await page.waitForSelector('#result:not([hidden])');
  await page.waitForSelector('#strategy-options button');
  await page.waitForSelector('#price-chart .price-line');
  pass('keyboard search selects and calculates canonical item');
  await page.click('#copy-price');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /^\d+\.\d{2}$/);
  pass('clipboard contains numeric amount without currency symbol');
  const callsBeforeStrategy = quoteCalls;
  await page.click('#strategy-options button:nth-child(3)');
  assert.equal(await page.inputValue('#strategy-select'), 'match');
  assert.equal(quoteCalls, callsBeforeStrategy);
  pass('strategy comparison switches without another Steam request');
  await page.fill('#quantity', '12');
  assert.match(await page.textContent('#quantity-total'), /12/);
  await page.click('#favorite-quote');
  assert.equal(await page.getAttribute('#favorite-quote', 'aria-pressed'), 'true');
  await page.reload();
  await page.waitForSelector('#strategy-options button');
  assert.equal(await page.inputValue('#quantity'), '12');
  assert.equal(await page.getAttribute('#favorite-quote', 'aria-pressed'), 'true');
  pass('quantity, favorites, and share query survive reload');
  await page.waitForSelector('#price-chart .price-line');
  assert.ok(await page.locator('#price-chart .ma-line').count() === 1);
  assert.ok(await page.locator('#price-chart .vol-bar').count() > 30);
  await page.click('#toggle-ma');
  assert.equal(await page.locator('#price-chart .ma-line').count(), 0);
  await page.click('#toggle-ma');
  assert.equal(await page.locator('#price-chart .ma-line').count(), 1);
  pass('chart MA7 and volume overlay render and toggle cleanly');
  await page.fill('#custom-receive', '5.00');
  assert.match(await page.inputValue('#custom-buyer'), /^\d+\.\d{2}$/);
  assert.notEqual(await page.inputValue('#custom-buyer'), '5.00');
  assert.equal(await page.isVisible('#bd-custom-badge'), true);
  assert.match(await page.textContent('#bd-receive'), /5\.00/);
  await page.click('#copy-custom-buyer');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.inputValue('#custom-buyer'));
  await page.click('#reset-custom');
  assert.equal(await page.isVisible('#bd-custom-badge'), false);
  pass('custom price calculator supports reverse receive calculation, live breakdown sync, and copy');
  await page.click('#favorites-list .side-action-pin');
  assert.equal(await page.getAttribute('#favorites-list .side-action-pin', 'aria-pressed'), 'true');
  pass('favorites can be pinned in sidebar');
  await page.focus('#price-chart');
  await page.keyboard.press('Home');
  const first = await page.textContent('#chart-selection');
  await page.keyboard.press('End');
  assert.notEqual(await page.textContent('#chart-selection'), first);
  await page.click('#chart-table-details summary');
  assert.ok(await page.locator('#chart-table tr').count() > 30);
  const download = page.waitForEvent('download');
  await page.click('#export-history');
  assert.match((await download).suggestedFilename(), /steam-market-180d.csv/);
  pass('chart keyboard navigation, accessible table, and CSV export');
  await page.click('#clear-history');
  assert.equal(await page.locator('.history-item').count(), 1);
  await page.click('#clear-history');
  assert.ok(await page.locator('#history-list .history-item').count() > 0);
  pass('cleared history can be restored');
  await page.fill('#item-name', 'https://steamcommunity.com/market/listings/730/Clutch%20Case');
  await page.click('#calculate');
  await page.waitForFunction(() => document.querySelector('#item-name').value === 'Clutch Case' && document.querySelector('#calculate').disabled === false);
  pass('Steam listing URL is normalized to app id and canonical name');
  await page.locator('#result').scrollIntoViewIfNeeded();
  await capture({ path: path.join(out, 'desktop-result.png'), fullPage: true });
  await page.route('**/api/quote?**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'upstream' } }) }));
  await page.click('#refresh-quote');
  await page.waitForSelector('#error-box:not([hidden])');
  assert.equal(await page.isVisible('#result'), true);
  assert.equal(await page.isVisible('#result-stale'), true);
  assert.equal(await page.isDisabled('#copy-price'), true);
  await page.dispatchEvent('#copy-price', 'click');
  assert.match(await page.textContent('#toast'), /\u91cd\u65b0\u8ba1\u7b97/);
  await capture({ path: path.join(out, 'desktop-error.png') });
  pass('failed refresh retains old quote and marks it stale');
  await page.unroute('**/api/quote?**');
  await page.click('#retry-quote');
  await page.waitForSelector('#error-box[hidden]', { state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#calculate').disabled);
  await page.fill('#item-name', 'Clutch newer');
  assert.equal(await page.isDisabled('#batch-add-quote'), true);
  assert.equal(await page.isDisabled('#copy-price'), true);
  await page.dispatchEvent('#copy-price', 'click');
  assert.match(await page.textContent('#toast'), /\u91cd\u65b0\u8ba1\u7b97/);
  pass('changed inputs cannot copy an old quote');
  await page.route('**/api/quote?**', async (route) => { await new Promise((resolve) => setTimeout(resolve, 350)); try { await route.continue(); } catch { /* Cancelled by the user. */ } });
  await page.click('#calculate');
  await page.waitForSelector('#query-status:not([hidden])');
  await page.click('#cancel-query');
  assert.equal(await page.isEnabled('#calculate'), true);
  assert.equal(await page.isVisible('#query-status'), false);
  await page.unroute('**/api/quote?**');
  pass('queries can be cancelled without leaving the form busy');
  await page.route('**/api/quote?**', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'rate-limited', retryAfterMs: 1000 } }) }));
  await page.click('#calculate');
  await page.waitForSelector('#cooldown-note:not([hidden])');
  assert.equal(await page.isEnabled('#calculate'), false);
  await page.waitForSelector('#cooldown-note[hidden]', { state: 'attached' });
  assert.equal(await page.isEnabled('#calculate'), true);
  await page.unroute('**/api/quote?**');
  pass('rate-limit countdown disables refresh until the cooldown expires');
  const beforeComposition = quoteCalls;
  await page.dispatchEvent('#item-name', 'compositionstart');
  await page.fill('#item-name', 'Composing');
  await page.press('#item-name', 'Enter');
  assert.equal(quoteCalls, beforeComposition);
  await page.dispatchEvent('#item-name', 'compositionend');
  pass('IME composition Enter does not submit a quote');
  let oldSeen;
  let releaseOld;
  const seen = new Promise((resolve) => { oldSeen = resolve; });
  const release = new Promise((resolve) => { releaseOld = resolve; });
  await page.route('**/api/search?**', async (route) => {
    const old = new URL(route.request().url()).searchParams.get('q') === 'Race old';
    if (old) { oldSeen(); await release; }
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: [{ ...item, name: old ? 'Old response' : 'New response' }] }) }); } catch { /* An old search can be cancelled. */ }
  });
  await page.fill('#item-name', 'Race old');
  await Promise.race([seen, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Old search did not start')), 4000); timer.unref(); })]);
  await page.fill('#item-name', 'Race new');
  await page.waitForFunction(() => document.querySelector('#suggestion-0')?.textContent.includes('New response'));
  releaseOld();
  assert.match(await page.textContent('#suggestions'), /New response/);
  await page.unroute('**/api/search?**');
  pass('late autocomplete responses cannot replace a newer search');
  const batchContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const batchPage = await batchContext.newPage();
  batchPage.setDefaultTimeout(8000);
  batchPage.on('pageerror', (error) => errors.push(error.message));
  await batchPage.addInitScript(() => {
    const key = 'steam-price-favorites-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([{
      appId: 730, name: 'Kilowatt Case', hashName: 'Kilowatt Case', currency: 8,
    }]));
  });
  await batchPage.goto(base + '?name=Clutch%20Case&quantity=3&currency=23');
  await batchPage.waitForSelector('#batch-add-quote:enabled');
  await batchPage.click('#batch-open');
  assert.equal(await batchPage.isVisible('#batch-empty'), true);
  await batchPage.keyboard.press('Escape');
  await batchPage.waitForFunction(() => document.activeElement.id === 'batch-open');
  await batchPage.click('#batch-add-quote');
  assert.equal(await batchPage.inputValue('.batch-quantity'), '3');
  await batchPage.fill('.batch-price', '0.29');
  await batchPage.fill('.batch-quantity', '2');
  assert.deepEqual(await batchPage.locator('#batch-groups dd').allTextContents(), ['0.58', '0.28', '0.30', '0.14', '0.14']);
  await batchPage.selectOption('#batch-strategy', 'median');
  assert.match(await batchPage.textContent('.batch-line-prices'), /0\.29/);
  await batchPage.fill('.batch-price', '');
  assert.match(await batchPage.textContent('.batch-line-prices'), /3\.56/);
  await batchPage.fill('.batch-price', '0.20');
  assert.equal(await batchPage.isDisabled('#batch-copy'), true);
  assert.match(await batchPage.textContent('.batch-line-note'), /0\.21 CNY/);
  await batchPage.fill('.batch-price', '0.291');
  assert.equal(await batchPage.getAttribute('.batch-price', 'aria-invalid'), 'true');
  await batchPage.fill('.batch-price', '0.29');
  await batchPage.fill('.batch-quantity', '');
  assert.equal(await batchPage.isDisabled('#batch-download'), true);
  await batchPage.fill('.batch-quantity', '2');
  await batchPage.keyboard.press('Escape');
  await batchPage.waitForFunction(() => document.activeElement.id === 'batch-add-quote');
  pass('batch drawer preserves focus and calculates quantity, strategy and custom fee floors');

  await batchPage.click('#favorites-list .side-action-batch');
  await batchPage.waitForSelector('#batch-dialog[open]');
  assert.equal(await batchPage.locator('.batch-row').count(), 2);
  assert.equal(await batchPage.inputValue('#item-name'), 'Clutch Case');
  assert.match(await batchPage.textContent('#batch-total-count'), /3/);
  assert.equal(await batchPage.isVisible('#batch-mixed'), true);
  assert.deepEqual((await batchPage.locator('.batch-currency h3').allTextContents()).map((text) => text.slice(0, 3)), ['CNY', 'JPY']);
  await batchPage.click('#batch-copy');
  const markdown = await batchPage.evaluate(() => navigator.clipboard.readText());
  assert.match(markdown, /\| CNY \| 2 \| 0\.58/);
  assert.match(markdown, /\| JPY \| 1 \|/);
  const batchDownload = batchPage.waitForEvent('download');
  await batchPage.click('#batch-download');
  const file = await batchDownload;
  assert.equal(file.suggestedFilename(), 'steam-market-batch.csv');
  const csv = fs.readFileSync(await file.path(), 'utf8');
  assert.match(csv, /^\ufeff"Item","App ID","Currency"/);
  assert.match(csv, /"Clutch Case","730","CNY","2","0\.29","0\.15","0\.30","0\.14","0\.14","0\.28","custom"/);
  assert.match(csv, /"Kilowatt Case","730","JPY","1"/);
  pass('a legacy favorite adds directly and both exports preserve currency and pricing');

  await batchPage.click('#batch-clear');
  assert.equal(await batchPage.locator('.batch-row').count(), 0);
  assert.equal(await batchPage.isDisabled('#batch-download'), true);
  await batchPage.click('#batch-clear');
  assert.equal(await batchPage.locator('.batch-row').count(), 2);
  await batchPage.reload();
  await batchPage.click('#batch-open');
  assert.equal(await batchPage.locator('.batch-row').count(), 2);
  assert.equal(await batchPage.inputValue('#batch-strategy'), 'median');
  assert.equal(await batchPage.locator('.batch-price').first().inputValue(), '0.29');
  assert.equal(await batchPage.locator('.batch-quantity').first().inputValue(), '2');
  pass('batch clear can be undone and saved quantities, prices and strategy survive reload');

  await batchPage.screenshot({ path: path.join(out, 'batch-desktop.png') });
  for (const width of [320, 390, 720]) {
    await batchPage.setViewportSize({ width, height: 844 });
    assert.ok(await batchPage.evaluate(() => {
      const dialog = document.querySelector('#batch-dialog');
      const body = dialog.querySelector('.batch-body');
      return Math.max(dialog.scrollWidth, body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1 &&
        document.querySelector('#batch-download').getBoundingClientRect().bottom <= innerHeight;
    }), 'batch horizontal overflow or inaccessible exports at ' + width);
    if (width === 390) await batchPage.screenshot({ path: path.join(out, 'batch-mobile.png') });
  }
  await batchPage.setViewportSize({ width: 1440, height: 1000 });
  await batchPage.evaluate(() => { document.documentElement.style.zoom = '2'; });
  assert.ok(await batchPage.evaluate(() => {
    const dialog = document.querySelector('#batch-dialog');
    const body = dialog.querySelector('.batch-body');
    return body.scrollWidth <= body.clientWidth + 1 && dialog.getBoundingClientRect().left >= -1 &&
      document.querySelector('#batch-download').getBoundingClientRect().bottom <= innerHeight + 1;
  }), 'batch layout at 200% zoom');
  await batchPage.locator('.batch-remove').last().click();
  assert.equal(await batchPage.locator('.batch-row').count(), 1);
  assert.equal(await batchPage.isVisible('#batch-mixed'), false);
  await batchPage.reload();
  await batchPage.click('#batch-open');
  assert.equal(await batchPage.locator('.batch-row').count(), 1);
  await batchContext.close();
  pass('batch dialog fits narrow viewports and zoom; removing a row persists');

  const inventoryContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const inventoryPage = await inventoryContext.newPage();
  inventoryPage.on('pageerror', (error) => errors.push(error.message));
  inventoryPage.setDefaultTimeout(8000);
  await inventoryPage.addInitScript(() => {
    localStorage.setItem('steam-price-batch-v1', JSON.stringify({ rows: [{
      appId: 753, name: 'Regular card', currency: 8, quantity: 1,
      lowest: 29, median: 28, undercut: 1, steamFee: 5, publisherFee: 10,
    }] }));
  });
  await inventoryPage.goto(base);
  await inventoryPage.locator('#batch-open[aria-label]').waitFor();
  await inventoryPage.click('#inventory-open');
  await inventoryPage.fill('#inventory-profile', 'https://steamcommunity.com/id/private-fixture');
  await inventoryPage.click('#inventory-load');
  await inventoryPage.waitForFunction(() => document.querySelector('#inventory-load-status').textContent.includes('\u9690\u79c1'));
  await inventoryPage.fill('#inventory-profile', 'https://steamcommunity.com/id/card-seller');
  await inventoryPage.click('#inventory-load');
  await inventoryPage.waitForSelector('#inventory-results:not([hidden])');
  assert.equal(await inventoryPage.locator('.inventory-row').count(), 4);
  assert.equal(await inventoryPage.textContent('#inventory-quantity'), '7');
  assert.equal(await inventoryPage.textContent('#inventory-foils'), '2');
  assert.equal(await inventoryPage.textContent('#inventory-games'), '2');
  await inventoryPage.check('#inventory-other');
  await inventoryPage.click('#inventory-load');
  await inventoryPage.waitForFunction(() => document.querySelectorAll('.inventory-row').length === 5);
  assert.equal(await inventoryPage.textContent('#inventory-quantity'), '11');
  assert.ok(await inventoryPage.isVisible('#inventory-truncated'));
  await inventoryPage.selectOption('#inventory-game', 'game:app_101');
  assert.equal(await inventoryPage.locator('.inventory-row').count(), 1);
  await inventoryPage.uncheck('#inventory-select-visible');
  await inventoryPage.selectOption('#inventory-game', 'all');
  await inventoryPage.check('#inventory-foil');
  assert.equal(await inventoryPage.locator('.inventory-row').count(), 1);
  assert.match(await inventoryPage.locator('.inventory-name').textContent(), /Foil/);
  assert.match(await inventoryPage.textContent('#inventory-selection'), /\u7b5b\u9009\u5916 3.*5/);
  await inventoryPage.uncheck('#inventory-foil');
  assert.match(await inventoryPage.textContent('#inventory-selection'), /4.*7/);
  pass('inventory drawer handles private profiles, card totals, community items, game and foil filters');

  await inventoryPage.selectOption('#inventory-mode', 'review');
  await inventoryPage.click('#inventory-import');
  await inventoryPage.waitForSelector('#batch-dialog[open]');
  const foilRow = inventoryPage.locator('.batch-row').filter({ hasText: 'Foil card' });
  assert.equal(await foilRow.locator('.batch-quantity').inputValue(), '2');
  assert.equal(await inventoryPage.isDisabled('#batch-download'), true);
  await inventoryPage.click('#batch-close');
  await inventoryPage.click('#inventory-open');

  await inventoryPage.click('#inventory-start');
  await inventoryPage.waitForFunction(() => document.querySelector('#inventory-run-status').textContent.includes('\u9650\u6d41'));
  assert.match(await inventoryPage.textContent('#inventory-progress-label'), /1\/4/);
  assert.match(await inventoryPage.textContent('#inventory-net'), /0\.45 CNY/);
  assert.equal(await inventoryPage.isDisabled('#inventory-start'), true);
  assert.equal(inventoryQuotes.length, 2);
  await inventoryPage.waitForFunction(() => !document.querySelector('#inventory-start').disabled);
  await inventoryPage.click('#inventory-start');
  await inventoryPage.waitForFunction(() => document.querySelector('#inventory-progress').value === 2);
  await inventoryPage.click('#inventory-pause');
  await inventoryPage.click('#inventory-cancel');
  assert.match(await inventoryPage.textContent('#inventory-run-status'), /\u53d6\u6d88/);
  await inventoryPage.waitForFunction(() => !document.querySelector('#inventory-start').disabled);
  assert.equal(inventoryQuotes.length, 3);
  await inventoryPage.click('#inventory-start');
  await inventoryPage.waitForFunction(() => document.querySelector('#inventory-run-status').textContent.includes('\u91cd\u8bd5'));
  assert.match(await inventoryPage.textContent('#inventory-progress-label'), /2\/4/);
  await inventoryPage.click('#inventory-start');
  await inventoryPage.waitForFunction(() => document.querySelector('#inventory-progress').value === 4);
  assert.deepEqual(inventoryQuotes.map(({ name }) => name), [
    'Regular card', 'Foil card', 'Foil card', 'Fee floor card', 'Fee floor card', 'No market card',
  ]);
  assert.equal(maxInventoryQuotes, 1);
  for (let index = 1; index < inventoryQuotes.length; index++) {
    assert.ok(inventoryQuotes[index].time - inventoryQuotes[index - 1].time >= 1100);
  }
  assert.equal(await inventoryPage.locator('[data-tier="review"]').count(), 1);
  assert.equal(await inventoryPage.locator('[data-tier="regular"]').count(), 1);
  assert.equal(await inventoryPage.locator('[data-tier="thin"]').count(), 1);
  pass('inventory prices one item at a time, preserves quotes across 429, pause and cancel, retries upstream failures, and assigns tiers');

  assert.match(await inventoryPage.textContent('#inventory-transfer-status'), /\u8865\u4e0a\u884c\u60c5/);
  assert.match(await inventoryPage.textContent('#inventory-import'), /\u67e5\u770b/);
  await inventoryPage.click('#inventory-import');
  await inventoryPage.waitForSelector('#batch-dialog[open]');
  assert.equal(await inventoryPage.locator('.batch-row').count(), 2);
  assert.equal(await foilRow.locator('.batch-quantity').inputValue(), '2');
  assert.equal(await inventoryPage.isEnabled('#batch-download'), true);
  await inventoryPage.click('#batch-close');
  await inventoryPage.click('#inventory-open');
  await inventoryPage.selectOption('#inventory-mode', 'all');
  pass('pricing a previously imported card fills the batch price without adding copies');

  const inventoryDownload = inventoryPage.waitForEvent('download');
  await inventoryPage.click('#inventory-export');
  const inventoryCsvFile = await inventoryDownload;
  assert.equal(inventoryCsvFile.suggestedFilename(), 'steam-market-inventory.csv');
  const inventoryCsv = fs.readFileSync(await inventoryCsvFile.path(), 'utf8');
  assert.match(inventoryCsv, /"Regular card","753","CNY","3","0\.29","0\.15","0\.45"/);
  assert.doesNotMatch(inventoryCsv, /No market card|Background/);
  await inventoryPage.screenshot({ path: path.join(out, 'inventory-desktop.png') });

  for (const width of [320, 390]) {
    await inventoryPage.setViewportSize({ width, height: 844 });
    await inventoryPage.click('#inventory-close');
    assert.ok(await inventoryPage.evaluate(() => {
      const toolbar = document.querySelector('.topbar-inner');
      return toolbar.scrollWidth <= toolbar.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
    }), 'inventory entry overflows at ' + width);
    await inventoryPage.click('#inventory-open');
    assert.ok(await inventoryPage.evaluate(() => {
      const dialog = document.querySelector('#inventory-dialog');
      const body = dialog.querySelector('.inventory-body');
      const footer = dialog.querySelector('.inventory-actions');
      return dialog.scrollWidth <= dialog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 &&
        footer.scrollWidth <= footer.clientWidth + 1 &&
        document.querySelector('#inventory-import').getBoundingClientRect().bottom <= innerHeight + 1;
    }), 'inventory drawer overflows at ' + width);
    if (width === 390) await inventoryPage.screenshot({ path: path.join(out, 'inventory-mobile.png') });
  }
  await inventoryPage.setViewportSize({ width: 1440, height: 1000 });
  await inventoryPage.evaluate(() => { document.documentElement.style.zoom = '2'; });
  assert.ok(await inventoryPage.evaluate(() => {
    const dialog = document.querySelector('#inventory-dialog');
    const body = dialog.querySelector('.inventory-body');
    return body.scrollWidth <= body.clientWidth + 1 && dialog.getBoundingClientRect().left >= -1 &&
      document.querySelector('#inventory-import').getBoundingClientRect().bottom <= innerHeight + 1;
  }), 'inventory layout at 200 percent zoom');
  pass('inventory entry and drawer fit 320px, 390px and 200 percent zoom');

  await inventoryPage.selectOption('#inventory-mode', 'regular');
  await inventoryPage.click('#inventory-import');
  await inventoryPage.waitForSelector('#batch-dialog[open]');
  assert.equal(await inventoryPage.locator('.batch-row').count(), 3);
  assert.deepEqual(await inventoryPage.locator('.batch-quantity').evaluateAll((inputs) => inputs.map((input) => input.value)), ['1', '2', '3']);
  await inventoryPage.keyboard.press('Escape');
  await inventoryPage.waitForFunction(() => document.activeElement.id === 'inventory-open');
  await inventoryPage.click('#inventory-open');
  await inventoryPage.selectOption('#inventory-mode', 'all');
  await inventoryPage.click('#inventory-import');
  await inventoryPage.waitForSelector('#batch-dialog[open]');
  assert.equal(await inventoryPage.locator('.batch-row').count(), 5);
  assert.match(await inventoryPage.textContent('#batch-total-count'), /8/);
  assert.deepEqual((await inventoryPage.locator('.batch-currency h3').allTextContents()).map((text) => text.slice(0, 3)), ['JPY', 'CNY']);
  assert.equal(await inventoryPage.isDisabled('#batch-download'), true);
  const pendingRow = inventoryPage.locator('.batch-row').filter({ hasText: 'No market card' });
  await pendingRow.locator('.batch-price').fill('0.29');
  assert.equal(await inventoryPage.isEnabled('#batch-download'), true);
  await inventoryContext.close();
  pass('inventory exports priced rows and transfers full quantities, pending rows and isolated currencies to the batch');

  const blocked = await context.newPage();
  await blocked.addInitScript(() => { Storage.prototype.setItem = function () { throw new DOMException('Storage blocked', 'SecurityError'); }; });
  blocked.on('pageerror', (error) => errors.push(error.message));
  await blocked.goto(base + '?name=Clutch%20Case');
  await blocked.waitForFunction(() => !document.querySelector('#calculate').disabled && !document.querySelector('#result').hidden);
  await blocked.click('#favorite-quote');
  assert.match(await blocked.textContent('#toast'), /\u5b58\u50a8\u4e0d\u53ef\u7528/);
  await blocked.click('#batch-add-quote');
  await blocked.waitForSelector('#batch-dialog[open]');
  assert.equal(await blocked.locator('.batch-row').count(), 1);
  assert.equal(await blocked.isVisible('#batch-storage'), true);
  assert.equal(await blocked.isEnabled('#batch-copy'), true);
  await blocked.close();
  pass('blocked local storage keeps the batch usable and reports save failures');
  await page.fill('#item-name', 'Clutch Case');
  await page.click('#calculate');
  await page.waitForFunction(() => !document.querySelector('#calculate').disabled);
  for (const width of [390, 320, 720]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => { const svg = document.querySelector('#price-chart'); return Math.abs(Number(svg.getAttribute('viewBox').split(' ')[2]) - svg.getBoundingClientRect().width) < 2; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow at ' + width);
    await capture({ path: path.join(out, 'viewport-' + width + '.png'), fullPage: width === 390 });
  }
  pass('320, 390, and 720px layouts do not overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; window.scrollTo(0, 0); });
  assert.ok(await page.evaluate(() => document.documentElement.getBoundingClientRect().width <= innerWidth + 1));
  await capture({ path: path.join(out, 'desktop-200percent.png') });
  pass('200 percent zoom remains usable');
  assert.deepEqual(errors, []);
  pass('no browser runtime errors');
  fs.writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ checks, errors, fixture: true, quoteCalls }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
