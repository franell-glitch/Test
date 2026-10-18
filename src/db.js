'use strict';

const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      personnel_no TEXT UNIQUE,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS face_descriptors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      descriptor TEXT NOT NULL,
      thumbnail  TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_time   TEXT NOT NULL,
      end_time     TEXT,
      start_method TEXT NOT NULL DEFAULT 'face',
      end_method   TEXT,
      note         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_user_start ON time_entries(user_id, start_time);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migration: PIN als Alternative zur Gesichtserkennung
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('pin_hash')) db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pin ON users(pin_hash)');

  // Geheimer Schlüssel pro Installation für das PIN-Hashing
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'pin_secret'").get()) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('pin_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
  }
  return db;
}

module.exports = { openDatabase };
