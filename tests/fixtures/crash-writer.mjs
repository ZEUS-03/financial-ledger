import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/database.mjs';
import { Ledger } from '../../src/ledger.mjs';

const { path, mode, a, b } = JSON.parse(process.argv[2]);
const db = openDatabase(path), ledger = new Ledger(db);
// Keep the child alive with the connection open until the test forcibly kills it.
process.on('message', () => {});
let result;
if (mode === 'uncommitted-debit') {
  db.exec('BEGIN IMMEDIATE');
  ledger.insert(a, { type: 'debit', amount_minor: 7000, reference_id: 'interrupted', description: '' });
} else if (mode === 'partial-transfer') {
  db.exec('BEGIN IMMEDIATE');
  const id = randomUUID();
  db.prepare(`INSERT INTO transfers(id, source_account_id, destination_account_id, amount_minor, reference_id, description)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, a, b, 7000, 'interrupted', '');
  ledger.insert(a, { type: 'debit', amount_minor: 7000, reference_id: 'interrupted', description: '' }, id);
} else if (mode === 'committed-transfer') {
  result = ledger.createTransfer({ source_account_id: a, destination_account_id: b, amount_minor: 7000, reference_id: 'committed', description: '' });
} else if (mode === 'committed-credit') {
  result = ledger.createTransaction(a, { type: 'credit', amount_minor: 1234, reference_id: 'committed', description: '' });
} else throw new Error('Unknown crash fixture mode');
process.send({ ready: true, result, source_balance: ledger.getBalance(a).balance, destination_balance: ledger.getBalance(b).balance });
