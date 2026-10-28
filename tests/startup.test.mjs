import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function environment(overrides = {}) {
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '3000', DATABASE_PATH: ':memory:' };
  delete env.API_KEY;
  return { ...env, ...overrides };
}

test('startup rejects invalid port, short API key and unauthenticated remote binding', () => {
  for (const [env, message] of [
    [{ PORT: 'abc' }, /PORT must/], [{ PORT: '0' }, /PORT must/], [{ PORT: '65536' }, /PORT must/],
    [{ API_KEY: 'short' }, /API_KEY must/], [{ HOST: '0.0.0.0' }, /Set API_KEY/],
  ]) {
    const result = spawnSync(process.execPath, ['src/server.mjs'], { cwd: root, env: environment(env), encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stderr, message);
  }
});

test('documented server entry point starts, serves health and creates accounts', { timeout: 10_000 }, async t => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, env: environment({ PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 5000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('"event":"listening"')) { clearTimeout(timeout); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { data: { status: 'ok' } });
  const account = await fetch(`${base}/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke test' }),
  });
  assert.equal(account.status, 201);
  assert.equal((await account.json()).data.balance, '0.00');
});

test('startup fails cleanly if another server already owns the port', { timeout: 10_000 }, async t => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const result = spawnSync(process.execPath, ['src/server.mjs'], {
    cwd: root, env: environment({ PORT: String(occupied.address().port) }), encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EADDRINUSE/);
});

test('graceful shutdown handles repeated signal events and preserves committed data', { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-shutdown-'));
  const path = join(directory, 'ledger.sqlite');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = fork(new URL('./fixtures/graceful-server.mjs', import.meta.url), [], {
    cwd: root, env: environment({ PORT: String(port), DATABASE_PATH: path }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  });
  await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Graceful server startup timed out: ${stderr}`)), 5000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('"event":"listening"')) { clearTimeout(timeout); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const account = await fetch(`${base}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"Shutdown test"}' });
  assert.equal(account.status, 201);
  const id = (await account.json()).data.id;
  const credit = await fetch(`${base}/accounts/${id}/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"credit","amount":"12.34","reference_id":"persist-on-shutdown"}',
  });
  assert.equal(credit.status, 201);
  await credit.json();
  child.send('shutdown');
  const [code, signal] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  const db = openDatabase(path);
  try {
    assert.equal(new Ledger(db).getBalance(id).balance, '12.34');
    assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  } finally { db.close(); }
});
