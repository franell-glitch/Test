/* global Face */
'use strict';

const $ = (id) => document.getElementById(id);
let users = [];
let lastReport = [];

// ---------- Hilfsfunktionen ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') {
    showLogin();
    throw new Error('Bitte erneut anmelden');
  }
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (d) => d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function fmtDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  return `${Math.floor(totalMin / 60)}:${pad(totalMin % 60)}`;
}

// ---------- Anmeldung & Navigation ----------
function showLogin() {
  $('login').classList.remove('hidden');
  $('nav').classList.add('hidden');
  $('tab-users').classList.add('hidden');
  $('tab-report').classList.add('hidden');
}

function showTab(name) {
  document.querySelectorAll('button.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-users').classList.toggle('hidden', name !== 'users');
  $('tab-report').classList.toggle('hidden', name !== 'report');
  if (name === 'report') loadReport();
}

async function showApp() {
  $('login').classList.add('hidden');
  $('nav').classList.remove('hidden');
  showTab('users');
  await loadUsers();
}

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('login-password').value } });
    $('login-password').value = '';
    showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
};

$('btn-logout').onclick = async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};

document.querySelectorAll('button.tab').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- Mitarbeiter ----------
async function loadUsers() {
  users = await api('/api/admin/users');
  const body = $('users-body');
  body.innerHTML = users.length
    ? users
        .map(
          (u) => `<tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.personnel_no || '–')}</td>
        <td>${u.face_count ? u.face_count : '<span class="badge warn">keine</span>'}</td>
        <td>${u.clockedIn ? `<span class="badge in">anwesend seit ${fmtTime(u.since)}</span>` : '<span class="badge out">abwesend</span>'}</td>
        <td><input type="checkbox" data-act="active" data-id="${u.id}" ${u.active ? 'checked' : ''}></td>
        <td>
          <button class="small primary" data-act="faces" data-id="${u.id}">Gesichter</button>
          <button class="small" data-act="edit" data-id="${u.id}">Bearbeiten</button>
          <button class="small danger" data-act="delete" data-id="${u.id}">Löschen</button>
        </td></tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="muted">Noch keine Mitarbeiter angelegt.</td></tr>';

  const sel = $('report-user');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Alle</option>' + users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  sel.value = prev;
  $('entry-user').innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
}

$('user-form').onsubmit = async (e) => {
  e.preventDefault();
  $('user-error').textContent = '';
  try {
    const user = await api('/api/admin/users', {
      method: 'POST',
      body: { name: $('user-name').value, personnel_no: $('user-pno').value },
    });
    $('user-form').reset();
    await loadUsers();
    openFaceDialog(user.id); // direkt im Anschluss Gesicht erfassen
  } catch (err) {
    $('user-error').textContent = err.message;
  }
};

$('users-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const user = users.find((u) => u.id === Number(btn.dataset.id));
  if (!user) return;
  try {
    if (btn.dataset.act === 'faces') {
      openFaceDialog(user.id);
    } else if (btn.dataset.act === 'edit') {
      const name = prompt('Name', user.name);
      if (name === null) return;
      const pno = prompt('Personalnummer', user.personnel_no || '');
      if (pno === null) return;
      await api(`/api/admin/users/${user.id}`, { method: 'PUT', body: { name, personnel_no: pno } });
      await loadUsers();
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`„${user.name}“ wirklich löschen? Alle Gesichter und Zeitbuchungen dieser Person werden ebenfalls gelöscht.`)) return;
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      await loadUsers();
    }
  } catch (err) {
    alert(err.message);
  }
});

$('users-body').addEventListener('change', async (e) => {
  const cb = e.target.closest('input[data-act="active"]');
  if (!cb) return;
  try {
    await api(`/api/admin/users/${cb.dataset.id}`, { method: 'PUT', body: { active: cb.checked } });
  } catch (err) {
    alert(err.message);
    cb.checked = !cb.checked;
  }
});

// ---------- Gesichter erfassen ----------
const faceDialog = $('face-dialog');
const enrollVideo = $('enroll-video');
const enrollOverlay = $('enroll-overlay');
let faceUserId = null;
let previewTimer = null;

function setFaceStatus(text, isError = false) {
  $('face-status').textContent = text;
  $('face-status').className = isError ? 'error' : 'muted';
}

async function loadFaces() {
  const faces = await api(`/api/admin/users/${faceUserId}/faces`);
  $('faces').innerHTML = faces.length
    ? faces
        .map(
          (f, i) => `<div class="face">
        ${f.thumbnail ? `<img src="${esc(f.thumbnail)}" alt="Aufnahme ${i + 1}">` : '<div class="ph"></div>'}
        <button class="small danger" data-face="${f.id}">Entfernen</button></div>`
        )
        .join('')
    : '<p class="muted">Noch keine Aufnahmen gespeichert.</p>';
}

async function openFaceDialog(userId) {
  faceUserId = userId;
  const user = users.find((u) => u.id === userId);
  $('face-title').textContent = `Gesichter: ${user ? user.name : ''}`;
  $('btn-capture').disabled = true;
  setFaceStatus('Lade Gesichtserkennung …');
  faceDialog.showModal();
  loadFaces();
  try {
    await Promise.all([Face.loadModels(), Face.startCamera(enrollVideo)]);
    $('btn-capture').disabled = false;
    setFaceStatus('Gesicht mittig in die Kamera halten und „Aufnahme speichern“ klicken.');
    previewLoop();
  } catch (err) {
    setFaceStatus((err.message || 'Kamera nicht verfügbar') + ' – Sie können alternativ ein Foto hochladen.', true);
    await Face.loadModels().catch(() => {});
  }
}

// Zeigt laufend einen Rahmen um das erkannte Gesicht
async function previewLoop() {
  if (!faceDialog.open || !enrollVideo.srcObject) return;
  try {
    const face = await Face.detectSingle(enrollVideo);
    Face.drawBox(enrollOverlay, enrollVideo, face?.box, '#3fb950');
  } catch {
    Face.drawBox(enrollOverlay, enrollVideo, null);
  }
  previewTimer = setTimeout(previewLoop, 400);
}

async function saveFace(source) {
  const face = await Face.detectSingle(source);
  if (!face) throw new Error('Kein Gesicht erkannt. Bitte Position oder Licht verbessern.');
  await api(`/api/admin/users/${faceUserId}/faces`, {
    method: 'POST',
    body: { descriptor: face.descriptor, thumbnail: Face.thumbnail(source, face.box) },
  });
  await loadFaces();
}

$('btn-capture').onclick = async () => {
  $('btn-capture').disabled = true;
  setFaceStatus('Analysiere …');
  try {
    await saveFace(enrollVideo);
    setFaceStatus('✔ Aufnahme gespeichert. Für bessere Erkennung weitere Aufnahmen hinzufügen.');
  } catch (err) {
    setFaceStatus(err.message, true);
  } finally {
    $('btn-capture').disabled = false;
  }
};

$('face-upload').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setFaceStatus('Analysiere Foto …');
  try {
    await Face.loadModels();
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    await saveFace(img);
    URL.revokeObjectURL(img.src);
    setFaceStatus('✔ Foto gespeichert.');
  } catch (err) {
    setFaceStatus(err.message, true);
  }
};

$('faces').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-face]');
  if (!btn || !confirm('Diese Aufnahme entfernen?')) return;
  await api(`/api/admin/faces/${btn.dataset.face}`, { method: 'DELETE' }).catch((err) => alert(err.message));
  loadFaces();
});

$('btn-face-close').onclick = () => faceDialog.close();
faceDialog.addEventListener('close', () => {
  clearTimeout(previewTimer);
  Face.stopCamera(enrollVideo);
  loadUsers();
});

// ---------- Auswertung ----------
function initReportDates() {
  const now = new Date();
  $('report-from').value = dateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  $('report-to').value = dateKey(now);
}

function reportRange() {
  const from = new Date($('report-from').value + 'T00:00');
  const to = new Date($('report-to').value + 'T00:00');
  to.setDate(to.getDate() + 1); // "Bis" inklusive
  return { from, to };
}

function entryDuration(e) {
  if (e.end_time) return Date.parse(e.end_time) - Date.parse(e.start_time);
  if (!e.missing_end) return Date.now() - Date.parse(e.start_time); // läuft noch
  return 0;
}

const methodLabel = (m) => (m === 'face' ? 'Gesicht' : m === 'manual' ? 'manuell' : '');

async function loadReport() {
  const { from, to } = reportRange();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if ($('report-user').value) params.set('userId', $('report-user').value);
  try {
    lastReport = await api('/api/admin/entries?' + params);
  } catch (err) {
    $('report-output').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  renderReport();
}

function groupReport(entries) {
  const byUser = new Map();
  for (const e of entries) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, { name: e.user_name, pno: e.personnel_no, days: new Map() });
    const days = byUser.get(e.user_id).days;
    const key = dateKey(new Date(e.start_time));
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  return byUser;
}

function renderReport() {
  const out = $('report-output');
  if (!lastReport.length) {
    out.innerHTML = '<div class="card muted">Keine Buchungen im gewählten Zeitraum.</div>';
    return;
  }
  const html = [];
  for (const [, u] of groupReport(lastReport)) {
    let userTotal = 0;
    const rows = [];
    for (const [key, entries] of u.days) {
      let dayTotal = 0;
      entries.forEach((e, i) => {
        const dur = entryDuration(e);
        dayTotal += dur;
        let end;
        if (e.end_time) end = fmtTime(e.end_time);
        else if (e.missing_end) end = '<span class="badge warn">Ausstempeln fehlt</span>';
        else end = '<span class="badge in">läuft</span>';
        const methods = [methodLabel(e.start_method), e.end_time ? methodLabel(e.end_method) : '']
          .filter(Boolean)
          .join(' / ');
        rows.push(`<tr>
          <td>${i === 0 ? fmtDate(new Date(key + 'T00:00')) : ''}</td>
          <td>${fmtTime(e.start_time)}</td>
          <td>${end}</td>
          <td class="num">${e.missing_end ? '–' : fmtDuration(dur)}</td>
          <td class="muted">${esc(methods)}</td>
          <td class="muted">${esc(e.note || '')}</td>
          <td><button class="small" data-entry="${e.id}">Bearbeiten</button></td>
        </tr>`);
      });
      userTotal += dayTotal;
      rows.push(`<tr class="day-total"><td></td><td colspan="2">Tagessumme</td><td class="num">${fmtDuration(dayTotal)}</td><td colspan="3"></td></tr>`);
    }
    rows.push(`<tr class="user-total"><td colspan="3">Gesamt ${esc(u.name)}</td><td class="num">${fmtDuration(userTotal)}</td><td colspan="3"></td></tr>`);
    html.push(`<div class="card">
      <h2>${esc(u.name)} ${u.pno ? `<span class="muted">(${esc(u.pno)})</span>` : ''}</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Datum</th><th>Beginn</th><th>Ende</th><th class="num">Dauer</th><th>Erfassung</th><th>Notiz</th><th></th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div></div>`);
  }
  out.innerHTML = html.join('');
}

$('report-form').onsubmit = (e) => {
  e.preventDefault();
  loadReport();
};
$('report-user').onchange = loadReport;

$('btn-csv').onclick = () => {
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Personalnummer', 'Name', 'Datum', 'Beginn', 'Ende', 'Dauer (h:mm)', 'Dauer (Std.)', 'Notiz']];
  for (const e of lastReport) {
    const dur = e.missing_end ? 0 : entryDuration(e);
    lines.push([
      e.personnel_no || '',
      e.user_name,
      new Date(e.start_time).toLocaleDateString('de-DE'),
      fmtTime(e.start_time),
      e.end_time ? fmtTime(e.end_time) : e.missing_end ? 'fehlt' : 'läuft',
      e.missing_end ? '' : fmtDuration(dur),
      e.missing_end ? '' : (dur / 3600000).toFixed(2).replace('.', ','),
      e.note || '',
    ]);
  }
  const csv = '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `zeiterfassung_${$('report-from').value}_bis_${$('report-to').value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- Buchung bearbeiten / hinzufügen ----------
const entryDialog = $('entry-dialog');
let editingEntry = null;

function openEntryDialog(entry) {
  editingEntry = entry;
  $('entry-error').textContent = '';
  $('entry-title').textContent = entry ? `Buchung bearbeiten – ${entry.user_name}` : 'Buchung hinzufügen';
  $('entry-user-label').classList.toggle('hidden', !!entry);
  $('btn-entry-delete').classList.toggle('hidden', !entry);
  if ($('report-user').value) $('entry-user').value = $('report-user').value;
  $('entry-start').value = toLocalInput(entry?.start_time);
  $('entry-end').value = toLocalInput(entry?.end_time);
  $('entry-note').value = entry?.note || '';
  entryDialog.showModal();
}

$('btn-add-entry').onclick = () => {
  if (!users.length) return alert('Bitte zuerst Mitarbeiter anlegen.');
  openEntryDialog(null);
};

$('report-output').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-entry]');
  if (btn) openEntryDialog(lastReport.find((x) => x.id === Number(btn.dataset.entry)));
});

$('entry-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    start_time: fromLocalInput($('entry-start').value),
    end_time: fromLocalInput($('entry-end').value),
    note: $('entry-note').value.trim() || null,
  };
  try {
    if (editingEntry) {
      await api(`/api/admin/entries/${editingEntry.id}`, { method: 'PUT', body });
    } else {
      await api('/api/admin/entries', { method: 'POST', body: { ...body, user_id: Number($('entry-user').value) } });
    }
    entryDialog.close();
    loadReport();
  } catch (err) {
    $('entry-error').textContent = err.message;
  }
};

$('btn-entry-delete').onclick = async () => {
  if (!editingEntry || !confirm('Buchung wirklich löschen?')) return;
  try {
    await api(`/api/admin/entries/${editingEntry.id}`, { method: 'DELETE' });
    entryDialog.close();
    loadReport();
  } catch (err) {
    $('entry-error').textContent = err.message;
  }
};
$('btn-entry-cancel').onclick = () => entryDialog.close();

// ---------- Start ----------
initReportDates();
api('/api/admin/me').then(showApp, showLogin);
