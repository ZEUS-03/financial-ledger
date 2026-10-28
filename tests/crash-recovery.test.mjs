import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';
import { fixture } from './helpers.mjs';

function fileFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-crash-'));
  const path = join(directory, 'ledger.sqlite');
  const f = { path, db: null, children: [] };
  t.after(async () => {
    for (const { child, exited } of f.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    if (f.db?.isOpen) f.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  });
  f.db = openDatabase(path);
  const ledger = new Ledger(f.db);
  f.a = ledger.createAccount('A').id;
  f.b = ledger.createAccount('B').id;
  ledger.createTransaction(f.a, { type: 'credit', amount_minor: 10000, reference_id: 'seed', description: '' });
  f.db.close();
  return f;
}

async function interruptedChild(f, mode) {
  const child = fork(new URL('./fixtures/crash-writer.mjs', import.meta.url), [JSON.stringify({ path: f.path, a: f.a, b: f.b, mode })], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  f.children.push({ child, exited });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Crash fixture timed out: ${stderr}`)), 5000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', code => { clearTimeout(deadline); reject(new Error(`Crash fixture exited ${code}: ${stderr}`)); });
    child.once('message', message => { clearTimeout(deadline); resolve(message); });
  });
  assert.equal(ready.ready, true);
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  f.db = openDatabase(f.path);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  return { ready, ledger: new Ledger(f.db) };
}

test('abrupt process termination discards an uncommitted debit and balance update', { timeout: 10000 }, async t => {
  const f = fileFixture(t);
  const { ready, ledger } = await interruptedChild(f, 'uncommitted-debit');
  assert.equal(ready.source_balance, '30.00');
  assert.equal(ledger.getBalance(f.a).balance, '100.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assert.equal(ledger.createTransaction(f.a, { type: 'debit', amount_minor: 7000, reference_id: 'interrupted', description: '' }).replayed, false);
});

test('abrupt process termination between transfer legs leaves no partial transfer', { timeout: 10000 }, async t => {
  const f = fileFixture(t);
  const { ready, ledger } = await interruptedChild(f, 'partial-transfer');
  assert.equal(ready.source_balance, '30.00');
  assert.equal(ready.destination_balance, '0.00');
  assert.equal(ledger.getBalance(f.a).balance, '100.00');
  assert.equal(ledger.getBalance(f.b).balance, '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
});

test('committed credit survives process termination and retry replays after reopening', { timeout: 10000 }, async t => {
  const f = fileFixture(t);
  const { ready, ledger } = await interruptedChild(f, 'committed-credit');
  const replay = ledger.createTransaction(f.a, { type: 'credit', amount_minor: 1234, reference_id: 'committed', description: '' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, ready.result.data);
  assert.equal(ledger.getBalance(f.a).balance, '112.34');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
});

test('committed transfer survives process termination and retry replays both original legs', { timeout: 10000 }, async t => {
  const f = fileFixture(t);
  const { ready, ledger } = await interruptedChild(f, 'committed-transfer');
  const replay = ledger.createTransfer({ source_account_id: f.a, destination_account_id: f.b, amount_minor: 7000, reference_id: 'committed', description: '' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, ready.result.data);
  assert.equal(ledger.getBalance(f.a).balance, '30.00');
  assert.equal(ledger.getBalance(f.b).balance, '70.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 3);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 1);
});

test('invalid SQLite file is rejected without overwriting its bytes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-invalid-file-'));
  const path = join(directory, 'ledger.sqlite');
  const original = Buffer.from('This is not a SQLite database. Preserve these bytes.');
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true }); rmdirSync(directory); });
  writeFileSync(path, original);
  assert.throws(() => openDatabase(path), /not a database/);
  assert.deepEqual(readFileSync(path), original);
});

test('read-only SQLite write failures return a safe error without changing readable state', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-readonly-'));
  const path = join(directory, 'ledger.sqlite');
  const writer = openDatabase(path), ledger = new Ledger(writer);
  const id = ledger.createAccount('Read only').id;
  ledger.createTransaction(id, { type: 'credit', amount_minor: 10000, reference_id: 'seed', description: '' });
  writer.close();
  const db = new DatabaseSync(path, { readOnly: true });
  const f = await fixture(t, { db, onClose() {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  } });
  const result = await f.post(id, { reference_id: 'read-only' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(await f.balance(id), '100.00');
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assert.equal(db.isTransaction, false);
  assert.ok(f.logs.some(log => /readonly/i.test(log.error)));
});
