import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { serveStatic } from './static.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_URL_BYTES = 8192;
const SHARED_MODULES = new Set(['batch.js', 'currency.js', 'fees.js', 'integer.js', 'inventory.js', 'quote.js']);
const LIB_ROOT = path.join(APP_ROOT, 'lib');

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://community.cloudflare.steamstatic.com https://shared.fastly.steamstatic.com https://cdn.fastly.steamstatic.com",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function sendText(res, status, message, extraHeaders = {}) {
  const body = String(message);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function createApp({ steam, version, publicDir }) {
  const api = createApi({ steam, version });

  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (Buffer.byteLength(req.url || '/') > MAX_URL_BYTES) {
      sendText(res, 414, 'URI too long');
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      const body = JSON.stringify({
        ok: true, appId: 'steam-market-price', version,
        root: APP_ROOT, pid: process.pid,
        proxy: steam.proxyLabel, time: new Date().toISOString(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url);
      return;
    }

    const shared = url.pathname.startsWith('/shared/') && SHARED_MODULES.has(url.pathname.slice('/shared/'.length));
    const served = shared
      ? await serveStatic(req, res, new URL(url.pathname.slice('/shared'.length), url), LIB_ROOT)
      : await serveStatic(req, res, url, publicDir);
    if (served) return;

    sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  };
}