import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';

async function setup(t) {
  const f = await fixture(t), a = await f.account('A'), b = await f.account('B');
  await f.post(a);
  await f.post(b, { amount: '50' });
  const transfer = patch => f.request('/transfers', { method: 'POST', body: {
    source_account_id: a, destination_account_id: b, amount: '30', reference_id: 'transfer-1', ...patch,
  } });
  return { ...f, a, b, transfer };
}

test('transfer atomically creates linked debit/credit and replays without moving money twice', async t => {
  const f = await setup(t);
  const first = await f.transfer(), replay = await f.transfer();
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.data, first.body.data);
  assert.equal(replay.body.meta.replayed, true);
  assert.equal(await f.balance(f.a), '70.00');
  assert.equal(await f.balance(f.b), '80.00');
  assert.deepEqual(first.body.data.transactions.map(x => x.type), ['debit', 'credit']);
  assert.ok(first.body.data.transactions.every(x => x.transfer_id === first.body.data.id));
  assert.equal((await f.transfer({ amount: '31' })).status, 409);
  assert.throws(() => f.db.prepare('UPDATE transfers SET description = ? WHERE id = ?').run('changed', first.body.data.id), /TRANSFER_IMMUTABLE/);
  assert.throws(() => f.db.prepare('DELETE FROM transfers WHERE id = ?').run(first.body.data.id), /TRANSFER_IMMUTABLE/);
  assert.equal((await f.post(f.a, { type: 'debit', amount: '30', reference_id: 'transfer-1' })).status, 409);
});

test('transfer validates accounts, amount, reference and distinct source/destination', async t => {
  const f = await setup(t);
  for (const [patch, expected] of [
    [{ source_account_id: randomUUID() }, 404], [{ destination_account_id: randomUUID() }, 404],
    [{ source_account_id: 'bad' }, 400], [{ destination_account_id: f.a }, 400],
    [{ amount: 0 }, 400], [{ reference_id: '' }, 400], [{ amount: 101 }, 409],
  ]) assert.equal((await f.transfer(patch)).status, expected, JSON.stringify(patch));
  assert.equal(await f.balance(f.a), '100.00');
  assert.equal(await f.balance(f.b), '50.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
});

test('destination reference collision rolls back source debit and transfer record', async t => {
  const f = await setup(t);
  await f.post(f.b, { amount: 1, reference_id: 'transfer-1' });
  const r = await f.transfer();
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'REFERENCE_CONFLICT');
  assert.equal(await f.balance(f.a), '100.00');
  assert.equal(await f.balance(f.b), '51.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ? AND reference_id = ?').get(f.a, 'transfer-1').n, 0);
});

test('destination overflow rolls back both transfer legs', async t => {
  const f = await setup(t);
  await f.post(f.b, { amount: '9999999950.00' });
  const r = await f.transfer();
  assert.equal(r.status, 409);
  assert.equal(await f.balance(f.a), '100.00');
  assert.equal(await f.balance(f.b), '10000000000.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
});

test('injected destination write failure rolls back source, destination and both ledger entries', async t => {
  const f = await setup(t);
  f.db.exec(`CREATE TRIGGER injected_destination_failure BEFORE UPDATE OF balance_minor ON accounts
    WHEN NEW.id = '${f.b}' BEGIN SELECT RAISE(ABORT, 'injected private database failure'); END`);
  const r = await f.transfer();
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(r.body), /injected|database failure/);
  assert.equal(f.logs.length, 1);
  assert.equal(await f.balance(f.a), '100.00');
  assert.equal(await f.balance(f.b), '50.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
  f.db.exec('DROP TRIGGER injected_destination_failure');
  assert.equal((await f.transfer()).status, 201);
});

test('concurrent identical transfers replay one transfer; competing transfers cannot overspend', async t => {
  const f = await setup(t);
  const repeated = await Promise.all(Array.from({ length: 10 }, () => f.transfer({ amount: 70 })));
  assert.equal(repeated.filter(x => x.status === 201).length, 1);
  assert.equal(repeated.filter(x => x.status === 200).length, 9);
  assert.equal(await f.balance(f.a), '30.00');
  const competing = await Promise.all(Array.from({ length: 10 }, () => f.transfer({ amount: 25, reference_id: randomUUID() })));
  assert.equal(competing.filter(x => x.status === 201).length, 1);
  assert.equal(competing.filter(x => x.status === 409).length, 9);
  assert.equal(await f.balance(f.a), '5.00');
  assert.equal(await f.balance(f.b), '145.00');
});

test('deferred commit failure rolls back both transfer legs and permits retry', async t => {
  const f = await setup(t);
  f.db.exec(`CREATE TABLE deferred_transfer_failure(account_id TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_transfer_commit AFTER INSERT ON transfers BEGIN INSERT INTO deferred_transfer_failure VALUES ('missing'); END;`);
  assert.equal((await f.transfer()).status, 500);
  assert.equal(await f.balance(f.a), '100.00');
  assert.equal(await f.balance(f.b), '50.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER fail_transfer_commit');
  assert.equal((await f.transfer()).status, 201);
});
