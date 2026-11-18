import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCookies,
  parseCookies,
  serializeCookies,
  steamIdFromCookies,
} from '../lib/cookies.js';

const STEAM_ID = '76561198000000000';

test('parses a browser cookie export array', () => {
  const cookies = parseCookies([
    { name: 'steamLoginSecure', value: `${STEAM_ID}%7C%7Ctoken`, domain: '.steamcommunity.com' },
    { name: 'sessionid', value: 'abc123', domain: 'steamcommunity.com' },
  ]);
  assert.equal(cookies.get('steamLoginSecure'), `${STEAM_ID}%7C%7Ctoken`);
  assert.equal(cookies.get('sessionid'), 'abc123');
});

test('parses a simple JSON object', () => {
  const cookies = parseCookies(JSON.stringify({ steamLoginSecure: 'x', sessionid: 'y' }));
  assert.equal(cookies.get('steamLoginSecure'), 'x');
  assert.equal(cookies.get('sessionid'), 'y');
});

test('parses an object with a cookies array', () => {
  const cookies = parseCookies({ cookies: [{ name: 'steamLoginSecure', value: 'x' }] });
  assert.equal(cookies.get('steamLoginSecure'), 'x');
});

test('parses a Cookie header string', () => {
  const cookies = parseCookies('steamLoginSecure=x%7C%7Cy; sessionid=z; other=1');
  assert.equal(cookies.get('steamLoginSecure'), 'x%7C%7Cy');
  assert.equal(cookies.get('sessionid'), 'z');
  assert.equal(cookies.get('other'), '1');
});

test('parses a Netscape cookies.txt file', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.steamcommunity.com\tTRUE\t/\tTRUE\t0\tsteamLoginSecure\t76561198000000000%7C%7Ctoken',
    '.steamcommunity.com\tTRUE\t/\tFALSE\t0\tsessionid\tabc',
  ].join('\n');
  const cookies = parseCookies(text);
  assert.equal(cookies.get('steamLoginSecure'), '76561198000000000%7C%7Ctoken');
  assert.equal(cookies.get('sessionid'), 'abc');
});

test('extracts the SteamID from steamLoginSecure', () => {
  const cookies = parseCookies({ steamLoginSecure: `${STEAM_ID}%7C%7Ctoken` });
  assert.equal(steamIdFromCookies(cookies), STEAM_ID);
});

test('rejects a malformed steamLoginSecure', () => {
  assert.equal(steamIdFromCookies(new Map([['steamLoginSecure', 'nope']])), null);
  assert.equal(steamIdFromCookies(new Map()), null);
});

test('serializes cookies into a header', () => {
  const cookies = new Map([
    ['a', '1'],
    ['b', '2'],
  ]);
  assert.equal(serializeCookies(cookies), 'a=1; b=2');
});

test('describes a cookie set without leaking values', () => {
  const info = describeCookies(new Map([['steamLoginSecure', 'secret'], ['sessionid', 'x']]));
  assert.deepEqual(info, {
    count: 2,
    hasLogin: true,
    hasSession: true,
    names: ['steamLoginSecure', 'sessionid'],
  });
});