export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function databaseError(error) {
  if (error instanceof ApiError) return error;
  const sqliteCode = Number.isInteger(error.errcode) ? error.errcode & 0xff : undefined;
  if (sqliteCode === 5 || sqliteCode === 6) {
    return new ApiError(503, 'DATABASE_BUSY', 'Database is busy. Retry with the same reference_id.');
  }
  if (error.message?.includes('INSUFFICIENT_BALANCE')) {
    return new ApiError(409, 'INSUFFICIENT_BALANCE', 'Account has insufficient balance.');
  }
  if (error.message?.includes('BALANCE_LIMIT')) {
    return new ApiError(409, 'BALANCE_LIMIT', 'Account balance would exceed the supported limit.');
  }
  if (error.message?.includes('UNIQUE constraint failed: transactions.account_id, transactions.reference_id')) {
    return new ApiError(409, 'REFERENCE_CONFLICT', 'Reference already belongs to another transaction.');
  }
  return error;
}
