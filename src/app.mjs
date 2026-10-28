import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, databaseError } from './errors.mjs';
import { id, moneyReviver, object, pagination, text, transactionInput, transferInput } from './validation.mjs';

const MAX_BODY = 16 * 1024;
const digest = value => createHash('sha256').update(value).digest();

function readBody(req) {
  const [mediaType, ...parameters] = (req.headers['content-type'] ?? '').split(';');
  const contentType = mediaType.trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  const charsets = parameters.filter(value => /^\s*charset\s*=/i.test(value));
  if (charsets.length > 1 || charsets.some(value => !/^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(value)) ||
      (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'].trim().toLowerCase() !== 'identity')) {
    req.resume();
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only uncompressed UTF-8 JSON is supported.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        chunks.length = 0;
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body must not exceed 16 KiB.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)), moneyReviver)); }
      catch (error) { reject(error instanceof ApiError ? error : new ApiError(400, 'INVALID_JSON', 'Request body must contain valid UTF-8 JSON.')); }
    });
    req.on('error', () => reject(new ApiError(400, 'INVALID_BODY', 'Unable to read request body.')));
    req.on('aborted', () => reject(new ApiError(400, 'INVALID_BODY', 'Request body was interrupted.')));
  });
}

function method(req, allowed, res) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    req.resume();
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method is not supported for this resource.');
  }
}

export function createApp({ ledger, apiKey, logger = console }) {
  const expectedKey = apiKey ? digest(`Bearer ${apiKey}`) : null;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch {
        req.resume();
        throw new ApiError(400, 'INVALID_URL', 'Request target is not a valid URL.');
      }
      if (url.pathname === '/health') {
        method(req, ['GET'], res);
        ledger.db.prepare('SELECT 1').get();
        send(200, { data: { status: 'ok' } });
        return;
      }
      if (expectedKey && !timingSafeEqual(expectedKey, digest(String(req.headers.authorization ?? '')))) {
        // Compare a hash of the entire expected Authorization value, with constant length.
        req.resume();
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'UNAUTHORIZED', 'A valid Bearer API key is required.');
      }
      if (url.pathname === '/accounts') {
        method(req, ['POST'], res);
        const body = await readBody(req);
        object(body, ['name']);
        const account = ledger.createAccount(text(body.name, 'name', 200, { trim: true }));
        res.setHeader('Location', `/accounts/${account.id}/balance`);
        send(201, { data: account });
        return;
      }
      const balanceMatch = /^\/accounts\/([^/]+)\/balance$/.exec(url.pathname);
      if (balanceMatch) {
        method(req, ['GET'], res);
        send(200, { data: ledger.getBalance(id(balanceMatch[1])) });
        return;
      }
      const historyMatch = /^\/accounts\/([^/]+)\/transactions$/.exec(url.pathname);
      if (historyMatch) {
        method(req, ['GET', 'POST'], res);
        const accountId = id(historyMatch[1]);
        if (req.method === 'GET') send(200, ledger.history(accountId, pagination(url.searchParams)));
        else {
          const result = ledger.createTransaction(accountId, transactionInput(await readBody(req)));
          send(result.replayed ? 200 : 201, { data: result.data, meta: { replayed: result.replayed } });
        }
        return;
      }
      if (url.pathname === '/transfers') {
        method(req, ['POST'], res);
        const result = ledger.createTransfer(transferInput(await readBody(req)));
        send(result.replayed ? 200 : 201, { data: result.data, meta: { replayed: result.replayed } });
        return;
      }
      req.resume();
      throw new ApiError(404, 'NOT_FOUND', 'Route does not exist.');
    } catch (original) {
      const error = databaseError(original);
      if (!(error instanceof ApiError)) logger.error({ request_id: requestId, error: error.message });
      if (res.destroyed) return;
      if (error.status === 503) res.setHeader('Retry-After', '1');
      send(error instanceof ApiError ? error.status : 500, { error: {
        code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof ApiError ? error.message : 'An unexpected server error occurred.',
        ...(error instanceof ApiError && error.details ? { details: error.details } : {}),
        request_id: requestId,
      } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  return server;
}

