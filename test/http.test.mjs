import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpClient,
  HttpError,
  RateLimiter,
  isLoginUrl,
  resolveProxy,
  safeUrl,
} from '../lib/http.js';

test('bounds queue depth and wait without reserving rejected slots', async () => {
  let now = 0;
  const limiter = new RateLimiter({ minIntervalMs: 100, maxWaitMs: 50, now: () => now });
  await limiter.wait();
  await assert.rejects(limiter.wait(), { code: 'queue-full' });
  assert.equal(limiter.nextAt, 100);
  now = 100;
  await limiter.wait();
  const stalled = new RateLimiter({ minIntervalMs: 1, maxWaitMs: 20, maxPending: 1, sleepFn: () => new Promise(() => {}) });
  await stalled.wait();
  stalled.nextAt = Date.now() + 5;
  const waiting = stalled.wait();
  await assert.rejects(stalled.wait(), { code: 'queue-full' });
  await assert.rejects(waiting, { code: 'timeout' });
  assert.equal(stalled.pending, 0);
});

test('bounds stalled custom transports and redirect chains by a total deadline', { timeout: 1000 }, async () => {
  const stalled = new HttpClient({ timeoutMs: 20, transport: () => new Promise(() => {}) });
  await assert.rejects(stalled.request('https://steamcommunity.com/'), { code: 'timeout' });
  const redirect = new HttpClient({ timeoutMs: 35, transport: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(302, '', { location: '/next' });
  } });
  await assert.rejects(redirect.request('https://steamcommunity.com/'), { code: 'timeout' });
});

test('strips cross-origin credentials and rejects non-http redirects', async () => {
  const calls = [];
  const http = new HttpClient({ transport: async (options) => {
    calls.push(options);
    return calls.length === 1 ? response(302, '', { location: 'https://other.test/' }) : response(200);
  } });
  await http.request('https://steamcommunity.com/', { headers: { authorization: 'secret', cookie: 'manual=secret' } });
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers.cookie, undefined);
  const invalid = new HttpClient({ transport: async () => response(302, '', { location: 'file:///tmp/test' }) });
  await assert.rejects(invalid.request('https://steamcommunity.com/'), { code: 'protocol' });
});

test('untrusted hosts do not overwrite Steam cookies and Retry-After dates are honored', async () => {
  const http = new HttpClient({ transport: async () => response(200, '', { 'set-cookie': ['sessionid=other'] }) });
  await http.request('https://other.test/');
  assert.equal(http.cookies.size, 0);
  const limited = new HttpClient({ transport: async () => response(429, '', { 'retry-after': new Date(Date.now() + 10000).toUTCString() }) });
  await assert.rejects(limited.request('https://steamcommunity.com/'), (err) => err.retryAfterMs > 8000 && err.retryAfterMs <= 10000);
});

test('default transport bounds compressed, chunked and trickling responses', { timeout: 3000 }, async () => {
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const timers = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(4096, 65)));
    } else if (req.url === '/large') {
      res.end(Buffer.alloc(2048));
    } else {
      res.writeHead(200);
      const timer = setInterval(() => res.write('a'), 5);
      timers.add(timer);
      res.on('close', () => { clearInterval(timer); timers.delete(timer); });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const http = new HttpClient({ timeoutMs: 100, maxBytes: 1024 });
    await assert.rejects(http.request(base + '/gzip'), { code: 'size' });
    await assert.rejects(http.request(base + '/large'), { code: 'size' });
    await assert.rejects(http.request(base + '/trickle'), { code: 'timeout' });
  } finally {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function response(status, body = '', headers = {}) {
  return { status, headers, body: Buffer.from(body, 'utf8') };
}

test('rate limiter spaces calls', async () => {
  let now = 1000;
  const sleeps = [];
  const limiter = new RateLimiter({
    minIntervalMs: 100,
    jitterMs: 0,
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  await limiter.wait();
  now = 1050;
  await limiter.wait();
  assert.deepEqual(sleeps, [50]);
  now = 1100;
  await limiter.wait();
  assert.deepEqual(sleeps, [50, 100]);
});

test('resolves proxy URLs and environment values', () => {
  const explicit = resolveProxy('127.0.0.1:7890', {});
  assert.equal(explicit.host, '127.0.0.1');
  assert.equal(explicit.port, 7890);
  assert.equal(explicit.label, 'http://127.0.0.1:7890');

  const env = resolveProxy(undefined, { HTTPS_PROXY: 'http://user:pass@proxy.local:8080' });
  assert.equal(env.host, 'proxy.local');
  assert.equal(env.port, 8080);
  assert.equal(env.auth, 'Basic ' + Buffer.from('user:pass').toString('base64'));

  assert.equal(resolveProxy('none', { HTTPS_PROXY: 'http://proxy.local:8080' }), null);
  assert.throws(() => resolveProxy(undefined, { HTTPS_PROXY: 'socks5://127.0.0.1:1080' }), /HTTP/);
});

test('follows redirects and stores session cookies', async () => {
  const calls = [];
  const transport = async (options) => {
    calls.push(options);
    if (calls.length === 1) {
      return response(302, '', {
        location: '/next',
        'set-cookie': ['sessionid=abc; Path=/; HttpOnly'],
      });
    }
    return response(200, 'ok');
  };
  const http = new HttpClient({
    cookies: new Map([['steamLoginSecure', 'login']]),
    transport,
  });
  const result = await http.request('https://steamcommunity.com/market/');
  assert.equal(result.status, 200);
  assert.equal(result.text, 'ok');
  assert.equal(http.cookies.get('sessionid'), 'abc');
  assert.equal(calls[1].url, 'https://steamcommunity.com/next');
  assert.match(calls[1].headers.Cookie, /sessionid=abc/);
});

test('turns HTTP 429 into a rate-limit error', async () => {
  const http = new HttpClient({
    transport: async () => response(429, 'slow down', { 'retry-after': '5' }),
  });
  await assert.rejects(
    () => http.request('https://steamcommunity.com/market/priceoverview/'),
    (err) =>
      err instanceof HttpError &&
      err.status === 429 &&
      err.code === 'rate-limited' &&
      err.retryAfterMs === 5000,
  );
});

test('does not send Steam cookies to other hosts', async () => {
  const calls = [];
  const http = new HttpClient({
    cookies: new Map([['steamLoginSecure', 'secret']]),
    transport: async (options) => {
      calls.push(options);
      return response(200, '{}');
    },
  });
  await http.request('https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', {
    method: 'POST',
    body: Buffer.alloc(0),
  });
  assert.equal(calls[0].headers.Cookie, undefined);
});

test('encodes form posts', async () => {
  const calls = [];
  const http = new HttpClient({
    transport: async (options) => {
      calls.push(options);
      return response(200, '{"success":true}');
    },
  });
  const result = await http.postForm('https://steamcommunity.com/market/sellitem/', {
    a: 1,
    b: 'x y',
  });
  assert.equal(result.json.success, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.toString('utf8'), 'a=1&b=x+y');
  assert.match(calls[0].headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.match(calls[0].headers.Referer, /steamcommunity\.com\/market/);
});

test('returns 4xx responses to the caller', async () => {
  const http = new HttpClient({
    transport: async () => response(400, 'bad request'),
  });
  const result = await http.request('https://steamcommunity.com/market/priceoverview/');
  assert.equal(result.status, 400);
  assert.equal(result.text, 'bad request');
});

test('redacts secrets from logged URLs', () => {
  const url = safeUrl('https://steamcommunity.com/mobileconf/getlist?a=1&k=secret&p=device&tag=list');
  assert.ok(!url.includes('secret'));
  assert.ok(url.includes('REDACTED'));
  assert.equal(url.includes('device'), false);
});

test('recognizes login redirects', () => {
  assert.equal(isLoginUrl('https://steamcommunity.com/login/home/?goto=market'), true);
  assert.equal(isLoginUrl('https://login.steampowered.com/jwt/finalizelogin'), true);
  assert.equal(isLoginUrl('https://steamcommunity.com/market/'), false);
});