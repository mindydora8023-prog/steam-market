import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen } from '../app/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
function run(script, setup, args = '') {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `${setup}\n& ${quote(path.join(root, 'scripts', script))} ${args}`], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return result;
}
const windows = { skip: process.platform !== 'win32' };
const noLaunch = `function Start-Process { throw 'Unexpected launch' }; function Stop-Process { throw 'Unexpected stop' }`;
function health(body, expectedUrl = 'http://127.0.0.1:8787/api/health') {
  return `function Invoke-WebRequest {
    param($Uri)
    if ($Uri -cne ${quote(expectedUrl)}) { throw 'Unexpected health URL' }
    [pscustomobject]@{ StatusCode = 200; Content = ${quote(JSON.stringify(body))} }
  }`;
}
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const valid = { ok: true, appId: 'steam-market-price', version, root, pid: 123, proxy: 'direct', time: '2026-11-14T00:00:00.000Z' };

test('CheckOnly never launches for arbitrary HTTP 200 or unavailable health', windows, () => {
  for (const body of [{}, { ok: true }, { ...valid, appId: 'other' }, { ...valid, version: '' }, { ...valid, ok: 'true' }, { ...valid, ok: 'True' }, { ...valid, pid: true }]) {
    const result = run('open-app.ps1', noLaunch + '\n' + health(body), '-CheckOnly');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trim(), 'not-ready');
    assert.doesNotMatch(result.stderr, /Unexpected/);
  }
  const unavailable = run('open-app.ps1', noLaunch + "\nfunction Invoke-WebRequest { throw 'offline' }", '-CheckOnly');
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout.trim(), 'not-ready');
});

test('CheckOnly recognizes current app identity without browser or server launch', windows, () => {
  const result = run('open-app.ps1', noLaunch + '\n' + health(valid), '-CheckOnly');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), 'ready: http://127.0.0.1:8787/');
});

test('NoOpen reaches the server without opening a browser or starting a local process', windows, () => {
  const result = run('open-app.ps1', noLaunch + '\n' + health(valid), '-NoOpen');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stderr, /Unexpected/);
});

test('the shortcut opens only the server page', windows, () => {
  const baseUrl = 'https://example.org/steam';
  const setup = noLaunch.replace("function Start-Process { throw 'Unexpected launch' }", 'function Start-Process { param($FilePath) Write-Output "OPEN:$FilePath" }') + '\n' + health(valid, `${baseUrl}/api/health`);
  const result = run('open-app.ps1', setup, `-BaseUrl ${quote(baseUrl)}`);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), `OPEN:${baseUrl}/`);
});

function stopSetup(commands, owners = [123]) {
  const entries = commands.map((command, index) => `[pscustomobject]@{ ProcessId = ${123 + index}; Name = 'node.exe'; CommandLine = ${quote(command)}; CreationDate = 'same' }`);
  return `$global:mockProcesses = @(${entries.join(';')})
function Get-NetTCPConnection { ${owners.map((id) => `[pscustomobject]@{ OwningProcess = ${id} }`).join(';')} }
function Get-CimInstance { param($Filter) if ($Filter -notmatch '^ProcessId=(\\d+)$') { throw 'Array PID filter' }; $global:mockProcesses | Where-Object ProcessId -eq ([int]$Matches[1]) }
function Stop-Process { param($Id) Write-Output "MOCK-STOP:$Id" }`;
}

test('stop uses exact absolute root entry and deduplicates listening PID arrays', windows, () => {
  const command = `"C:\\Program Files\\nodejs\\node.exe" "${path.join(root, 'app', 'server.mjs')}" --port 8787`;
  const result = run('stop-app.ps1', stopSetup([command], [123, 123]));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal((result.stdout.match(/MOCK-STOP:123/g) || []).length, 1);
});

test('stop rejects fuzzy regex matches, relative roots and mixed owners before any stop', windows, () => {
  const exact = `node.exe "${path.join(root, 'app', 'server.mjs')}"`;
  for (const command of ['node.exe appXserverYmjs', 'node.exe app\\server.mjs', `node.exe "${path.join(root + '-other', 'app', 'server.mjs')}"`, exact + '.bak']) {
    const result = run('stop-app.ps1', stopSetup([command]));
    assert.equal(result.status, 1, command + result.stderr);
    assert.doesNotMatch(result.stdout, /MOCK-STOP/);
  }
  const mixed = run('stop-app.ps1', stopSetup([exact, 'node.exe other.mjs'], [123, 124]));
  assert.equal(mixed.status, 1);
  assert.doesNotMatch(mixed.stdout, /MOCK-STOP/);
});

test('server reports EADDRINUSE instead of silently moving ports', async (t) => {
  const occupied = await listen((req, res) => res.end('fixture'), 0, '127.0.0.1');
  t.after(() => new Promise((resolve) => occupied.server.close(resolve)));
  await assert.rejects(listen(() => {}, occupied.port, '127.0.0.1'), { code: 'EADDRINUSE' });
});
