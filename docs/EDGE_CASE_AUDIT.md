# Edge-case audit

Date: 2026-10-27. Runtime: Node.js 22.21.1 on Windows. The first audit expanded the original 31 tests to 58; a second pass added 13 tests, for **71 tests**. It checked the API contract, exact numeric input, money boundaries, duplicate/retry behavior, concurrent database connections, migrations, read consistency, immutability, rollback, storage failures and crash recovery. The assessment checklist remains in `REQUIREMENTS.md`.

## Findings fixed

Each finding below was reproduced before its fix. The final combined coverage run passed after the fixes.

| Priority | Finding and failure scenario | Impact | Smallest fix applied | Regression evidence |
| --- | --- | --- | --- | --- |
| P1 | NUL-containing and unpaired-surrogate strings passed text validation. SQLite bindings truncated NUL text or replaced malformed Unicode. A leading NUL could fail a SQL CHECK. | Persisted/returned text could change; descriptions could conflict on identical retries; some invalid input returned 500. | Reject NUL and ill-formed Unicode in shared text validation before database access. Preserve valid Unicode exactly. | Invalid names/references/descriptions return 400 with no rows; emoji, non-Latin text and descriptions with line breaks round-trip and replay. |
| P1 | Invalid UTF-8 request bytes were decoded using replacement characters. | The API silently changed client input and could create immutable records from malformed bytes. | Use a fatal UTF-8 decoder before parsing JSON. | An invalid byte sequence returns 400 `INVALID_JSON` and creates no account. |
| P2 | Content-Encoding and non-UTF-8 charset declarations were ignored. | A client declaring a compressed/different-charset body could receive a success for bytes interpreted with the wrong contract. | Explicitly allow uncompressed UTF-8 JSON and return 415 for unsupported declarations. | Gzip/Latin-1 declarations rejected; quoted UTF-8 charset accepted. This is optional protocol hardening beyond the PDF's specific examples. |
| P2 | A malformed request target such as `//` caused the URL constructor to throw an unclassified error. | Invalid client requests returned 500 and generated internal-error logs. | Translate URL parsing failures to 400 `INVALID_URL`. | A real HTTP request with the malformed target returns a consistent client-error envelope. |
| P2 | Negative SQLite schema versions passed the startup version check. | The process could accept an unsupported schema version and operate on an unexpected structure. | Accept only supported versions 0 and 1; reject all other values without changing data. | Positive/negative unsupported versions fail; existing content and version remain intact. This is optional startup hardening. |
| P1 | Simultaneous first connections could fail with `database is locked` while switching a new file into WAL mode, despite a busy timeout. | An intermittent startup failure when multiple connections/processes initialize the database together. | Close failed connections and retry only SQLite BUSY/LOCKED initialization errors within a five-second startup budget; retain the normal five-second operation busy timeout. | Fresh-file initialization raced eight connections over five rounds; schema migrated once per file, all accounts persisted, integrity/reconciliation checks passed. The race first failed in a combined coverage run and then passed after the fix. This improves optional multi-process deployment reliability. |
| P1 | JSON numeric amounts were validated after conversion to a floating-point Number. For example, `0.009999999999999999999` became `0.01`, and a value just above the balance limit could round down to the limit. | Invalid precision or an over-limit amount could be accepted for a transaction or transfer. | Use the JSON reviver's original numeric source token and exact decimal scaling before normalizing money. Preserve valid exponent/trailing-zero numeric forms. | Sub-cent, over-limit and enormous-exponent tokens return 400 with no writes; exact exponent forms replay identically to decimal strings. The credit and transfer regressions failed before the fix. This enforces the implementation's documented precision/limit choices. |

## Additional edge cases exercised

| Area | New or expanded coverage |
| --- | --- |
| Money | Smallest cent, zero/negative zero, sub-cent/invalid representations, maximum amount and balance, maximum debit, overflow with no write, equivalent string/number replay identity. |
| Text and body validation | Missing required fields; scalar/array bodies; exact reference/name/description length boundaries; case-sensitive references; valid Unicode and SQL-like text; exact 16 KiB body limit and multibyte byte counting; server recovery after oversize or interrupted uploads. |
| Idempotency | Changed-payload races over one reference; retries after funds are spent; description/default normalization; failed debits/transfers do not reserve references; original transfer legs replay unchanged. |
| Transfers | Source-only reference collision; changed destination/description conflicts; insufficient transfer retry after funding; deferred commit failure after both legs have executed; standalone debits compete with transfers for the same funds. |
| Cross-connection concurrency | Conflicting duplicate payloads have one winner; duplicate transfers move funds once; opposite-direction transfers conserve funds; simultaneous migrations; exact per-account ledger reconciliation. |
| History | Pagination caps, repeated filters, whitespace/non-integer/oversized parameters, filtered counts, deterministic timestamp ties, and a real concurrent write between establishing a reader snapshot and fetching history. |
| Immutability | Direct field updates/deletes and `INSERT OR REPLACE` cannot replace a ledger entry. |
| Operations | Unsupported schema versions, partial migration rollback, occupied TCP port, repeated shutdown signal events, persisted data after a graceful exit. On Windows the shutdown test invokes the registered SIGTERM handler through test-only IPC; it does not claim to verify OS signal routing. |
| Independent model | A deterministic 100-operation sequence of credits, debits, transfers and retries is compared to an independent integer-money model. Stored balances, signed ledger totals and entry counts are checked after every operation. |
| Abrupt process termination | Dedicated temporary child processes are force-killed with open connections: an uncommitted debit and a transfer staged between its legs roll back; committed credits/transfers survive and replay with original IDs and timestamps after reopening. SQLite integrity and foreign-key checks run after each recovery. The between-leg test deliberately stages the same SQL transaction/trigger mechanism; it is not an interruption injected into the HTTP handler. |
| Storage faults | A real SQLITE_FULL error is induced using SQLite's page-count limit, then capacity is restored and the same reference retries successfully. A read-only database safely rejects writes. A non-SQLite file is rejected without overwriting its original bytes. These are controlled local tests, not physical disk-failure simulations. |
| HTTP streaming | UTF-8 split across chunked body chunks is preserved; requests without Content-Length still obey the byte limit; a keep-alive connection remains usable after invalid JSON. |

## Executed result

Final command: `npm run test:coverage`.

- **71 passed; 0 failed; 0 skipped; 0 cancelled.**
- Test-runner duration: **12.847 seconds**.
- All six production JavaScript modules reported **100% line coverage**. Branch and function coverage are not 100%.
- `npm run check` also completed successfully.

| Production module | Lines | Branches | Functions |
| --- | --- | --- | --- |
| app.mjs | 100% | 98.72% | 100% |
| database.mjs | 100% | 100% | 100% |
| errors.mjs | 100% | 93.75% | 100% |
| ledger.mjs | 100% | 100% | 100% |
| server.mjs | 100% | 66.67% | 80% |
| validation.mjs | 100% | 100% | 100% |

Coverage describes executed JavaScript, not proof of every SQL behavior or every possible input/schedule. Earlier regression runs intentionally failed before their respective fixes. An initial sandboxed edge-suite invocation could not reach localhost; successful verification used the approved unsandboxed commands.

## What remains

No additional missing assessment feature was identified. The following are **optional deployment/verification work**, not new assessment requirements:

1. **Before serving unrelated users:** implement authenticated principals and account ownership checks. A shared API key grants service-wide access.
2. **Before storing production data:** configure TLS, secret/filesystem controls, monitored backups and an actual restore drill.
3. **Before selecting a production capacity target:** benchmark sustained load and contention. SQLite's synchronous single-writer behavior is a documented deployment limit.
4. **For durability validation:** real hardware power loss, physical disk exhaustion/I/O faults and repair of damaged SQLite pages remain unverified. Controlled SQLITE_FULL, invalid-file rejection, read-only errors and real child-process-kill recovery are now covered; they do not prove hardware crash durability.
5. **For shutdown/transport validation:** the ten-second forced-drain deadline, slow-client timeout schedules, OS-level signal delivery and every invalid HTTP framing/header case have not been exhaustively tested.
6. **For stable paging during ongoing writes:** add cursor pagination if the product needs a stable traversal across multiple requests. Each existing response is internally consistent, but offset pages can shift between requests.
7. **For runtime policy:** Node 22 marks `node:sqlite` experimental. Pin a validated runtime or replace the adapter if experimental APIs are disallowed.

## Reproduce

```powershell
cd C:\Users\Gautam\Desktop\gautam-job-agent\transaction-ledger-api
npm test
npm run test:coverage
npm run check
```

Focused suites: `node --test tests/edge-cases.test.mjs`, `node --test tests/concurrency.test.mjs`, `node --test tests/database.test.mjs`, `node --test tests/snapshot.test.mjs`, `node --test tests/transfers.test.mjs`, `node --test tests/startup.test.mjs`, `node --test tests/reliability.test.mjs`, `node --test tests/crash-recovery.test.mjs`, and `node --test tests/http-streaming.test.mjs`.
