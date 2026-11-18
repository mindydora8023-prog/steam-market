import path from 'node:path';
import os from 'node:os';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toInt(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, ''));
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

export function toFloat(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function maskId(value) {
  const s = String(value || '');
  if (s.length <= 8) return s ? '***' : '';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

export function timestampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function defaultDataDir(env = process.env) {
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'steam-market');
}

export function ensureDirSync(fs, dir) {
  fs.mkdirSync(dir, { recursive: true });
}
