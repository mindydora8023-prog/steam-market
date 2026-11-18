import net from 'node:net';
import { resolveProxy } from '../lib/http.js';

const COMMON_PORTS = [7890, 7897, 10809];

export function canConnect(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function detectLocalProxy(env = process.env) {
  const fromEnv = resolveProxy(undefined, env);
  if (fromEnv) return fromEnv;
  for (const port of COMMON_PORTS) {
    if (await canConnect('127.0.0.1', port)) {
      return resolveProxy(`http://127.0.0.1:${port}`, {});
    }
  }
  return null;
}