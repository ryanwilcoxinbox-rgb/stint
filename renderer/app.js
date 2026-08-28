'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let data = null;
let tickTimer = null;
let pendingStop = null; // ID of a persisted session awaiting a note
let recoveredRunningTimer = false;

let historyPeriod = 'day';            // 'day' | 'week' | 'month'
let historyAnchor = localDateStr(new Date()); // a date inside the viewed period
let historySearch = '';

const COLORS = ['#818cf8', '#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#a78bfa', '#fb7185', '#4ade80', '#f97316', '#22d3ee'];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}`;
}
function fmtHours(totalSec) { return (totalSec / 3600).toFixed(2) + ' h'; }

function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function clientById(id) { return (data.clients || []).find((c) => c.id === id) || null; }
function clientColor(id) { const c = clientById(id); return c && c.color ? c.color : '#5e6880'; }

// Billing helpers
function roundSec(sec) {
  const inc = Number(data.settings.roundIncrementMin || 0) * 60;
  if (!inc) return sec;
  return (data.settings.roundUp ? Math.ceil(sec / inc) : Math.round(sec / inc)) * inc;
}
function currency() { return data.settings.currencySymbol || '€'; }
function fmtMoney(amount) { return currency() + amount.toFixed(2); }
// Returns hourly rate for a client. Day rate takes priority; falls back to legacy hourly rate.
function hourlyRate(clientId) {
  const c = clientById(clientId);
  if (!c) return null;
  const hpd = Math.max(1, Number(data.settings.hoursPerDay || 8));
  if (c.dayRate != null && c.dayRate !== '' && !isNaN(Number(c.dayRate))) return Number(c.dayRate) / hpd;
  if (c.rate != null && c.rate !== '' && !isNaN(Number(c.rate))) return Number(c.rate);
  return null;
}
function earningsFor(clientId, sec) {
  const hr = hourlyRate(clientId);
  if (hr == null) return null;
  return (roundSec(sec) / 3600) * hr;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (data.timer.running) data.timer.lastPersistedTs = Date.now();
    window.api.saveData(data);
  }, 150);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (data.timer.running) data.timer.lastPersistedTs = Date.now();
  return window.api.saveData(data);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Period maths (for History)
// ---------------------------------------------------------------------------
function parseDay(str) { return new Date(str + 'T12:00:00'); }

function periodRange(anchorStr, period) {
  const a = parseDay(anchorStr);
  if (period === 'day') {
    return { start: anchorStr, end: anchorStr, label: a.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) };
  }
  if (period === 'week') {
    const dow = (a.getDay() + 6) % 7; // Monday = 0
    const start = new Date(a); start.setDate(a.getDate() - dow);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    const lbl = `${start.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
    return { start: localDateStr(start), end: localDateStr(end), label: lbl };
  }
  // month
  const start = new Date(a.getFullYear(), a.getMonth(), 1);
  const end = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  return { start: localDateStr(start), end: localDateStr(end), label: a.toLocaleDateString([], { month: 'long', year: 'numeric' }) };
}

function shiftAnchor(delta) {
  const a = parseDay(historyAnchor);
  if (historyPeriod === 'day') a.setDate(a.getDate() + delta);
  else if (historyPeriod === 'week') a.setDate(a.getDate() + 7 * delta);
  else a.setMonth(a.getMonth() + delta);
  historyAnchor = localDateStr(a);
}

function thisWeekRange() { return periodRange(localDateStr(new Date()), 'week'); }

// ---------------------------------------------------------------------------
// Timer logic
// ---------------------------------------------------------------------------
function currentElapsedSec() {
  const t = data.timer;
  let sec = t.accumulatedSec || 0;
  if (t.running && t.lastStartTs) sec += (Date.now() - t.lastStartTs) / 1000;
  return sec;
}
function isActiveSession() {
  const t = data.timer;
  return t.running || (t.accumulatedSec || 0) > 0 || !!t.sessionStart;
}

function startTimer() {
  const t = data.timer;
  if (t.running) return;
  if (!t.activeClientId) {
    if (data.clients.length) t.activeClientId = data.clients[0].id;
    else { toast('Add a client first (Clients tab).'); switchTab('clients'); return; }
  }
  if (!t.sessionStart) t.sessionStart = new Date().toISOString();
  t.running = true;
  t.lastStartTs = Date.now();
  t.lastPersistedTs = t.lastStartTs;
  save(); renderTimer(); startTick();
}

function pauseTimer() {
  const t = data.timer;
  if (!t.running) return;
  t.accumulatedSec = currentElapsedSec();
  t.running = false;
  t.lastStartTs = null;
  save(); renderTimer(); stopTick();
}

function toggleTimer() { if (data.timer.running) pauseTimer(); else startTimer(); }

function stopTimer() {
  const t = data.timer;
  if (!isActiveSession()) return;
  const durationSec = Math.round(currentElapsedSec());
  const session = {
    id: uid(),
    clientId: t.activeClientId,
    date: localDateStr(t.sessionStart ? new Date(t.sessionStart) : new Date()),
    start: t.sessionStart || new Date().toISOString(),
    end: new Date().toISOString(),
    durationSec,
    note: '',
  };
  const keepClient = t.activeClientId;
  data.timer = { activeClientId: keepClient, running: false, accumulatedSec: 0, lastStartTs: null, sessionStart: null, lastPersistedTs: Date.now() };
  stopTick(); renderTimer();
  if (durationSec <= 0) { save(); renderAll(); return; }
  // Persist the completed session before asking for a note. A crash or quit while the
  // modal is open now leaves a valid session with a blank note instead of losing time.
  data.sessions.push(session);
  pendingStop = session.id;
  saveNow();
  openNoteModal();
}

function startTick() { stopTick(); tickTimer = setInterval(onTick, 1000); }
function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }
function onTick() {
  renderTimerDisplay();
  checkIdle();
}

// ---------------------------------------------------------------------------
// Rendering — Track
// ---------------------------------------------------------------------------
function renderTimerDisplay() {
  $('#timer-display').textContent = fmtDuration(currentElapsedSec());
  if (data.timer.running) { renderTodayTotals(); renderStatStrip(); }
}

function renderTimer() {
  const t = data.timer;
  renderTimerDisplay();
  const paused = !t.running && isActiveSession();
  const card = $('#timer-card');
  card.classList.toggle('running', t.running);
  card.classList.toggle('paused', paused);
  // Flag the Track tab so you can see the timer state from any other tab:
  // green pulsing = running, amber steady = paused, nothing = stopped.
  const trackTab = document.querySelector('.tab[data-tab="track"]');
  if (trackTab) {
    trackTab.classList.toggle('tracking', t.running);
    trackTab.classList.toggle('tracking-paused', paused);
  }
  const statusText = $('#timer-status .status-text');
  if (t.running) statusText.textContent = 'Running';
  else if (isActiveSession()) statusText.textContent = 'Paused';
  else statusText.textContent = 'Stopped';

  $('#btn-start').disabled = t.running;
  $('#btn-pause').disabled = !t.running;
  $('#btn-stop').disabled = !isActiveSession();

  const sel = $('#client-select');
  sel.disabled = isActiveSession();
  if (t.activeClientId) sel.value = t.activeClientId;
  $('#select-dot').style.background = clientColor(t.activeClientId);
}

function renderClientSelect() {
  const sel = $('#client-select');
  const prev = data.timer.activeClientId;
  sel.innerHTML = '';
  if (!data.clients.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No clients — add one in the Clients tab';
    opt.value = '';
    sel.appendChild(opt);
    $('#select-dot').style.background = '#5e6880';
    return;
  }
  data.clients.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${i + 1}. ${c.name}`;
    sel.appendChild(opt);
  });
  if (prev && clientById(prev)) sel.value = prev;
  else data.timer.activeClientId = data.clients[0].id;
  $('#select-dot').style.background = clientColor(data.timer.activeClientId);
}

// Live in-progress session for today (raw, unrounded — Track shows exact time)
function liveTodaySession() {
  const t = data.timer;
  const today = localDateStr(new Date());
  if (!isActiveSession() || !t.sessionStart) return null;
  if (localDateStr(new Date(t.sessionStart)) !== today) return null;
  return { clientId: t.activeClientId, sec: currentElapsedSec(), running: t.running };
}

function sumByClientRaw(startStr, endStr) {
  const map = new Map();
  for (const s of (data.sessions || [])) {
    if (s.date >= startStr && s.date <= endStr) {
      map.set(s.clientId, (map.get(s.clientId) || 0) + (s.durationSec || 0));
    }
  }
  return map;
}

function renderStatStrip() {
  const today = localDateStr(new Date());
  let todaySec = 0;
  for (const s of (data.sessions || [])) if (s.date === today) todaySec += s.durationSec || 0;
  const wk = thisWeekRange();
  let weekSec = 0;
  for (const s of (data.sessions || [])) if (s.date >= wk.start && s.date <= wk.end) weekSec += s.durationSec || 0;
  const live = liveTodaySession();
  if (live) { todaySec += live.sec; weekSec += live.sec; }
  $('#stat-today').textContent = fmtHours(todaySec);
  $('#stat-week').textContent = fmtHours(weekSec);
}

function renderTodayTotals() {
  const today = localDateStr(new Date());
  const totalsEl = $('#today-totals');
  totalsEl.innerHTML = '';
  const byClient = sumByClientRaw(today, today);
  const live = liveTodaySession();
  if (live && live.clientId) byClient.set(live.clientId, (byClient.get(live.clientId) || 0) + live.sec);

  if (byClient.size === 0) {
    totalsEl.innerHTML = '<div class="empty">No time logged today yet.</div>';
    return;
  }
  for (const [cid, sec] of byClient) {
    const c = clientById(cid);
    const isLive = live && live.clientId === cid;
    const row = document.createElement('div');
    row.className = 'total-row';
    row.innerHTML = `<span class="name"><span class="dot"></span><span class="cname"></span></span><span class="hours"></span>`;
    row.querySelector('.dot').style.background = clientColor(cid);
    row.querySelector('.cname').textContent = c ? c.name : '(deleted client)';
    if (isLive) {
      const tag = document.createElement('span');
      tag.className = 'live-tag';
      tag.textContent = live.running ? 'live' : 'paused';
      row.querySelector('.name').appendChild(tag);
    }
    row.querySelector('.hours').textContent = fmtHours(sec);
    totalsEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Rendering — History (summary + sessions)
// ---------------------------------------------------------------------------
function renderHistory() {
  $$('.period-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === historyPeriod));
  const range = periodRange(historyAnchor, historyPeriod);
  $('#period-label').textContent = range.label;
  renderSummary(range);
  renderHistorySessions(range);
}

function renderSummary(range) {
  const el = $('#history-summary');
  el.innerHTML = '';
  const note = $('#summary-note');
  const rounding = Number(data.settings.roundIncrementMin || 0);
  note.textContent = rounding ? `(rounded to ${rounding} min${data.settings.roundUp ? ', up' : ''})` : '';

  const raw = sumByClientRaw(range.start, range.end);
  if (raw.size === 0) { el.innerHTML = '<div class="empty">No time logged in this period.</div>'; return; }

  // Apply rounding per-session for billing accuracy
  const rounded = new Map();
  for (const s of (data.sessions || [])) {
    if (s.date >= range.start && s.date <= range.end) {
      rounded.set(s.clientId, (rounded.get(s.clientId) || 0) + roundSec(s.durationSec || 0));
    }
  }
  const entries = [...rounded.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map((e) => e[1]), 1);
  let totalSec = 0, totalEarn = 0, anyEarn = false;

  for (const [cid, sec] of entries) {
    totalSec += sec;
    const earn = earningsFor(cid, sec);
    if (earn != null) { totalEarn += earn; anyEarn = true; }
    const c = clientById(cid);
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `
      <div class="summary-head">
        <span class="name"><span class="dot"></span><span class="cname"></span></span>
        <span class="vals"><span class="hrs"></span><span class="earn"></span></span>
      </div>
      <div class="bar"><span class="bar-fill"></span></div>`;
    row.querySelector('.dot').style.background = clientColor(cid);
    row.querySelector('.cname').textContent = c ? c.name : '(deleted client)';
    row.querySelector('.hrs').textContent = fmtHours(sec);
    row.querySelector('.earn').textContent = earn != null ? fmtMoney(earn) : '';
    const fill = row.querySelector('.bar-fill');
    fill.style.width = (sec / max * 100).toFixed(1) + '%';
    fill.style.background = clientColor(cid);
    el.appendChild(row);
  }

  const tot = document.createElement('div');
  tot.className = 'summary-total';
  tot.innerHTML = `<span>Total</span><span>${fmtHours(totalSec)}${anyEarn ? ' · ' + fmtMoney(totalEarn) : ''}</span>`;
  el.appendChild(tot);
}

function renderHistorySessions(range) {
  const listEl = $('#history-sessions');
  listEl.innerHTML = '';
  const q = historySearch.trim().toLowerCase();
  let sessions = (data.sessions || [])
    .filter((s) => s.date >= range.start && s.date <= range.end)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
  if (q) {
    sessions = sessions.filter((s) => {
      const c = clientById(s.clientId);
      return (s.note || '').toLowerCase().includes(q) || (c && c.name.toLowerCase().includes(q));
    });
  }
  if (sessions.length === 0) { listEl.innerHTML = '<div class="empty">No sessions.</div>'; return; }

  let currentDate = null;
  for (const s of sessions) {
    if (s.date !== currentDate) {
      currentDate = s.date;
      const h = document.createElement('div');
      h.className = 'date-divider';
      h.textContent = parseDay(s.date).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      listEl.appendChild(h);
    }
    const c = clientById(s.clientId);
    const earn = earningsFor(s.clientId, s.durationSec || 0);
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `
      <div class="meta">
        <span class="client"><span class="dot"></span><span class="cname"></span></span>
        <span class="time"></span>
      </div>
      <div class="note"></div>
      <div class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="delete">Delete</button>
      </div>`;
    row.querySelector('.dot').style.background = clientColor(s.clientId);
    row.querySelector('.cname').textContent = c ? c.name : '(deleted client)';
    row.querySelector('.time').textContent =
      `${fmtClock(s.start)}–${fmtClock(s.end)} · ${fmtDuration(s.durationSec)}` + (earn != null ? ` · ${fmtMoney(earn)}` : '');
    row.querySelector('.note').textContent = s.note || '';
    row.querySelector('[data-act="edit"]').addEventListener('click', () => openSessionModal(s.id));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSession(s.id));
    listEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Rendering — Clients
// ---------------------------------------------------------------------------
function renderClients() {
  const listEl = $('#client-list');
  listEl.innerHTML = '';
  if (!data.clients.length) { listEl.innerHTML = '<div class="empty">No clients yet. Add one above.</div>'; return; }
  data.clients.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'client-card';
    card.innerHTML = `
      <div class="name"><span class="dot"></span><span class="cname"></span><span class="rate"></span></div>
      <div class="sub addr"></div>
      <div class="sub det"></div>
      <div class="row-actions">
        <button data-act="edit">Edit</button>
        <button data-act="delete">Delete</button>
      </div>`;
    card.querySelector('.dot').style.background = c.color || '#5e6880';
    card.querySelector('.cname').textContent = `${i + 1}. ${c.name}`;
    const rateDisplay = (c.dayRate != null && c.dayRate !== '') ? `${currency()}${Number(c.dayRate)}/day`
      : (c.rate != null && c.rate !== '') ? `${currency()}${Number(c.rate)}/h` : '';
    card.querySelector('.rate').textContent = rateDisplay;
    card.querySelector('.addr').textContent = c.address || '';
    card.querySelector('.det').textContent = c.details || '';
    card.querySelector('[data-act="edit"]').addEventListener('click', () => editClient(c.id));
    card.querySelector('[data-act="delete"]').addEventListener('click', () => deleteClient(c.id));
    listEl.appendChild(card);
  });
}

function renderColorSwatches() {
  const wrap = $('#color-swatches');
  wrap.innerHTML = '';
  const selected = $('#client-color').value || COLORS[0];
  COLORS.forEach((col) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (col === selected ? ' active' : '');
    b.style.background = col;
    // Update the selection in place (don't rebuild the buttons) so the click target
    // isn't destroyed mid-interaction.
    b.addEventListener('click', () => {
      $('#client-color').value = col;
      wrap.querySelectorAll('.swatch').forEach((s, i) => s.classList.toggle('active', COLORS[i] === col));
    });
    wrap.appendChild(b);
  });
}

function renderAll() {
  renderClientSelect();
  renderTimer();
  renderStatStrip();
  renderTodayTotals();
  renderHistory();
  renderClients();
  if (data.timer.running) startTick();
  $('#hk-global').textContent = friendlyAccel(data.settings.showHideHotkey) || 'none';
}

// ---------------------------------------------------------------------------
// Clients CRUD
// ---------------------------------------------------------------------------
function nextColor() { return COLORS[(data.clients.length) % COLORS.length]; }

function resetClientForm() {
  $('#client-id').value = '';
  $('#client-name').value = '';
  $('#client-address').value = '';
  $('#client-details').value = '';
  $('#client-day-rate').value = '';
  $('#client-color').value = nextColor();
  $('#client-save').textContent = 'Add client';
  $('#client-cancel').hidden = true;
  renderColorSwatches();
}

function editClient(id) {
  const c = clientById(id);
  if (!c) return;
  $('#client-id').value = c.id;
  $('#client-name').value = c.name || '';
  $('#client-address').value = c.address || '';
  $('#client-details').value = c.details || '';
  $('#client-day-rate').value = (c.dayRate != null ? c.dayRate : '');
  $('#client-color').value = c.color || nextColor();
  $('#client-save').textContent = 'Save changes';
  $('#client-cancel').hidden = false;
  renderColorSwatches();
  switchTab('clients');
  $('#client-name').focus();
}

function deleteClient(id) {
  const c = clientById(id);
  if (!c) return;
  const count = (data.sessions || []).filter((s) => s.clientId === id).length;
  const msg = count
    ? `Delete "${c.name}"? Its ${count} saved session(s) remain in your records but show as "(deleted client)".`
    : `Delete "${c.name}"?`;
  if (!confirm(msg)) return;
  data.clients = data.clients.filter((x) => x.id !== id);
  if (data.timer.activeClientId === id) data.timer.activeClientId = data.clients[0] ? data.clients[0].id : null;
  save(); renderAll(); toast('Client deleted.');
}

$('#client-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#client-id').value;
  const name = $('#client-name').value.trim();
  if (!name) return;
  const address = $('#client-address').value.trim();
  const details = $('#client-details').value.trim();
  const dayRateRaw = $('#client-day-rate').value.trim();
  const dayRate = dayRateRaw === '' ? null : Number(dayRateRaw);
  const color = $('#client-color').value || nextColor();
  if (id) {
    const c = clientById(id);
    if (c) { c.name = name; c.address = address; c.details = details; c.dayRate = dayRate; c.color = color; }
    toast('Client updated.');
  } else {
    data.clients.push({ id: uid(), name, address, details, dayRate, color, createdAt: new Date().toISOString() });
    toast('Client added.');
  }
  resetClientForm();
  save(); renderAll();
});
$('#client-cancel').addEventListener('click', resetClientForm);

// ---------------------------------------------------------------------------
// Sessions: note modal, edit/add modal, delete
// ---------------------------------------------------------------------------
function openNoteModal() {
  $('#note-input').value = '';
  $('#note-modal').hidden = false;
  $('#note-input').focus();
}
function commitNote(note) {
  if (pendingStop) {
    const session = data.sessions.find((s) => s.id === pendingStop);
    if (session) session.note = (note || '').trim();
    pendingStop = null;
    save(); renderAll(); toast('Session saved.');
  }
  $('#note-modal').hidden = true;
}
// Throw the just-stopped session away entirely (e.g. mistimed or non-billable).
function discardPending() {
  if (pendingStop) data.sessions = data.sessions.filter((s) => s.id !== pendingStop);
  pendingStop = null;
  $('#note-modal').hidden = true;
  save();
  renderAll();
  toast('Session discarded.');
}
$('#note-save').addEventListener('click', () => commitNote($('#note-input').value));
$('#note-discard').addEventListener('click', discardPending);
$('#note-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitNote($('#note-input').value); });

function deleteSession(id) {
  const s = (data.sessions || []).find((x) => x.id === id);
  if (!s) return;
  if (!confirm('Delete this session permanently?')) return;
  data.sessions = data.sessions.filter((x) => x.id !== id);
  save(); renderAll(); toast('Session deleted.');
}

// Edit / Add session modal
function timeStr(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '00:00';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function isoFrom(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

function fillSeClients(selectedId) {
  const sel = $('#se-client');
  sel.innerHTML = '';
  data.clients.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
  if (selectedId) sel.value = selectedId;
}

function openSessionModal(id) {
  if (!data.clients.length) { toast('Add a client first.'); switchTab('clients'); return; }
  const editing = !!id;
  const s = editing ? (data.sessions || []).find((x) => x.id === id) : null;
  $('#session-modal-title').textContent = editing ? 'Edit session' : 'Add session';
  $('#se-delete').style.display = editing ? '' : 'none';
  $('#se-id').value = editing ? id : '';
  fillSeClients(editing ? s.clientId : data.timer.activeClientId);
  const dateStr = editing ? s.date : historyAnchor;
  $('#se-date').value = dateStr;
  $('#se-start').value = editing ? timeStr(s.start) : '09:00';
  $('#se-end').value = editing ? timeStr(s.end) : '10:00';
  updateSeDuration();
  $('#se-note').value = editing ? (s.note || '') : '';
  $('#session-modal').hidden = false;
}

function seDurationSec() {
  const d = $('#se-date').value;
  let startISO = isoFrom(d, $('#se-start').value || '00:00');
  let endISO = isoFrom(d, $('#se-end').value || '00:00');
  let sec = (new Date(endISO) - new Date(startISO)) / 1000;
  if (sec < 0) {
    const end = new Date(endISO);
    end.setDate(end.getDate() + 1);
    endISO = end.toISOString();
    sec = (new Date(endISO) - new Date(startISO)) / 1000;
  }
  return { sec: Math.round(sec), startISO, endISO };
}
function updateSeDuration() {
  const { sec } = seDurationSec();
  $('#se-duration').textContent = 'Duration: ' + fmtDuration(sec);
}
['#se-start', '#se-end', '#se-date'].forEach((id) => $(id).addEventListener('input', updateSeDuration));

$('#se-save').addEventListener('click', () => {
  const id = $('#se-id').value;
  const clientId = $('#se-client').value;
  const dateStr = $('#se-date').value;
  if (!clientId || !dateStr) { toast('Pick a client and date.'); return; }
  const { sec, startISO, endISO } = seDurationSec();
  const note = $('#se-note').value.trim();
  if (id) {
    const s = (data.sessions || []).find((x) => x.id === id);
    if (s) { s.clientId = clientId; s.date = dateStr; s.start = startISO; s.end = endISO; s.durationSec = sec; s.note = note; }
  } else {
    data.sessions.push({ id: uid(), clientId, date: dateStr, start: startISO, end: endISO, durationSec: sec, note });
  }
  $('#session-modal').hidden = true;
  save(); renderAll(); toast(id ? 'Session updated.' : 'Session added.');
});
$('#se-cancel').addEventListener('click', () => { $('#session-modal').hidden = true; });
$('#se-delete').addEventListener('click', () => {
  const id = $('#se-id').value;
  if (id && confirm('Delete this session permanently?')) {
    data.sessions = data.sessions.filter((x) => x.id !== id);
    $('#session-modal').hidden = true;
    save(); renderAll(); toast('Session deleted.');
  }
});

// ---------------------------------------------------------------------------
// Timer buttons + client select
// ---------------------------------------------------------------------------
$('#btn-start').addEventListener('click', startTimer);
$('#btn-pause').addEventListener('click', pauseTimer);
$('#btn-stop').addEventListener('click', stopTimer);
$('#client-select').addEventListener('change', (e) => {
  if (isActiveSession()) return;
  data.timer.activeClientId = e.target.value || null;
  $('#select-dot').style.background = clientColor(data.timer.activeClientId);
  save();
});

// ---------------------------------------------------------------------------
// History controls
// ---------------------------------------------------------------------------
$$('.period-btn').forEach((b) => b.addEventListener('click', () => { historyPeriod = b.dataset.period; renderHistory(); }));
$('#period-prev').addEventListener('click', () => { shiftAnchor(-1); renderHistory(); });
$('#period-next').addEventListener('click', () => { shiftAnchor(1); renderHistory(); });
$('#period-reset').addEventListener('click', () => { historyAnchor = localDateStr(new Date()); renderHistory(); });
$('#history-search').addEventListener('input', (e) => { historySearch = e.target.value; renderHistory(); });
$('#btn-add-session').addEventListener('click', () => openSessionModal(null));

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const TAB_ORDER = ['track', 'history', 'clients', 'data'];
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  const i = Math.max(0, TAB_ORDER.indexOf(name));
  const n = TAB_ORDER.length;
  const indicator = $('#tab-indicator');
  if (indicator) {
    indicator.style.width = `calc((100% - 8px) / ${n})`;
    indicator.style.transform = `translateX(calc(${i * 100}% + ${i * 2}px))`;
  }
  if (name === 'history') renderHistory();
  // When opening Clients to add a new client, focus the name field so you can type
  // straight away (avoids the "first click only focuses the window" quirk).
  if (name === 'clients' && !$('#client-id').value) {
    setTimeout(() => $('#client-name').focus(), 60);
  }
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ---------------------------------------------------------------------------
// Data tab: export / import / settings / hotkeys
// ---------------------------------------------------------------------------
$('#btn-export-csv').addEventListener('click', async () => { const r = await window.api.exportCsv(data); if (r.ok) toast('CSV saved.'); });
$('#btn-export-json').addEventListener('click', async () => { const r = await window.api.exportJson(data); if (r.ok) toast('Backup saved.'); });
$('#btn-import-json').addEventListener('click', async () => {
  if (!confirm('Importing replaces all current data with the backup. Continue?')) return;
  const r = await window.api.importJson();
  if (r.ok) { data = normalize(r.data); historyAnchor = localDateStr(new Date()); loadSettingsInputs(); renderAll(); toast('Backup imported.'); }
  else if (r.error) toast('Import failed: ' + r.error);
});

function fmtBackupStatus(info) {
  if (!info) return '';
  const last = info.lastBackup ? new Date(info.lastBackup).toLocaleString() : 'not yet this session';
  return `Last backup: ${last} · ${info.count} snapshot${info.count === 1 ? '' : 's'} kept · Folder: ${info.dir}`;
}
async function refreshBackupStatus() {
  try { $('#backup-status').textContent = fmtBackupStatus(await window.api.backupInfo()); } catch (_) {}
}
$('#btn-backup-now').addEventListener('click', async () => {
  const r = await window.api.backupNow();
  $('#backup-status').textContent = fmtBackupStatus(r.info);
  toast(r.ok ? 'Backup saved.' : 'Backup failed (see folder permissions).');
});
$('#btn-open-backups').addEventListener('click', () => window.api.openBackups());

function refreshLaunchAtLogin() {
  $('#launch-at-login').checked = !!data.settings.launchAtLogin;
}
$('#launch-at-login').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  data.settings.launchAtLogin = enabled;
  save();
  try { await window.api.setLoginItem(enabled); } catch (_) {}
  toast(enabled ? 'Will launch at login.' : 'Auto-start disabled.');
});

function loadSettingsInputs() {
  const sh = data.settings.showHideHotkey || '';
  $('#hotkey-show').dataset.accel = sh;
  $('#hotkey-show').value = friendlyAccel(sh);
  $('#currency-symbol').value = data.settings.currencySymbol || '€';
  $('#hours-per-day').value = data.settings.hoursPerDay != null ? data.settings.hoursPerDay : 8;
  $('#round-increment').value = String(data.settings.roundIncrementMin || 0);
  $('#round-up').checked = !!data.settings.roundUp;
  $('#idle-threshold').value = data.settings.idleThresholdMin != null ? data.settings.idleThresholdMin : 10;
  $('#launch-at-login').checked = !!data.settings.launchAtLogin;
}

function bindSetting(sel, key, transform) {
  $(sel).addEventListener('change', (e) => {
    const v = transform ? transform(e.target) : e.target.value;
    data.settings[key] = v;
    save(); renderAll();
  });
}
bindSetting('#currency-symbol', 'currencySymbol', (el) => el.value.trim() || '€');
bindSetting('#hours-per-day', 'hoursPerDay', (el) => Math.max(1, Number(el.value) || 8));
bindSetting('#round-increment', 'roundIncrementMin', (el) => Number(el.value));
bindSetting('#round-up', 'roundUp', (el) => el.checked);
bindSetting('#idle-threshold', 'idleThresholdMin', (el) => Math.max(0, Number(el.value) || 0));

// Convert a keydown event to an Electron accelerator string (or null if incomplete).
function eventToAccelerator(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null; // a modifier alone
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let key = e.key;
  if (key === ' ' || e.code === 'Space') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else {
    const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
    key = map[key] || key; // F1–F12, Enter, Tab, etc. pass through
  }
  // Need a modifier unless it's a function key, otherwise it'd hijack a normal key everywhere.
  if (parts.length === 0 && !/^F\d+$/.test(key)) return null;
  parts.push(key);
  return parts.join('+');
}
function friendlyAccel(accel) { return (accel || '').replace('CommandOrControl', 'Ctrl'); }

function friendlyAccel(accel) { return (accel || '').replace('CommandOrControl', 'Ctrl'); }

// Apply a hotkey immediately: store it, persist, and (re)register globally so there's
// never a mismatch between what the box shows and what's actually active.
async function applyHotkey(accel) {
  data.settings.showHideHotkey = accel;
  data.settings.globalHotkey = ''; // one hotkey only; start/pause stays in-app (Space)
  $('#hotkey-show').dataset.accel = accel;
  $('#hotkey-show').value = friendlyAccel(accel);
  $('#hk-global').textContent = friendlyAccel(accel) || 'none';
  save();
  const res = await window.api.setHotkeys(data.settings);
  if (!accel) $('#hotkey-status').textContent = 'No global hotkey set.';
  else if (res.showHide) $('#hotkey-status').textContent = `Active: ${friendlyAccel(accel)} opens/hides the tracker from any app.`;
  else $('#hotkey-status').textContent = `${friendlyAccel(accel)} is already used by another app — try a different combination.`;
}

// Record a key combination directly into the box; it applies as soon as you press it.
$('#hotkey-show').addEventListener('keydown', (e) => {
  e.preventDefault();
  const accel = eventToAccelerator(e);
  if (accel) applyHotkey(accel);
});
$('#hotkey-clear').addEventListener('click', () => applyHotkey(''));
$('#btn-save-hotkeys').addEventListener('click', () => {
  applyHotkey($('#hotkey-show').dataset.accel || '');
  toast('Hotkey saved.');
});

// ---------------------------------------------------------------------------
// Idle detection
// ---------------------------------------------------------------------------
let prevIdleSec = 0;
let idlePromptOpen = false;
async function checkIdle() {
  const threshold = Number(data.settings.idleThresholdMin || 0);
  if (!threshold || !data.timer.running || idlePromptOpen) { return; }
  let idle = 0;
  try { idle = await window.api.idleTime(); } catch { return; }
  const thr = threshold * 60;
  // User has returned after being idle past the threshold -> offer to discard.
  if (prevIdleSec >= thr && idle < 5) {
    promptIdle(prevIdleSec);
  }
  prevIdleSec = idle;
}
function promptIdle(idleSec) {
  idlePromptOpen = true;
  const mins = Math.round(idleSec / 60);
  $('#idle-text').textContent = `Your PC was idle for about ${mins} minute${mins === 1 ? '' : 's'} while the timer ran. Discard that idle time from the current session?`;
  $('#idle-modal').hidden = false;
  $('#idle-modal')._idleSec = idleSec;
}
$('#idle-keep').addEventListener('click', () => { $('#idle-modal').hidden = true; idlePromptOpen = false; prevIdleSec = 0; });
$('#idle-discard').addEventListener('click', () => {
  const idleSec = $('#idle-modal')._idleSec || 0;
  const t = data.timer;
  // Fold running time into accumulated, subtract idle, keep running.
  t.accumulatedSec = Math.max(0, currentElapsedSec() - idleSec);
  if (t.running) t.lastStartTs = Date.now();
  $('#idle-modal').hidden = true; idlePromptOpen = false; prevIdleSec = 0;
  save(); renderTimer(); toast('Idle time discarded.');
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (in-app)
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const modalOpen = !$('#note-modal').hidden || !$('#session-modal').hidden || !$('#idle-modal').hidden;
  if (modalOpen || typing) return;
  if (e.code === 'Space') { e.preventDefault(); toggleTimer(); }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); stopTimer(); }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    if (data.clients[idx] && !isActiveSession()) {
      data.timer.activeClientId = data.clients[idx].id;
      save(); renderTimer(); switchTab('track');
    }
  }
});

// ---------------------------------------------------------------------------
// Signals from main (global hotkey / tray)
// ---------------------------------------------------------------------------
window.api.onToggle(() => toggleTimer());
window.api.onStop(() => stopTimer());
window.api.onNavigate(() => switchTab('track'));

// ---------------------------------------------------------------------------
// Normalize loaded data (back-fill new fields on older saves)
// ---------------------------------------------------------------------------
function normalize(d) {
  d.clients = (d.clients || []).map((c, i) => ({
    rate: null, dayRate: null, color: COLORS[i % COLORS.length], address: '', details: '', ...c,
  }));
  d.sessions = d.sessions || [];
  d.settings = Object.assign({
    globalHotkey: '', showHideHotkey: 'CommandOrControl+Alt+T',
    currencySymbol: '€', roundIncrementMin: 0, roundUp: false, idleThresholdMin: 10,
    hoursPerDay: 8, launchAtLogin: false,
  }, d.settings || {});
  // One-time hotkey migration: fold the two old hotkeys into one and move the old
  // defaults (Ctrl+Shift+T clashes with Chrome's reopen-tab; Ctrl+Shift+Space also
  // triggered the in-app Space start) onto a clean Ctrl+Alt+T. Runs once so a future
  // deliberate choice is preserved.
  if (!d.settings.hotkeyV3) {
    d.settings.globalHotkey = '';
    const oldDefaults = ['', 'CommandOrControl+Shift+T', 'CommandOrControl+Shift+Space'];
    if (oldDefaults.includes(d.settings.showHideHotkey)) d.settings.showHideHotkey = 'CommandOrControl+Alt+T';
    d.settings.hotkeyV3 = true;
  }
  d.timer = Object.assign({ activeClientId: null, running: false, accumulatedSec: 0, lastStartTs: null, sessionStart: null, lastPersistedTs: null }, d.timer || {});
  if (d.timer.running) {
    // Recover only through the most recent heartbeat; never count the offline gap.
    const cutoff = Number(d.timer.lastPersistedTs || d.timer.lastStartTs || Date.now());
    const started = Number(d.timer.lastStartTs || cutoff);
    d.timer.accumulatedSec = Math.max(0, Number(d.timer.accumulatedSec || 0) + Math.max(0, cutoff - started) / 1000);
    d.timer.running = false;
    d.timer.lastStartTs = null;
    d.timer.lastPersistedTs = cutoff;
    recoveredRunningTimer = true;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  data = normalize(await window.api.loadData());
  save();                                  // persist any settings migration (e.g. old hotkey)
  window.api.setHotkeys(data.settings);    // re-register so the migrated hotkey takes effect now
  loadSettingsInputs();
  resetClientForm();   // renders the colour swatches so a new client has a colour picker
  switchTab('track');
  renderAll();
  refreshBackupStatus();
  refreshLaunchAtLogin();
  // Heartbeat running timers so an abrupt shutdown can recover nearly all elapsed time.
  setInterval(() => { if (data.timer.running) saveNow(); }, 15 * 1000);
  if (recoveredRunningTimer) toast('Previous timer recovered and paused. Review it, then resume or stop.');
})();
