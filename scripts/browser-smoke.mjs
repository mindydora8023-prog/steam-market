import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../app/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.PLAYWRIGHT_MODULE || path.resolve(root, '../.toolchain/ui-review/node_modules/playwright-core/index.mjs');
if (!fs.existsSync(modulePath)) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright-core index.mjs.');
const { chromium } = await import(pathToFileURL(modulePath));
const out = process.env.UI_EVIDENCE_DIR || path.resolve(root, '../.toolchain/out/steam-redesign-0.5.0');
fs.mkdirSync(out, { recursive: true });
let quoteCalls = 0;
const item = { appId: 730, name: 'Clutch Case', hashName: 'Clutch Case', appName: 'Counter-Strike 2', type: 'Container', iconUrl: '', sellListings: 100 };
const steam = {
  proxyLabel: 'direct',
  async search(appId, query) { return { results: query === 'none' ? [] : [{ ...item, appId }], fetchedAt: new Date().toISOString() }; },
  async price() { quoteCalls++; return { ok: true, lowest: 361, median: 356, volume: 6159, fetchedAt: new Date().toISOString() }; },
  async history() {
    const now = Math.floor(Date.now() / 1000);
    return { currency: 23, fetchedAt: new Date().toISOString(), points: Array.from({ length: 365 }, (_, i) => ({ time: now - (364 - i) * 86400, price: 3.2 + Math.sin(i / 12) * .35 + i / 1000, volume: 100 + i })) };
  },
};
const mount = '/steam/';
const app = createApp({ steam, version: '0.5.1-test', publicDir: path.join(root, 'app/public') });
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
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
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
  await page.waitForFunction(() => document.querySelector('#version').textContent.includes('0.5.1'));
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
  const blocked = await context.newPage();
  await blocked.addInitScript(() => { Storage.prototype.setItem = function () { throw new DOMException('Storage blocked', 'SecurityError'); }; });
  blocked.on('pageerror', (error) => errors.push(error.message));
  await blocked.goto(base + '?name=Clutch%20Case');
  await blocked.waitForFunction(() => !document.querySelector('#calculate').disabled && !document.querySelector('#result').hidden);
  await blocked.click('#favorite-quote');
  assert.match(await blocked.textContent('#toast'), /\u5b58\u50a8\u4e0d\u53ef\u7528/);
  await blocked.close();
  pass('blocked local storage reports save failure without crashing');
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
