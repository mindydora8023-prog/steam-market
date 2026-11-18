import fs from 'node:fs';

const COOKIE_NAME = /^[A-Za-z0-9_\-.[\]]+$/;

function addCookie(map, name, value) {
  if (!name || !COOKIE_NAME.test(name)) return;
  if (value === undefined || value === null) return;
  map.set(name, String(value));
}

function parseHeaderString(text, map) {
  for (const part of String(text).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    addCookie(map, name, value);
  }
}

function parseJsonObject(value, map) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.name || entry.key;
      addCookie(map, name, entry.value);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.cookies)) {
    parseJsonObject(value.cookies, map);
    return;
  }
  if (value.cookies && typeof value.cookies === 'object') {
    parseJsonObject(value.cookies, map);
    return;
  }
  for (const [name, raw] of Object.entries(value)) {
    if (raw && typeof raw === 'object' && 'value' in raw) {
      addCookie(map, name, raw.value);
    } else if (typeof raw === 'string' || typeof raw === 'number') {
      addCookie(map, name, raw);
    }
  }
}

function parseNetscape(text, map) {
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    addCookie(map, name, value);
  }
}

export function parseCookies(input) {
  const map = new Map();
  if (input === null || input === undefined) return map;

  if (typeof input === 'object') {
    parseJsonObject(input, map);
    return map;
  }

  const text = String(input).trim();
  if (!text) return map;

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      parseJsonObject(JSON.parse(text), map);
      return map;
    } catch {
      // Fall through to the header/Netscape parsers.
    }
  }

  if (text.includes('\t')) parseNetscape(text, map);
  if (map.size === 0) parseHeaderString(text, map);
  return map;
}

export function loadCookiesFromFile(file) {
  if (!file) return new Map();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw new Error(`Cannot read cookie file ${file}: ${err.message}`);
  }
  return parseCookies(text);
}

export function serializeCookies(cookies) {
  const map = cookies instanceof Map ? cookies : parseCookies(cookies);
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function steamIdFromCookies(cookies) {
  const map = cookies instanceof Map ? cookies : parseCookies(cookies);
  const login = map.get('steamLoginSecure');
  if (!login) return null;
  let decoded = login;
  try {
    decoded = decodeURIComponent(login);
  } catch {
    // Keep the raw value if it is not URL encoded.
  }
  const candidate = decoded.split('||')[0];
  return /^\d{17}$/.test(candidate) ? candidate : null;
}

export function describeCookies(cookies) {
  const map = cookies instanceof Map ? cookies : parseCookies(cookies);
  const names = [...map.keys()];
  return {
    count: names.length,
    hasLogin: map.has('steamLoginSecure'),
    hasSession: map.has('sessionid'),
    names,
  };
}