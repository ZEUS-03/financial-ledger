import { ApiError } from './errors.mjs';

export const MAX_MINOR = 1_000_000_000_000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = (field, message) => { throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request data.', { [field]: message }); };

export function object(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('body', 'Must be a JSON object.');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(key, 'Unknown or server-managed field.');
}

export function text(value, field, max, { optional = false, trim = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') invalid(field, 'Must be a string.');
  // SQLite bindings can truncate NUL text and UTF-8 encoding replaces lone surrogates.
  // Reject lossy input before it becomes an immutable record or an idempotency key.
  if (value.includes('\u0000') || !value.isWellFormed()) invalid(field, 'Must be valid Unicode without NUL characters.');
  const result = trim ? value.trim() : value;
  if ((!optional && !result.trim()) || result.length > max) invalid(field, `Must contain ${optional ? '0' : '1'} to ${max} characters.`);
  if (field === 'reference_id' && result !== result.trim()) invalid(field, 'Must not contain leading or trailing whitespace.');
  return result;
}

export function id(value, field = 'account_id') {
  if (typeof value !== 'string' || !UUID.test(value)) invalid(field, 'Must be a lowercase UUID v4.');
  return value;
}

export function amount(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,11}(?:\.\d{1,2})?$/.test(String(value))) {
    invalid('amount', 'Must be a positive decimal with at most two decimal places.');
  }
  const [whole, fraction = ''] = String(value).split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(MAX_MINOR)) invalid('amount', 'Must be between 0.01 and 10000000000.00.');
  return Number(minor);
}

export function money(minor) {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function moneyReviver(key, value, context) {
  if (key !== 'amount' || typeof value !== 'number') return value;
  // JSON.parse already rounds Number values. Use the original numeric token so
  // a sub-cent value or an amount just above the limit cannot round into validity.
  const [, sign, whole, fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(context.source);
  let digits = (whole + fraction).replace(/^0+/, '');
  const shift = Number(exponent) - fraction.length + 2;
  if (sign || !digits || !Number.isSafeInteger(shift)) invalid('amount', 'Must be a positive exact decimal amount within the supported range.');
  if (shift < 0) {
    if (-shift >= digits.length || /[1-9]/.test(digits.slice(shift))) invalid('amount', 'Must be an exact multiple of 0.01.');
    digits = digits.slice(0, shift);
  } else {
    if (digits.length + shift > 13) invalid('amount', 'Must be between 0.01 and 10000000000.00.');
    digits += '0'.repeat(shift);
  }
  if (digits.length > 13 || Number(digits) > MAX_MINOR) invalid('amount', 'Must be between 0.01 and 10000000000.00.');
  return money(Number(digits));
}

export function transactionInput(body) {
  object(body, ['type', 'amount', 'description', 'reference_id']);
  if (!['credit', 'debit'].includes(body.type)) invalid('type', 'Must be credit or debit.');
  return {
    type: body.type,
    amount_minor: amount(body.amount),
    description: text(body.description, 'description', 1000, { optional: true }),
    reference_id: text(body.reference_id, 'reference_id', 128),
  };
}

export function transferInput(body) {
  object(body, ['source_account_id', 'destination_account_id', 'amount', 'description', 'reference_id']);
  const source = id(body.source_account_id, 'source_account_id');
  const destination = id(body.destination_account_id, 'destination_account_id');
  if (source === destination) invalid('destination_account_id', 'Must differ from source_account_id.');
  return {
    source_account_id: source, destination_account_id: destination,
    amount_minor: amount(body.amount),
    description: text(body.description, 'description', 1000, { optional: true }),
    reference_id: text(body.reference_id, 'reference_id', 128),
  };
}

export function pagination(params) {
  for (const key of params.keys()) {
    if (!['type', 'page', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid(key, 'Unknown or repeated query parameter.');
  }
  const type = params.get('type');
  if (type !== null && !['credit', 'debit'].includes(type)) invalid('type', 'Must be credit or debit.');
  function integer(name, fallback, maximum) {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) invalid(name, `Must be an integer between 1 and ${maximum}.`);
    return Number(raw);
  }
  return { type, page: integer('page', 1, 1_000_000), limit: integer('limit', 20, 100) };
}
