import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createApp } from '../src/app.mjs';

export async function fixture(t, options = {}) {
  const db = options.db ?? openDatabase(options.path);
  const ledger = new Ledger(db);
  const logs = [];
  const server = createApp({ ledger, logger: { error: item => logs.push(item) }, apiKey: options.apiKey });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    db.close();
    options.onClose?.();
  });
  async function request(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function account(name = 'Test account') {
    const result = await request('/accounts', { method: 'POST', body: { name } });
    if (result.status !== 201) throw new Error(JSON.stringify(result.body));
    return result.body.data.id;
  }
  const post = (accountId, overrides = {}) => request(`/accounts/${accountId}/transactions`, {
    method: 'POST', body: { type: 'credit', amount: '100.00', reference_id: randomUUID(), ...overrides },
  });
  const balance = async accountId => (await request(`/accounts/${accountId}/balance`)).body.data.balance;
  return { db, ledger, server, request, account, post, balance, logs };
}
