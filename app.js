/**
 * Study Timer Log - app.js
 * One file that runs the whole site: the "log a session" form (with a live
 * stopwatch) and the dashboard (stats, charts, recent sessions).
 *
 * This page talks DIRECTLY to a Google Apps Script web app - there is no
 * Node server anymore. Follow these steps once:
 *   1. Make a Google Sheet with header row: Timestamp, Subject, Minutes, Note, Nickname
 *   2. Extensions > Apps Script, paste in code.gs, save.
 *   3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *   4. Copy the web app URL and paste it below as APPS_SCRIPT_URL.
 *   5. Every time you edit code.gs, redeploy with "New version" (Deploy > Manage deployments).
 */
'use strict';

// ===================== 1) PASTE YOUR WEB APP URL HERE =====================
const APPS_SCRIPT_URL = ''; // e.g. 'https://script.google.com/macros/s/AKfycb.../exec'
// ============================================================================

const $ = id => document.getElementById(id);
const MAX_MINUTES = 720;
const COLORS = ['#ffb3c6', '#a9d6ff', '#ffe58f', '#a8ecc4', '#cdb8ff', '#ffc9a3', '#9fe6e0', '#f5b8f0'];
const NOTE_COLORS = ['#fff2b3', '#ffd6e0', '#cfe8ff', '#d3f5df', '#e5d9ff', '#ffdcc2'];
const PAGE_SIZE = 8;

/* ============================================================
   Talking to the Google Apps Script web app
   ============================================================ */

/** GET all sessions from the Sheet. Throws a friendly error on failure. */
async function fetchSessions() {
  if (!APPS_SCRIPT_URL) throw new Error('not configured');
  const res = await fetch(APPS_SCRIPT_URL, { method: 'GET' });
  const data = await res.json();
  if (!Array.isArray(data.sessions)) throw new Error(data.error || 'Unexpected answer from Apps Script');
  return data.sessions;
}

/** POST one session to the Sheet. Uses text/plain so the browser skips a CORS preflight. */
async function postSession(session) {
  if (!APPS_SCRIPT_URL) throw new Error('not configured');
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(session),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Apps Script refused the session');
  return data;
}

/* ============================================================
   Small shared helpers
   ============================================================ */

/** Creates an element with optional class and text (textContent = safe, no HTML injection). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 135 -> "2h 15m", 45 -> "45m" */
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "math" and "Math" count as one subject. */
function subjectKey(name) { return name.trim().toLowerCase(); }

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function dayKey(date) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }

/* ============================================================
   Top-level view switcher (Log page vs Dashboard page, one HTML file)
   ============================================================ */

function selectView(name) {
  $('nav-log').setAttribute('aria-selected', name === 'log');
  $('nav-dashboard').setAttribute('aria-selected', name === 'dashboard');
  $('view-log').classList.toggle('active', name === 'log');
  $('view-dashboard').classList.toggle('active', name === 'dashboard');
  if (name === 'dashboard') loadDashboard(dash.firstLoad);
  else loadTodaySummary();
}

$('nav-log').addEventListener('click', () => selectView('log'));
$('nav-dashboard').addEventListener('click', () => selectView('dashboard'));

/* ============================================================
   LOG PAGE: stopwatch, form validation, saving
   ============================================================ */

// We never count setInterval ticks. We store WHEN the timer started and how
// much time was collected before the last pause, so it stays correct even
// if the browser tab is in the background.
const timer = { running: false, startedAt: 0, accumulatedMs: 0, recordedMinutes: null };
let activeTab = 'timer';

function elapsedMs() {
  return timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0);
}

function renderTimer() {
  const totalSeconds = Math.floor(elapsedMs() / 1000);
  $('digits').textContent = `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
  const stopped = timer.recordedMinutes !== null;
  $('btn-start').disabled = timer.running;
  $('btn-pause').disabled = !timer.running;
  $('btn-stop').disabled = stopped || elapsedMs() === 0;
}

function startTimer() {
  if (timer.recordedMinutes !== null) resetTimer();   // starting after Stop = fresh timer
  timer.running = true;
  timer.startedAt = Date.now();
  renderTimer();
}

function pauseTimer() {
  timer.accumulatedMs = elapsedMs();
  timer.running = false;
  renderTimer();
}

/** Stop: freeze the time and convert it to whole minutes (rounded, at least 1). */
function stopTimer() {
  timer.accumulatedMs = elapsedMs();
  timer.running = false;
  timer.recordedMinutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(timer.accumulatedMs / 60000)));
  $('recorded').textContent = `Recorded: ${timer.recordedMinutes} min. Press Save when you're ready!`;
  renderTimer();
}

function resetTimer() {
  Object.assign(timer, { running: false, startedAt: 0, accumulatedMs: 0, recordedMinutes: null });
  $('recorded').textContent = '';
  renderTimer();
}

setInterval(() => { if (timer.running) renderTimer(); }, 250);   // only redraws; time comes from timestamps
window.addEventListener('beforeunload', e => {                   // warn before losing a running timer
  if (timer.running) { e.preventDefault(); e.returnValue = ''; }
});

function selectTab(name) {
  activeTab = name;
  $('tab-timer').setAttribute('aria-selected', name === 'timer');
  $('tab-manual').setAttribute('aria-selected', name === 'manual');
  $('panel-timer').classList.toggle('hidden', name !== 'timer');
  $('panel-manual').classList.toggle('hidden', name !== 'manual');
}

function showMessage(text, type) {
  const box = $('message');
  box.textContent = text;                       // textContent = safe, never innerHTML
  box.className = `message ${type}`;
}

/** Returns the chosen subject text ('' if missing). */
function getSubject() {
  const value = $('subject').value;
  return (value === 'Other' ? $('custom-subject').value : value).trim().slice(0, 30);
}

/** Returns minutes from the active tab, or an { error }. */
function getMinutes() {
  if (activeTab === 'timer') {
    if (timer.recordedMinutes === null) return { error: 'Start the timer, then press Stop, before saving.' };
    return { minutes: timer.recordedMinutes };
  }
  const raw = $('minutes').value.trim();
  const minutes = Number(raw);
  if (raw === '' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return { error: `Enter a whole number of minutes from 1 to ${MAX_MINUTES}.` };
  }
  return { minutes };
}

async function saveSession(event) {
  event.preventDefault();
  if (!APPS_SCRIPT_URL) return showMessage("Not connected yet - see the setup box above.", 'err');
  const subject = getSubject();
  if (!subject) return showMessage('Please choose a subject first.', 'err');
  const { minutes, error } = getMinutes();
  if (error) return showMessage(error, 'err');

  const nickname = $('nickname').value.trim().slice(0, 20);
  try { localStorage.setItem('studyNickname', nickname); } catch (e) { /* storage may be blocked */ }

  $('btn-save').disabled = true;                // no double-clicks while sending
  $('btn-save').textContent = 'Saving…';
  try {
    await postSession({ subject, minutes, nickname, note: $('note').value.trim().slice(0, 100) });
    showMessage(`Nice one! +${minutes} min of ${subject} 🎉`, 'ok');
    resetForm();
    loadTodaySummary();
  } catch (err) {
    showMessage(`Couldn't save that: ${err.message}. Your entry is still here, so try again.`, 'err');
  } finally {
    $('btn-save').disabled = false;
    $('btn-save').textContent = 'Save session';
  }
}

/** Clears everything except the remembered nickname. */
function resetForm() {
  $('subject').value = '';
  $('custom-subject').value = '';
  $('custom-wrap').classList.add('hidden');
  $('minutes').value = '';
  $('note').value = '';
  $('note-count').textContent = '0/100';
  resetTimer();
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function loadTodaySummary() {
  if (!APPS_SCRIPT_URL) { $('today-total').textContent = '–'; $('today-detail').textContent = 'Connect a Google Sheet first (see the box above).'; return; }
  try {
    const sessions = await fetchSessions();
    const now = new Date();
    const today = sessions.filter(s => isSameLocalDay(new Date(s.timestamp), now));
    const total = today.reduce((sum, s) => sum + s.minutes, 0);
    $('today-total').textContent = `${total} min`;
    $('today-detail').textContent = today.length
      ? `${today.length} session${today.length === 1 ? '' : 's'} logged today`
      : 'Nothing logged yet. Time to start!';
  } catch (err) {
    $('today-total').textContent = '–';
    $('today-detail').textContent = "Couldn't load today's total.";
  }
}

/* ============================================================
   DASHBOARD PAGE: stats, bar charts, recent sessions
   ============================================================ */

const dash = { sessions: [], range: 'all', subject: null, shown: PAGE_SIZE, firstLoad: true, timer: null };

function sessionsInRange() {
  const today = startOfDay(new Date());
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);
  return dash.sessions.filter(s => {
    const when = new Date(s.timestamp);
    if (dash.range === 'today') return dayKey(when) === dayKey(today);
    if (dash.range === 'week') return when >= weekStart;
    return true;
  });
}

/** Adds up minutes per subject (case-insensitive), sorted most to least. */
function totalsBySubject(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = subjectKey(s.subject);
    if (!map.has(key)) map.set(key, { key, name: s.subject.trim(), minutes: 0, count: 0 });
    map.get(key).minutes += s.minutes;
    map.get(key).count += 1;
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

/** Each subject keeps the same colour no matter which range is shown. */
function colorFor(key) {
  const keys = [...new Set(dash.sessions.map(s => subjectKey(s.subject)))].sort();
  return COLORS[keys.indexOf(key) % COLORS.length];
}

/** Days in a row (ending today, or yesterday if nothing yet today) with at least one session. */
function currentStreak() {
  const days = new Set(dash.sessions.map(s => dayKey(new Date(s.timestamp))));
  const cursor = startOfDay(new Date());
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

function renderStats(sessions, totals) {
  const total = sessions.reduce((sum, s) => sum + s.minutes, 0);
  const streak = currentStreak();
  $('stat-total').textContent = formatDuration(total);
  $('stat-count').textContent = sessions.length;
  $('stat-top').textContent = totals.length ? totals[0].name : '–';
  $('stat-streak').textContent = `${streak} day${streak === 1 ? '' : 's'}`;
}

function renderBars(totals, animate) {
  const box = $('bars');
  box.replaceChildren();
  if (!totals.length) {
    box.append(el('p', 'hint', 'Nothing logged in this time range yet. Go log a session and it will show up here! ✏️'));
    return;
  }
  const max = totals[0].minutes;
  const fills = [];
  for (const t of totals) {
    const row = el('div', 'bar-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', dash.subject === t.key);
    if (dash.subject === t.key) row.classList.add('active');
    else if (dash.subject) row.classList.add('dim');

    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill', `${t.minutes} min (${(t.minutes / 60).toFixed(1)} h)`);
    fill.style.background = colorFor(t.key);
    const target = Math.max(4, Math.round((t.minutes / max) * 100));
    fill.style.width = animate ? '0' : `${target}%`;
    fills.push([fill, target]);
    track.append(fill);
    row.append(el('div', 'bar-name', t.name), track);

    const toggle = () => { dash.subject = dash.subject === t.key ? null : t.key; dash.shown = PAGE_SIZE; renderDashboard(false); };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    box.append(row);
  }
  if (animate) requestAnimationFrame(() => requestAnimationFrame(() => {   // grow the bars in
    fills.forEach(([fill, target]) => { fill.style.width = `${target}%`; });
  }));
}

/** Small SVG bar chart: minutes per day for the last 7 days (not affected by the range switch). */
function renderWeekChart() {
  const NS = 'http://www.w3.org/2000/svg';
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = startOfDay(new Date()); d.setDate(d.getDate() - i);
    days.push({ date: d, minutes: 0 });
  }
  for (const s of dash.sessions) {
    const day = days.find(d => dayKey(d.date) === dayKey(new Date(s.timestamp)));
    if (day) day.minutes += s.minutes;
  }
  const max = Math.max(60, ...days.map(d => d.minutes));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 700 230');
  svg.setAttribute('class', 'week-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Minutes studied per day over the last 7 days');
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    svg.append(n); return n;
  };
  add('line', { x1: 20, y1: 180, x2: 680, y2: 180, stroke: '#4a4368', 'stroke-width': 3, 'stroke-linecap': 'round' });
  days.forEach((d, i) => {
    const x = 40 + i * 92, h = Math.round((d.minutes / max) * 140);
    if (h > 0) add('rect', { x, y: 180 - h, width: 60, height: h, rx: 8, fill: COLORS[i % COLORS.length], stroke: '#4a4368', 'stroke-width': 2.5 });
    add('text', { x: x + 30, y: 172 - h, 'text-anchor': 'middle', 'font-size': 18 }, d.minutes ? `${d.minutes}m` : '');
    add('text', { x: x + 30, y: 208, 'text-anchor': 'middle', 'font-size': 20 },
      d.date.toLocaleDateString([], { weekday: 'short' }));
  });
  $('week-chart').replaceChildren(svg);
}

function renderTopStudiers(sessions) {
  const map = new Map();
  for (const s of sessions) {
    if (!s.nickname) continue;
    const key = s.nickname.trim().toLowerCase();
    if (!map.has(key)) map.set(key, { name: s.nickname.trim(), minutes: 0 });
    map.get(key).minutes += s.minutes;
  }
  const ranked = [...map.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5);
  $('top-card').classList.toggle('hidden', ranked.length === 0);   // hide when nobody used a nickname
  const medals = ['🥇', '🥈', '🥉', '⭐', '⭐'];
  $('top-list').replaceChildren(...ranked.map((r, i) => {
    const li = el('li');
    li.append(el('span', '', `${medals[i]} ${r.name}`), el('span', '', formatDuration(r.minutes)));
    return li;
  }));
}

function renderNotes(sessions) {
  const list = dash.subject ? sessions.filter(s => subjectKey(s.subject) === dash.subject) : sessions;
  const newestFirst = [...list].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const visible = newestFirst.slice(0, dash.shown);

  const active = dash.subject && totalsBySubject(sessions).find(t => t.key === dash.subject);
  $('filter-note').textContent = active ? `Showing only ${active.name}. Tap its bar again to show everything.` : '';

  const box = $('notes');
  box.replaceChildren();
  if (!visible.length) box.append(el('p', 'hint', 'No sessions here yet. Your first sticky note is waiting! 🌱'));
  visible.forEach((s, i) => {
    const note = el('article', 'note');
    note.style.background = NOTE_COLORS[i % NOTE_COLORS.length];
    note.style.transform = `rotate(${[-1.5, 1, -0.6, 1.4][i % 4]}deg)`;
    note.append(el('div', 'subj', s.subject), el('div', 'mins', `${s.minutes} min`));
    if (s.note) note.append(el('div', 'text', s.note));
    const when = new Date(s.timestamp).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    note.append(el('div', 'small', `${s.nickname ? `${s.nickname} · ` : ''}${when}`));
    box.append(note);
  });
  $('more').classList.toggle('hidden', newestFirst.length <= dash.shown);
}

/** Redraws everything from dash state. animate=true only on the first load. */
function renderDashboard(animate) {
  const sessions = sessionsInRange();
  const totals = totalsBySubject(sessions);
  if (dash.subject && !totals.some(t => t.key === dash.subject)) dash.subject = null;  // stale filter
  document.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', b.dataset.range === dash.range));
  renderStats(sessions, totals);
  renderBars(totals, animate);
  renderWeekChart();
  renderTopStudiers(sessions);
  renderNotes(sessions);
}

function setStatus(text) {
  const box = $('status');
  box.textContent = text || '';
  box.className = text ? 'message err' : 'message hidden';
}

async function loadDashboard(firstTime) {
  const badge = $('mode-badge');
  if (!APPS_SCRIPT_URL) {
    badge.textContent = 'Setup needed';
    badge.className = 'badge local';
    setStatus('Connect a Google Sheet first - see the setup box above.');
    return;
  }
  if (firstTime) setStatus('Loading your sessions…');
  try {
    dash.sessions = (await fetchSessions()).filter(
      s => s && s.subject && Number.isFinite(s.minutes) && !isNaN(new Date(s.timestamp))
    );
    badge.textContent = 'Connected to Google Sheets';
    badge.className = 'badge';
    setStatus('');
    renderDashboard(firstTime);
    dash.firstLoad = false;
  } catch (err) {
    setStatus(`Couldn't load sessions (${err.message}). Retrying in 30 seconds.`);
  }
}

/* ============================================================
   Wire everything up
   ============================================================ */

$('log-form').addEventListener('submit', saveSession);
$('btn-start').addEventListener('click', startTimer);
$('btn-pause').addEventListener('click', pauseTimer);
$('btn-stop').addEventListener('click', stopTimer);
$('tab-timer').addEventListener('click', () => selectTab('timer'));
$('tab-manual').addEventListener('click', () => selectTab('manual'));
$('subject').addEventListener('change', () => {
  const other = $('subject').value === 'Other';
  $('custom-wrap').classList.toggle('hidden', !other);
  if (other) $('custom-subject').focus();
});
$('note').addEventListener('input', () => { $('note-count').textContent = `${$('note').value.length}/100`; });
document.querySelectorAll('[data-range]').forEach(button => {
  button.addEventListener('click', () => { dash.range = button.dataset.range; dash.shown = PAGE_SIZE; renderDashboard(false); });
});
$('more').addEventListener('click', () => { dash.shown += PAGE_SIZE; renderDashboard(false); });

try { $('nickname').value = localStorage.getItem('studyNickname') || ''; } catch (e) { /* ignore */ }

if (!APPS_SCRIPT_URL) $('setup-banner').classList.remove('hidden');

renderTimer();
loadTodaySummary();
setInterval(() => { if ($('view-dashboard').classList.contains('active')) loadDashboard(false); }, 30000); // auto-refresh
