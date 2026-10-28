import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';

function setup(t, { fresh = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-concurrency-'));
  const path = join(directory, 'ledger.sqlite');
  const db = fresh ? null : openDatabase(path), ledger = db ? new Ledger(db) : null;
  const fixture = { path, db, ledger };
  t.after(() => {
    if (fixture.db?.isOpen) fixture.db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  });
  return fixture;
}

async function compete(path, jobs) {
  const barrier = new SharedArrayBuffer(4);
  const workers = [];
  let readyCount = 0;
  try {
    return await Promise.all(jobs.map(job => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./fixtures/concurrent-writer.mjs', import.meta.url), { workerData: { path, barrier, ...job } });
      workers.push(worker);
      let finished = false;
      const timeout = setTimeout(() => reject(new Error('Concurrent writer timed out')), 15_000);
      worker.on('error', error => { clearTimeout(timeout); reject(error); });
      worker.on('exit', code => { clearTimeout(timeout); if (!finished) reject(new Error(`Worker exited ${code} before reporting a result`)); });
      worker.on('message', message => {
        if (message.ready && ++readyCount === jobs.length) {
          Atomics.store(new Int32Array(barrier), 0, 1);
          Atomics.notify(new Int32Array(barrier), 0);
        }
        if (message.done) { finished = true; clearTimeout(timeout); resolve(message); }
      });
    })));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

function assertConsistent(db) {
  const rows = db.prepare(`SELECT a.id, a.balance_minor, coalesce(sum(CASE t.type WHEN 'credit' THEN t.amount_minor ELSE -t.amount_minor END), 0) AS ledger_balance
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id GROUP BY a.id`).all();
  for (const row of rows) {
    assert.equal(row.balance_minor, row.ledger_balance);
    assert.ok(row.balance_minor >= 0);
  }
}

test('independent database connections race debits without negative balances', { timeout: 20_000 }, async t => {
  const f = setup(t), accountId = f.ledger.createAccount('Race').id;
  f.ledger.createTransaction(accountId, { type: 'credit', amount_minor: 10000, description: '', reference_id: 'seed' });
  const results = await compete(f.path, Array.from({ length: 8 }, () => ({ accountId,
    input: { type: 'debit', amount_minor: 7000, description: '', reference_id: randomUUID() } })));
  assert.equal(results.filter(r => r.result).length, 1);
  assert.equal(results.filter(r => r.error?.code === 'INSUFFICIENT_BALANCE').length, 7);
  assert.equal(f.ledger.getBalance(accountId).balance, '30.00');
  assertConsistent(f.db);
});

test('independent connections serialize duplicate references and preserve all unique credits', { timeout: 20_000 }, async t => {
  const f = setup(t), accountId = f.ledger.createAccount('Race').id;
  const jobs = Array.from({ length: 8 }, () => ({ accountId, input: { type: 'credit', amount_minor: 100, description: '', reference_id: 'same' } }));
  const duplicates = await compete(f.path, jobs);
  assert.ok(duplicates.every(r => r.result), JSON.stringify(duplicates));
  assert.equal(duplicates.filter(r => !r.result.replayed).length, 1);
  assert.equal(new Set(duplicates.map(r => r.result.data.id)).size, 1);
  const unique = await compete(f.path, jobs.map(job => ({ ...job, input: { ...job.input, reference_id: randomUUID() } })));
  assert.equal(unique.filter(r => r.result && !r.result.replayed).length, 8);
  assert.equal(f.ledger.getBalance(accountId).balance, '9.00');
  assertConsistent(f.db);
});

test('opposite-direction transfers across independent connections conserve total funds', { timeout: 20_000 }, async t => {
  const f = setup(t), a = f.ledger.createAccount('A').id, b = f.ledger.createAccount('B').id;
  for (const accountId of [a, b]) f.ledger.createTransaction(accountId, { type: 'credit', amount_minor: 10000, description: '', reference_id: 'seed' });
  const results = await compete(f.path, Array.from({ length: 8 }, (_, i) => ({ transfer: true, input: {
    source_account_id: i % 2 ? a : b, destination_account_id: i % 2 ? b : a,
    amount_minor: 1000, description: '', reference_id: randomUUID(),
  } })));
  assert.equal(results.filter(r => r.result).length, 8, JSON.stringify(results));
  assert.equal(f.ledger.getBalance(a).balance, '100.00');
  assert.equal(f.ledger.getBalance(b).balance, '100.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 8);
  assertConsistent(f.db);
});

test('conflicting duplicate payloads across connections persist exactly one winner', { timeout: 20_000 }, async t => {
  const f = setup(t), accountId = f.ledger.createAccount('Conflict race').id;
  const results = await compete(f.path, Array.from({ length: 8 }, (_, i) => ({ accountId, input: {
    type: 'credit', amount_minor: i % 2 ? 100 : 200, description: '', reference_id: 'conflict-race',
  } })));
  assert.equal(results.filter(r => r.result && !r.result.replayed).length, 1);
  assert.equal(results.filter(r => r.result?.replayed).length, 3);
  assert.equal(results.filter(r => r.error?.code === 'REFERENCE_CONFLICT').length, 4);
  const winner = results.find(r => r.result && !r.result.replayed).result.data;
  assert.equal(f.ledger.getBalance(accountId).balance, winner.amount);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assertConsistent(f.db);
});

test('standalone debits and transfers compete for the same funds across connections', { timeout: 20_000 }, async t => {
  const f = setup(t), a = f.ledger.createAccount('Source').id, b = f.ledger.createAccount('Destination').id;
  f.ledger.createTransaction(a, { type: 'credit', amount_minor: 10000, description: '', reference_id: 'seed' });
  const results = await compete(f.path, Array.from({ length: 8 }, (_, i) => i % 2 ? {
    transfer: true, input: { source_account_id: a, destination_account_id: b, amount_minor: 7000, description: '', reference_id: randomUUID() },
  } : { accountId: a, input: { type: 'debit', amount_minor: 7000, description: '', reference_id: randomUUID() } }));
  assert.equal(results.filter(r => r.result).length, 1);
  assert.equal(results.filter(r => r.error?.code === 'INSUFFICIENT_BALANCE').length, 7);
  assert.equal(f.ledger.getBalance(a).balance, '30.00');
  const transferCount = f.db.prepare('SELECT count(*) AS n FROM transfers').get().n;
  assert.equal(f.ledger.getBalance(b).balance, transferCount ? '70.00' : '0.00');
  assertConsistent(f.db);
});

test('duplicate transfers across connections move funds once and replay linked entries', { timeout: 20_000 }, async t => {
  const f = setup(t), a = f.ledger.createAccount('Source').id, b = f.ledger.createAccount('Destination').id;
  f.ledger.createTransaction(a, { type: 'credit', amount_minor: 10000, description: '', reference_id: 'seed' });
  const results = await compete(f.path, Array.from({ length: 8 }, () => ({ transfer: true, input: {
    source_account_id: a, destination_account_id: b, amount_minor: 7000, description: '', reference_id: 'same-transfer',
  } })));
  assert.ok(results.every(r => r.result), JSON.stringify(results));
  assert.equal(results.filter(r => !r.result.replayed).length, 1);
  assert.equal(results.filter(r => r.result.replayed).length, 7);
  assert.equal(new Set(results.map(r => r.result.data.id)).size, 1);
  assert.ok(results.every(r => r.result.data.transactions.length === 2));
  assert.equal(f.ledger.getBalance(a).balance, '30.00');
  assert.equal(f.ledger.getBalance(b).balance, '70.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 1);
  assertConsistent(f.db);
});

test('simultaneous first connections migrate a fresh database exactly once', { timeout: 20_000 }, async t => {
  for (let round = 0; round < 5; round++) {
    const f = setup(t, { fresh: true });
    const results = await compete(f.path, Array.from({ length: 8 }, (_, i) => ({ createAccount: `Startup ${i}` })));
    assert.ok(results.every(r => r.result), `round ${round}: ${JSON.stringify(results)}`);
    f.db = openDatabase(f.path);
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 8);
    assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(f.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assertConsistent(f.db);
  }
});
