import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';

test('creates zero-balance accounts with system IDs/timestamps and trims names', async t => {
  const f = await fixture(t);
  const r = await f.request('/accounts', { method: 'POST', body: { name: '  Alice  ' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'Alice');
  assert.equal(r.body.data.balance, '0.00');
  assert.ok(Number.isFinite(Date.parse(r.body.data.created_at)));
  assert.match(r.body.data.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.headers.get('location'), `/accounts/${r.body.data.id}/balance`);
  assert.notEqual(r.body.data.id, await f.account());
});

test('credits, debits, exact-balance debit, and precise fractional money', async t => {
  const f = await fixture(t), id = await f.account();
  for (const [type, amount, expected] of [['credit', '0.10', '0.10'], ['credit', 0.2, '0.30'], ['debit', '0.30', '0.00']]) {
    assert.equal((await f.post(id, { type, amount })).status, 201);
    assert.equal(await f.balance(id), expected);
  }
  assert.equal((await f.post(id, { type: 'debit', amount: '0.01' })).status, 409);
  assert.equal(await f.balance(id), '0.00');
  assert.equal((await f.request(`/accounts/${id}/transactions`)).body.meta.total_records, 3);
});

test('rejects invalid names and client-managed account fields consistently', async t => {
  const f = await fixture(t);
  for (const body of [{}, { name: '' }, { name: '  ' }, { name: 123 }, { name: 'x'.repeat(201) }, { name: 'A', balance: 200 }, { name: 'A', id: randomUUID() }, { name: 'A', created_at: 'yesterday' }, null, []]) {
    const r = await f.request('/accounts', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.equal(r.body.error.request_id, r.headers.get('x-request-id'));
  }
});

test('validates types, amounts, references, description and protected transaction fields', async t => {
  const f = await fixture(t), id = await f.account();
  const cases = [
    { type: 'withdrawal' }, { type: null }, { amount: 0 }, { amount: -1 }, { amount: '0.001' }, { amount: 'NaN' },
    { amount: true }, { amount: null }, { amount: {} }, { amount: '1e2' }, { amount: '10000000000.01' },
    { reference_id: '' }, { reference_id: '  ' }, { reference_id: ' leading' }, { reference_id: 1 },
    { reference_id: 'x'.repeat(129) }, { description: 1 }, { description: 'x'.repeat(1001) },
    { account_id: randomUUID() }, { created_at: '2020-01-01' }, { transfer_id: randomUUID() },
  ];
  for (const data of cases) {
    const r = await f.post(id, data);
    assert.equal(r.status, 400, JSON.stringify(data));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
  const missing = await f.request(`/accounts/${id}/transactions`, { method: 'POST', body: { type: 'credit', amount: 1 } });
  assert.equal(missing.status, 400);
  assert.equal(await f.balance(id), '0.00');
  assert.equal((await f.request(`/accounts/${id}/transactions`)).body.meta.total_records, 0);
});

test('unknown and malformed accounts have appropriate errors for balance/history/transactions', async t => {
  const f = await fixture(t);
  for (const id of [randomUUID(), 'bad-id']) {
    for (const suffix of ['balance', 'transactions']) {
      const r = await f.request(`/accounts/${id}/${suffix}`);
      assert.equal(r.status, id === 'bad-id' ? 400 : 404);
    }
    assert.equal((await f.post(id)).status, id === 'bad-id' ? 400 : 404);
  }
});

test('identical duplicate replays original response; changed payload conflicts; references are per account', async t => {
  const f = await fixture(t), a = await f.account(), b = await f.account();
  const input = { reference_id: 'deposit-1', amount: '25.50', description: 'Deposit' };
  const first = await f.post(a, input), replay = await f.post(a, input);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.meta.replayed, true);
  assert.deepEqual(replay.body.data, first.body.data);
  for (const patch of [{ amount: '26' }, { type: 'debit' }, { description: 'Changed' }]) {
    const conflict = await f.post(a, { ...input, ...patch });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'REFERENCE_CONFLICT');
  }
  assert.equal(await f.balance(a), '25.50');
  assert.equal((await f.post(b, input)).status, 201);
  assert.equal(await f.balance(b), '25.50');
  // A retry must replay even after the original debit consumed the entire balance.
  const debit = { type: 'debit', amount: '25.50', reference_id: 'spend' };
  assert.equal((await f.post(a, debit)).status, 201);
  assert.equal((await f.post(a, debit)).status, 200);
  assert.equal(await f.balance(a), '0.00');
});

test('failed debit leaves reference available for a later funded attempt', async t => {
  const f = await fixture(t), id = await f.account();
  const data = { type: 'debit', amount: '10', reference_id: 'retry' };
  assert.equal((await f.post(id, data)).status, 409);
  await f.post(id);
  assert.equal((await f.post(id, data)).status, 201);
  assert.equal(await f.balance(id), '90.00');
});

test('history filters, stable latest-first ordering, metadata and empty/out-of-range pages', async t => {
  const f = await fixture(t), id = await f.account(), other = await f.account();
  const first = await f.post(id, { amount: 10 });
  const second = await f.post(id, { type: 'debit', amount: 2 });
  const third = await f.post(id, { amount: 1 });
  await f.post(other);
  const all = await f.request(`/accounts/${id}/transactions?limit=2`);
  assert.deepEqual(all.body.meta, { page: 1, limit: 2, total_records: 3, total_pages: 2 });
  assert.deepEqual(all.body.data.map(x => x.id), [third.body.data.id, second.body.data.id]);
  const next = await f.request(`/accounts/${id}/transactions?page=2&limit=2`);
  assert.deepEqual(next.body.data.map(x => x.id), [first.body.data.id]);
  const filtered = await f.request(`/accounts/${id}/transactions?type=debit`);
  assert.deepEqual(filtered.body.data.map(x => x.id), [second.body.data.id]);
  assert.equal(filtered.body.meta.total_records, 1);
  const credits = await f.request(`/accounts/${id}/transactions?type=credit&limit=1`);
  assert.equal(credits.body.meta.total_records, 2);
  assert.equal(credits.body.meta.total_pages, 2);
  assert.deepEqual((await f.request(`/accounts/${id}/transactions?page=100`)).body.data, []);
  const empty = await f.account();
  assert.equal((await f.request(`/accounts/${empty}/transactions`)).body.meta.total_pages, 0);
  // Force equal timestamps at INSERT time to exercise the sequence tie-breaker.
  const sameTime = '2026-01-01T00:00:00.000Z';
  const insert = f.db.prepare('INSERT INTO transactions(id, account_id, type, amount_minor, description, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ids = [randomUUID(), randomUUID()];
  for (const tx of ids) insert.run(tx, empty, 'credit', 100, '', tx, sameTime);
  assert.deepEqual((await f.request(`/accounts/${empty}/transactions`)).body.data.map(x => x.id), ids.toReversed());
});

test('rejects invalid pagination/filter values including duplicate or unknown query keys', async t => {
  const f = await fixture(t), id = await f.account();
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1000001', 'limit=0', 'limit=101', 'limit=', 'limit=1e1', 'type=refund', 'type=', 'page=1&page=2', 'sort=asc']) {
    const r = await f.request(`/accounts/${id}/transactions?${query}`);
    assert.equal(r.status, 400, query);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
});

test('rejects malformed/oversized JSON, unsupported media, unknown routes and mutation methods', async t => {
  const f = await fixture(t), id = await f.account();
  const malformed = await f.request('/accounts', { method: 'POST', raw: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_JSON');
  assert.equal((await f.request('/accounts', { method: 'POST', raw: '' })).status, 400);
  assert.equal((await f.request('/accounts', { method: 'POST', raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/accounts', { method: 'POST', body: { name: 'x'.repeat(17000) } })).status, 413);
  assert.equal((await f.request('/missing')).status, 404);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await f.request(`/accounts/${id}/transactions`, { method });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, POST');
    assert.equal((await f.request(`/accounts/${id}/transactions/${randomUUID()}`, { method })).status, 404);
  }
});

test('balance limit errors leave both ledger and account unchanged', async t => {
  const f = await fixture(t), id = await f.account();
  assert.equal((await f.post(id, { amount: '10000000000.00' })).status, 201);
  const r = await f.post(id, { amount: '0.01' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'BALANCE_LIMIT');
  assert.equal(await f.balance(id), '10000000000.00');
  assert.equal((await f.request(`/accounts/${id}/transactions`)).body.meta.total_records, 1);
});

test('optional Bearer auth and public health endpoint', async t => {
  const key = 'a-long-test-service-key-123456';
  const f = await fixture(t, { apiKey: key });
  assert.equal((await f.request('/health')).status, 200);
  assert.equal((await f.request('/accounts', { method: 'POST', body: { name: 'A' } })).status, 401);
  assert.equal((await f.request('/accounts', { method: 'POST', body: { name: 'A' }, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.request('/accounts', { method: 'POST', body: { name: 'A' }, headers: { Authorization: `Bearer ${key}` } })).status, 201);
});

test('concurrent HTTP debits and duplicate requests never overspend or double-credit', async t => {
  const f = await fixture(t), id = await f.account();
  await f.post(id);
  const debits = await Promise.all(Array.from({ length: 20 }, () => f.post(id, { type: 'debit', amount: '70' })));
  assert.equal(debits.filter(r => r.status === 201).length, 1);
  assert.equal(debits.filter(r => r.status === 409).length, 19);
  assert.equal(await f.balance(id), '30.00');
  const duplicates = await Promise.all(Array.from({ length: 20 }, () => f.post(id, { amount: '1', reference_id: 'concurrent' })));
  assert.equal(duplicates.filter(r => r.status === 201).length, 1);
  assert.equal(duplicates.filter(r => r.status === 200).length, 19);
  assert.equal(new Set(duplicates.map(r => r.body.data.id)).size, 1);
  assert.equal(await f.balance(id), '31.00');
});
