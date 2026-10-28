import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('numeric JSON amounts cannot round sub-cent or over-limit values into valid money', async t => {
  const f = await fixture(t), id = await f.account();
  for (const rawAmount of ['0.009999999999999999999', '9999999999.99000001', '10000000000.00000001', '10000000000.01', '1e99999', '1e-99999', '-1', '-0', '0', '123e-3', '99999999999.999', '1e' + '9'.repeat(1000)]) {
    const raw = `{"type":"credit","amount":${rawAmount},"reference_id":"numeric-boundary"}`;
    const result = await f.request(`/accounts/${id}/transactions`, { method: 'POST', raw });
    assert.equal(result.status, 400, rawAmount);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
});

test('exact numeric exponent and trailing-zero forms retain their monetary value and replay identity', async t => {
  const f = await fixture(t), id = await f.account();
  for (const [rawAmount, expected] of [['1e2', '100.00'], ['1e-2', '0.01'], ['1.2300', '1.23'], ['1.234e1', '12.34'], ['123e-2', '1.23']]) {
    const reference = `exact-${rawAmount}`;
    const result = await f.request(`/accounts/${id}/transactions`, { method: 'POST', raw: `{"type":"credit","amount":${rawAmount},"reference_id":"${reference}"}` });
    assert.equal(result.status, 201, rawAmount);
    assert.equal(result.body.data.amount, expected);
    const replay = await f.post(id, { amount: expected, reference_id: reference });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.data, result.body.data);
  }
  assert.equal(await f.balance(id), '114.81');
});

test('numeric precision validation also protects atomic transfers', async t => {
  const f = await fixture(t), a = await f.account(), b = await f.account();
  await f.post(a, { amount: '1' });
  const raw = `{"source_account_id":"${a}","destination_account_id":"${b}","amount":0.009999999999999999999,"reference_id":"precise-transfer"}`;
  const result = await f.request('/transfers', { method: 'POST', raw });
  assert.equal(result.status, 400);
  assert.equal(await f.balance(a), '1.00');
  assert.equal(await f.balance(b), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
});

test('SQLite FULL errors roll back both balance and entry, then allow retry after capacity is restored', async t => {
  const f = await fixture(t), id = await f.account();
  const pages = f.db.prepare('PRAGMA page_count').get().page_count;
  f.db.exec(`PRAGMA max_page_count = ${pages}`);
  let successful = 0, failedReference;
  for (let i = 0; i < 100; i++) {
    const reference_id = `storage-${i}`;
    const result = await f.post(id, { amount: '1', description: 'x'.repeat(1000), reference_id });
    if (result.status === 500) {
      failedReference = reference_id;
      assert.equal(result.body.error.code, 'INTERNAL_ERROR');
      break;
    }
    assert.equal(result.status, 201);
    successful++;
  }
  assert.ok(failedReference, 'The page limit must actually produce SQLITE_FULL.');
  assert.ok(f.logs.some(log => /database or disk is full/i.test(log.error)));
  assert.equal(f.db.isTransaction, false);
  assert.equal(await f.balance(id), `${successful}.00`);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, successful);
  f.db.exec(`PRAGMA max_page_count = ${pages + 100}`);
  assert.equal((await f.post(id, { amount: '1', description: 'x'.repeat(1000), reference_id: failedReference })).status, 201);
  assert.equal(await f.balance(id), `${successful + 1}.00`);
});
