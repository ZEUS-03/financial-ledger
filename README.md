# Transaction Ledger API

A standalone backend for the Transaction Ledger API assessment. Built with Node.js and SQLite, with no third-party runtime or test dependencies. This directory is independent of the surrounding job-search project.

Accounts start at zero. Credits and debits append immutable ledger entries. SQLite triggers update the balance as part of the insert statement, while explicit write transactions serialize competing requests. Transfers commit the transfer record, both ledger entries, and both balances together.

## Run locally

Requires **Node.js 22.21 or newer** with `node:sqlite` support. Verified using Node.js 22.21.1. Node 22 emits an experimental SQLite warning; it is expected and is not suppressed. No database service, credentials, `npm install`, or network download is needed.

```powershell
cd C:\Users\Gautam\Desktop\gautam-job-agent\transaction-ledger-api
npm run check
npm test
npm start
```

The API listens at `http://127.0.0.1:3000`. The database is created and migrated automatically at `./data/ledger.sqlite`. Restarting preserves data. Stop with Ctrl+C. `npm run dev` enables Node's file watcher.

Configuration uses environment variables; `.env.example` documents them. Files are not loaded automatically. To load a copied `.env`, use `node --env-file=.env src/server.mjs`, or set PowerShell environment variables:

```powershell
$env:PORT = '3000'
$env:DATABASE_PATH = './data/ledger.sqlite'
# Optional locally; required by startup checks when HOST is not loopback.
$env:API_KEY = 'replace-with-at-least-24-random-characters'
npm start
```

`HOST` defaults to `127.0.0.1`. The process refuses a non-loopback binding without an API key. `PORT` must be 1-65535. The database directory is created automatically. Relative database paths resolve from the process working directory.

## API

See [API reference](docs/API.md) for payloads, errors, examples and retry behavior, [assumptions](docs/ASSUMPTIONS.md) for decisions the assessment leaves open, [requirements review](docs/REQUIREMENTS.md) for assessment mapping, and [edge-case audit](docs/EDGE_CASE_AUDIT.md) for additional findings, test evidence and remaining verification work.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/accounts` | Create a zero-balance account |
| POST | `/accounts/:account_id/transactions` | Credit or debit; replay an identical reference |
| GET | `/accounts/:account_id/balance` | Get current balance |
| GET | `/accounts/:account_id/transactions?type=credit&page=1&limit=20` | Filtered, latest-first history |
| POST | `/transfers` | Atomic transfer with two linked ledger entries (assessment bonus) |
| GET | `/health` | Public database connectivity health check |

Success bodies use `{ "data": ... }`, with `meta` for pagination or retry status. Errors consistently use `{ "error": { "code", "message", "request_id", "details"? } }`. `X-Request-Id` is present on application responses. Amounts and balances are returned as decimal strings.

## Integrity design

- Money is stored as integer minor units, avoiding floating-point arithmetic. Numeric JSON amounts are validated using their original source text, preventing rounding from hiding sub-cent values or overflow. Each amount and account balance is limited to `10000000000.00`.
- `BEGIN IMMEDIATE` obtains SQLite's write lock before reading an existing reference or balance. This works across connections to the same local database, not just concurrent requests within one Node process.
- `UNIQUE(account_id, reference_id)` is a database constraint. An identical request returns the original transaction with HTTP 200 and `meta.replayed: true`; a different payload using that reference returns 409. A new write returns 201.
- An `AFTER INSERT` trigger validates available funds and updates the balance. A failed trigger, duplicate insert, or failed commit rolls back the entire transaction.
- A transfer inserts its record and both transactions inside one write transaction. A destination conflict or failure rolls back the source debit too.
- Database triggers reject ledger updates/deletes. The API provides no transaction or account edit/delete operations.
- SQL values use bound parameters. History count and results share a read snapshot; sorting uses `created_at DESC, sequence DESC` for deterministic timestamp ties.
- File databases use WAL, foreign keys, a five-second busy timeout and `synchronous=FULL`. Startup migrations run under a write lock and track `PRAGMA user_version`; transient WAL initialization locks are retried within a five-second startup budget.

## Tests

```powershell
npm test
npm run check
# Optional coverage report (does not impose a coverage threshold):
npm run test:coverage
# Focused suites:
node --test tests/api.test.mjs
node --test tests/database.test.mjs
node --test tests/concurrency.test.mjs
node --test tests/transfers.test.mjs
node --test tests/startup.test.mjs
node --test tests/edge-cases.test.mjs
node --test tests/snapshot.test.mjs
node --test tests/reliability.test.mjs
node --test tests/crash-recovery.test.mjs
node --test tests/http-streaming.test.mjs
```

Tests use real HTTP servers on ephemeral loopback ports and real SQLite databases, without mocking the persistence layer. Worker threads use separate database connections and a start barrier for contention tests. Temporary file databases are cleaned up after use; production data is never used by tests.

Coverage includes normal flows, invalid bodies and pagination, exact and conflicting retries, the same reference on separate accounts, insufficient funds, concurrent debits/credits/transfers, immutable records (including replacement attempts), persistence, database-busy retries, simultaneous migrations, read snapshots during writes, runtime startup and shutdown, and rollback on insert, balance update, destination write, and deferred commit failures. Additional tests check exact numeric JSON amounts, malformed Unicode/UTF-8, chunked uploads, exact byte limits, interrupted uploads, controlled storage faults, forced child-process termination and a 100-operation independent balance model. See the edge-case audit for the executed results and verification limits.

## Deployment scope

This is an assessment implementation with database-backed integrity protections, not evidence of readiness for every production workload. It suits a modest service on one host with a persistent **local** disk. SQLite writes are serialized, and synchronous database calls block that process's event loop while executing or waiting for locks. Contention eventually returns 503; retry the same reference with backoff.

For an actual deployment, terminate TLS at a reverse proxy, configure the API key, restrict database filesystem access, set upstream body/time/rate limits, supervise the process, and establish monitored backups and restore drills. The shared key authenticates a trusted service; it does not implement users, ownership permissions or tenant isolation. Do not expose this as a public banking service.

The following are optional additions beyond the assessment: per-user authorization, audit/metrics infrastructure, a supported non-experimental database driver, PostgreSQL for sustained concurrent writes or multiple hosts, and cursor pagination for history navigation during ongoing writes. Local tests exercise forced child-process termination and simulated SQLite capacity exhaustion; these do not replace hardware power-loss testing. No load benchmark, real power-loss test, deployment, or backup/restore drill has been performed.

Do not copy only the main SQLite file while the service is writing in WAL mode. Use SQLite's online backup facilities, or stop every writer cleanly before copying the database and verify the restored database separately.

Design references: [Node SQLite API and runtime stability](https://nodejs.org/api/sqlite.html), [SQLite transactions and write locking](https://sqlite.org/lang_transaction.html), [SQLite triggers](https://sqlite.org/lang_createtrigger.html).

## Structure

```text
src/
  app.mjs          HTTP routing, request limits, auth and error formatting
  server.mjs       Configuration, startup and graceful shutdown
  ledger.mjs       Atomic business operations and replay semantics
  database.mjs     SQLite configuration and versioned schema initialization
  schema.sql       Constraints, balance and immutability triggers, indexes
  validation.mjs   Input validation and exact money conversion
  errors.mjs       Typed API errors and database error translation
tests/            HTTP, integrity, rollback and concurrent-connection tests
docs/             API contract, assumptions and assessment checklist
```
