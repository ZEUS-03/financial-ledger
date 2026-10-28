import { openDatabase } from './database.mjs';
import { Ledger } from './ledger.mjs';
import { createApp } from './app.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const portText = process.env.PORT ?? '3000';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('PORT must be between 1 and 65535.');
const apiKey = process.env.API_KEY;
if (apiKey !== undefined && apiKey.length < 24) throw new Error('API_KEY must contain at least 24 characters.');
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !apiKey) throw new Error('Set API_KEY before binding to a non-loopback host.');

const db = openDatabase(process.env.DATABASE_PATH ?? './data/ledger.sqlite');
const server = createApp({ ledger: new Ledger(db), apiKey });
server.on('error', error => { console.error(JSON.stringify({ event: 'server_error', message: error.message })); db.close(); process.exitCode = 1; });
server.listen(Number(portText), host, () => {
  console.log(JSON.stringify({ event: 'listening', host, port: Number(portText), authenticated: Boolean(apiKey) }));
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); db.close(); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
