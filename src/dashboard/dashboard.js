import { TimelineDB } from '../shared/db.js';
import { EventType, PROVISIONAL_PREFIX } from '../shared/constants.js';
import { convertConversation } from '../shared/convert.js';
import { loadHistory } from './loader.js';
import { buildRows, selectRows, shortId } from '../timeline/model.js';
import { layoutRow, ROW_HEIGHT } from '../timeline/layout.js';
import {
  VIEWS, windowFor, shiftWindow, changeView, ticks, formatWindow, formatInstant, formatDuration, xFor, tFor, customWindow,
} from '../timeline/scale.js';

const $ = (sel) => document.querySelector(sel);
const LOCALE = undefined; // browser default locale and time zone
const OVERSCAN = 8;

const TYPE_LABEL = {
  [EventType.USER_MESSAGE]: 'You sent a message',
  [EventType.ASSISTANT_RESPONSE_COMPLETED]: 'Response completed',
  [EventType.ASSISTANT_RESPONSE_INTERRUPTED]: 'Response stopped before completion',
  [EventType.ASSISTANT_RESPONSE_FAILED]: 'Response failed',
};
const SOURCE_LABEL = {
  'server-create-time': 'creation time stored by ChatGPT',
  'server-update-time': 'last update of the response stored by ChatGPT (close to completion)',
};
const DAY = 24 * 3600 * 1000;
// Load range -> view to show afterwards.
const RANGE_VIEW = { 1: 'day', 3: 'week', 7: 'week', 30: 'month', 90: 'month', 365: 'month' };

const state = {
  db: null,
  conversations: [],
  events: [],
  rows: [],
  visible: [],
  win: null,
  query: '',
  sort: 'recent',
  activeOnly: true,
  activeFrom: null,
  activeTo: null,
  selection: null, // { kind: 'event'|'interval'|'row', rowId, id }
  loadDays: 7,
  loading: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('timeline-prefs') || '{}');
    if (VIEWS.includes(p.view)) state.win = windowFor(p.view, Date.now());
    if (p.sort) state.sort = p.sort;
    if (typeof p.activeOnly === 'boolean') state.activeOnly = p.activeOnly;
    if (RANGE_VIEW[p.loadDays]) state.loadDays = p.loadDays;
  } catch { /* storage unavailable */ }
  if (!state.win) state.win = windowFor('day', Date.now());
}

function savePrefs() {
  try {
    localStorage.setItem('timeline-prefs', JSON.stringify({ view: state.win.view, sort: state.sort, activeOnly: state.activeOnly, loadDays: state.loadDays }));
  } catch { /* storage unavailable */ }
}

async function reload() {
  const [conversations, events] = await Promise.all([state.db.listConversations(), state.db.listEvents()]);
  state.conversations = conversations;
  state.events = events;
  state.rows = buildRows(conversations, events);
  state.rowById = new Map(state.rows.map((r) => [r.id, r]));
  state.eventById = new Map(events.map((e) => [e.id, e]));
  applyFilters();
  if (state.selection && !findSelection()) state.selection = null;
  renderDetails();
  if ($('#dataDialog').open) renderDataDialog();
}

function applyFilters() {
  state.visible = selectRows(state.rows, {
    query: state.query,
    sort: state.sort,
    window: state.win,
    onlyActiveInWindow: state.activeOnly,
    activeFrom: state.activeFrom,
    activeTo: state.activeTo,
  });
  render();
}

// ---- rendering -----------------------------------------------------------

function trackWidth() {
  const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-w')) || 280;
  return Math.max(100, $('#viewport').clientWidth - labelW);
}

function render() {
  const win = state.win;
  for (const b of document.querySelectorAll('.seg')) b.setAttribute('aria-pressed', String(b.dataset.view === win.view));
  $('#range').textContent = formatWindow(win, LOCALE);
  $('#rowCount').textContent = `${state.visible.length} of ${state.rows.length} conversations`;
  $('.filter').classList.toggle('active', state.activeFrom != null || state.activeTo != null);
  renderAxis();
  $('#rows').style.height = `${state.visible.length * ROW_HEIGHT}px`;
  renderRows();
  renderEmpty();
}

function renderAxis() {
  const width = trackWidth();
  const viewportH = $('#viewport').clientHeight;
  const all = ticks(state.win, LOCALE);
  const axis = [];
  const grid = [];
  let lastLabelX = -Infinity;
  for (const tk of all) {
    const x = xFor(tk.t, state.win.start, state.win.end, width);
    grid.push(`<div class="gl${tk.major ? ' major' : ''}" style="left:${x.toFixed(1)}px;height:${viewportH}px"></div>`);
    if (tk.label && x - lastLabelX >= 54 && x < width - 20) {
      axis.push(`<span class="tick${x < 20 ? ' first' : ''}" style="left:${x.toFixed(1)}px">${esc(tk.label)}</span>`);
      lastLabelX = x;
    }
  }
  const now = Date.now();
  if (now >= state.win.start && now < state.win.end) {
    grid.push(`<div class="now" title="Now" style="left:${xFor(now, state.win.start, state.win.end, width).toFixed(1)}px;height:${viewportH}px"></div>`);
  }
  $('#axis').innerHTML = axis.join('');
  $('#grid').innerHTML = grid.join('');
}

function renderRows() {
  const viewport = $('#viewport');
  const width = trackWidth();
  const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(state.visible.length, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) + OVERSCAN);
  const sel = state.selection;
  const html = [];
  for (let i = first; i < last; i++) {
    const row = state.visible[i];
    const items = layoutRow(row, state.win, width);
    const title = esc(row.title);
    const link = row.conversation.url
      ? `<a href="${esc(row.conversation.url)}" target="_blank" rel="noopener noreferrer" title="Open in ChatGPT: ${title}">${title}</a>`
      : `<span class="title" title="${title}">${title}</span>`;
    const parts = items.map((it) => {
      const kind = it.kind === 'marker' ? 'event' : it.kind;
      const selected = sel && sel.rowId === row.id && sel.id === it.id && sel.kind === kind;
      const tip = esc(tooltip(row, it));
      if (it.kind === 'interval' || it.kind === 'session') {
        return `<div class="${it.cls}${selected ? ' sel' : ''}" data-kind="${kind}" data-id="${esc(it.id)}" style="left:${it.x.toFixed(1)}px;width:${it.w.toFixed(1)}px;top:${it.y.toFixed(1)}px;height:${it.h}px" title="${tip}"></div>`;
      }
      return `<div class="${it.cls}${selected ? ' sel' : ''}" data-kind="event" data-id="${esc(it.id)}" role="button" tabindex="0" aria-label="${tip}" style="left:${it.x.toFixed(1)}px;top:${(it.y - 4.5).toFixed(1)}px" title="${tip}"></div>`;
    });
    html.push(
      `<div class="row${sel && sel.rowId === row.id ? ' selected' : ''}" data-row="${esc(row.id)}" style="top:${i * ROW_HEIGHT}px">` +
        `<div class="label" data-kind="row">${link}<span class="id" title="Conversation id: ${esc(row.id)}">${esc(shortId(row.id))}</span><span class="count" title="Events">${row.events.length}</span></div>` +
        `<div class="track">${parts.join('')}</div></div>`,
    );
  }
  $('#rows').innerHTML = html.join('');
}

function sessionText(sn) {
  return `${sn.messages} message${sn.messages === 1 ? '' : 's'} · ${time(sn.start)} → ${time(sn.end)} (${formatDuration(sn.end - sn.start)})`;
}

function tooltip(row, it) {
  if (it.kind === 'session') {
    const sn = row.sessions.find((x) => x.id === it.id);
    return sn ? `Session: ${sessionText(sn)}. Click for details, double-click to zoom in.` : '';
  }
  if (it.kind === 'interval') {
    const iv = row.intervals.find((x) => x.id === it.id);
    if (!iv) return '';
    return `${statusText(iv)} · ${time(iv.start)} → ${time(iv.end)} (${formatDuration(iv.end - iv.start)})`;
  }
  const e = state.eventById.get(it.id);
  return e ? `${TYPE_LABEL[e.type]} · ${time(e.timestamp)}` : '';
}

function time(t) {
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t);
}

function statusText(iv) {
  const s = { completed: 'Completed', interrupted: 'Stopped', failed: 'Failed' }[iv.status];
  return iv.regenerated ? `${s} (regenerated attempt ${iv.attempt})` : s;
}

function renderEmpty() {
  const el = $('#empty');
  if (state.visible.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!state.rows.length) {
    el.innerHTML = `<h2>No activity loaded yet</h2>
      <p>Choose a period above and click <b>Load from ChatGPT</b>. Your conversations from that period are read from chatgpt.com (you must be signed in there), one row per conversation.</p>
      <p class="muted">Only titles, message ids and timestamps are stored, locally in this browser. No message text.</p>`;
    return;
  }
  const latest = state.rows.reduce((m, r) => Math.max(m, r.lastActivityAt ?? -Infinity), -Infinity);
  const filtered = state.query || state.activeFrom != null || state.activeTo != null;
  el.innerHTML = `<h2>No activity ${state.activeOnly ? 'in this period' : 'matches'}</h2>
    <p>${esc(formatWindow(state.win, LOCALE))}${filtered ? ' · search or date filters are active' : ''}</p>
    <div class="actions">
      ${Number.isFinite(latest) ? '<button data-action="latest">Jump to latest activity</button>' : ''}
      ${state.activeOnly ? '<button data-action="showAll">Show all conversations</button>' : ''}
      ${filtered ? '<button data-action="clearFilters">Clear filters</button>' : ''}
    </div>`;
}

// ---- details -------------------------------------------------------------

function findSelection() {
  const s = state.selection;
  if (!s) return null;
  const row = state.rowById?.get(s.rowId);
  if (!row) return null;
  if (s.kind === 'row') return { row };
  if (s.kind === 'interval') {
    const iv = row.intervals.find((x) => x.id === s.id);
    return iv ? { row, iv } : null;
  }
  if (s.kind === 'session') {
    const session = row.sessions.find((x) => x.id === s.id);
    return session ? { row, session } : null;
  }
  const event = state.eventById.get(s.id);
  return event ? { row, event } : null;
}

function dl(pairs) {
  return `<dl>${pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function exact(t) {
  return `${esc(formatInstant(t, { locale: LOCALE }))}<br><code>${esc(new Date(t).toISOString())}</code>`;
}

function convHeader(row) {
  const link = row.conversation.url
    ? `<a href="${esc(row.conversation.url)}" target="_blank" rel="noopener noreferrer">Open conversation in ChatGPT ↗</a>`
    : '<span class="muted">No conversation URL</span>';
  return `<h2>${esc(row.title)}</h2><p>${link}</p>`;
}

function renderDetails() {
  const el = $('#details');
  const found = findSelection();
  if (!found) {
    el.innerHTML = '<p class="hint">Click a marker, an interval or a conversation title to see details.</p>';
    return;
  }
  const { row } = found;
  if (found.session) {
    const sn = found.session;
    el.innerHTML = `${convHeader(row)}
      <p><span class="badge completed">Session</span></p>
      ${dl([
        ['From', exact(sn.start)],
        ['To', exact(sn.end)],
        ['Length', esc(formatDuration(sn.end - sn.start))],
        ['Messages sent', String(sn.messages)],
        ['Responses', `${sn.responses} (${sn.completed} completed)`],
        ['Waiting for responses', esc(formatDuration(sn.waitingMs)) || '—'],
      ])}
      <p class="note">A session groups messages that were less than 15 minutes apart. Its band covers the whole span; the darker bars inside are the actual message → response intervals.</p>
      <div class="actions"><button data-action="zoomSession">Zoom in to this session</button></div>`;
    return;
  }
  if (found.iv) {
    const iv = found.iv;
    const r = iv.response;
    el.innerHTML = `${convHeader(row)}
      <p><span class="badge ${iv.status}">${esc(statusText(iv))}</span></p>
      ${dl([
        ['Message sent', exact(iv.request.timestamp)],
        iv.regenerated ? ['Regeneration observed', exact(iv.start)] : null,
        [TYPE_LABEL[r.type], exact(r.timestamp)],
        ['Duration', esc(formatDuration(iv.end - iv.start))],
        ['Association', r.association === 'server-tree' ? 'Reply to this message in ChatGPT\'s conversation tree' : 'Uncertain'],
        ['Message id', `<code>${esc(iv.request.messageId)}</code>`],
        ['Response id', r.messageId ? `<code>${esc(r.messageId)}</code>` : '—'],
      ].filter(Boolean))}
      ${iv.status !== 'completed' ? '<p class="note">The response did not complete normally, so this is not a completed message→response interval.</p>' : ''}`;
    return;
  }
  if (found.event) {
    const e = found.event;
    const pairs = [
      ['Type', esc(TYPE_LABEL[e.type])],
      ['Time', exact(e.timestamp)],
      ['Timestamp source', esc(SOURCE_LABEL[e.timestampSource] || e.timestampSource || '')],
      ['Event id', `<code>${esc(e.id)}</code>`],
      ['Message id', e.messageId ? `<code>${esc(e.messageId)}</code>` : '—'],
    ];
    let note = '';
    if (e.type === EventType.USER_MESSAGE) {
      const ivs = row.intervals.filter((iv) => iv.request.id === e.id);
      for (const iv of ivs) {
        pairs.push([`Response${ivs.length > 1 ? ` #${iv.attempt}` : ''}`, `${esc(statusText(iv))} at ${esc(time(iv.response.timestamp))} (${esc(formatDuration(iv.response.timestamp - e.timestamp))} after sending)`]);
      }
      if (e.revisionOf) pairs.push(['Edited version of', `<code>${esc(e.revisionOf)}</code>`]);
      if (!ivs.length) note = 'ChatGPT has no finished response to this message (it was still generating when loaded, or it failed without a response).';
    } else {
      const req = e.requestMessageId ? [...state.events].find((x) => x.messageId === e.requestMessageId && x.type === EventType.USER_MESSAGE) : null;
      if (req) pairs.push(['In response to message sent', exact(req.timestamp)]);
      if (e.startedAt) pairs.push(['Generation first observed', esc(time(e.startedAt))]);
      if (e.responseKind === 'regenerated') pairs.push(['Kind', 'Regenerated response']);
      if (!req) {
        note = e.requestMessageId
          ? 'The message that requested this response is not part of the loaded data, so no interval is drawn.'
          : 'This response could not be associated with a user message.';
      }
    }
    el.innerHTML = `${convHeader(row)}${dl(pairs)}${note ? `<p class="note">${esc(note)}</p>` : ''}`;
    return;
  }
  // Conversation selected.
  const c = row.conversation;
  const completed = row.intervals.filter((iv) => iv.status === 'completed');
  el.innerHTML = `${convHeader(row)}
    ${dl([
      ['Conversation id', `<code>${esc(row.id)}</code>`],
      ['Created', c.firstObservedAt ? esc(formatInstant(c.firstObservedAt, { locale: LOCALE })) : '—'],
      ['Last activity', row.lastActivityAt ? esc(formatInstant(row.lastActivityAt, { locale: LOCALE })) : '—'],
      ['Messages sent', String(row.events.filter((e) => e.type === EventType.USER_MESSAGE).length)],
      ['Completed responses', String(completed.length)],
      ['Awaiting / unknown outcome', String(row.pending.length)],
    ])}
    <div class="actions">
      <button data-action="focusLatest">Show latest activity</button>
      <button data-action="raw">Show stored data</button>
      <button class="danger" data-action="deleteConv">Delete this conversation's activity</button>
    </div>
    <table class="events">${row.events.slice(-50).reverse().map((e) => `<tr><td>${esc(time(e.timestamp))}</td><td>${esc(TYPE_LABEL[e.type])}</td></tr>`).join('')}</table>
    ${row.events.length > 50 ? '<p class="muted">Showing the latest 50 events.</p>' : ''}
    <pre class="raw" hidden></pre>`;
}

// ---- data management ----------------------------------------------------

async function deleteConversation(id) {
  const row = state.rowById.get(id);
  const ok = confirm(`Delete the loaded activity for "${row ? row.title : id}"?\n\nThis removes ${row ? row.events.length : 'its'} events from this browser. It does not affect the conversation in ChatGPT. This cannot be undone.`);
  if (!ok) return;
  await state.db.deleteConversation(id);
  if (state.selection?.rowId === id) state.selection = null;
  await reload();
}

async function exportJson() {
  const data = await state.db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chatgpt-activity-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function clearAll() {
  const stats = await state.db.stats();
  if (!confirm(`Delete ALL loaded activity?\n\n${stats.conversations} conversations and ${stats.events} events will be removed from this browser. Consider exporting first. This cannot be undone.`)) return;
  if (!confirm('Are you sure? This permanently deletes the activity history.')) return;
  await state.db.clearAll();
  state.selection = null;
  await reload();
}

async function renderDataDialog() {
  const stats = await state.db.stats();
  $('#stats').innerHTML = `<div><b>${stats.conversations}</b>conversations</div><div><b>${stats.events}</b>events</div><div><b>${stats.lastEventAt ? esc(time(stats.lastEventAt)) : '—'}</b>last event</div><div><b>v${state.db.db.version}</b>schema</div>`;
  const last = await state.db.getSetting('lastLoad', null);
  $('#lastLoad').textContent = last
    ? `Last load: ${time(last.at)}, period from ${time(last.since)}. ${last.stats.listed} conversations listed, ${last.stats.fetched} read, ${last.stats.unchanged} unchanged` +
      `${last.stats.missing + last.stats.failed ? `, ${last.stats.missing + last.stats.failed} could not be read` : ''}. ` +
      `${last.totals.responses} responses read; ${last.totals.withUpdateTime} had a stored completion (update) time, the rest use the final message's creation time.`
    : 'Nothing loaded yet.';
  const rows = [...state.rows].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  $('#convTable tbody').innerHTML = rows.map((r) => `<tr>
      <td>${esc(r.title)}</td><td><code>${esc(shortId(r.id))}</code></td><td>${r.events.length}</td>
      <td>${r.lastActivityAt ? esc(time(r.lastActivityAt)) : '—'}</td>
      <td><button data-action="inspect" data-id="${esc(r.id)}">Inspect</button> <button class="danger" data-action="deleteConv" data-id="${esc(r.id)}">Delete</button></td></tr>`).join('');
}

// ---- interaction --------------------------------------------------------

function setWindow(win) {
  state.win = win;
  savePrefs();
  applyFilters();
}

// Instant to keep in view when changing zoom: now if visible, else the middle.
function zoomFocus() {
  const now = Date.now();
  return now >= state.win.start && now < state.win.end ? now : (state.win.start + state.win.end) / 2;
}

// Fit [a, b] in view: a fitted window for short ranges, otherwise the
// smallest calendar view that contains it.
function zoomTo(a, b) {
  if (b - a < 50 * 60e3) {
    const pad = Math.max(30e3, (b - a) * 0.08);
    return setWindow(customWindow(a - pad, b + pad));
  }
  for (const view of VIEWS) {
    const w = windowFor(view, (a + b) / 2);
    if (w.start <= a && w.end >= b) return setWindow(w);
  }
  setWindow(windowFor('month', (a + b) / 2));
}

function focusTime(t) {
  setWindow(windowFor(state.win.view, t));
}

// Updates selection classes in place (re-rendering would replace the clicked
// element and break double-click).
function select(sel) {
  state.selection = sel;
  for (const el of document.querySelectorAll('#rows .sel')) el.classList.remove('sel');
  for (const el of document.querySelectorAll('#rows .row.selected')) el.classList.remove('selected');
  if (sel) {
    const rowEl = [...document.querySelectorAll('#rows .row')].find((r) => r.dataset.row === sel.rowId);
    if (rowEl) {
      rowEl.classList.add('selected');
      if (sel.kind !== 'row') {
        const item = [...rowEl.querySelectorAll(`[data-kind="${sel.kind}"]`)].find((el) => el.dataset.id === sel.id);
        item?.classList.add('sel');
      }
    }
  }
  renderDetails();
}

function dateInputToMs(value, endOfDay) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d + (endOfDay ? 1 : 0)).getTime();
}

function bind() {
  for (const b of document.querySelectorAll('.seg')) b.addEventListener('click', () => setWindow(changeView(state.win, b.dataset.view, zoomFocus())));
  $('#prev').addEventListener('click', () => setWindow(shiftWindow(state.win, -1)));
  $('#next').addEventListener('click', () => setWindow(shiftWindow(state.win, 1)));
  $('#today').addEventListener('click', () => focusTime(Date.now()));
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; $('#viewport').scrollTop = 0; applyFilters(); });
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; savePrefs(); applyFilters(); });
  $('#activeOnly').checked = state.activeOnly;
  $('#activeOnly').addEventListener('change', (e) => { state.activeOnly = e.target.checked; savePrefs(); applyFilters(); });
  const onDates = () => {
    state.activeFrom = dateInputToMs($('#activeFrom').value, false);
    state.activeTo = dateInputToMs($('#activeTo').value, true);
    applyFilters();
  };
  $('#activeFrom').addEventListener('change', onDates);
  $('#activeTo').addEventListener('change', onDates);
  $('#clearDates').addEventListener('click', () => { $('#activeFrom').value = ''; $('#activeTo').value = ''; onDates(); });

  let scrollFrame = 0;
  $('#viewport').addEventListener('scroll', () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; renderRows(); });
  });
  new ResizeObserver(() => render()).observe($('#viewport'));

  $('#rows').addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // conversation link opens ChatGPT
    const rowEl = e.target.closest('.row');
    if (!rowEl) return;
    const rowId = rowEl.dataset.row;
    const item = e.target.closest('[data-kind="event"], [data-kind="interval"], [data-kind="session"]');
    if (item) select({ kind: item.dataset.kind, rowId, id: item.dataset.id });
    else select({ kind: 'row', rowId, id: rowId });
  });
  // Double-click on a track zooms into the next finer view at that time.
  $('#rows').addEventListener('dblclick', (e) => {
    const sessionEl = e.target.closest('[data-kind="session"]');
    if (sessionEl) {
      const sn = state.rowById.get(sessionEl.closest('.row').dataset.row)?.sessions.find((x) => x.id === sessionEl.dataset.id);
      if (sn) return zoomTo(sn.start, sn.end);
    }
    const track = e.target.closest('.track');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const t = tFor(e.clientX - rect.left, state.win.start, state.win.end, rect.width);
    const finer = VIEWS[VIEWS.indexOf(state.win.view) - 1];
    if (finer) setWindow(changeView(state.win, finer, t));
    else {
      // Hour or fitted view: zoom to a third of the current span around t.
      const span = Math.max(60e3, (state.win.end - state.win.start) / 3);
      setWindow(customWindow(t - span / 2, t + span / 2));
    }
  });
  $('#rows').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.kind === 'event') {
      e.preventDefault();
      e.target.click();
    }
  });

  $('#empty').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'latest') {
      const latest = state.rows.reduce((m, r) => Math.max(m, r.lastActivityAt ?? -Infinity), -Infinity);
      focusTime(latest);
    } else if (action === 'showAll') {
      state.activeOnly = false;
      $('#activeOnly').checked = false;
      savePrefs();
      applyFilters();
    } else if (action === 'clearFilters') {
      state.query = '';
      $('#search').value = '';
      $('#clearDates').click();
    }
  });

  $('#details').addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    const found = findSelection();
    if (!action || !found) return;
    if (action === 'deleteConv') await deleteConversation(found.row.id);
    else if (action === 'focusLatest' && found.row.lastActivityAt) focusTime(found.row.lastActivityAt);
    else if (action === 'zoomSession' && found.session) zoomTo(found.session.start, found.session.end);
    else if (action === 'raw') {
      const pre = $('#details pre.raw');
      pre.textContent = JSON.stringify({ conversation: found.row.conversation, events: found.row.events }, null, 2);
      pre.hidden = !pre.hidden;
    }
  });

  $('#dataBtn').addEventListener('click', async () => {
    await renderDataDialog();
    $('#dataDialog').showModal();
  });
  $('#exportBtn').addEventListener('click', exportJson);
  $('#clearBtn').addEventListener('click', clearAll);
  $('#convTable').addEventListener('click', async (e) => {
    const { action, id } = e.target.dataset;
    if (action === 'deleteConv') await deleteConversation(id);
    else if (action === 'inspect') {
      $('#dataDialog').close();
      select({ kind: 'row', rowId: id, id });
      const idx = state.visible.findIndex((r) => r.id === id);
      if (idx >= 0) $('#viewport').scrollTop = idx * ROW_HEIGHT;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') setWindow(shiftWindow(state.win, -1));
    else if (e.key === 'ArrowRight') setWindow(shiftWindow(state.win, 1));
    else if (['1', '2', '3', '4'].includes(e.key)) setWindow(changeView(state.win, VIEWS[Number(e.key) - 1], zoomFocus()));
    else if (e.key === 'Escape') select(null);
  });

  $('#loadRange').value = String(state.loadDays);
  $('#loadRange').addEventListener('change', (e) => { state.loadDays = Number(e.target.value); savePrefs(); });
  $('#loadBtn').addEventListener('click', () => loadFromChatGPT());
  $('#cancelBtn').addEventListener('click', () => state.loading?.abort());
  // Keep the "now" line current.
  setInterval(() => renderAxis(), 30000);
}

// ---- loading from ChatGPT ------------------------------------------------

function setLoadStatus(text, kind = '') {
  const el = $('#loadStatus');
  el.textContent = text;
  el.className = `load-status ${kind}`;
}

async function loadFromChatGPT() {
  if (state.loading) return;
  const ctrl = new AbortController();
  state.loading = ctrl;
  $('#loadBtn').disabled = true;
  $('#cancelBtn').hidden = false;
  const since = Date.now() - state.loadDays * DAY;
  const totals = { conversations: 0, responses: 0, withUpdateTime: 0, inProgress: 0 };
  let lastRefresh = 0;
  setLoadStatus('Connecting to chatgpt.com…');
  try {
    const known = await state.db.knownUpdateTimes();
    const stats = await loadHistory({
      since,
      known,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.phase === 'connect') setLoadStatus(p.message);
        else if (p.phase === 'list') setLoadStatus(`Listing conversations… ${p.listed}`);
        else if (p.phase === 'details') setLoadStatus(`Reading conversations ${p.done}/${p.total}${p.unchanged ? ` (${p.unchanged} unchanged)` : ''}…`);
      },
      onConversation: async (conv) => {
        const { conversation, events, stats: s } = convertConversation(conv);
        await state.db.replaceConversation(conversation, events);
        totals.conversations++;
        totals.responses += s.responses;
        totals.withUpdateTime += s.withUpdateTime;
        totals.inProgress += s.inProgress;
        if (Date.now() - lastRefresh > 1000) {
          lastRefresh = Date.now();
          await reload();
        }
      },
    });
    await state.db.setSetting('lastLoad', { at: Date.now(), since, days: state.loadDays, stats, totals });
    await reload();
    setWindow(windowFor(RANGE_VIEW[state.loadDays] || 'week', Date.now()));
    setLoadStatus(`Loaded ${stats.listed} conversations from the last ${state.loadDays === 1 ? '24 hours' : `${state.loadDays} days`} (${stats.fetched} read, ${stats.unchanged} unchanged${stats.missing + stats.failed ? `, ${stats.missing + stats.failed} could not be read` : ''}).`, 'ok');
  } catch (err) {
    setLoadStatus(err.code === 'aborted' ? 'Cancelled. Conversations read so far are kept.' : err.message || String(err), err.code === 'aborted' ? '' : 'error');
    await reload();
  } finally {
    state.loading = null;
    $('#loadBtn').disabled = false;
    $('#cancelBtn').hidden = true;
  }
}

async function init() {
  loadPrefs();
  state.db = await TimelineDB.open();
  bind();
  await reload();
  // Expose for debugging and end-to-end tests.
  window.__timeline = { state, reload, loadFromChatGPT, PROVISIONAL_PREFIX };
}

init().catch((err) => {
  console.error(err);
  $('#empty').hidden = false;
  $('#empty').innerHTML = `<h2>Could not open the activity database</h2><p>${esc(err?.message || err)}</p>`;
});
