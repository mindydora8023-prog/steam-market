import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendError(req, res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function serveStatic(req, res, url, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(req, res, 400, 'Bad request');
    return true;
  }

  if (/[\\\x00:]/.test(pathname)) {
    sendError(req, res, 400, 'Bad request');
    return true;
  }
  if (pathname === '/') pathname = '/index.html';
  const base = path.resolve(root);
  let resolved = path.resolve(base, pathname.replace(/^\/+/, ''));
  if (!within(base, resolved)) {
    sendError(req, res, 404, 'Not found');
    return true;
  }

  try {
    const realRoot = await fs.promises.realpath(base);
    resolved = await fs.promises.realpath(resolved);
    if (!within(realRoot, resolved) || !(await fs.promises.stat(resolved)).isFile()) {
      sendError(req, res, 404, 'Not found');
      return true;
    }
  } catch {
    sendError(req, res, 404, 'Not found');
    return true;
  }

  let data;
  try {
    data = await fs.promises.readFile(resolved);
  } catch {
    sendError(req, res, 404, 'Not found');
    return true;
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const noCache = ['.html', '.css', '.js', '.mjs', '.json'].includes(ext);
  const etag = '"' + createHash('sha256').update(data).digest('hex') + '"';
  const headers = {
    'Content-Type': type,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
    ETag: etag,
  };
  const condition = req.headers['if-none-match'];
  if (typeof condition === 'string' && condition.split(',').some((tag) => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  })) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(data);
  return true;
}