import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient, resolveProxy } from '../lib/http.js';
import { createApp } from './app.mjs';
import { detectLocalProxy } from './proxy.mjs';
import { SteamMarket } from './steam.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

function helpText() {
  return [
    'Steam Market Price Calculator',
    '',
    'Usage:',
    '  node app/server.mjs [--port 8787] [--host 127.0.0.1] [--proxy URL|none] [--no-auto-proxy]',
    '',
    'Options:',
    '  --port <n>        HTTP port (default 8787; fails if busy)',
    '  --host <addr>     Bind address (default 127.0.0.1)',
    '  --proxy <url>     HTTP proxy, e.g. http://127.0.0.1:7890',
    '  --proxy none      Do not use a proxy',
    '  --no-auto-proxy   Do not probe local 7890/7897/10809',
    '  --help            Show this help',
    '',
    'Open the printed local URL in a browser. The app is read-only.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    port: 8787,
    host: '127.0.0.1',
    proxy: undefined,
    autoProxy: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--no-auto-proxy') {
      opts.autoProxy = false;
    } else if (arg === '--port') {
      const value = argv[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be 1..65535');
      opts.port = n;
    } else if (arg === '--host') {
      const value = argv[++i];
      if (!value) throw new Error('--host requires a value');
      opts.host = value;
    } else if (arg === '--proxy') {
      const value = argv[++i];
      if (!value) throw new Error('--proxy requires a URL or "none"');
      opts.proxy = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port });
    });
    server.listen(port, host);
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(helpText());
    return 0;
  }

  let proxy = null;
  if (opts.proxy !== 'none') {
    if (opts.proxy) {
      proxy = resolveProxy(opts.proxy, env);
    } else if (opts.autoProxy) {
      proxy = await detectLocalProxy(env);
    }
  }

  const client = new HttpClient({ proxy, timeoutMs: 30000 });
  const steam = new SteamMarket({ http: client, proxyLabel: proxy ? proxy.label : 'direct' });
  const app = createApp({ steam, version: VERSION, publicDir: PUBLIC_DIR });
  const { server, port } = await listen(app, opts.port, opts.host);
  const displayHost = opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host;

  console.log(`Steam Market Price Calculator ${VERSION}`);
  console.log(`Local: http://${displayHost}:${port}`);
  console.log(`Proxy: ${proxy ? proxy.label : 'direct'}`);
  console.log('Read-only. Press Ctrl+C to stop.');

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}