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
