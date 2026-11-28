import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { sleep } from './util.js';
import { serializeCookies } from './cookies.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

const REDACT_KEYS = new Set(['k', 'ck', 'p', 'key', 'token', 'access_token', 'identity_secret']);

export class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status || 0;
    this.code = options.code || 'http-error';
    this.url = options.url || '';
    this.retryAfterMs = options.retryAfterMs || 0;
    this.bodySnippet = options.bodySnippet || '';
    this.effectState = options.effectState || 'none';
  }
}

export class RateLimiter {
  constructor({ minIntervalMs = 0, jitterMs = 0, now = Date.now, sleepFn = sleep, maxWaitMs = 30000, maxPending = 100 } = {}) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.jitterMs = Math.max(0, jitterMs);
    this.now = now;
    this.sleepFn = sleepFn;
    this.nextAt = 0;
    this.maxWaitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : 30000;
    this.maxPending = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 100;
    this.pending = 0;
  }

  async wait() {
    const now = this.now();
    const slot = Math.max(now, this.nextAt || 0);
    const delay = slot - now;
    if (delay > this.maxWaitMs || this.pending >= this.maxPending) {
      throw new HttpError('Request queue is full', { code: 'queue-full' });
    }
    this.nextAt = slot + this.minIntervalMs + Math.random() * this.jitterMs;
    if (delay > 0) {
      this.pending++;
      let timer;
      try {
        await Promise.race([
          this.sleepFn(delay),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new HttpError('Request queue timed out', { code: 'timeout' })), this.maxWaitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.pending--;
      }
    }
  }
}

export function safeUrl(input) {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (REDACT_KEYS.has(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return String(input).split('?')[0];
  }
}

export function resolveProxy(explicit, env = process.env) {
  let raw = explicit;
  if (raw === 'none' || raw === 'false' || raw === '') return null;
  if (!raw) raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (!raw) return null;

  let text = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid proxy URL: ${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(
      `Only http:// proxy endpoints are supported (got ${url.protocol}). ` +
        'Point --proxy at the local HTTP/mixed port, not a SOCKS or HTTPS proxy URL.',
    );
  }

  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const auth =
    url.username || url.password
      ? 'Basic ' +
        Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          'utf8',
        ).toString('base64')
      : null;

  return {
    protocol: url.protocol,
    host: url.hostname,
    port,
    auth,
    label: `${url.protocol}//${url.hostname}:${port}`,
  };
}

export function isSteamCommunityHost(hostname) {
  return hostname === 'steamcommunity.com' || hostname.endsWith('.steamcommunity.com');
}

export function isLoginUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'login.steampowered.com' ||
      (parsed.hostname === 'steamcommunity.com' && parsed.pathname.startsWith('/login'))
    );
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === key) return Array.isArray(v) ? v.join(', ') : String(v);
  }
  return '';
}

function decompress(buffer, encoding, maxBytes) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buffer;
  const options = { maxOutputLength: maxBytes };
  if (enc.includes('gzip')) return zlib.gunzipSync(buffer, options);
  if (enc.includes('deflate')) return zlib.inflateSync(buffer, options);
  if (enc.includes('br')) return zlib.brotliDecompressSync(buffer, options);
  return buffer;
}

function connectTunnel(proxy, host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let buffer = Buffer.alloc(0);
    let timer;
    const abort = () => fail(new HttpError('Proxy CONNECT aborted', { code: 'timeout' }));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16 * 1024) fail(new Error('Proxy CONNECT response is too large'));
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      socket.removeListener('data', onData);
      socket.pause();

      const statusLine = head.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01]\s+200\b/.test(statusLine)) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }

      settled = true;
      cleanup();
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };

    timer = setTimeout(() => fail(new HttpError('Proxy CONNECT timed out', { code: 'timeout' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: ${proxy.auth}\r\n` : '';
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          auth +
          'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });
    socket.on('data', onData);
  });
}

function requestThroughProxy(options) {
  const { url, proxy, method, headers, body, timeoutMs, maxBytes } = options;
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));

  const doRequest = (socket) => {
    let agent = false;
    if (isHttps) {
      agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
    }
    const requestOptions = {
      hostname: target.hostname,
      port,
      path: target.pathname + target.search,
      method,
      headers: { ...headers, Host: target.host },
      agent,
      signal: options.signal,
    };
    return collectRequest(isHttps ? https : http, requestOptions, body, timeoutMs, maxBytes);
  };

  if (isHttps) {
    return connectTunnel(proxy, target.hostname, port, timeoutMs, options.signal).then(
      (socket) =>
        new Promise((resolve, reject) => {
          const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
            cleanup();
            doRequest(tlsSocket).then(resolve, reject);
          });
          const abort = () => tlsSocket.destroy(new HttpError('TLS handshake timed out', { code: 'timeout' }));
          const timer = setTimeout(abort, timeoutMs);
          const cleanup = () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          tlsSocket.once('error', (err) => { cleanup(); reject(err); });
          if (options.signal?.aborted) abort();
        }),
    );
  }

  const absolute = target.toString();
  return collectRequest(
    http,
    {
      hostname: proxy.host,
      port: proxy.port,
      path: absolute,
      method,
      headers: {
        ...headers,
        Host: target.host,
        ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}),
      },
      agent: false,
      signal: options.signal,
    },
    body,
    timeoutMs,
    maxBytes,
  );
}

function collectRequest(module, requestOptions, body, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const req = module.request(requestOptions, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const err = new HttpError(`Response exceeds ${maxBytes} bytes`, { code: 'size' });
          finish(err);
          res.destroy();
          req.destroy(err);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        let payload = Buffer.concat(chunks);
        try {
          payload = decompress(payload, headerValue(res.headers, 'content-encoding'), maxBytes);
        } catch (err) {
          finish(new HttpError(`Cannot decompress response: ${err.message}`, { code: err.code === 'ERR_BUFFER_TOO_LARGE' ? 'size' : 'decompress' }));
          return;
        }
        finish(null, {
          status: res.statusCode || 0,
          headers: res.headers,
          body: payload,
        });
      });
      res.on('error', (err) => finish(new HttpError(`Response error: ${err.message}`, { code: 'network' })));
      res.on('aborted', () => finish(new HttpError('Response aborted', { code: 'network' })));
    });

    timer = setTimeout(() => {
      const err = new HttpError(`Request timed out after ${timeoutMs} ms`, { code: 'timeout' });
      finish(err);
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (err) => finish(err instanceof HttpError ? err : new HttpError(err.message, { code: 'network' })));
    if (body && body.length) req.write(body);
    req.end();
  });
}

export function defaultTransport(options) {
  if (options.proxy) return requestThroughProxy(options);
  const target = new URL(options.url);
  const isHttps = target.protocol === 'https:';
  const requestOptions = {
    hostname: target.hostname,
    port: Number(target.port || (isHttps ? 443 : 80)),
    path: target.pathname + target.search,
    method: options.method,
    headers: options.headers,
    agent: false,
    signal: options.signal,
  };
  return collectRequest(isHttps ? https : http, requestOptions, options.body, options.timeoutMs, options.maxBytes);
}

function parseSetCookie(headers) {
  const raw = headers && headers['set-cookie'];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const result = [];
  for (const line of list) {
    const first = String(line).split(';')[0];
    const idx = first.indexOf('=');
    if (idx === -1) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) result.push([name, value]);
  }
  return result;
}

function withinDeadline(work, deadline, controller) {
  let timer;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    return Promise.reject(new HttpError('Request timed out', { code: 'timeout' }));
  }
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HttpError('Request timed out', { code: 'timeout' }));
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function retryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(86400000, Math.max(1, Number(text) * 1000));
  const date = Date.parse(text);
  return Number.isFinite(date) && date > now ? Math.min(86400000, date - now) : 60000;
}

export class HttpClient {
  constructor({
    cookies = new Map(),
    proxy = null,
    timeoutMs = 30000,
    userAgent = DEFAULT_UA,
    maxBytes = 8 * 1024 * 1024,
    transport = defaultTransport,
    cookieDomain = isSteamCommunityHost,
  } = {}) {
    this.cookies = cookies instanceof Map ? cookies : new Map(Object.entries(cookies || {}));
    this.proxy = proxy;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2147483647) : 30000;
    this.userAgent = userAgent;
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 8 * 1024 * 1024;
    this.transport = transport;
    this.cookieDomain = cookieDomain;
    this.lastUrl = '';
    this.requestCount = 0;
  }

  cookieHeaderFor(url) {
    try {
      const parsed = new URL(url);
      if (!this.cookieDomain(parsed.hostname)) return '';
    } catch {
      return '';
    }
    return serializeCookies(this.cookies);
  }

  applySetCookies(headers) {
    for (const [name, value] of parseSetCookie(headers)) {
      this.cookies.set(name, value);
    }
  }

  async request(url, { method = 'GET', headers = {}, form = null, body = null, redirects = 5, rateLimiter = null, timeoutMs = this.timeoutMs, cookies = true } = {}) {
    const controller = new AbortController();
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 2147483647) : this.timeoutMs;
    const deadline = Date.now() + budget;
    redirects = Number.isFinite(redirects) ? Math.min(20, Math.max(0, Math.floor(redirects))) : 5;
    let currentUrl = url;
    let currentMethod = method.toUpperCase();
    let payload = body;
    const baseHeaders = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      ...headers,
    };

    if (!cookies) {
      for (const key of Object.keys(baseHeaders)) {
        if (key.toLowerCase() === 'cookie') delete baseHeaders[key];
      }
    }

    if (form) {
      payload = Buffer.from(new URLSearchParams(form).toString(), 'utf8');
      baseHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      baseHeaders['Content-Length'] = String(payload.length);
    } else if (payload && !Buffer.isBuffer(payload)) {
      payload = Buffer.from(String(payload), 'utf8');
      baseHeaders['Content-Length'] = String(payload.length);
    }

    for (let hop = 0; hop <= redirects; hop++) {
      const target = new URL(currentUrl);
      if (!['http:', 'https:'].includes(target.protocol)) {
        throw new HttpError('Unsupported URL protocol', { code: 'protocol', url: safeUrl(currentUrl) });
      }
      if (rateLimiter) await withinDeadline(() => rateLimiter.wait(), deadline, controller);
      const cookie = cookies ? this.cookieHeaderFor(currentUrl) : '';
      const requestHeaders = { ...baseHeaders };
      if (cookie) requestHeaders.Cookie = cookie;
      if (!payload) delete requestHeaders['Content-Length'];

      const response = await (async () => {
        try {
          return await withinDeadline(() => this.transport({
            url: currentUrl,
            method: currentMethod,
            headers: requestHeaders,
            body: payload,
            proxy: this.proxy,
            timeoutMs: Math.max(1, deadline - Date.now()),
            maxBytes: this.maxBytes,
            signal: controller.signal,
          }), deadline, controller);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(err.message, {
            code: this.proxy ? 'proxy' : 'network',
            url: safeUrl(currentUrl),
          });
        }
      })();

      this.requestCount++;
      this.lastUrl = currentUrl;
      if (cookies && this.cookieDomain(target.hostname)) this.applySetCookies(response.headers);
      if (response.body.length > this.maxBytes) {
        throw new HttpError(`Response exceeds ${this.maxBytes} bytes`, { code: 'size' });
      }

      const status = response.status;
      const location = headerValue(response.headers, 'location');
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        const next = new URL(location, currentUrl).toString();
        if (new URL(next).origin !== target.origin) {
          for (const key of Object.keys(baseHeaders)) {
            if (['authorization', 'cookie', 'proxy-authorization', 'host'].includes(key.toLowerCase())) delete baseHeaders[key];
          }
        }
        if (status === 303 || (currentMethod === 'POST' && (status === 301 || status === 302))) {
          currentMethod = 'GET';
          payload = null;
          delete baseHeaders['Content-Type'];
          delete baseHeaders['Content-Length'];
        }
        currentUrl = next;
        continue;
      }

      const text = response.body.toString('utf8');
      const result = {
        status,
        headers: response.headers,
        text,
        url: currentUrl,
        redirectedToLogin: isLoginUrl(currentUrl),
      };

      if (status === 429) {
        const retryAfter = retryAfterMs(headerValue(response.headers, 'retry-after'));
        throw new HttpError('Steam is rate limiting requests (HTTP 429)', {
          status,
          code: 'rate-limited',
          url: safeUrl(currentUrl),
          retryAfterMs: retryAfter,
          bodySnippet: text.slice(0, 300),
        });
      }

      if (status >= 500) {
        throw new HttpError(`Steam returned HTTP ${status}`, {
          status,
          code: 'server-error',
          url: safeUrl(currentUrl),
          bodySnippet: text.slice(0, 300),
        });
      }

      return result;
    }

    throw new HttpError('Too many redirects', { code: 'redirects', url: safeUrl(currentUrl) });
  }

  async getJson(url, options = {}) {
    const res = await this.request(url, { ...options, method: 'GET' });
    return { ...res, json: parseJson(res.text) };
  }

  async postForm(url, form, options = {}) {
    const res = await this.request(url, {
      ...options,
      method: 'POST',
      form,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://steamcommunity.com',
        Referer: options.referer || 'https://steamcommunity.com/market/',
        ...(options.headers || {}),
      },
    });
    return { ...res, json: parseJson(res.text) };
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}