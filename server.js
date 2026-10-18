'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { openDatabase } = require('./src/db');
const { findBestMatch, isValidDescriptor } = require('./src/matching');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5);
// Mindestabstand zwischen zwei Stempelungen derselben Person (verhindert Doppelbuchungen)
const STAMP_COOLDOWN_SECONDS = Number(process.env.STAMP_COOLDOWN_SECONDS || 60);
// Offene Buchungen, die älter sind, gelten als "Ausstempeln vergessen"
const MAX_OPEN_HOURS = Number(process.env.MAX_OPEN_HOURS || 16);
const SESSION_HOURS = 12;

function createApp({ dbPath, adminPassword = ADMIN_PASSWORD } = {}) {
  const db = openDatabase(dbPath);
  const app = express();
  const sessions = new Map(); // token -> Ablaufzeitpunkt
  const stampTokens = new Map(); // token -> { userId, expires }

  app.use(express.json({ limit: '1mb' }));

  // ---------- Statische Dateien ----------
  const faceApiDir = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
  app.use('/vendor', express.static(path.join(faceApiDir, 'dist')));
  app.use('/models', express.static(path.join(faceApiDir, 'model')));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  // ---------- Hilfsfunktionen ----------
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function requireAdmin(req, res, next) {
    const token = parseCookies(req).admin_session;
    const expires = token && sessions.get(token);
    if (!expires || expires < Date.now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({ error: 'Nicht angemeldet' });
    }
    next();
  }

  function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  function isIsoDate(v) {
    return typeof v === 'string' && !Number.isNaN(Date.parse(v));
  }

  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    openEntry: db.prepare(
      'SELECT * FROM time_entries WHERE user_id = ? AND end_time IS NULL AND start_time >= ? ORDER BY start_time DESC LIMIT 1'
    ),
    lastEntry: db.prepare(
      'SELECT * FROM time_entries WHERE user_id = ? ORDER BY COALESCE(end_time, start_time) DESC LIMIT 1'
    ),
    activeDescriptors: db.prepare(
      'SELECT f.user_id, f.descriptor FROM face_descriptors f JOIN users u ON u.id = f.user_id WHERE u.active = 1'
    ),
  };

  function openEntryFor(userId, now = new Date()) {
    const since = new Date(now.getTime() - MAX_OPEN_HOURS * 3600 * 1000).toISOString();
    return q.openEntry.get(userId, since);
  }

  function userStatus(userId) {
    const open = openEntryFor(userId);
    return open ? { clockedIn: true, since: open.start_time } : { clockedIn: false };
  }

  // ---------- Admin: Anmeldung ----------
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    if (!password || !safeEqual(password, adminPassword)) {
      return res.status(401).json({ error: 'Falsches Passwort' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
    res.setHeader(
      'Set-Cookie',
      `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`
    );
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    const token = parseCookies(req).admin_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

  // ---------- Admin: Mitarbeiter ----------
  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM face_descriptors f WHERE f.user_id = u.id) AS face_count
         FROM users u ORDER BY u.name COLLATE NOCASE`
      )
      .all()
      .map((u) => ({ ...u, active: !!u.active, ...userStatus(u.id) }));
    res.json(users);
  });

  app.post('/api/admin/users', requireAdmin, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const personnelNo = String(req.body?.personnel_no || '').trim() || null;
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
    try {
      const r = db
        .prepare('INSERT INTO users (name, personnel_no, active, created_at) VALUES (?, ?, 1, ?)')
        .run(name, personnelNo, new Date().toISOString());
      res.status(201).json(q.userById.get(r.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Personalnummer ist bereits vergeben' });
      }
      throw e;
    }
  });

  app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
    const user = q.userById.get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : user.name;
    const personnelNo =
      req.body?.personnel_no !== undefined ? String(req.body.personnel_no).trim() || null : user.personnel_no;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : user.active;
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
    try {
      db.prepare('UPDATE users SET name = ?, personnel_no = ?, active = ? WHERE id = ?').run(
        name,
        personnelNo,
        active,
        user.id
      );
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Personalnummer ist bereits vergeben' });
      }
      throw e;
    }
    res.json(q.userById.get(user.id));
  });

  app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
    res.json({ ok: true });
  });

  // ---------- Admin: Gesichter ----------
  app.get('/api/admin/users/:id/faces', requireAdmin, (req, res) => {
    const faces = db
      .prepare('SELECT id, created_at, thumbnail FROM face_descriptors WHERE user_id = ? ORDER BY id')
      .all(req.params.id);
    res.json(faces);
  });

  app.post('/api/admin/users/:id/faces', requireAdmin, (req, res) => {
    const user = q.userById.get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
    const { descriptor, thumbnail } = req.body || {};
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({ error: 'Ungültiger Gesichts-Deskriptor' });
    }
    const thumb =
      typeof thumbnail === 'string' && thumbnail.startsWith('data:image/') && thumbnail.length < 200000
        ? thumbnail
        : null;
    const r = db
      .prepare('INSERT INTO face_descriptors (user_id, descriptor, thumbnail, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, JSON.stringify(descriptor), thumb, new Date().toISOString());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.delete('/api/admin/faces/:faceId', requireAdmin, (req, res) => {
    const r = db.prepare('DELETE FROM face_descriptors WHERE id = ?').run(req.params.faceId);
    if (!r.changes) return res.status(404).json({ error: 'Gesicht nicht gefunden' });
    res.json({ ok: true });
  });

  // ---------- Admin: Zeitbuchungen / Auswertung ----------
  app.get('/api/admin/entries', requireAdmin, (req, res) => {
    const { userId, from, to } = req.query;
    const where = [];
    const params = [];
    if (userId) {
      where.push('e.user_id = ?');
      params.push(userId);
    }
    if (from && isIsoDate(from)) {
      where.push('e.start_time >= ?');
      params.push(new Date(from).toISOString());
    }
    if (to && isIsoDate(to)) {
      where.push('e.start_time < ?');
      params.push(new Date(to).toISOString());
    }
    const sql = `SELECT e.*, u.name AS user_name, u.personnel_no
                 FROM time_entries e JOIN users u ON u.id = e.user_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY u.name COLLATE NOCASE, e.start_time`;
    const cutoff = Date.now() - MAX_OPEN_HOURS * 3600 * 1000;
    const entries = db
      .prepare(sql)
      .all(...params)
      .map((e) => ({
        ...e,
        missing_end: !e.end_time && Date.parse(e.start_time) < cutoff,
      }));
    res.json(entries);
  });

  function validateEntryBody(body) {
    const { start_time, end_time } = body || {};
    if (!isIsoDate(start_time)) return 'Startzeit ist ungültig';
    if (end_time != null && end_time !== '') {
      if (!isIsoDate(end_time)) return 'Endzeit ist ungültig';
      if (Date.parse(end_time) <= Date.parse(start_time)) return 'Endzeit muss nach der Startzeit liegen';
    }
    return null;
  }

  app.post('/api/admin/entries', requireAdmin, (req, res) => {
    const user = q.userById.get(req.body?.user_id);
    if (!user) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
    const err = validateEntryBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const end = req.body.end_time ? new Date(req.body.end_time).toISOString() : null;
    const r = db
      .prepare(
        "INSERT INTO time_entries (user_id, start_time, end_time, start_method, end_method, note) VALUES (?, ?, ?, 'manual', ?, ?)"
      )
      .run(user.id, new Date(req.body.start_time).toISOString(), end, end ? 'manual' : null, req.body.note || null);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  app.put('/api/admin/entries/:id', requireAdmin, (req, res) => {
    const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Buchung nicht gefunden' });
    const err = validateEntryBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const start = new Date(req.body.start_time).toISOString();
    const end = req.body.end_time ? new Date(req.body.end_time).toISOString() : null;
    // Geänderte Zeiten werden als "manuell" markiert, damit Korrekturen nachvollziehbar bleiben
    const startMethod = start === entry.start_time ? entry.start_method : 'manual';
    const endMethod = !end ? null : end === entry.end_time ? entry.end_method : 'manual';
    db.prepare(
      'UPDATE time_entries SET start_time = ?, end_time = ?, start_method = ?, end_method = ?, note = ? WHERE id = ?'
    ).run(start, end, startMethod, endMethod, req.body.note ?? entry.note, entry.id);
    res.json({ ok: true });
  });

  app.delete('/api/admin/entries/:id', requireAdmin, (req, res) => {
    const r = db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Buchung nicht gefunden' });
    res.json({ ok: true });
  });

  // ---------- Terminal (Mitarbeiter-Bereich) ----------
  app.post('/api/kiosk/identify', (req, res) => {
    const { descriptor } = req.body || {};
    if (!isValidDescriptor(descriptor)) {
      return res.status(400).json({ error: 'Ungültiger Gesichts-Deskriptor' });
    }
    const candidates = q.activeDescriptors.all().map((r) => ({ userId: r.user_id, descriptor: JSON.parse(r.descriptor) }));
    const match = findBestMatch(descriptor, candidates, FACE_THRESHOLD);
    if (!match) return res.json({ recognized: false });

    const user = q.userById.get(match.userId);
    const status = userStatus(user.id);
    const token = crypto.randomBytes(24).toString('hex');
    stampTokens.set(token, { userId: user.id, expires: Date.now() + 30 * 1000 });
    for (const [t, v] of stampTokens) if (v.expires < Date.now()) stampTokens.delete(t);

    res.json({
      recognized: true,
      user: { id: user.id, name: user.name },
      distance: Number(match.distance.toFixed(3)),
      ...status,
      suggestedAction: status.clockedIn ? 'out' : 'in',
      token,
    });
  });

  app.post('/api/kiosk/stamp', (req, res) => {
    const { token, action } = req.body || {};
    const t = token && stampTokens.get(token);
    if (!t || t.expires < Date.now()) {
      return res.status(401).json({ error: 'Erkennung abgelaufen – bitte erneut in die Kamera schauen' });
    }
    if (action !== 'in' && action !== 'out') return res.status(400).json({ error: 'Ungültige Aktion' });
    stampTokens.delete(token);

    const user = q.userById.get(t.userId);
    if (!user || !user.active) return res.status(404).json({ error: 'Mitarbeiter nicht aktiv' });

    const now = new Date();
    const last = q.lastEntry.get(user.id);
    if (last) {
      const lastTs = Date.parse(last.end_time || last.start_time);
      if (now.getTime() - lastTs < STAMP_COOLDOWN_SECONDS * 1000) {
        return res.status(429).json({ error: 'Sie haben gerade erst gestempelt. Bitte kurz warten.' });
      }
    }

    const open = openEntryFor(user.id, now);
    if (action === 'in') {
      if (open) return res.status(409).json({ error: 'Sie sind bereits eingestempelt' });
      db.prepare("INSERT INTO time_entries (user_id, start_time, start_method) VALUES (?, ?, 'face')").run(
        user.id,
        now.toISOString()
      );
    } else {
      if (!open) return res.status(409).json({ error: 'Sie sind nicht eingestempelt' });
      db.prepare("UPDATE time_entries SET end_time = ?, end_method = 'face' WHERE id = ?").run(
        now.toISOString(),
        open.id
      );
    }
    res.json({ ok: true, action, time: now.toISOString(), user: { id: user.id, name: user.name } });
  });

  // ---------- Fehlerbehandlung ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({ dbPath: process.env.DB_PATH || path.join(dataDir, 'zeiterfassung.db') });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Zeiterfassung läuft auf http://localhost:${port}`);
    console.log(`  Terminal:   http://localhost:${port}/kiosk`);
    console.log(`  Verwaltung: http://localhost:${port}/admin`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('WARNUNG: Kein ADMIN_PASSWORD gesetzt – Standardpasswort "admin" wird verwendet.');
    }
  });
}

module.exports = { createApp };
