import { marketMinimumFor } from './fees.js';

export const COMMUNITY_APP_ID = 753;
export const INVENTORY_PAGE_SIZE = 200;
export const MAX_INVENTORY_PAGES = 5;

const STEAM_ID = /^\d{17}$/;
const PROFILE_URL = /^(?:https?:\/\/)?steamcommunity\.com\/(profiles|id)\/([a-z0-9_-]{1,64})(?:\/inventory(?:\/753(?:\/6)?)?)?\/?(?:[?#][^\s\\]*)?$/i;
const CARD_TYPES = { item_class_2: 'card', item_class_3: 'background', item_class_4: 'emoticon' };
const ICON_ROOT = 'https://community.cloudflare.steamstatic.com/economy/image/';

// Fixed review thresholds in minor units for each market, not live FX quotes.
const HIGH_NET = [
  0, 100, 80, 100, 90, 10000, 400, 600, 150, 1100, 16000,
  450, 5800, 140, 3500, 25000, 1400, 3500, 4200, 2000, 140,
  155, 170, 700, 8500, 1000, 380, 4200, 1800, 780, 3200,
  375, 367, 1100, 100000, 370, 330, 50000, 300, 365, 52000,
];

export function parseSteamProfile(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (STEAM_ID.test(value)) return { steamId: value };
  if (value.length > 500) return null;
  const match = PROFILE_URL.exec(value);
  if (!match) return null;
  const [, kind, name] = match;
  if (kind.toLowerCase() === 'id') return { vanity: name };
  return STEAM_ID.test(name) ? { steamId: name } : null;
}

export function parseVanitySteamId(xml) {
  if (typeof xml !== 'string' || !/^\s*(?:<\?xml[^>]*\?>\s*)?<profile(?:\s[^>]*)?>/i.test(xml)) return null;
  const match = /<steamID64>\s*(?:<!\[CDATA\[(\d{17})\]\]>|(\d{17}))\s*<\/steamID64>/i.exec(xml);
  return match ? match[1] || match[2] : null;
}

export function inventoryCursor(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
}

function assetClass(entry) {
  const classId = inventoryCursor(entry?.classid);
  const instanceId = inventoryCursor(entry?.instanceid ?? '0');
  return classId && instanceId ? classId + ':' + instanceId : null;
}

function describeItem(description) {
  const hashName = typeof description.market_hash_name === 'string' ? description.market_hash_name.trim() : '';
  if (description.marketable !== 1 || !hashName || hashName.length > 200 ||
      /[\ud800-\udfff]/u.test(hashName)) return null;
  const tags = Array.isArray(description.tags) ? description.tags : [];
  const tag = (category) => tags.find((entry) => entry?.category === category);
  const itemClass = tag('item_class')?.internal_name;
  const type = Object.hasOwn(CARD_TYPES, itemClass) ? CARD_TYPES[itemClass] : 'other';
  const game = tag('Game');
  const gameNameValue = game?.localized_tag_name || game?.name;
  const gameName = typeof gameNameValue === 'string' ? gameNameValue.trim().slice(0, 160) : '';
  const gameKey = /^app_\d+$/.test(game?.internal_name) ? game.internal_name : gameName;
  const icon = description.icon_url;
  return {
    appId: COMMUNITY_APP_ID,
    hashName,
    name: typeof description.name === 'string' && description.name.trim()
      ? description.name.trim().slice(0, 200) : hashName,
    type,
    foil: type === 'card' && tag('cardborder')?.internal_name === 'cardborder_1',
    gameKey,
    gameName,
    iconUrl: typeof icon === 'string' && /^[a-z0-9_-]{1,1024}$/i.test(icon) ? ICON_ROOT + icon + '/64fx64f' : '',
  };
}

export function aggregateInventory(pages) {
  const descriptions = new Map();
  const seen = new Set();
  const items = new Map();
  for (const page of pages) {
    for (const description of page.descriptions || []) {
      const key = assetClass(description);
      if (key && !descriptions.has(key)) descriptions.set(key, describeItem(description));
    }
  }
  for (const page of pages) {
    for (const asset of page.assets || []) {
      const id = inventoryCursor(asset?.assetid);
      const rawAmount = asset?.amount ?? '1';
      const amount = Number(rawAmount);
      if (!id || seen.has(id) || !/^\d+$/.test(rawAmount) ||
          !Number.isSafeInteger(amount) || amount < 1 ||
          amount > Math.floor(Number.MAX_SAFE_INTEGER / (MAX_INVENTORY_PAGES * INVENTORY_PAGE_SIZE))) continue;
      seen.add(id);
      const item = descriptions.get(assetClass(asset));
      if (!item) continue;
      const existing = items.get(item.hashName);
      if (existing) existing.count += amount;
      else items.set(item.hashName, { ...item, count: amount });
    }
  }
  return [...items.values()];
}

export function summarizeInventory(items, onlyCards = true) {
  const filtered = onlyCards ? items.filter((item) => item.type === 'card') : items;
  const games = new Map();
  let totalCount = 0;
  let cardCount = 0;
  let foilCount = 0;
  for (const item of filtered) {
    totalCount += item.count;
    if (item.type === 'card') cardCount += item.count;
    if (item.foil) foilCount += item.count;
    let game = games.get(item.gameKey);
    if (!game) {
      game = { key: item.gameKey, name: item.gameName, count: 0, kinds: 0 };
      games.set(item.gameKey, game);
    }
    game.count += item.count;
    game.kinds++;
  }
  return {
    items: filtered, totalCount, cardCount, kindCount: filtered.length, foilCount,
    gameCount: [...games.keys()].filter(Boolean).length, games: [...games.values()],
  };
}

export function inventoryTier(item, quote, currency, {
  highNet = HIGH_NET[currency] ?? 100, minVolume = 10,
} = {}) {
  const receive = quote?.recommendation?.receive;
  if (item.foil || receive >= highNet) return 'review';
  if (quote?.error?.code === 'below-fee-floor') return 'thin';
  if (!quote?.ok) return null;
  if (receive <= marketMinimumFor(currency) || quote.recommendation.warnings?.includes('fee-floor') ||
      !quote.market.lowest || (quote.market.volume || 0) < minVolume) return 'thin';
  return 'regular';
}

export function inventoryBatchRow(item, quote, { currency, undercut, steamFee, publisherFee }) {
  return {
    appId: COMMUNITY_APP_ID, name: item.hashName, quantity: item.count,
    currency, undercut, steamFee, publisherFee,
    lowest: quote?.market?.lowest ?? null, median: quote?.market?.median ?? null,
    unpriced: true,
  };
}
