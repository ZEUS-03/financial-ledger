# Assessment checklist and implementation review

Reviewed against the five-page **Full Stack Developer Assessment.pdf** provided on 2026-10-27. The original workspace was a job-search tool, not a ledger implementation. After clarification, the user requested creation from scratch. No pre-existing ledger defects are claimed here. This checklist describes the resulting standalone implementation.

The PDF is the source of required application behavior. Automated testing is additionally requested by the user. Exact routes, decimal precision, HTTP codes, and duplicate replay payloads are documented design choices; money transfers are explicitly a bonus. Production operations recommendations below are optional additions, not invented assessment requirements.

## Required behavior

| Requirement | Status | Implementation / executed evidence |
| --- | --- | --- |
| Unique account ID, required name, system creation timestamp | Implemented | UUID generation, validation, database PK/default; account creation and invalid-name tests |
| Initial balance is always zero; client cannot choose it | Implemented | Only `name` accepted; SQL zero default plus initial-balance trigger; account validation and direct database tests |
| Transaction ID, account, type, amount, description, reference and timestamp | Implemented | `transactions` schema and response projection; normal flow tests |
| Credit increases balance; debit decreases it | Implemented | Insert trigger with signed integer amount; fractional money and exact-balance debit tests |
| Reject insufficient debit without changing balance | Implemented | Trigger raises before update; API 409; failed-debit and concurrent-debit tests |
| Balance update and transaction creation are atomic | Implemented | Trigger plus explicit transaction; injected insert, balance update and commit failures verify neither persists |
| Concurrent requests cannot overspend or lose updates | Implemented (supports consistency requirement) | `BEGIN IMMEDIATE`, no read/modify/write outside lock; HTTP race plus eight separate worker connections for debit/credit races |
| Unique `(account_id, reference_id)` in the database | Implemented | Composite UNIQUE; direct SQL duplicate test and separate-connection race |
| Duplicate reference creates no new entry and does not move balance | Implemented | Exact replay returns 200/original entry; changed data returns 409; duplicate and concurrent replay tests |
| Same reference permitted on different accounts | Implemented | Uniqueness scoped to account; API and direct database tests |
| Balance endpoint includes account ID and balance; missing account error | Implemented | Balance endpoint; malformed-ID and missing-account tests |
| Filter history by credit/debit; omitted type includes both | Implemented | Account-scoped parameterized queries; filter tests |
| Pagination and sufficient metadata | Implemented | Page, limit, total records, total pages; count and rows use same read snapshot; pagination/empty-page tests |
| Latest-first order based on created_at | Implemented | Descending timestamp plus deterministic insertion-sequence tie-breaker; normal and equal-timestamp tests |
| No API edit/delete of transaction or its fields | Implemented | No mutation routes; 405 on collection, 404 on unsupported per-entry routes; database immutability triggers tested for all listed fields |
| Balance equals all valid entries; failed entries have no effect | Implemented | Append-only insert-driven updates; post-race SQL reconciliation assertions and rollback tests |
| Validate names, account existence, type, positive amount, reference and funds | Implemented | Explicit validation plus SQL constraints; invalid input tests |
| Invalid pagination/body and meaningful, consistent HTTP errors | Implemented | Shared JSON error envelope and typed statuses; malformed JSON, media, pagination and rollback-error tests |
| Database and maintainable backend structure | Implemented | SQLite file database, separated HTTP/validation/business/database modules |
| Locally runnable README | Implemented | README commands; check/test commands executed locally; runtime persistence tested |
| API documentation and documented assumptions | Implemented | `docs/API.md` and `docs/ASSUMPTIONS.md` |
| Atomic money transfers | Implemented bonus | Both accounts checked; one transaction for transfer and both legs; missing-account, balance, destination collision/failure, replay and concurrent transfer tests |

## Executed validation

The follow-up audits expanded the suite to **71 tests**. On Node.js **22.21.1**, the latest `npm run test:coverage` completed with **71 passed, 0 failed, 0 skipped**, after fixing the findings in [the edge-case audit](EDGE_CASE_AUDIT.md). The suite includes real HTTP requests, real SQLite constraints, worker threads sharing one local file through separate database connections, database lock contention, startup/shutdown, read snapshots, exact numeric JSON validation, controlled storage faults and forced child-process termination. Successful verification used approved unsandboxed commands because sandboxed HTTP requests could not reach localhost.

`npm run check` completed successfully. All six production JavaScript modules reported 100% line coverage in the executed coverage run; branch/function coverage is lower and detailed in the audit. No throughput benchmark, deployment, power-loss simulation, tenant security review, backup/restore drill or external assessment grading was performed. Coverage is not proof of exhaustive edge-case correctness.

## Failure scenarios addressed

| Priority | Failure scenario and impact | Smallest appropriate protection implemented |
| --- | --- | --- |
| P0 | Balance update succeeds but ledger insert fails, or vice versa: balance cannot reconcile | Apply balance from the insert trigger; wrap complete operation and commit in rollback handling |
| P0 | Two debits both see 100 and each spend 70: overspend or stale balance write | Obtain database write lock before reads; validate funds inside the balance trigger; nonnegative balance CHECK |
| P0 | Two requests both pass an application-only duplicate check: double credit | Composite database UNIQUE plus locked replay check |
| P0 | Transfer source debit succeeds and destination write fails: money disappears | Wrap transfer record and both entry inserts in a single transaction |
| P1 | Client retries after response loss: transaction applies twice | Replay identical reference; reject altered payload; retain original IDs/timestamps |
| P1 | A duplicate debit is checked against today's empty balance: original successful request appears to fail | Resolve existing reference before validating available funds |
| P1 | A transfer reference collides only at destination after source debit: partial transfer | Let database constraint reject destination insert and roll back whole transaction |
| P1 | Float arithmetic accumulates cent errors or balance overflows: inconsistent amounts | Integer minor units, exact decimal parsing, explicit upper bound and SQL checks |
| P1 | Malformed input reaches SQL or inconsistent errors confuse clients | Reject unknown/server-managed fields; common validation/errors and bound parameters |
| P1 | Ledger entries are later changed or deleted: audit trail no longer matches balance | No API mutation routes; database triggers reject update/delete |
| P2 | Filtered history count includes other types/accounts, or ties reorder unpredictably | Use same filter in count and data, one read snapshot, descending timestamp/sequence |

## Remaining work, prioritized (optional beyond assessment)

| Priority | Scenario / impact | Smallest next step |
| --- | --- | --- |
| Before public exposure | Shared key has no account ownership permissions: any holder can operate every account | Keep service private, or add authenticated principals and account authorization before serving unrelated users |
| Before production data | Disk loss or a bad backup destroys the only local authority | Configure encrypted backups using SQLite backup tools; execute and document a restore drill |
| Before deployment | Plain HTTP or stolen shared credential exposes access | Configure TLS proxy and secret management; keep loopback/private binding and filesystem restrictions |
| Based on load | SQLite's one writer and synchronous lock waits stall request handling under sustained contention | Measure expected workload; use a worker-backed supported driver or PostgreSQL when latency/availability demands it |
| Runtime policy | Node 22 labels built-in SQLite experimental, creating runtime-support risk | Pin and validate the runtime; if experimental modules are disallowed, replace the adapter while preserving schema/atomicity tests |
| History UX | New entries shift offset pages between separate requests: duplicate/skipped rows while paging | Add a timestamp/sequence cursor when a stable traversal is required |
| Operations | Failures or contention go unnoticed without monitoring | Add request/latency/error metrics and alerts; connect request IDs to an operational log sink |

No missing mandatory assessment feature was identified in this implementation review. Passing these tests does not establish unrestricted production readiness; the deployment assumptions and remaining operations work still apply.
