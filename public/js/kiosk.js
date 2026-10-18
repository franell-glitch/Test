/* global Face */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const statusEl = $('status');
const actionsEl = $('actions');
const btnIn = $('btn-in');
const btnOut = $('btn-out');
const btnCancel = $('btn-cancel');
const countdownEl = $('countdown');

const SCAN_INTERVAL_MS = 700;
const AUTO_CONFIRM_SECONDS = 5;
const MIN_FACE_WIDTH = 110; // Pixel – Personen im Hintergrund werden ignoriert
const RESULT_DISPLAY_MS = 4000;

let state = 'scanning'; // scanning | pin | confirm | busy
let current = null; // Ergebnis von /identify
let countdownTimer = null;
let lastUnknownAt = 0;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('de-DE');
  $('date').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler ' + res.status);
  return data;
}

function resetToScanning(delay = 0) {
  clearInterval(countdownTimer);
  setTimeout(() => {
    current = null;
    state = 'scanning';
    actionsEl.classList.add('hidden');
    btnCancel.classList.add('hidden');
    countdownEl.textContent = '';
    setStatus('Bitte in die Kamera schauen');
  }, delay);
}

function showConfirm(result) {
  state = 'confirm';
  current = result;
  const since = result.clockedIn ? ` – eingestempelt seit ${fmtTime(result.since)}` : '';
  setStatus(`Hallo ${result.user.name}${since}`, 'ok');
  btnIn.classList.toggle('suggested', result.suggestedAction === 'in');
  btnOut.classList.toggle('suggested', result.suggestedAction === 'out');
  actionsEl.classList.remove('hidden');
  btnCancel.classList.remove('hidden');

  let remaining = AUTO_CONFIRM_SECONDS;
  const label = result.suggestedAction === 'in' ? 'Kommen' : 'Gehen';
  countdownEl.textContent = `„${label}“ wird in ${remaining} s automatisch gebucht`;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      stamp(result.suggestedAction);
    } else {
      countdownEl.textContent = `„${label}“ wird in ${remaining} s automatisch gebucht`;
    }
  }, 1000);
}

async function stamp(action) {
  if (state !== 'confirm' || !current) return;
  state = 'busy';
  clearInterval(countdownTimer);
  actionsEl.classList.add('hidden');
  btnCancel.classList.add('hidden');
  countdownEl.textContent = '';
  try {
    const r = await api('/api/kiosk/stamp', { token: current.token, action });
    const verb = action === 'in' ? 'Eingestempelt' : 'Ausgestempelt';
    setStatus(`✔ ${verb}: ${r.user.name} um ${fmtTime(r.time)} Uhr`, 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  }
  resetToScanning(RESULT_DISPLAY_MS);
}

btnIn.onclick = () => stamp('in');
btnOut.onclick = () => stamp('out');
btnCancel.onclick = () => {
  setStatus('Abgebrochen');
  resetToScanning(1500);
};

// ---------- PIN-Eingabe als Alternative zur Gesichtserkennung ----------
const pinDialog = $('pin-dialog');
let pin = '';

function renderPin() {
  $('pin-display').innerHTML = pin ? '•'.repeat(pin.length) : '&nbsp;';
}

$('btn-pin').onclick = () => {
  if (state !== 'scanning') return;
  state = 'pin';
  pin = '';
  renderPin();
  $('pin-error').innerHTML = '&nbsp;';
  pinDialog.showModal();
};

async function submitPin() {
  if (pin.length < 4) {
    $('pin-error').textContent = 'Mindestens 4 Ziffern';
    return;
  }
  try {
    const result = await api('/api/kiosk/identify-pin', { pin });
    pinDialog.close('ok');
    showConfirm(result);
  } catch (e) {
    pin = '';
    renderPin();
    $('pin-error').textContent = e.message;
  }
}

function pinKey(key) {
  if (key === 'del') pin = pin.slice(0, -1);
  else if (key === 'ok') return submitPin();
  else if (/^\d$/.test(key) && pin.length < 8) pin += key;
  renderPin();
}

$('pin-pad').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-key]');
  if (btn) pinKey(btn.dataset.key);
});
pinDialog.addEventListener('keydown', (e) => {
  if (/^\d$/.test(e.key)) pinKey(e.key);
  else if (e.key === 'Backspace') pinKey('del');
  else if (e.key === 'Enter') {
    e.preventDefault();
    pinKey('ok');
  }
});
$('pin-close').onclick = () => pinDialog.close();
pinDialog.addEventListener('close', () => {
  if (state === 'pin') resetToScanning();
});

async function scanLoop() {
  if (state === 'scanning' && video.readyState >= 2) {
    try {
      const face = await Face.detectSingle(video);
      if (state !== 'scanning') {
        // Zustand hat sich während der Erkennung geändert
      } else if (!face) {
        Face.drawBox(overlay, video, null);
      } else if (face.box.width < MIN_FACE_WIDTH) {
        Face.drawBox(overlay, video, face.box, '#d29922');
        setStatus('Bitte näher an die Kamera kommen');
      } else {
        Face.drawBox(overlay, video, face.box, '#3fb950');
        state = 'busy';
        const result = await api('/api/kiosk/identify', { descriptor: face.descriptor });
        if (result.recognized) {
          showConfirm(result);
        } else {
          state = 'scanning';
          Face.drawBox(overlay, video, face.box, '#f85149');
          if (Date.now() - lastUnknownAt > 2000) setStatus('Gesicht nicht erkannt – bitte an die Verwaltung wenden', 'err');
          lastUnknownAt = Date.now();
        }
      }
    } catch (e) {
      if (state === 'busy') state = 'scanning';
      setStatus(e.message, 'err');
    }
  }
  if (state !== 'scanning') Face.drawBox(overlay, video, null);
  setTimeout(scanLoop, SCAN_INTERVAL_MS);
}

(async () => {
  try {
    await Promise.all([Face.loadModels(), Face.startCamera(video)]);
    setStatus('Bitte in die Kamera schauen');
    scanLoop();
  } catch (e) {
    setStatus((e.message || 'Kamera konnte nicht gestartet werden') + ' – Stempeln per PIN ist weiterhin möglich.', 'err');
  }
})();
