import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/database.mjs';
import { Ledger } from '../src/ledger.mjs';

test('history count and rows keep one read snapshot while another connection commits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-snapshot-'));
  const path = join(directory, 'ledger.sqlite');
  const readerDb = openDatabase(path), writerDb = openDatabase(path);
  try {
    const reader = new Ledger(readerDb), writer = new Ledger(writerDb);
    const id = writer.createAccount('Snapshot').id;
    const first = writer.createTransaction(id, { type: 'credit', amount_minor: 100, description: '', reference_id: 'first' }).data;
    const account = reader.account.bind(reader);
    // Interleave a real second connection after the reader establishes its snapshot.
    reader.account = accountId => {
      const row = account(accountId);
      writer.createTransaction(id, { type: 'credit', amount_minor: 200, description: '', reference_id: 'second' });
      return row;
    };
    const history = reader.history(id, { type: null, page: 1, limit: 20 });
    assert.equal(history.meta.total_records, 1);
    assert.deepEqual(history.data.map(row => row.id), [first.id]);
    reader.account = account;
    const next = reader.history(id, { type: null, page: 1, limit: 20 });
    assert.equal(next.meta.total_records, 2);
    assert.equal(next.data.length, 2);
    assert.equal(reader.getBalance(id).balance, '3.00');
    assert.equal(readerDb.isTransaction, false);
  } finally {
    readerDb.close(); writerDb.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    rmdirSync(directory);
  }
});
