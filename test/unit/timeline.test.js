import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pairEvents, buildRows, selectRows, rowHasActivityIn, shortId, displayTitle, buildSessions } from '../../src/timeline/model.js';
import { windowFor, shiftWindow, changeView, ticks, xFor, intervalPixels, startOfView, formatInstant, customWindow, formatWindow } from '../../src/timeline/scale.js';
import { layoutRow, laneCenter, ROW_HEIGHT, MARKER_MIN_PX } from '../../src/timeline/layout.js';
import { EventType } from '../../src/shared/constants.js';

const ORIGINAL_TZ = process.env.TZ;
before(() => { process.env.TZ = 'America/New_York'; });
after(() => { process.env.TZ = ORIGINAL_TZ; });

const T0 = Date.UTC(2026, 9, 27, 14, 0, 0); // 2026-10-27 10:00 New York (EDT)
const user = (id, t, conv = 'c1') => ({ id: `user:${id}`, conversationId: conv, type: EventType.USER_MESSAGE, timestamp: t, messageId: id });
const resp = (id, req, t, type = EventType.ASSISTANT_RESPONSE_COMPLETED, extra = {}) => ({
  id: `resp:${id}`, conversationId: 'c1', type, timestamp: t, messageId: id, requestMessageId: req, association: 'dom-adjacent', startedAt: t - 1000, ...extra,
});

describe('pairing events into intervals', () => {
  test('a completed response connects to its user message', () => {
    const { intervals, pending, unpaired, markers } = pairEvents([resp('r1', 'm1', T0 + 9000), user('m1', T0)]);
    assert.equal(intervals.length, 1);
    assert.deepEqual([intervals[0].start, intervals[0].end, intervals[0].status], [T0, T0 + 9000, 'completed']);
    assert.deepEqual(pending, []);
    assert.deepEqual(unpaired, []);
    assert.deepEqual(markers.map((m) => m.type), [EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_COMPLETED]);
  });

  test('out-of-order completions pair by request id, not by recency', () => {
    const events = [user('m1', T0), user('m2', T0 + 1000), resp('r2', 'm2', T0 + 3000), resp('r1', 'm1', T0 + 8000)];
    const { intervals } = pairEvents(events);
    const byReq = Object.fromEntries(intervals.map((iv) => [iv.request.messageId, [iv.start, iv.end]]));
    assert.deepEqual(byReq, { m1: [T0, T0 + 8000], m2: [T0 + 1000, T0 + 3000] });
    // They overlap, so they are placed in different lanes.
    assert.notEqual(intervals[0].lane, intervals[1].lane);
  });

  test('a message without an outcome is pending; no completion is invented', () => {
    const { intervals, pending } = pairEvents([user('m1', T0)]);
    assert.equal(intervals.length, 0);
    assert.deepEqual(pending.map((e) => e.id), ['user:m1']);
  });

  test('interrupted and failed outcomes are intervals with a non-completed status', () => {
    const { intervals } = pairEvents([
      user('m1', T0), resp('r1', 'm1', T0 + 2000, EventType.ASSISTANT_RESPONSE_INTERRUPTED),
      user('m2', T0 + 5000), resp('r2', 'm2', T0 + 6000, EventType.ASSISTANT_RESPONSE_FAILED),
    ]);
    assert.deepEqual(intervals.map((iv) => iv.status), ['interrupted', 'failed']);
  });

  test('a regenerated attempt starts at its own generation and keeps the original intact', () => {
    const { intervals } = pairEvents([
      user('m1', T0),
      resp('r1', 'm1', T0 + 5000),
      resp('r2', 'm1', T0 + 70000, EventType.ASSISTANT_RESPONSE_COMPLETED, { startedAt: T0 + 60000, responseKind: 'regenerated' }),
    ]);
    assert.deepEqual(intervals.map((iv) => [iv.attempt, iv.regenerated, iv.start, iv.end]), [
      [1, false, T0, T0 + 5000],
      [2, true, T0 + 60000, T0 + 70000],
    ]);
  });

  test('responses whose request was not recorded are unpaired (no interval)', () => {
    const { intervals, unpaired } = pairEvents([resp('r1', 'not-recorded', T0), resp('r2', null, T0 + 1, EventType.ASSISTANT_RESPONSE_COMPLETED, { association: 'none' })]);
    assert.equal(intervals.length, 0);
    assert.deepEqual(unpaired.map((e) => e.id), ['resp:r1', 'resp:r2']);
  });
});

describe('time windows and ticks (America/New_York)', () => {
  test('windows align to local boundaries', () => {
    const day = windowFor('day', T0);
    assert.equal(new Date(day.start).toISOString(), '2026-10-27T04:00:00.000Z');
    assert.equal(day.end - day.start, 24 * 3600e3);
    const week = windowFor('week', T0);
    assert.equal(new Date(week.start).getDay(), 1, 'weeks start on Monday');
    assert.equal(new Date(week.start).toISOString(), '2026-10-26T04:00:00.000Z');
    const month = windowFor('month', T0);
    assert.equal(new Date(month.start).toISOString(), '2026-10-01T04:00:00.000Z');
    assert.equal(new Date(month.end).toISOString(), '2026-11-01T04:00:00.000Z');
    const hour = windowFor('hour', T0 + 25 * 60e3);
    assert.equal(hour.start, T0);
  });

  test('a DST-change day spans 25 hours and ticks label true local times', () => {
    const fallBack = windowFor('day', Date.UTC(2026, 10, 1, 15)); // 2026-11-01
    assert.equal(fallBack.end - fallBack.start, 25 * 3600e3);
    const hours = ticks(fallBack).map((tk) => new Date(tk.t).getHours());
    assert.equal(hours.length, 26);
    assert.deepEqual(hours.slice(0, 4), [0, 1, 1, 2], '01:00 occurs twice');
    const springForward = windowFor('day', Date.UTC(2026, 2, 8, 15));
    assert.equal(springForward.end - springForward.start, 23 * 3600e3);
    // Navigation across DST stays aligned to local midnight.
    const next = shiftWindow(fallBack, 1);
    assert.equal(new Date(next.start).getHours(), 0);
    assert.equal(next.end - next.start, 24 * 3600e3);
  });

  test('timestamps are displayed in the local time zone, stored as UTC instants', () => {
    const t = Date.UTC(2026, 9, 27, 14, 3, 7, 250);
    const ny = formatInstant(t, { locale: 'en-US' });
    assert.match(ny, /10:03:07\.250/);
    assert.match(ny, /EDT/);
    const tokyo = formatInstant(t, { locale: 'en-US', timeZone: 'Asia/Tokyo' });
    assert.match(tokyo, /11:03:07\.250/);
    process.env.TZ = 'Europe/Berlin';
    try {
      assert.equal(startOfView('day', t), Date.UTC(2026, 9, 26, 23), 'Berlin midnight (CET after DST ended Oct 25)');
    } finally {
      process.env.TZ = 'America/New_York';
    }
  });

  test('every view produces ordered, in-window ticks with labels', () => {
    for (const view of ['hour', 'day', 'week', 'month']) {
      const win = windowFor(view, T0);
      const tks = ticks(win, 'en-US');
      assert.ok(tks.length > 3, view);
      for (let i = 1; i < tks.length; i++) assert.ok(tks[i].t >= tks[i - 1].t, view);
      assert.ok(tks.every((tk) => tk.t >= win.start && tk.t <= win.end), view);
      assert.ok(tks.some((tk) => tk.label), view);
    }
  });

  test('fitted windows (zoom to a session) get second/minute ticks and shift by their own span', () => {
    const w = customWindow(T0 + 20e3, T0 + 5 * 60e3 + 20e3); // ~5 min
    const tks = ticks(w, 'en-US');
    assert.ok(tks.length >= 5 && tks.length <= 13, `${tks.length} ticks`);
    assert.ok(tks.every((tk) => tk.t >= w.start && tk.t <= w.end));
    assert.equal(tks[1].t - tks[0].t, 30e3, '30 s steps for a 5 min span');
    assert.equal(new Date(tks[0].t).getSeconds() % 30, 0, 'aligned to the wall clock');
    const short = ticks(customWindow(T0, T0 + 40e3), 'en-US');
    assert.match(short[0].label, /\d{2}:\d{2}:\d{2}/, 'seconds shown for short spans');
    const next = shiftWindow(w, 1);
    assert.deepEqual([next.view, next.start, next.end], ['custom', w.end, w.end + (w.end - w.start)]);
    assert.match(formatWindow(w, 'en-US'), /10:00:20 AM – 10:05:20 AM/);
  });

  test('changing zoom keeps the focus instant visible', () => {
    const day = windowFor('day', T0);
    for (const view of ['hour', 'week', 'month']) {
      const w = changeView(day, view, T0);
      assert.ok(T0 >= w.start && T0 < w.end, view);
    }
  });
});

describe('positions', () => {
  test('markers and intervals are positioned proportionally and clipped to the window', () => {
    const win = { view: 'hour', start: T0, end: T0 + 3600e3 };
    assert.equal(xFor(T0 + 1800e3, win.start, win.end, 1000), 500);
    assert.deepEqual(intervalPixels(T0 - 600e3, T0 + 360e3, win.start, win.end, 1000), { x: 0, w: 100 });
    assert.equal(intervalPixels(T0 - 600e3, T0 - 1, win.start, win.end, 1000), null);
    assert.equal(intervalPixels(win.end, win.end + 10, win.start, win.end, 1000), null);
  });

  test('layout of a row: user marker, completion marker and connecting interval', () => {
    const [row] = buildRows([{ id: 'c1', title: 'A' }], [user('m1', T0 + 360e3), resp('r1', 'm1', T0 + 720e3)]);
    const items = layoutRow(row, { start: T0, end: T0 + 3600e3 }, 1000);
    const iv = items.find((i) => i.kind === 'interval');
    const [mu, mr] = items.filter((i) => i.kind === 'marker');
    assert.equal(iv.x, 100);
    assert.equal(iv.w, 100);
    assert.ok(iv.cls.includes('completed'));
    assert.equal(mu.x, 100);
    assert.ok(mu.cls.includes('user'));
    assert.equal(mr.x, 200);
    assert.ok(mr.cls.includes('done'));
    assert.equal(mu.y, ROW_HEIGHT / 2);
  });

  test('zooming changes pixels but never the underlying timestamps', () => {
    const events = [user('m1', T0 + 360e3), resp('r1', 'm1', T0 + 720e3)];
    const snapshot = JSON.stringify(events);
    const [row] = buildRows([{ id: 'c1', title: 'A' }], events);
    const atHour = layoutRow(row, windowFor('hour', T0), 1200).find((i) => i.kind === 'interval');
    const atDay = layoutRow(row, windowFor('day', T0), 1200).find((i) => i.kind === 'interval');
    assert.ok(atHour.w > atDay.w);
    assert.equal(JSON.stringify(events), snapshot);
    assert.deepEqual([row.intervals[0].start, row.intervals[0].end], [T0 + 360e3, T0 + 720e3]);
  });

  test('overlapping intervals get distinct lanes so both stay visible', () => {
    const [row] = buildRows([{ id: 'c1', title: 'A' }], [user('m1', T0), user('m2', T0 + 1000), resp('r1', 'm1', T0 + 9000), resp('r2', 'm2', T0 + 5000)]);
    assert.equal(row.lanes, 2);
    const ys = layoutRow(row, windowFor('hour', T0), 1000).filter((i) => i.kind === 'interval').map((i) => i.y);
    assert.notEqual(ys[0], ys[1]);
    assert.ok(laneCenter(1, 2) < ROW_HEIGHT && laneCenter(0, 2) > 0);
  });
});

describe('sessions and readability when zoomed out', () => {
  const MIN = 60e3;
  // Three exchanges a few minutes apart, then one two hours later.
  const events = [
    user('m1', T0), resp('r1', 'm1', T0 + 30e3),
    user('m2', T0 + 5 * MIN), resp('r2', 'm2', T0 + 5 * MIN + 45e3),
    user('m3', T0 + 12 * MIN), // no response
    user('m4', T0 + 120 * MIN), resp('r4', 'm4', T0 + 121 * MIN),
  ];

  test('messages less than 15 minutes apart form one session; long gaps start a new one', () => {
    const sessions = buildSessions(pairEvents(events));
    assert.deepEqual(sessions.map((s) => [s.start, s.end, s.messages, s.responses, s.completed]), [
      [T0, T0 + 12 * MIN, 3, 2, 2],
      [T0 + 120 * MIN, T0 + 121 * MIN, 1, 1, 1],
    ]);
    assert.equal(sessions[0].waitingMs, 30e3 + 45e3);
  });

  test('day view: sessions are visible bands and short exchanges are compact bars without dots', () => {
    const [row] = buildRows([{ id: 'c1', title: 'A' }], events);
    const items = layoutRow(row, windowFor('day', T0), 1000);
    const band = items.find((i) => i.kind === 'session');
    assert.ok(band, 'multi-message session drawn');
    assert.ok(band.w >= 8, `band is visible (${band.w.toFixed(1)}px)`);
    const bars = items.filter((i) => i.kind === 'interval');
    assert.equal(bars.length, 3);
    assert.ok(bars.every((b) => b.cls.includes('compact') && b.w >= 4 && b.h === 10));
    const dots = items.filter((i) => i.kind === 'marker').map((i) => i.id);
    assert.deepEqual(dots, ['user:m3'], 'only the message without a response keeps its dot');
    assert.equal(items.filter((i) => i.kind === 'session').length, 1, 'single-exchange session has no band');
  });

  test('hour view: wide bars keep their send and finish dots', () => {
    const [row] = buildRows([{ id: 'c1', title: 'A' }], events);
    const items = layoutRow(row, windowFor('hour', T0), 1800); // 45 s = 22.5 px
    const r2 = items.find((i) => i.id === 'resp:r2' && i.kind === 'interval');
    assert.ok(r2.w >= MARKER_MIN_PX && !r2.cls.includes('compact'));
    assert.ok(items.some((i) => i.kind === 'marker' && i.id === 'user:m2'));
    assert.ok(items.some((i) => i.kind === 'marker' && i.id === 'resp:r2'));
  });
});

describe('rows: search, sort, filter', () => {
  const convs = [
    { id: 'aaaaaaaa-1', title: 'Project X: parser' },
    { id: 'bbbbbbbb-2', title: 'Project X: parser' }, // same title, different conversation
    { id: 'cccccccc-3', title: 'Holiday plans' },
  ];
  const events = [
    user('a1', T0, 'aaaaaaaa-1'),
    user('b1', T0 + 86400e3, 'bbbbbbbb-2'),
    user('c1', T0 - 86400e3 * 3, 'cccccccc-3'),
  ];
  const rows = buildRows(convs, events);

  test('identical titles remain separate rows distinguished by id', () => {
    const matches = selectRows(rows, { query: 'parser' });
    assert.equal(matches.length, 2);
    assert.notEqual(shortId(matches[0].id), shortId(matches[1].id));
    assert.equal(shortId('tmp-123'), 'unsaved');
    assert.equal(displayTitle({ id: 'tmp-1', title: '' }), 'New chat (no conversation id yet)');
  });

  test('sorts by most recent activity or chronologically', () => {
    assert.deepEqual(selectRows(rows, { sort: 'recent' }).map((r) => r.id), ['bbbbbbbb-2', 'aaaaaaaa-1', 'cccccccc-3']);
    assert.deepEqual(selectRows(rows, { sort: 'chronological' }).map((r) => r.id), ['cccccccc-3', 'aaaaaaaa-1', 'bbbbbbbb-2']);
  });

  test('filters by activity date and by the visible window', () => {
    const day = windowFor('day', T0);
    assert.deepEqual(selectRows(rows, { activeFrom: day.start, activeTo: day.end }).map((r) => r.id), ['aaaaaaaa-1']);
    assert.deepEqual(selectRows(rows, { window: day, onlyActiveInWindow: true }).map((r) => r.id), ['aaaaaaaa-1']);
    assert.equal(selectRows(rows, { window: shiftWindow(windowFor('month', T0), -6), onlyActiveInWindow: true }).length, 0, 'empty period');
  });

  test('an interval spanning the window edge counts as activity in the window', () => {
    const [row] = buildRows([{ id: 'c', title: '' }], [user('m', T0 - 1000, 'c'), { ...resp('r', 'm', T0 + 1000), conversationId: 'c' }]);
    assert.ok(rowHasActivityIn(row, T0, T0 + 500));
  });

  test('empty dataset', () => {
    assert.deepEqual(buildRows([], []), []);
    assert.deepEqual(selectRows([], { query: 'x', window: windowFor('day', T0), onlyActiveInWindow: true }), []);
  });

  test('large dataset: 3000 conversations, 60000 events stay fast', () => {
    const cs = [];
    const es = [];
    for (let c = 0; c < 3000; c++) {
      cs.push({ id: `conv-${c}`, title: `Conversation ${c % 500}` });
      for (let k = 0; k < 10; k++) {
        const t = T0 - c * 3600e3 + k * 60e3;
        es.push(user(`m${c}-${k}`, t, `conv-${c}`), { ...resp(`r${c}-${k}`, `m${c}-${k}`, t + 20e3), conversationId: `conv-${c}` });
      }
    }
    const t0 = performance.now();
    const built = buildRows(cs, es);
    const visible = selectRows(built, { query: 'conversation 1', sort: 'recent', window: windowFor('month', T0), onlyActiveInWindow: true });
    for (const r of visible.slice(0, 60)) layoutRow(r, windowFor('month', T0), 1400);
    const ms = performance.now() - t0;
    assert.equal(built.length, 3000);
    assert.ok(visible.length > 0);
    assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  });
});
