import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { fixture } from './helpers.mjs';

function upload(f, chunks, agent) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.server.address().port, path: '/accounts', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, agent,
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body), reused: req.reusedSocket }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('chunked upload preserves UTF-8 characters split across body chunks', async t => {
  const f = await fixture(t);
  const body = Buffer.from('{"name":"Alice 🌍 नमस्ते"}');
  const index = body.indexOf(Buffer.from('🌍'));
  const result = await upload(f, [body.subarray(0, index + 1), body.subarray(index + 1, index + 3), body.subarray(index + 3)]);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.name, 'Alice 🌍 नमस्ते');
});

test('chunked uploads without Content-Length still enforce the byte limit', async t => {
  const f = await fixture(t);
  const result = await upload(f, ['{"name":"Alice"}', ...Array.from({ length: 17 }, () => ' '.repeat(1024))]);
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
  assert.equal((await f.request('/health')).status, 200);
});

test('a keep-alive connection remains usable after malformed JSON', async t => {
  const f = await fixture(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  assert.equal((await upload(f, ['{'], agent)).status, 400);
  const next = await upload(f, ['{"name":"After invalid request"}'], agent);
  assert.equal(next.status, 201);
  assert.equal(next.reused, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 1);
});
