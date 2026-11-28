import { HttpClient, HttpError, parseJson, RateLimiter, retryAfterMs } from '../lib/http.js';
import { parsePriceToMinor } from '../lib/currency.js';
import { sleep } from '../lib/util.js';
import { parsePriceHistoryHtml } from './history.mjs';
import {
  aggregateInventory, COMMUNITY_APP_ID, inventoryCursor, INVENTORY_PAGE_SIZE,
  MAX_INVENTORY_PAGES, parseSteamProfile, parseVanitySteamId, summarizeInventory,
} from '../lib/inventory.js';

const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
const PRICE_URL = 'https://steamcommunity.com/market/priceoverview/';

export class MarketError extends Error {
  constructor(code, message, { status = 502, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

class TTLCache {
  constructor(max = 400) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + Math.max(1000, ttlMs) });
  }
}

function iconUrl(hash) {
  const raw = String(hash || '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://community.cloudflare.steamstatic.com/economy/image/${raw}/64fx64f`;
}

function parseVolume(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? Number(digits) : 0;
}

function isSuccess(value) {
  return value === true || Number(value) === 1;
}

export class SteamMarket {
  constructor({
    http = new HttpClient(),
    proxyLabel = 'direct',
    searchIntervalMs = 1000,
    priceIntervalMs = 1200,
    historyIntervalMs = 1500,
    inventoryIntervalMs = 1200,
    searchTtlMs = 5 * 60 * 1000,
    priceTtlMs = 60 * 1000,
    historyTtlMs = 10 * 60 * 1000,
    negativeTtlMs = 2 * 60 * 1000,
    requestTimeoutMs = 30000,
  } = {}) {
    this.http = http;
    this.proxyLabel = proxyLabel;
    this.searchLimiter = new RateLimiter({ minIntervalMs: searchIntervalMs, jitterMs: 250 });
    this.priceLimiter = new RateLimiter({ minIntervalMs: priceIntervalMs, jitterMs: 250 });
    this.historyLimiter = new RateLimiter({ minIntervalMs: historyIntervalMs, jitterMs: 250 });
    this.searchCache = new TTLCache(500);
    this.priceCache = new TTLCache(800);
    this.historyCache = new TTLCache(200);
    this.inventoryCache = new TTLCache(32);
    this.vanityCache = new TTLCache(128);
    this.inventoryLimiter = new RateLimiter({ minIntervalMs: inventoryIntervalMs, jitterMs: inventoryIntervalMs ? 250 : 0 });
    this.searchTtlMs = searchTtlMs;
    this.priceTtlMs = priceTtlMs;
    this.historyTtlMs = historyTtlMs;
    this.negativeTtlMs = negativeTtlMs;
    const budget = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? Math.min(requestTimeoutMs, 2147483647) : 30000;
    this.requestTimeoutMs = Number.isFinite(http.timeoutMs) && http.timeoutMs > 0 ? Math.min(budget, http.timeoutMs) : budget;
    this.inflight = new Map();
    this.cooldownUntil = 0;
  }

  checkCooldown() {
    const retryAfterMs = this.cooldownUntil - Date.now();
    if (retryAfterMs > 0) {
      throw new MarketError('rate-limited', 'Steam is rate limiting requests.', { status: 429, retryAfterMs });
    }
  }

  coalesce(key, work) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = Promise.resolve().then(work).catch((error) => {
      const err = this.toMarketError(error);
      if (err.code === 'rate-limited') {
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + (err.retryAfterMs || 60000));
      }
      throw err;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async boundedRequest(work) {
    this.checkCooldown();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new MarketError('upstream', 'Steam request timed out.')), this.requestTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  toMarketError(err) {
    if (err instanceof MarketError) return err;
    if (err instanceof HttpError) {
      if (err.status === 429 || err.code === 'rate-limited') {
        return new MarketError('rate-limited', 'Steam is rate limiting requests.', {
          status: 429,
          retryAfterMs: err.retryAfterMs || 60000,
        });
      }
      if (err.status === 401 || err.status === 403) {
        return new MarketError('blocked', 'Steam rejected the market request.', { status: 502 });
      }
      return new MarketError('upstream', err.message || 'Steam request failed.', { status: 502 });
    }
    const message = err && err.message ? err.message : 'Steam request failed.';
    return new MarketError('upstream', message, { status: 502 });
  }

  async requestJson(url, headers, retried = false) {
    try {
      return await this.boundedRequest(() => this.http.getJson(url, { headers, timeoutMs: this.requestTimeoutMs, cookies: false }));
    } catch (err) {
      const transient =
        err instanceof HttpError &&
        (err.status >= 500 || err.code === 'network' || err.code === 'proxy');
      if (!retried && transient) {
        await sleep(500);
        return this.requestJson(url, headers, true);
      }
      throw this.toMarketError(err);
    }
  }

  async requestText(url, headers, retried = false) {
    try {
      return await this.boundedRequest(() => this.http.request(url, { headers, timeoutMs: this.requestTimeoutMs, cookies: false }));
    } catch (err) {
      const transient =
        err instanceof HttpError &&
        (err.status >= 500 || err.code === 'network' || err.code === 'proxy');
      if (!retried && transient) {
        await sleep(500);
        return this.requestText(url, headers, true);
      }
      throw this.toMarketError(err);
    }
  }

  async requestInventoryResource(url, accept, deadline) {
    this.checkCooldown();
    await this.inventoryLimiter.wait();
    this.checkCooldown();
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new MarketError('inventory-upstream', 'Steam inventory request timed out.');
    const response = await this.http.request(url, {
      headers: { Accept: accept }, timeoutMs, redirects: 0, cookies: false,
    });
    if (response.status === 429) {
      throw new MarketError('rate-limited', 'Steam is rate limiting requests.', {
        status: 429, retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
      });
    }
    return response;
  }

  async resolveInventoryVanity(vanity) {
    const cached = this.vanityCache.get(vanity);
    if (cached) return cached;
    return this.coalesce('inventory-vanity:' + vanity, () => {
      const deadline = Date.now() + this.requestTimeoutMs;
      return this.boundedRequest(async () => {
        const response = await this.requestInventoryResource(
          'https://steamcommunity.com/id/' + vanity + '/?xml=1', 'application/xml, text/xml', deadline,
        );
        const steamId = response.status === 200 ? parseVanitySteamId(response.text) : null;
        if (!steamId) {
          throw new MarketError('inventory-profile-unavailable', 'Steam profile could not be resolved.', { status: 404 });
        }
        this.vanityCache.set(vanity, steamId, 60 * 60 * 1000);
        return steamId;
      });
    });
  }

  async inventory(input, { onlyCards = true } = {}) {
    const profile = parseSteamProfile(input);
    if (!profile) throw new MarketError('bad-request', 'Invalid Steam profile.', { status: 400 });
    const steamId = profile.steamId || await this.resolveInventoryVanity(profile.vanity);
    const cached = this.inventoryCache.get(steamId);
    const snapshot = cached || await this.coalesce('inventory:' + steamId, () => {
      const deadline = Date.now() + this.requestTimeoutMs;
      return this.boundedRequest(() => this.fetchInventory(steamId, deadline));
    });
    const { items, ...metadata } = snapshot;
    const summary = summarizeInventory(items, onlyCards);
    if (!summary.kindCount && !metadata.truncated) {
      throw new MarketError('inventory-empty', 'No marketable items match this inventory filter.', { status: 200 });
    }
    return { steamId, ...summary, ...metadata, cached: Boolean(cached) };
  }

  async fetchInventory(steamId, deadline) {
    const pages = [];
    const cursors = new Set();
    let cursor = null;
    let truncated = false;
    let more = false;
    for (let index = 0; index < MAX_INVENTORY_PAGES; index++) {
      const params = new URLSearchParams({ l: 'english', count: String(INVENTORY_PAGE_SIZE) });
      if (cursor) params.set('start_assetid', cursor);
      const url = 'https://steamcommunity.com/inventory/' + steamId + '/' + COMMUNITY_APP_ID + '/6?' + params;
      const response = await this.requestInventoryResource(url, 'application/json', deadline);
      const page = parseJson(response.text);
      const privateBody = /\b(?:private|not public)\b/i.test(String(page?.Error || page?.error || page || ''))
        || /^private$/i.test(response.text.trim());
      if ([401, 403].includes(response.status) ||
          (response.status === 200 && (response.text.trim() === 'null' || (!isSuccess(page?.success) && privateBody)))) {
        throw new MarketError('inventory-private', 'Steam inventory is private.', { status: 403 });
      }
      if (response.status !== 200 || !isSuccess(page?.success) ||
          (!Array.isArray(page.assets) && !(Number(page.total_inventory_count) === 0 && page.assets == null))) {
        throw new MarketError('inventory-upstream', 'Steam returned an invalid inventory response.');
      }
      const assets = page.assets || [];
      truncated ||= assets.length > INVENTORY_PAGE_SIZE;
      pages.push({
        assets: assets.slice(0, INVENTORY_PAGE_SIZE),
        descriptions: Array.isArray(page.descriptions) ? page.descriptions.slice(0, INVENTORY_PAGE_SIZE) : [],
      });
      more = isSuccess(page.more_items);
      if (!more) break;
      cursor = inventoryCursor(page.last_assetid);
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    const snapshot = {
      items: aggregateInventory(pages), pages: pages.length, truncated: truncated || more,
      fetchedAt: new Date().toISOString(),
    };
    this.inventoryCache.set(steamId, snapshot, 60 * 1000);
    return snapshot;
  }

  async search(appId, query, { limit = 8, refresh = false } = {}) {
    const count = Number(limit);
    limit = Number.isFinite(count) ? Math.min(12, Math.max(1, Math.floor(count))) : 8;
    const text = String(query || '').trim();
    const key = JSON.stringify(['s', String(appId), text.toLowerCase(), limit]);
    const cached = refresh ? null : this.searchCache.get(key);
    if (cached) return { ...cached, cached: true };
    return this.coalesce(key, () => this.fetchSearch(appId, text, { limit, refresh }));
  }

  async fetchSearch(appId, query, { limit = 8, refresh = false } = {}) {
    const text = String(query || '').trim();
    if (!text) return { results: [], fetchedAt: new Date().toISOString(), cached: false };
    const key = JSON.stringify(['s', String(appId), text.toLowerCase(), limit]);
    const cached = refresh ? null : this.searchCache.get(key);
    if (cached) return { ...cached, cached: true };

    this.checkCooldown();
    await this.searchLimiter.wait();
    const params = new URLSearchParams({
      search_descriptions: '0',
      sort_column: 'default',
      sort_dir: 'desc',
      appid: String(appId),
      norender: '1',
      count: String(Math.min(12, Math.max(1, limit))),
      query: text,
    });
    const url = `${SEARCH_URL}?${params.toString()}`;
    const res = await this.requestJson(url, {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `https://steamcommunity.com/market/search?appid=${encodeURIComponent(appId)}&q=${encodeURIComponent(text)}`,
    });

    if (res.status === 429) {
      throw new MarketError('rate-limited', 'Steam is rate limiting search requests.', {
        status: 429,
        retryAfterMs: retryAfterMs(res.headers?.['retry-after']),
      });
    }
    if (res.status !== 200) {
      throw new MarketError('upstream', `Steam search returned HTTP ${res.status}.`);
    }
    if (!res.json || !isSuccess(res.json.success)) {
      throw new MarketError('upstream', 'Steam search returned an invalid response.');
    }

    const seen = new Set();
    const results = [];
    for (const row of res.json.results || []) {
      const desc = row.asset_description || {};
      const hashName = String(row.hash_name || desc.market_hash_name || desc.market_name || row.name || '').trim();
      if (!hashName || seen.has(hashName.toLowerCase())) continue;
      seen.add(hashName.toLowerCase());
      results.push({
        name: String(row.name || desc.name || hashName),
        hashName,
        type: String(desc.type || ''),
        iconUrl: iconUrl(desc.icon_url),
        appId: Number(desc.appid) || Number(appId),
        appName: String(row.app_name || ''),
        sellListings: Number(row.sell_listings) || 0,
      });
      if (results.length >= limit) break;
    }

    const value = { results, fetchedAt: new Date().toISOString() };
    this.searchCache.set(key, value, this.searchTtlMs);
    return { ...value, cached: false };
  }

  async price(appId, marketHashName, currency, { refresh = false } = {}) {
    const name = String(marketHashName || '').trim();
    const cached = refresh ? null : this.priceCache.get(`p:${appId}:${currency}:${name}`);
    if (cached) return { ...cached, cached: true };
    return this.coalesce(JSON.stringify(['p', String(appId), String(currency), name]),
      () => this.fetchPrice(appId, name, currency, { refresh }));
  }

  async fetchPrice(appId, marketHashName, currency, { refresh = false } = {}) {
    const hashName = String(marketHashName || '').trim();
    const key = `p:${appId}:${currency}:${hashName}`;
    const cached = refresh ? null : this.priceCache.get(key);
    if (cached) return { ...cached, cached: true };

    this.checkCooldown();
    await this.priceLimiter.wait();
    const params = new URLSearchParams({
      appid: String(appId),
      currency: String(currency),
      market_hash_name: hashName,
    });
    const url = `${PRICE_URL}?${params.toString()}`;
    const res = await this.requestJson(url, {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: `https://steamcommunity.com/market/listings/${encodeURIComponent(appId)}/${encodeURIComponent(hashName)}`,
    });

    if (res.status === 429) {
      throw new MarketError('rate-limited', 'Steam is rate limiting price requests.', {
        status: 429,
        retryAfterMs: retryAfterMs(res.headers?.['retry-after']),
      });
    }
    if (res.status !== 200) {
      throw new MarketError('upstream', `Steam price request returned HTTP ${res.status}.`);
    }
    if (!res.json) {
      throw new MarketError('upstream', 'Steam price response was not valid JSON.');
    }

    const fetchedAt = new Date().toISOString();
    if (!isSuccess(res.json.success)) {
      const value = { ok: false, code: 'no-market-data', fetchedAt };
      this.priceCache.set(key, value, this.negativeTtlMs);
      return { ...value, cached: false };
    }

    const lowest = res.json.lowest_price
      ? parsePriceToMinor(res.json.lowest_price, currency)
      : null;
    const median = res.json.median_price
      ? parsePriceToMinor(res.json.median_price, currency)
      : null;
    const volume = parseVolume(res.json.volume);

    if (res.json.lowest_price && lowest === null) {
      const value = { ok: false, code: 'unparseable-price', fetchedAt };
      this.priceCache.set(key, value, this.negativeTtlMs);
      return { ...value, cached: false };
    }
    if (lowest === null && median === null) {
      const value = { ok: false, code: 'no-price-data', fetchedAt };
      this.priceCache.set(key, value, this.negativeTtlMs);
      return { ...value, cached: false };
    }

    const value = { ok: true, lowest, median, volume, fetchedAt };
    this.priceCache.set(key, value, this.priceTtlMs);
    return { ...value, cached: false };
  }

  async history(appId, marketHashName, { refresh = false } = {}) {
    const name = String(marketHashName || '').trim();
    const cached = refresh ? null : this.historyCache.get(`h:${appId}:${name}`);
    if (cached) return { ...cached, cached: true };
    return this.coalesce(JSON.stringify(['h', String(appId), name]),
      () => this.fetchHistory(appId, name, { refresh }));
  }

  async fetchHistory(appId, marketHashName, { refresh = false } = {}) {
    const hashName = String(marketHashName || '').trim();
    const key = `h:${appId}:${hashName}`;
    const cached = refresh ? null : this.historyCache.get(key);
    if (cached) return { ...cached, cached: true };

    this.checkCooldown();
    await this.historyLimiter.wait();
    const url = `https://steamcommunity.com/market/listings/${encodeURIComponent(
      appId,
    )}/${encodeURIComponent(hashName)}`;
    const res = await this.requestText(url, {
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://steamcommunity.com/market/',
    });

    if (res.status === 429) {
      throw new MarketError('rate-limited', 'Steam is rate limiting history requests.', {
        status: 429,
        retryAfterMs: retryAfterMs(res.headers?.['retry-after']),
      });
    }
    if (res.status !== 200) {
      throw new MarketError('upstream', `Steam history page returned HTTP ${res.status}.`);
    }

    const parsed = parsePriceHistoryHtml(res.text);
    if (!parsed || parsed.points.length === 0) {
      throw new MarketError(
        'history-unavailable',
        'Steam did not include price history for this item.',
        { status: 502 },
      );
    }

    const value = {
      points: parsed.points,
      currency: parsed.currency,
      fetchedAt: new Date().toISOString(),
    };
    this.historyCache.set(key, value, this.historyTtlMs);
    return { ...value, cached: false };
  }
}

export function sameMarketName(value) {
  return String(value || '').trim().toLowerCase();
}

export function findExactSearchResult(results, name) {
  const wanted = sameMarketName(name);
  if (!wanted) return null;
  return (
    results.find(
      (result) =>
        sameMarketName(result.hashName) === wanted || sameMarketName(result.name) === wanted,
    ) || null
  );
}