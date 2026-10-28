import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';
import { fixture } from './helpers.mjs';

test('database enforces account reference uniqueness, foreign keys, types, positive amounts and zero initial balance', t => {
  const db = openDatabase(); t.after(() => db.close());
  const ledger = new Ledger(db), a = ledger.createAccount('A').id, b = ledger.createAccount('B').id;
  const insert = db.prepare('INSERT INTO transactions(id, account_id, type, amount_minor, description, reference_id) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(randomUUID(), a, 'credit', 100, '', 'same');
  assert.throws(() => insert.run(randomUUID(), a, 'credit', 100, '', 'same'), /UNIQUE constraint/);
  insert.run(randomUUID(), b, 'credit', 100, '', 'same');
  assert.throws(() => insert.run(randomUUID(), randomUUID(), 'credit', 100, '', 'orphan'), /FOREIGN KEY/);
  assert.throws(() => insert.run(randomUUID(), a, 'refund', 100, '', 'type'), /CHECK constraint/);
  assert.throws(() => insert.run(randomUUID(), a, 'credit', 0, '', 'zero'), /CHECK constraint/);
  assert.throws(() => insert.run(randomUUID(), a, 'credit', 1.5, '', 'fractional'), /cannot store REAL/);
  assert.throws(() => insert.run(randomUUID(), a, 'debit', 101, '', 'negative'), /INSUFFICIENT_BALANCE/);
  assert.throws(() => db.prepare('INSERT INTO accounts(id, name, balance_minor) VALUES (?, ?, ?)').run(randomUUID(), 'A', 100), /INITIAL_BALANCE/);
  assert.equal(ledger.getBalance(a).balance, '1.00');
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
});

test('database rejects edits/deletes of all transaction fields and preserves balances', t => {
  const db = openDatabase(); t.after(() => db.close());
  const ledger = new Ledger(db), a = ledger.createAccount('A').id;
  const tx = ledger.createTransaction(a, { type: 'credit', amount_minor: 100, description: 'Original', reference_id: 'immutable' }).data;
  for (const field of ['type', 'amount_minor', 'description', 'reference_id', 'account_id', 'created_at', 'id', 'transfer_id']) {
    assert.throws(() => db.prepare(`UPDATE transactions SET ${field} = ${field} WHERE id = ?`).run(tx.id), /TRANSACTION_IMMUTABLE/);
  }
  assert.throws(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id), /TRANSACTION_IMMUTABLE/);
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO transactions(id, account_id, type, amount_minor, description, reference_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), a, 'credit', 500, 'Replacement', 'immutable'), /TRANSACTION_IMMUTABLE/);
  assert.equal(db.prepare('SELECT id FROM transactions').get().id, tx.id);
  assert.equal(ledger.getBalance(a).balance, '1.00');
});

test('injected ledger insertion failure leaves balance unchanged and request can retry', async t => {
  const f = await fixture(t), id = await f.account();
  f.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END");
  assert.equal((await f.post(id, { reference_id: 'retry' })).status, 500);
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER fail_insert');
  assert.equal((await f.post(id, { reference_id: 'retry' })).status, 201);
});

test('injected balance write failure rolls back ledger entry', async t => {
  const f = await fixture(t), id = await f.account();
  f.db.exec("CREATE TRIGGER fail_balance BEFORE UPDATE OF balance_minor ON accounts BEGIN SELECT RAISE(ABORT, 'injected balance failure'); END");
  assert.equal((await f.post(id)).status, 500);
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal(f.db.isTransaction, false);
});

test('commit failure rolls back both balance and entry, including deferred constraints', async t => {
  const f = await fixture(t), id = await f.account();
  f.db.exec(`CREATE TABLE deferred_failure(account_id TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON transactions BEGIN INSERT INTO deferred_failure VALUES ('missing-account'); END;`);
  assert.equal((await f.post(id, { reference_id: 'retry' })).status, 500);
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM deferred_failure').get().n, 0);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER fail_commit');
  assert.equal((await f.post(id, { reference_id: 'retry' })).status, 201);
});

test('file database persists accounts/transactions and schema migration is repeatable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-persistence-'));
  const path = join(directory, 'ledger.sqlite');
  let db;
  try {
    db = openDatabase(path);
    const ledger = new Ledger(db), id = ledger.createAccount('Persistent').id;
    ledger.createTransaction(id, { type: 'credit', amount_minor: 1250, reference_id: 'persist', description: '' });
    db.close(); db = openDatabase(path);
    assert.equal(new Ledger(db).getBalance(id).balance, '12.50');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  } finally {
    if (db?.isOpen) db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('database lock contention returns 503 with Retry-After and permits an idempotent retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-busy-'));
  const path = join(directory, 'ledger.sqlite');
  const f = await fixture(t, { path, onClose() {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  } });
  const id = await f.account();
  const locker = openDatabase(path);
  try {
    locker.exec('BEGIN IMMEDIATE');
    f.db.exec('PRAGMA busy_timeout = 20');
    const r = await f.post(id, { reference_id: 'retry-busy' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'DATABASE_BUSY');
    assert.equal(r.headers.get('retry-after'), '1');
    assert.equal(await f.balance(id), '0.00');
    assert.equal(f.db.isTransaction, false);
  } finally {
    if (locker.isTransaction) locker.exec('ROLLBACK');
    locker.close();
  }
  assert.equal((await f.post(id, { reference_id: 'retry-busy' })).status, 201);
  assert.equal((await f.post(id, { reference_id: 'retry-busy' })).status, 200);
  assert.equal(await f.balance(id), '100.00');
});

test('unsupported positive and negative schema versions fail without changing existing data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-version-'));
  const path = join(directory, 'ledger.sqlite');
  let db;
  try {
    db = openDatabase(path);
    new Ledger(db).createAccount('Existing');
    for (const version of [2, -1]) {
      db.exec(`PRAGMA user_version = ${version}`);
      db.close(); db = undefined;
      let opened;
      try { assert.throws(() => { opened = openDatabase(path); }, /Unsupported schema version/); }
      finally { if (opened?.isOpen) opened.close(); }
      db = new DatabaseSync(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(db.prepare('SELECT name FROM accounts').get().name, 'Existing');
    }
  } finally {
    if (db?.isOpen) db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});

test('failed schema migration rolls back newly created tables and preserves existing content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-migration-'));
  const path = join(directory, 'ledger.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE transfers(legacy TEXT); INSERT INTO transfers VALUES ('keep me');");
    db.close(); db = undefined;
    assert.throws(() => openDatabase(path), /already exists/);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare('SELECT legacy FROM transfers').get().legacy, 'keep me');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['transfers']);
  } finally {
    if (db?.isOpen) db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});
