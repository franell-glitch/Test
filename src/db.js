'use strict';

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
  `);
  return db;
}

module.exports = { openDatabase };
