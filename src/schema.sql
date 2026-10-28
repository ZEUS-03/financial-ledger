CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor BETWEEN 0 AND 1000000000000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER accounts_start_at_zero BEFORE INSERT ON accounts
WHEN NEW.balance_minor != 0 BEGIN
  SELECT RAISE(ABORT, 'INITIAL_BALANCE_MUST_BE_ZERO');
END;

CREATE TABLE transfers (
  id TEXT PRIMARY KEY NOT NULL,
  source_account_id TEXT NOT NULL REFERENCES accounts(id),
  destination_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),
  reference_id TEXT NOT NULL CHECK(length(trim(reference_id)) BETWEEN 1 AND 128),
  description TEXT NOT NULL CHECK(length(description) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK(source_account_id != destination_account_id),
  UNIQUE(source_account_id, reference_id)
) STRICT;

CREATE TABLE transactions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL CHECK(type IN ('credit', 'debit')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),
  description TEXT NOT NULL CHECK(length(description) <= 1000),
  reference_id TEXT NOT NULL CHECK(length(trim(reference_id)) BETWEEN 1 AND 128),
  transfer_id TEXT REFERENCES transfers(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(account_id, reference_id)
) STRICT;

CREATE INDEX transaction_history ON transactions(account_id, created_at DESC, sequence DESC);
CREATE INDEX transaction_history_type ON transactions(account_id, type, created_at DESC, sequence DESC);
CREATE INDEX transfer_entries ON transactions(transfer_id);

-- The balance change is part of the INSERT statement: either both succeed or neither does.
CREATE TRIGGER transaction_apply_balance AFTER INSERT ON transactions BEGIN
  SELECT CASE WHEN NEW.type = 'debit' AND
    (SELECT balance_minor FROM accounts WHERE id = NEW.account_id) < NEW.amount_minor
    THEN RAISE(ABORT, 'INSUFFICIENT_BALANCE') END;
  SELECT CASE WHEN NEW.type = 'credit' AND
    (SELECT balance_minor FROM accounts WHERE id = NEW.account_id) > 1000000000000 - NEW.amount_minor
    THEN RAISE(ABORT, 'BALANCE_LIMIT') END;
  UPDATE accounts SET balance_minor = balance_minor +
    CASE NEW.type WHEN 'credit' THEN NEW.amount_minor ELSE -NEW.amount_minor END
    WHERE id = NEW.account_id;
END;

CREATE TRIGGER transactions_no_update BEFORE UPDATE ON transactions BEGIN
  SELECT RAISE(ABORT, 'TRANSACTION_IMMUTABLE');
END;
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions BEGIN
  SELECT RAISE(ABORT, 'TRANSACTION_IMMUTABLE');
END;
CREATE TRIGGER transfers_no_update BEFORE UPDATE ON transfers BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_IMMUTABLE');
END;
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_IMMUTABLE');
END;
