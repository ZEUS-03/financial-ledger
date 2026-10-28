import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function connect(path, busyTimeout) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA recursive_triggers = ON;`);
    // Migration check is inside a write lock so two starting processes cannot both migrate.
    db.exec('BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw new Error(`Unsupported schema version: ${version}`);
    if (version === 0) {
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
}

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const deadline = performance.now() + 5000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return connect(path, Math.max(1, Math.ceil(deadline - performance.now()))); }
    catch (error) {
      const code = Number.isInteger(error.errcode) ? error.errcode & 0xff : undefined;
      const remaining = deadline - performance.now();
      if (![5, 6].includes(code) || remaining <= 0) throw error;
      // Concurrent WAL initialization can return BUSY without invoking SQLite's
      // busy handler. Retry only startup lock errors after closing the failed connection.
      Atomics.wait(wait, 0, 0, Math.min(25, remaining));
    }
  }
}
