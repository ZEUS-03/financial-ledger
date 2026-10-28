# API reference

Base URL: `http://127.0.0.1:3000`. All request bodies must be JSON objects with `Content-Type: application/json`, maximum 16 KiB of encoded bytes. UTF-8 is required; a `charset=utf-8` declaration is allowed. Other charsets and compressed content encodings return 415. Invalid UTF-8 returns 400. Unsupported fields are rejected. IDs are lowercase UUID v4. All money responses use strings such as `"125.50"`.

All persisted text must be well-formed Unicode without NUL characters; invalid values return 400. Text length limits count UTF-16 code units. Valid emoji, non-Latin text and description line breaks are preserved. Malformed request targets return 400 `INVALID_URL`.

If `API_KEY` is configured, send `Authorization: Bearer <key>` on every endpoint except `/health`. Without a configured key, the default local service is unauthenticated.

## Create account

`POST /accounts`

```json
{ "name": "Alice" }
```

Returns **201** and a `Location` header pointing to the balance endpoint:

```json
{
  "data": {
    "id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001",
    "name": "Alice",
    "balance": "0.00",
    "created_at": "2026-10-27T12:00:00.000Z"
  }
}
```

`name` is the only permitted field, required and nonblank, maximum 200 characters. Balance, ID and timestamp are server-managed. Invalid input returns 400.

## Create transaction

`POST /accounts/{account_id}/transactions`

```json
{
  "type": "credit",
  "amount": "100.00",
  "description": "Opening deposit",
  "reference_id": "deposit-001"
}
```

`type` must be `credit` or `debit`. `amount` is required, greater than zero, at most two decimal places and no greater than `10000000000.00`. `reference_id` is required, case-sensitive and 1-128 characters with no surrounding whitespace. `description` is optional and at most 1000 characters.

Amounts can be decimal strings or JSON numbers. Numeric inputs are checked against their original JSON text, so values such as `0.009999999999999999999` cannot round into an accepted cent. Exact numeric exponent/trailing-zero forms such as `1e-2` and `1.2300` are accepted; exponent strings such as `"1e-2"` are rejected. Decimal strings are recommended for clients handling money.

Returns **201** for a new transaction:

```json
{
  "data": {
    "id": "dec5972f-3ff2-44eb-a0fa-8f4e09010001",
    "account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001",
    "type": "credit",
    "amount": "100.00",
    "description": "Opening deposit",
    "reference_id": "deposit-001",
    "created_at": "2026-10-27T12:00:01.000Z"
  },
  "meta": { "replayed": false }
}
```

An identical reference and payload returns **200**, the original `data` unchanged and `meta.replayed=true`, indicating the transaction already exists. The balance does not change. Different payload data with the same reference returns **409 REFERENCE_CONFLICT**. Different accounts may reuse a reference. Replay identity uses the numeric amount and the exact type and description after applying the default description.

A debit with insufficient funds returns **409 INSUFFICIENT_BALANCE**; a credit exceeding the supported balance limit returns **409 BALANCE_LIMIT**. Neither creates a ledger entry. A missing account returns 404; invalid body or account ID returns 400.

## Get balance

`GET /accounts/{account_id}/balance`

Returns **200**:

```json
{ "data": { "account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001", "balance": "100.00" } }
```

Missing account: 404. Malformed account ID: 400.

## Get history

`GET /accounts/{account_id}/transactions?type=credit&page=1&limit=20`

| Parameter | Rules |
| --- | --- |
| `type` | Optional: `credit` or `debit`. Omit to include both. |
| `page` | Positive integer, default 1, maximum 1,000,000. |
| `limit` | Positive integer, default 20, maximum 100. |

Returns **200**, with each item having the transaction representation above:

```json
{
  "data": [],
  "meta": { "page": 1, "limit": 20, "total_records": 0, "total_pages": 0 }
}
```

Results are sorted by creation timestamp descending, then internal insertion sequence descending. Metadata counts only transactions matching the account and filter. Transfer entries include `transfer_id`. A page past the last is empty. Invalid, repeated or unknown query parameters return 400; a missing account returns 404.

## Atomic transfer (assessment bonus)

`POST /transfers`

```json
{
  "source_account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001",
  "destination_account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0002",
  "amount": "30.00",
  "description": "Shared expenses",
  "reference_id": "transfer-001"
}
```

Both accounts must exist and differ. The source must have enough funds and the destination must remain within the balance limit. Transfer fields follow the same amount, reference and description rules as transactions. The transfer record and two ledger entries commit together; any failure rolls everything back.

Returns **201**:

```json
{
  "data": {
    "id": "719e286b-d1bd-4e2e-bfd3-03e386020001",
    "source_account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001",
    "destination_account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0002",
    "amount": "30.00",
    "description": "Shared expenses",
    "reference_id": "transfer-001",
    "created_at": "2026-10-27T12:00:02.000Z",
    "transactions": [
      {
        "id": "dec5972f-3ff2-44eb-a0fa-8f4e09010002",
        "account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0001",
        "type": "debit",
        "amount": "30.00",
        "description": "Shared expenses",
        "reference_id": "transfer-001",
        "created_at": "2026-10-27T12:00:02.000Z",
        "transfer_id": "719e286b-d1bd-4e2e-bfd3-03e386020001"
      },
      {
        "id": "dec5972f-3ff2-44eb-a0fa-8f4e09010003",
        "account_id": "a80f470d-f93b-4c5e-830a-9dc47a4e0002",
        "type": "credit",
        "amount": "30.00",
        "description": "Shared expenses",
        "reference_id": "transfer-001",
        "created_at": "2026-10-27T12:00:02.000Z",
        "transfer_id": "719e286b-d1bd-4e2e-bfd3-03e386020001"
      }
    ]
  },
  "meta": { "replayed": false }
}
```

Successful responses contain two full transaction objects, source debit followed by destination credit, each linked to the transfer ID. The same reference is reserved in both accounts.

An identical retry for the source account returns **200** with the original transfer and `replayed=true`. A changed destination, amount or description returns **409**. Reusing a reference already occupied in either ledger account also returns **409**, without a partial transfer. Self-transfer or invalid input: 400. Missing account: 404. Insufficient funds or overflow: 409.

## Health

`GET /health` returns **200** with `{ "data": { "status": "ok" } }` after a database query. No authentication is required. This tests connectivity, not a full ledger audit or a backup's health.

## Errors and retries

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data.",
    "details": { "amount": "Must be between 0.01 and 10000000000.00." },
    "request_id": "013925a9-b9f0-41c3-a050-61b5a88c0001"
  }
}
```

`details` is optional. Application errors include `X-Request-Id` matching the body. Internal errors return a generic message; server logs contain the request ID and error message without request bodies or credentials. Node's transport-level failures (for example an invalid HTTP header or an aborted socket) may terminate a connection before an application JSON response is possible.

| Status | Code / meaning |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_BODY`, `INVALID_URL` |
| 401 | `UNAUTHORIZED` when the optional shared key is configured |
| 404 | `ACCOUNT_NOT_FOUND` or `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED`, with an `Allow` header on known resources |
| 409 | `INSUFFICIENT_BALANCE`, `REFERENCE_CONFLICT`, `BALANCE_LIMIT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 500 | `INTERNAL_ERROR`, no database details in the response |
| 503 | `DATABASE_BUSY`, with `Retry-After: 1` |

After a timeout, network disconnect, 500 or 503, retry a transaction or transfer with **the same reference and payload**, using bounded exponential backoff. A commit may have succeeded even if the response was lost. Do not generate a new reference for a retry. Account creation has no idempotency key and should not be retried blindly after an ambiguous failure. Correct input or fund the account before retrying validation/insufficient-funds failures.

## PowerShell example

Run the server in another terminal, then:

```powershell
$base = 'http://127.0.0.1:3000'
$headers = @{}
# If configured on the server:
# $headers.Authorization = "Bearer $env:API_KEY"
$alice = Invoke-RestMethod "$base/accounts" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ name = 'Alice' } | ConvertTo-Json)
$bob = Invoke-RestMethod "$base/accounts" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ name = 'Bob' } | ConvertTo-Json)
$credit = @{ type = 'credit'; amount = '100.00'; reference_id = 'deposit-001' } | ConvertTo-Json
Invoke-RestMethod "$base/accounts/$($alice.data.id)/transactions" -Method Post -Headers $headers -ContentType 'application/json' -Body $credit
# Same body: replayed=true, same transaction ID, no extra credit.
Invoke-RestMethod "$base/accounts/$($alice.data.id)/transactions" -Method Post -Headers $headers -ContentType 'application/json' -Body $credit
$transfer = @{ source_account_id = $alice.data.id; destination_account_id = $bob.data.id; amount = '30.00'; reference_id = 'transfer-001' } | ConvertTo-Json
Invoke-RestMethod "$base/transfers" -Method Post -Headers $headers -ContentType 'application/json' -Body $transfer
Invoke-RestMethod "$base/accounts/$($alice.data.id)/balance" -Headers $headers
Invoke-RestMethod "$base/accounts/$($alice.data.id)/transactions?type=debit&page=1&limit=10" -Headers $headers
```
