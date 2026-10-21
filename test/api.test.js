'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');

const vec = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(i * seed) * 0.1);

async function setup() {
  const app = createApp({ dbPath: ':memory:', adminPassword: 'geheim' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return { app, server, call };
}

test('Admin-Bereich erfordert Anmeldung', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  assert.strictEqual((await call('GET', '/api/admin/users')).status, 401);
  assert.strictEqual((await call('POST', '/api/admin/login', { password: 'falsch' })).status, 401);
  assert.strictEqual((await call('POST', '/api/admin/login', { password: 'geheim' })).status, 200);
  assert.strictEqual((await call('GET', '/api/admin/users')).status, 200);
});

test('Gesicht erkennen, kommen und gehen, Auswertung', async (t) => {
  const { app, server, call } = await setup();
  t.after(() => server.close());
  await call('POST', '/api/admin/login', { password: 'geheim' });

  const anna = (await call('POST', '/api/admin/users', { name: 'Anna Muster', personnel_no: '001' })).body;
  const ben = (await call('POST', '/api/admin/users', { name: 'Ben Beispiel' })).body;
  assert.strictEqual((await call('POST', `/api/admin/users/${anna.id}/faces`, { descriptor: vec(1) })).status, 201);
  assert.strictEqual((await call('POST', `/api/admin/users/${ben.id}/faces`, { descriptor: vec(7) })).status, 201);
  assert.strictEqual((await call('POST', `/api/admin/users/${ben.id}/faces`, { descriptor: [1, 2] })).status, 400);

  // Unbekanntes Gesicht
  const unknown = await call('POST', '/api/kiosk/identify', { descriptor: vec(3).map((v) => v + 0.2) });
  assert.strictEqual(unknown.body.recognized, false);

  // Anna erkennen (leicht verrauscht) und einstempeln
  let id = await call('POST', '/api/kiosk/identify', { descriptor: vec(1).map((v) => v + 0.005) });
  assert.strictEqual(id.body.recognized, true);
  assert.strictEqual(id.body.user.name, 'Anna Muster');
  assert.strictEqual(id.body.suggestedAction, 'in');
  let r = await call('POST', '/api/kiosk/stamp', { token: id.body.token, action: 'in' });
  assert.strictEqual(r.status, 200);

  // Token ist nur einmal gültig
  r = await call('POST', '/api/kiosk/stamp', { token: id.body.token, action: 'out' });
  assert.strictEqual(r.status, 401);

  // Sperrzeit gegen Doppelbuchung
  id = await call('POST', '/api/kiosk/identify', { descriptor: vec(1) });
  assert.strictEqual(id.body.suggestedAction, 'out');
  r = await call('POST', '/api/kiosk/stamp', { token: id.body.token, action: 'out' });
  assert.strictEqual(r.status, 429);

  // Startzeit zurückdatieren, dann ausstempeln
  app.locals.db.prepare('UPDATE time_entries SET start_time = ?').run(new Date(Date.now() - 4 * 3600e3).toISOString());
  id = await call('POST', '/api/kiosk/identify', { descriptor: vec(1) });
  r = await call('POST', '/api/kiosk/stamp', { token: id.body.token, action: 'out' });
  assert.strictEqual(r.status, 200);

  const entries = (await call('GET', `/api/admin/entries?userId=${anna.id}`)).body;
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].end_time);
  assert.strictEqual(entries[0].start_method, 'face');

  // Manuelle Korrektur
  r = await call('PUT', `/api/admin/entries/${entries[0].id}`, {
    start_time: entries[0].start_time,
    end_time: '2000-01-01T00:00:00Z',
  });
  assert.strictEqual(r.status, 400);
  const newEnd = new Date(Date.parse(entries[0].start_time) + 3600e3).toISOString();
  r = await call('PUT', `/api/admin/entries/${entries[0].id}`, { start_time: entries[0].start_time, end_time: newEnd });
  assert.strictEqual(r.status, 200);
  const updated = (await call('GET', `/api/admin/entries?userId=${anna.id}`)).body[0];
  assert.strictEqual(updated.end_time, newEnd);
  assert.strictEqual(updated.start_method, 'face');
  assert.strictEqual(updated.end_method, 'manual');

  // Deaktivierte Mitarbeiter werden nicht erkannt
  await call('PUT', `/api/admin/users/${ben.id}`, { active: false });
  id = await call('POST', '/api/kiosk/identify', { descriptor: vec(7) });
  assert.strictEqual(id.body.recognized, false);
});

test('Vergessenes Ausstempeln wird markiert', async (t) => {
  const { app, server, call } = await setup();
  t.after(() => server.close());
  await call('POST', '/api/admin/login', { password: 'geheim' });
  const u = (await call('POST', '/api/admin/users', { name: 'Carla' })).body;
  await call('POST', '/api/admin/entries', { user_id: u.id, start_time: new Date(Date.now() - 30 * 3600e3).toISOString() });
  await call('POST', `/api/admin/users/${u.id}/faces`, { descriptor: vec(2) });
  const [e] = (await call('GET', '/api/admin/entries')).body;
  assert.strictEqual(e.missing_end, true);
  // Neue Anmeldung ist trotzdem möglich
  const id = await call('POST', '/api/kiosk/identify', { descriptor: vec(2) });
  assert.strictEqual(id.body.suggestedAction, 'in');
  assert.strictEqual(app.locals.db.prepare('SELECT COUNT(*) AS c FROM time_entries').get().c, 1);
});

test('Stempeln per PIN', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  await call('POST', '/api/admin/login', { password: 'geheim' });

  assert.strictEqual((await call('POST', '/api/admin/users', { name: 'Dora', pin: '12' })).status, 400);
  const dora = (await call('POST', '/api/admin/users', { name: 'Dora', pin: '4711' })).body;
  assert.strictEqual(dora.has_pin, true);
  assert.strictEqual(dora.pin_hash, undefined);
  const emil = (await call('POST', '/api/admin/users', { name: 'Emil' })).body;

  // PINs sind eindeutig
  assert.strictEqual((await call('PUT', `/api/admin/users/${emil.id}/pin`, { pin: '4711' })).status, 409);
  assert.strictEqual((await call('PUT', `/api/admin/users/${emil.id}/pin`, { pin: '123456' })).status, 200);

  const users = (await call('GET', '/api/admin/users')).body;
  assert.ok(users.every((u) => u.pin_hash === undefined && u.has_pin === true));

  const id = await call('POST', '/api/kiosk/identify-pin', { pin: '4711' });
  assert.strictEqual(id.body.user.name, 'Dora');
  assert.strictEqual((await call('POST', '/api/kiosk/stamp', { token: id.body.token, action: 'in' })).status, 200);
  const [entry] = (await call('GET', `/api/admin/entries?userId=${dora.id}`)).body;
  assert.strictEqual(entry.start_method, 'pin');

  // PIN entfernen
  await call('PUT', `/api/admin/users/${emil.id}/pin`, { pin: '' });
  assert.strictEqual((await call('POST', '/api/kiosk/identify-pin', { pin: '123456' })).status, 401);
});

test('PIN-Sperre nach zu vielen Fehlversuchen', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  await call('POST', '/api/admin/login', { password: 'geheim' });
  await call('POST', '/api/admin/users', { name: 'Fritz', pin: '9999' });
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await call('POST', '/api/kiosk/identify-pin', { pin: '000' + i })).status, 401);
  }
  // Auch die richtige PIN wird während der Sperre abgelehnt
  assert.strictEqual((await call('POST', '/api/kiosk/identify-pin', { pin: '9999' })).status, 429);
});

test('Datensicherung herunterladen', async (t) => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { server, call } = await setup();
  t.after(() => server.close());
  assert.strictEqual((await call('GET', '/api/admin/users')).status, 401);
  await call('POST', '/api/admin/login', { password: 'geheim' });
  await call('POST', '/api/admin/users', { name: 'Gerda', pin: '2580' });

  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'geheim' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await fetch(base + '/api/admin/backup')).status, 401);
  const res = await fetch(base + '/api/admin/backup', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /zeiterfassung-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.db/);

  const file = path.join(os.tmpdir(), `test-backup-${process.pid}.db`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  t.after(() => fs.unlinkSync(file));
  const copy = new DatabaseSync(file);
  assert.deepStrictEqual(copy.prepare('SELECT name FROM users').all().map((u) => u.name), ['Gerda']);
  copy.close();
});

test('Externe Sicherung nach OneDrive', async (t) => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');

  // Nachbildung von Microsoft Graph: /me/drive
  const graph = http.createServer((req, res) => {
    const ok = req.url === '/me/drive' && req.headers.authorization === 'Bearer gueltig';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { id: 'b!abc123', driveType: 'business', owner: { user: { displayName: 'Chefin' } } } : {}));
  });
  graph.listen(0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offsite-'));
  process.env.FAKE_REMOTE_DIR = tmp;
  t.after(() => {
    graph.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.FAKE_RCLONE_FAIL;
  });

  const { createApp } = require('../server');
  const app = createApp({
    dbPath: ':memory:',
    adminPassword: 'geheim',
    offsiteConfigPath: path.join(tmp, 'rclone.conf'),
    rcloneBin: path.join(__dirname, 'fixtures', 'fake-rclone.js'),
    graphBase: `http://127.0.0.1:${graph.address().port}`,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'geheim' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  assert.strictEqual((await call('GET', '/api/admin/offsite')).body.configured, false);
  assert.strictEqual((await call('POST', '/api/admin/offsite/run')).status, 400);
  assert.strictEqual((await call('POST', '/api/admin/offsite', { token: 'Unsinn' })).status, 400);
  const expired = '{"access_token":"abgelaufen","refresh_token":"r"}';
  assert.strictEqual((await call('POST', '/api/admin/offsite', { token: expired })).status, 400);

  // Ausgabe von "rclone authorize" inklusive der Rahmenzeilen einfügen
  const pasted = 'Paste the following into your remote machine --->\n{"access_token":"gueltig","token_type":"Bearer","refresh_token":"r","expiry":"2030-01-01T00:00:00Z"}\n<---End paste';
  const conf = await call('POST', '/api/admin/offsite', { token: pasted });
  assert.strictEqual(conf.status, 200);
  assert.strictEqual(conf.body.owner, 'Chefin');
  const confText = fs.readFileSync(path.join(tmp, 'rclone.conf'), 'utf8');
  assert.match(confText, /drive_id = b!abc123/);
  assert.match(confText, /drive_type = business/);
  assert.strictEqual(fs.statSync(path.join(tmp, 'rclone.conf')).mode & 0o777, 0o600);

  await call('POST', '/api/admin/users', { name: 'Hanna' });
  const run = await call('POST', '/api/admin/offsite/run');
  assert.strictEqual(run.status, 200);
  assert.strictEqual(run.body.last.ok, true);
  const day = new Date().toISOString().slice(0, 10);
  const uploaded = new DatabaseSync(path.join(tmp, 'Zeiterfassung-Backups', `zeiterfassung-${day}.db`));
  assert.deepStrictEqual(uploaded.prepare('SELECT name FROM users').all().map((u) => u.name), ['Hanna']);
  uploaded.close();
  assert.match(fs.readFileSync(path.join(tmp, 'deletes.log'), 'utf8'), /onedrive:Zeiterfassung-Backups --min-age 90d/);

  // Fehler werden gemeldet und gespeichert
  process.env.FAKE_RCLONE_FAIL = '1';
  const failed = await call('POST', '/api/admin/offsite/run');
  assert.strictEqual(failed.status, 502);
  assert.match(failed.body.error, /token expired/);
  const st = (await call('GET', '/api/admin/offsite')).body;
  assert.strictEqual(st.last.ok, false);

  assert.strictEqual((await call('DELETE', '/api/admin/offsite')).body.configured, false);
});
