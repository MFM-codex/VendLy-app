import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Amounts are whole naira. Balance is never stored: it is the SUM of the ledger.
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      pass_hash TEXT NOT NULL, pin_hash TEXT NOT NULL,
      pin_fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      pw_changed_at INTEGER NOT NULL DEFAULT 0, terms_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ledger(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL, ref TEXT UNIQUE NOT NULL, note TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tx(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      req_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
      amount INTEGER NOT NULL, status TEXT NOT NULL, ref TEXT UNIQUE NOT NULL,
      token TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id, req_id));
  `);
  for (const col of ['pw_changed_at', 'terms_at']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch {} } // upgrades older databases
  return db;
}
