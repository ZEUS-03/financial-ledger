import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/database.mjs';
import { Ledger } from '../../src/ledger.mjs';

const db = openDatabase(workerData.path);
const ledger = new Ledger(db);
const barrier = new Int32Array(workerData.barrier);
parentPort.postMessage({ ready: true });
try {
  if (Atomics.wait(barrier, 0, 0, 10_000) === 'timed-out') throw new Error('Start barrier timed out');
  const result = workerData.createAccount ? ledger.createAccount(workerData.createAccount) : workerData.transfer
    ? ledger.createTransfer(workerData.input)
    : ledger.createTransaction(workerData.accountId, workerData.input);
  parentPort.postMessage({ done: true, result });
} catch (error) {
  parentPort.postMessage({ done: true, error: { code: error.code, status: error.status, message: error.message } });
} finally { db.close(); }
