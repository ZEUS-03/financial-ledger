import { randomUUID } from 'node:crypto';
import { ApiError, databaseError } from './errors.mjs';
import { money } from './validation.mjs';

const accountView = row => ({ id: row.id, name: row.name, balance: money(row.balance_minor), created_at: row.created_at });
const transactionView = row => ({ id: row.id, account_id: row.account_id, type: row.type,
  amount: money(row.amount_minor), description: row.description, reference_id: row.reference_id,
  created_at: row.created_at, ...(row.transfer_id ? { transfer_id: row.transfer_id } : {}) });

export class Ledger {
  constructor(db) { this.db = db; }

  atomic(fn, { write = true } = {}) {
    try {
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) { throw databaseError(error); }
  }

  account(id) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!row) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account does not exist.');
    return row;
  }

  createAccount(name) {
    return this.atomic(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO accounts(id, name) VALUES (?, ?)').run(id, name);
      return accountView(this.account(id));
    });
  }

  getBalance(id) {
    const row = this.account(id);
    return { account_id: row.id, balance: money(row.balance_minor) };
  }

  insert(accountId, input, transferId = null) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO transactions(id, account_id, type, amount_minor, description, reference_id, transfer_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, accountId, input.type, input.amount_minor, input.description, input.reference_id, transferId);
    return this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  }

  createTransaction(accountId, input) {
    return this.atomic(() => {
      this.account(accountId);
      const prior = this.db.prepare('SELECT * FROM transactions WHERE account_id = ? AND reference_id = ?').get(accountId, input.reference_id);
      if (prior) {
        if (prior.transfer_id || prior.type !== input.type || prior.amount_minor !== input.amount_minor || prior.description !== input.description) {
          throw new ApiError(409, 'REFERENCE_CONFLICT', 'Reference already exists with different transaction data.');
        }
        return { data: transactionView(prior), replayed: true };
      }
      return { data: transactionView(this.insert(accountId, input)), replayed: false };
    });
  }

  history(accountId, { type, page, limit }) {
    // Count and rows share a read snapshot even if another process inserts concurrently.
    return this.atomic(() => {
      this.account(accountId);
      const where = 'account_id = ?' + (type ? ' AND type = ?' : '');
      const params = type ? [accountId, type] : [accountId];
      const total = this.db.prepare(`SELECT count(*) AS total FROM transactions WHERE ${where}`).get(...params).total;
      const rows = this.db.prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC, sequence DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, (page - 1) * limit);
      return { data: rows.map(transactionView), meta: { page, limit, total_records: total, total_pages: Math.ceil(total / limit) } };
    }, { write: false });
  }

  transferView(row) {
    const entries = this.db.prepare('SELECT * FROM transactions WHERE transfer_id = ? ORDER BY sequence').all(row.id);
    return { id: row.id, source_account_id: row.source_account_id, destination_account_id: row.destination_account_id,
      amount: money(row.amount_minor), description: row.description, reference_id: row.reference_id,
      created_at: row.created_at, transactions: entries.map(transactionView) };
  }

  createTransfer(input) {
    return this.atomic(() => {
      this.account(input.source_account_id);
      this.account(input.destination_account_id);
      const prior = this.db.prepare('SELECT * FROM transfers WHERE source_account_id = ? AND reference_id = ?')
        .get(input.source_account_id, input.reference_id);
      if (prior) {
        if (prior.destination_account_id !== input.destination_account_id || prior.amount_minor !== input.amount_minor || prior.description !== input.description) {
          throw new ApiError(409, 'REFERENCE_CONFLICT', 'Reference already exists with different transfer data.');
        }
        return { data: this.transferView(prior), replayed: true };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO transfers(id, source_account_id, destination_account_id, amount_minor, description, reference_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.source_account_id, input.destination_account_id, input.amount_minor, input.description, input.reference_id);
      this.insert(input.source_account_id, { ...input, type: 'debit' }, id);
      this.insert(input.destination_account_id, { ...input, type: 'credit' }, id);
      return { data: this.transferView(this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id)), replayed: false };
    });
  }
}
