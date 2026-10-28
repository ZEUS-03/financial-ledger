import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { fixture } from './helpers.mjs';

test('rejects NUL characters and unpaired surrogates in persisted text without server errors', async t => {
  const f = await fixture(t), id = await f.account();
  for (const value of ['\u0000start', 'middle\u0000end', '\ud800', '\udfff', 'x\ud800y']) {
    const account = await f.request('/accounts', { method: 'POST', body: { name: value } });
    assert.equal(account.status, 400, `account ${JSON.stringify(value)}`);
    for (const field of ['description', 'reference_id']) {
      const result = await f.post(id, { [field]: value });
      assert.equal(result.status, 400, `${field} ${JSON.stringify(value)}`);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }
  }
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal(f.logs.length, 0);
});

test('valid Unicode and SQL-like text round-trip exactly and replay unchanged', async t => {
  const f = await fixture(t), id = await f.account('नमस्ते 🌍');
  const data = { amount: '1.01', reference_id: "नाम-🌍-' OR 1=1 --", description: "Payment 🌍\nनमस्ते '; DROP TABLE accounts; --" };
  const first = await f.post(id, data), replay = await f.post(id, data);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(first.body.data.description, data.description);
  assert.equal(first.body.data.reference_id, data.reference_id);
  assert.deepEqual(replay.body.data, first.body.data);
  assert.equal(await f.balance(id), '1.01');
});

test('invalid UTF-8 bytes are rejected before JSON text can be silently changed', async t => {
  const f = await fixture(t);
  const raw = Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  const result = await f.request('/accounts', { method: 'POST', raw });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_JSON');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
});

test('compressed bodies and non-UTF-8 charset declarations receive a media error', async t => {
  const f = await fixture(t);
  for (const headers of [{ 'Content-Encoding': 'gzip' }, { 'Content-Type': 'application/json; charset=iso-8859-1' }]) {
    const result = await f.request('/accounts', { method: 'POST', raw: '{"name":"Alice"}', headers });
    assert.equal(result.status, 415);
    assert.equal(result.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  assert.equal((await f.request('/accounts', { method: 'POST', body: { name: 'UTF8' }, headers: { 'Content-Type': 'application/json; charset="UTF-8"' } })).status, 201);
});

test('body limit counts bytes, accepts the exact boundary, and survives an oversized request', async t => {
  const f = await fixture(t), id = await f.account();
  const compact = JSON.stringify({ type: 'credit', amount: '1', reference_id: 'boundary' });
  const raw = compact + ' '.repeat(16 * 1024 - Buffer.byteLength(compact));
  assert.equal((await f.request(`/accounts/${id}/transactions`, { method: 'POST', raw })).status, 201);
  assert.equal((await f.request(`/accounts/${id}/transactions`, { method: 'POST', raw: raw + ' ' })).status, 413);
  // Fewer than 16K characters can still exceed 16K encoded bytes.
  const multibyte = JSON.stringify({ name: '🌍'.repeat(5000) });
  assert.ok(multibyte.length < 16 * 1024);
  assert.equal((await f.request('/accounts', { method: 'POST', raw: multibyte })).status, 413);
  assert.equal((await f.request('/health')).status, 200);
  assert.equal(await f.balance(id), '1.00');
});

test('required transaction fields cannot be omitted, and scalar/array bodies are rejected', async t => {
  const f = await fixture(t), id = await f.account();
  for (const field of ['type', 'amount', 'reference_id']) {
    const body = { type: 'credit', amount: '1', reference_id: 'required' };
    delete body[field];
    assert.equal((await f.request(`/accounts/${id}/transactions`, { method: 'POST', body })).status, 400);
  }
  for (const body of [null, [], 1, true, 'text']) {
    assert.equal((await f.request(`/accounts/${id}/transactions`, { method: 'POST', body })).status, 400);
    assert.equal((await f.request('/transfers', { method: 'POST', body })).status, 400);
  }
  assert.equal(await f.balance(id), '0.00');
});

test('money boundary values and equivalent representations preserve cents and retry identity', async t => {
  const f = await fixture(t), id = await f.account();
  for (const value of ['0', '-0', 0, -0, '0.00', '0.001', '1.001', ' 1', '1 ', '+1', '.1', '1.', '1e2', 'Infinity', 'NaN', [], '10000000000.01']) {
    assert.equal((await f.post(id, { amount: value })).status, 400, JSON.stringify(value));
  }
  const first = await f.post(id, { amount: '00001.0', reference_id: 'equivalent' });
  const replay = await f.post(id, { amount: 1, description: '', reference_id: 'equivalent' });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.deepEqual(first.body.data, replay.body.data);
  assert.equal((await f.post(id, { amount: '9999999999.00' })).status, 201);
  assert.equal(await f.balance(id), '10000000000.00');
  assert.equal((await f.post(id, { amount: '0.01' })).status, 409);
  assert.equal((await f.post(id, { type: 'debit', amount: '10000000000.00' })).status, 201);
  assert.equal(await f.balance(id), '0.00');
});

test('reference matching is case-sensitive and text length boundaries are enforced', async t => {
  const f = await fixture(t), id = await f.account('x'.repeat(200));
  assert.equal((await f.post(id, { reference_id: 'r'.repeat(128), description: 'd'.repeat(1000), amount: '0.01' })).status, 201);
  assert.equal((await f.post(id, { reference_id: 'Reference', amount: '0.01' })).status, 201);
  assert.equal((await f.post(id, { reference_id: 'reference', amount: '0.01' })).status, 201);
  assert.equal((await f.post(id, { reference_id: 'r'.repeat(129) })).status, 400);
  assert.equal((await f.post(id, { description: 'd'.repeat(1001) })).status, 400);
  assert.equal(await f.balance(id), '0.03');
});

test('concurrent changed-payload retries commit one payload and reject the other', async t => {
  const f = await fixture(t), id = await f.account();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.post(id, {
    amount: i % 2 ? '1' : '2', reference_id: 'same-reference',
  })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 9);
  assert.equal(results.filter(r => r.status === 409).length, 10);
  const winner = results.find(r => r.status === 201).body.data;
  assert.equal(await f.balance(id), winner.amount);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
});

test('transfer replay survives later spending; changed descriptions/destinations conflict', async t => {
  const f = await fixture(t), a = await f.account(), b = await f.account(), c = await f.account();
  await f.post(a, { amount: '100' });
  const body = { source_account_id: a, destination_account_id: b, amount: '100', reference_id: 'transfer-edge' };
  const transfer = patch => f.request('/transfers', { method: 'POST', body: { ...body, ...patch } });
  const first = await transfer();
  assert.equal(first.status, 201);
  await f.post(b, { type: 'debit', amount: '100' });
  assert.equal(await f.balance(a), '0.00');
  assert.equal(await f.balance(b), '0.00');
  const retry = await transfer({ amount: '100.00', description: '' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.data, first.body.data);
  assert.equal((await transfer({ description: 'changed' })).status, 409);
  assert.equal((await transfer({ destination_account_id: c })).status, 409);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 1);
});

test('source reference collision and failed transfer leave the entire transfer uncommitted', async t => {
  const f = await fixture(t), a = await f.account(), b = await f.account();
  await f.post(a, { reference_id: 'occupied', amount: '100' });
  const body = { source_account_id: a, destination_account_id: b, amount: '30', reference_id: 'occupied' };
  const result = await f.request('/transfers', { method: 'POST', body });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'REFERENCE_CONFLICT');
  assert.equal(await f.balance(a), '100.00');
  assert.equal(await f.balance(b), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transfers').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
});

test('failed insufficient transfer can retry its reference after funding', async t => {
  const f = await fixture(t), a = await f.account(), b = await f.account();
  const body = { source_account_id: a, destination_account_id: b, amount: '30', reference_id: 'fund-later' };
  assert.equal((await f.request('/transfers', { method: 'POST', body })).status, 409);
  await f.post(a, { amount: '30' });
  assert.equal((await f.request('/transfers', { method: 'POST', body })).status, 201);
  assert.equal(await f.balance(a), '0.00');
  assert.equal(await f.balance(b), '30.00');
});

test('pagination upper boundaries and additional malformed queries are handled without writes', async t => {
  const f = await fixture(t), id = await f.account();
  const boundary = await f.request(`/accounts/${id}/transactions?page=1000000&limit=100`);
  assert.equal(boundary.status, 200);
  assert.deepEqual(boundary.body.data, []);
  for (const query of ['page=01', 'page=%201', 'page=1%0A', 'page=9007199254740992', 'page=Infinity', 'limit=1.0', 'type=CREDIT', 'type=credit&type=debit', 'limit=1&limit=2']) {
    assert.equal((await f.request(`/accounts/${id}/transactions?${query}`)).status, 400, query);
  }
});

test('unauthenticated transaction/transfer writes cannot change balances', async t => {
  const f = await fixture(t, { apiKey: 'a-realistic-long-test-key-123456' });
  const a = f.ledger.createAccount('A').id, b = f.ledger.createAccount('B').id;
  assert.equal((await f.post(a)).status, 401);
  assert.equal((await f.request('/transfers', { method: 'POST', body: {
    source_account_id: a, destination_account_id: b, amount: '1', reference_id: 'unauthorized',
  } })).status, 401);
  assert.equal(f.ledger.getBalance(a).balance, '0.00');
  assert.equal(f.ledger.getBalance(b).balance, '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
});

test('deterministic mixed-operation sequence matches an independent integer-money model', async t => {
  const f = await fixture(t);
  const ids = await Promise.all([f.account('A'), f.account('B'), f.account('C')]);
  const balances = new Map(ids.map(id => [id, 0]));
  const counts = new Map(ids.map(id => [id, 0]));
  const history = new Map();
  let seed = 20261027;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let i = 0; i < 100; i++) {
    const a = ids[random(ids.length)], b = ids[(ids.indexOf(a) + 1) % ids.length];
    const minor = random(10000) + 1, value = `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
    const reference = `model-${i}`;
    let result;
    if (i % 4 === 0) {
      result = await f.post(a, { type: 'credit', amount: value, reference_id: reference });
      assert.equal(result.status, 201);
      balances.set(a, balances.get(a) + minor); counts.set(a, counts.get(a) + 1);
      history.set(i, { a, value, reference, data: result.body.data });
    } else if (i % 4 === 1) {
      result = await f.post(a, { type: 'debit', amount: value, reference_id: reference });
      const possible = balances.get(a) >= minor;
      assert.equal(result.status, possible ? 201 : 409);
      if (possible) { balances.set(a, balances.get(a) - minor); counts.set(a, counts.get(a) + 1); }
    } else if (i % 4 === 2) {
      result = await f.request('/transfers', { method: 'POST', body: { source_account_id: a, destination_account_id: b, amount: value, reference_id: reference } });
      const possible = balances.get(a) >= minor;
      assert.equal(result.status, possible ? 201 : 409);
      if (possible) {
        balances.set(a, balances.get(a) - minor); balances.set(b, balances.get(b) + minor);
        counts.set(a, counts.get(a) + 1); counts.set(b, counts.get(b) + 1);
      }
    } else {
      const previous = history.get(i - 3);
      result = await f.post(previous.a, { amount: previous.value, reference_id: previous.reference });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data, previous.data);
    }
    for (const id of ids) {
      const stored = f.db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(id).balance_minor;
      const ledger = f.db.prepare("SELECT coalesce(sum(CASE type WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS total FROM transactions WHERE account_id = ?").get(id).total;
      assert.equal(stored, balances.get(id), `operation ${i}`);
      assert.equal(ledger, balances.get(id), `reconciliation ${i}`);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ?').get(id).n, counts.get(id));
    }
  }
});

test('malformed request targets receive a client error rather than an internal server error', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: f.server.address().port, path: '//' }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'INVALID_URL');
  assert.equal(f.logs.length, 0);
});

test('aborting a partially uploaded transaction creates no record and keeps the server usable', { timeout: 5000 }, async t => {
  const f = await fixture(t), id = await f.account();
  const received = once(f.server, 'request');
  const client = httpRequest({ hostname: '127.0.0.1', port: f.server.address().port,
    path: `/accounts/${id}/transactions`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2000' },
  });
  client.on('error', () => {});
  client.write('{"type":"credit","amount":"1",');
  const [request] = await received;
  const aborted = once(request, 'aborted');
  client.destroy();
  await aborted;
  assert.equal((await f.request('/health')).status, 200);
  assert.equal(await f.balance(id), '0.00');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 0);
  assert.equal(f.logs.length, 0);
});
