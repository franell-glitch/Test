'use strict';

// Externe Datensicherung nach OneDrive über rclone.
// Die Zugangsdaten (OAuth-Token aus "rclone authorize onedrive") liegen in einer
// rclone-Konfigurationsdatei neben der Datenbank; die App lädt einmal täglich eine
// Kopie der Datenbank hoch und löscht dort Sicherungen, die älter als 90 Tage sind.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const REMOTE = 'onedrive';
const FOLDER = 'Zeiterfassung-Backups';
const KEEP_DAYS = 90;
const UPLOAD_HOUR = 2; // frühestens ab 2 Uhr nachts (Serverzeit)

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout);
    });
  });
}

/** Holt das JSON-Token aus dem eingefügten Text (darf die ---> / <--- Zeilen enthalten). */
function parseToken(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const token = JSON.parse(match[0]);
    return token.access_token && token.refresh_token ? token : null;
  } catch {
    return null;
  }
}

function createOffsite({ db, configPath, rcloneBin = 'rclone', graphBase = 'https://graph.microsoft.com/v1.0' }) {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const saveSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  let running = null;

  const isConfigured = () => fs.existsSync(configPath);

  function status() {
    const last = setting.get('offsite_last');
    return { configured: isConfigured(), folder: FOLDER, keepDays: KEEP_DAYS, last: last ? JSON.parse(last.value) : null };
  }

  async function configure(pastedText) {
    const token = parseToken(pastedText);
    if (!token) {
      throw Object.assign(new Error('Kein gültiger Zugangsschlüssel. Bitte den kompletten Text zwischen ---> und <--- einfügen.'), { status: 400 });
    }
    // OneDrive des angemeldeten Kontos ermitteln
    const res = await fetch(`${graphBase}/me/drive`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!res.ok) {
      throw Object.assign(new Error(`OneDrive nicht erreichbar (Microsoft meldet ${res.status}). Ist der Schlüssel noch gültig?`), { status: 400 });
    }
    const drive = await res.json();
    const conf = [
      `[${REMOTE}]`,
      'type = onedrive',
      `token = ${JSON.stringify(token)}`,
      `drive_id = ${drive.id}`,
      `drive_type = ${drive.driveType}`,
      '',
    ].join('\n');
    fs.writeFileSync(configPath, conf, { mode: 0o600 });
    return { owner: drive.owner?.user?.displayName || null };
  }

  function remove() {
    fs.rmSync(configPath, { force: true });
  }

  async function upload() {
    if (!isConfigured()) throw Object.assign(new Error('OneDrive-Sicherung ist nicht eingerichtet'), { status: 400 });
    if (running) return running;
    running = (async () => {
      const day = new Date().toISOString().slice(0, 10);
      const tmpFile = path.join(os.tmpdir(), `zeiterfassung-offsite-${crypto.randomBytes(8).toString('hex')}.db`);
      try {
        db.exec(`VACUUM INTO '${tmpFile}'`);
        const conf = ['--config', configPath];
        await run(rcloneBin, ['copyto', tmpFile, `${REMOTE}:${FOLDER}/zeiterfassung-${day}.db`, ...conf]);
        await run(rcloneBin, ['delete', `${REMOTE}:${FOLDER}`, '--min-age', `${KEEP_DAYS}d`, ...conf]);
        const result = { ok: true, time: new Date().toISOString(), day };
        saveSetting.run('offsite_last', JSON.stringify(result));
        return result;
      } catch (e) {
        const result = { ok: false, time: new Date().toISOString(), error: e.message };
        saveSetting.run('offsite_last', JSON.stringify(result));
        throw Object.assign(new Error(`Hochladen fehlgeschlagen: ${e.message}`), { status: 502 });
      } finally {
        fs.rm(tmpFile, { force: true }, () => {});
        running = null;
      }
    })();
    return running;
  }

  // Einmal pro Tag sichern; bei Fehlern wird es zur nächsten vollen Stunde erneut versucht
  function startSchedule() {
    const tick = () => {
      const last = status().last;
      const today = new Date().toISOString().slice(0, 10);
      const doneToday = last?.ok && last.day === today;
      if (isConfigured() && !doneToday && new Date().getUTCHours() >= UPLOAD_HOUR) {
        upload().catch((e) => console.error(e.message));
      }
    };
    return setInterval(tick, 60 * 60 * 1000).unref();
  }

  return { status, configure, remove, upload, startSchedule };
}

module.exports = { createOffsite, parseToken };
