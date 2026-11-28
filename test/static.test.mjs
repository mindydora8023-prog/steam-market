import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app/app.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-static-'));
  const root = path.join(dir, 'public');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.html'), '<main>ok</main>');
  await fs.writeFile(path.join(root, 'main.mjs'), 'export const value = 1;');
  await fs.writeFile(path.join(dir, 'secret.txt'), 'outside-root');
  const handler = createApp({ steam: { proxyLabel: 'direct' }, version: '0.3.0', publicDir: root });
  const server = http.createServer(handler);
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, root, handler, get: (url, options) => fetch(base + url, { signal: AbortSignal.timeout(3000), ...options }) };
}

function security(res) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /sandbox|default-src 'none'/);
}

test('content ETags validate GET and HEAD without response bodies or stale lengths', async (t) => {
  const app = await fixture(t);
  const first = await app.get('/main.mjs');
  assert.equal(first.status, 200);
  security(first);
  assert.match(first.headers.get('content-type'), /javascript/);
  const etag = first.headers.get('etag');
  const text = await first.text();
  const head = await app.get('/main.mjs', { method: 'HEAD' });
  assert.equal(head.headers.get('etag'), etag);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(text));
  assert.equal(await head.text(), '');
  for (const condition of [etag, `"other", W/${etag}`, '*']) {
    for (const method of ['GET', 'HEAD']) {
      const cached = await app.get('/main.mjs', { method, headers: { 'If-None-Match': condition } });
      assert.equal(cached.status, 304);
      assert.equal(cached.headers.get('content-length'), null);
      assert.equal(cached.headers.get('cache-control'), 'no-cache');
      assert.equal(await cached.text(), '');
      security(cached);
    }
  }
  await fs.writeFile(path.join(app.root, 'main.mjs'), 'export const value = 2;');
  const changed = await app.get('/main.mjs', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
});

test('malformed paths, encoded traversal, ADS and HEAD errors stay bounded', async (t) => {
  const app = await fixture(t);
  for (const [url, status] of [['/%zz', 400], ['/..%2fsecret.txt', 404], ['/..%5csecret.txt', 400], ['/index.html%3astream', 400], ['/%00', 400], ['/missing', 404]]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await app.get(url, { method });
      assert.equal(res.status, status, url);
      security(res);
      const body = await res.text();
      assert.doesNotMatch(body, /outside-root/);
      if (method === 'HEAD') assert.equal(body, '');
    }
  }
});

test('realpath containment blocks linked files outside public root', async (t) => {
  const app = await fixture(t);
  await fs.symlink(app.dir, path.join(app.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const res = await app.get('/escape/secret.txt');
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /outside-root/);
});

test('URL budget rejects before parsing or dispatch and preserves security headers', async (t) => {
  const app = await fixture(t);
  for (const route of ['/?q=', '/api/search?q=']) {
    const res = await app.get(route + 'a'.repeat(8192));
    assert.equal(res.status, 414);
    security(res);
    assert.equal(await res.text(), 'URI too long');
  }
});


test('browser can load only the allowlisted shared modules', async (t) => {
  const app = await fixture(t);
  for (const name of ['batch.js', 'currency.js', 'fees.js', 'integer.js', 'quote.js']) {
    const res = await app.get('/shared/' + name);
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.ok((await res.text()).length > 0);
    security(res);
  }
  for (const route of ['/shared/http.js', '/shared/cookies.js', '/shared/..%2fserver.mjs', '/lib/batch.js']) {
    assert.equal((await app.get(route)).status, 404, route);
  }
});

test('health exposes stable identity, root, version and process for launch checks', async (t) => {
  const app = await fixture(t);
  const res = await app.get('/api/health');
  const health = await res.json();
  assert.equal(health.ok, true);
  assert.equal(health.appId, 'steam-market-price');
  assert.equal(health.version, '0.3.0');
  assert.equal(health.root, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.equal(health.pid, process.pid);
  assert.equal(health.proxy, 'direct');
  assert.ok(Number.isFinite(Date.parse(health.time)));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  security(res);
});
