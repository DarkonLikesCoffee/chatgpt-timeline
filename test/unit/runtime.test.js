// Integration: content-script runtime (real MutationObserver, timers, adapter,
// tracker, transport) on a simulated ChatGPT page in jsdom, delivering to the
// real service-worker handler backed by an in-memory IndexedDB.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createRuntime } from '../../src/content/main.js';
import { handleMessage } from '../../src/background/handlers.js';
import { TimelineDB } from '../../src/shared/db.js';
import { EventType } from '../../src/shared/constants.js';
import { buildRows } from '../../src/timeline/model.js';

const LAYOUTS = [
  {
    name: 'legacy layout (data-message-author-role, data-testid controls)',
    script: readFileSync(new URL('../fixtures/mock-chatgpt.js', import.meta.url), 'utf8'),
    unitMarker: 'data-message-author-role=user',
    stopMarker: 'stop-button',
  },
  {
    name: '2026-10 layout (turn units, localized controls)',
    script: readFileSync(new URL('../fixtures/mock-chatgpt-2026.js', import.meta.url), 'utf8'),
    unitMarker: 'data-chatgpt-search-unit-key=fallback-turn-0:0:user',
    stopMarker: 'aria-label="Detener"',
  },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backend(factory = new IDBFactory()) {
  let db = null;
  const ctx = { getDB: async () => (db ??= await TimelineDB.open({ factory })) };
  return {
    factory,
    sendMessage: (m) => handleMessage(m, ctx),
    db: () => ctx.getDB(),
    restart() { db?.close(); db = null; }, // service worker suspended
  };
}

function makeTab(be, path = '/', layout = LAYOUTS[0], mockConfig = {}) {
  const dom = new JSDOM('<!doctype html><html><head><title>ChatGPT</title></head><body></body></html>', {
    url: `https://chatgpt.com${path}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.MOCK_CONFIG = { assignIdMs: 60, firstTokenMs: 40, tokenMs: 15, tokens: 5, ...mockConfig };
  w.eval(layout.script);
  const primary = () => w.document.querySelector(w.mockChat.primarySelector);
  const rt = createRuntime({ doc: w.document, win: w, sendMessage: be.sendMessage, options: { CONFIRM_MS: 80 } });
  rt.start();
  const api = {
    w,
    rt,
    clickPrimary() {
      primary().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    },
    async send(text = 'hello', opts) {
      w.__nextSendOptions = opts;
      w.mockChat.type(text);
      const done = new Promise((r) => w.addEventListener('mock:done', r, { once: true }));
      primary().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      return done;
    },
    async pressEnter(text = 'hello') {
      w.mockChat.type(text);
      const done = new Promise((r) => w.addEventListener('mock:done', r, { once: true }));
      w.document.querySelector('#prompt-textarea, .ProseMirror').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return done;
    },
    async settle() {
      await sleep(250);
      while (rt.transport.pending) await sleep(20);
    },
    close() { if (!this.closed) { this.closed = true; rt.stop(); w.close(); } },
  };
  return api;
}

async function allEvents(be) {
  return (await (await be.db()).listEvents()).sort((a, b) => a.timestamp - b.timestamp);
}

for (const layout of LAYOUTS) describe(`content script on a simulated ChatGPT page: ${layout.name}`, () => {
  const tab = (be, path, cfg) => makeTab(be, path, layout, cfg);

  test('records a new chat end-to-end, rebinds to the assigned URL id, no duplicates', async () => {
    const be = backend();
    const t = tab(be);
    const before = Date.now();
    await t.send('first');
    await t.settle();
    await t.pressEnter('second');
    await t.settle();
    const cid = /\/c\/([^/]+)/.exec(t.w.location.pathname)[1];
    const events = await allEvents(be);
    assert.deepEqual(events.map((e) => e.type), [
      EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_COMPLETED, EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_COMPLETED,
    ]);
    assert.ok(events.every((e) => e.conversationId === cid), 'provisional events moved to the real id');
    assert.equal(events[0].timestampSource, 'submit-intent');
    assert.ok(events[0].timestamp >= before);
    assert.equal(events[1].requestMessageId, events[0].messageId);
    assert.equal(events[3].requestMessageId, events[2].messageId);
    assert.ok(events[1].timestamp > events[1].startedAt, 'completion after first render');
    const db = await be.db();
    const convs = await db.listConversations();
    assert.equal(convs.length, 1);
    assert.equal(convs[0].url, `https://chatgpt.com/c/${cid}`);
    assert.equal(convs[0].title, `Chat ${cid.slice(0, 4)}`);
    t.close();
  });

  test('diagnostics capture what the page added after a send, without text', async (ctx) => {
    const be = backend();
    const t = tab(be, '/c/aaaaaaaa-0000-0000-0000-0000000000d1');
    ctx.after(() => t.close());
    await t.send('very private words');
    await t.settle();
    await sleep(300); // button-state samples are taken 0, 400, 2000 and 6000 ms after the send
    const d = t.rt.diagnostics();
    const cap = d.afterLastSend;
    assert.ok(cap.buttons.length >= 2);
    assert.ok(cap.added.some((a) => a.outline.some((l) => l.includes(layout.unitMarker))));
    assert.ok(
      cap.buttons.some((b) => b.buttons.some((x) => x.includes(layout.stopMarker))) ||
        cap.attributeChanges.some((c) => (c.element || '').includes(layout.stopMarker)),
    );
    const json = JSON.stringify(d);
    for (const text of ['very private', 'token1']) assert.ok(!json.includes(text), text);
  });

  test('stop and failure produce non-completed outcomes', async () => {
    const be = backend();
    const t = tab(be, '/c/aaaaaaaa-0000-0000-0000-000000000001');
    await t.send('fail please', { fail: true });
    await t.settle();
    t.w.mockChat.type('long answer');
    t.clickPrimary();
    await sleep(90);
    t.clickPrimary(); // stop
    await t.settle();
    const types = (await allEvents(be)).map((e) => e.type);
    assert.deepEqual(types, [EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_FAILED, EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_INTERRUPTED]);
    t.close();
  });

  test('regeneration is stored as a second attempt for the same message', async () => {
    const be = backend();
    const t = tab(be, '/c/aaaaaaaa-0000-0000-0000-000000000002');
    await t.send('q');
    await t.settle();
    const done = new Promise((r) => t.w.addEventListener('mock:done', r, { once: true }));
    t.w.mockChat.regenerate();
    await done;
    await t.settle();
    const events = await allEvents(be);
    const responses = events.filter((e) => e.type === EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.equal(responses.length, 2);
    assert.equal(responses[1].responseKind, 'regenerated');
    assert.equal(responses[0].requestMessageId, responses[1].requestMessageId);
    const [row] = buildRows(await (await be.db()).listConversations(), events);
    assert.deepEqual(row.intervals.map((iv) => [iv.attempt, iv.regenerated]), [[1, false], [2, true]]);
    t.close();
  });

  test('SPA navigation: history of the conversation navigated to is not recorded', async () => {
    const be = backend();
    const t = tab(be, '/c/aaaaaaaa-0000-0000-0000-000000000003');
    await t.send('q');
    await t.settle();
    t.w.mockChat.navigate('/c/bbbbbbbb-0000-0000-0000-000000000004', 6);
    await t.settle();
    await sleep(1100); // URL poll interval
    await t.settle();
    let events = await allEvents(be);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.conversationId === 'aaaaaaaa-0000-0000-0000-000000000003'));
    await t.send('in second conversation');
    await t.settle();
    events = await allEvents(be);
    assert.deepEqual(events.slice(2).map((e) => e.conversationId), ['bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-0000-0000-0000-000000000004']);
    t.close();
  });

  test('multiple tabs: concurrent conversations stay separate; the same conversation in two tabs is not duplicated', async () => {
    const be = backend();
    const a = tab(be, '/c/aaaaaaaa-0000-0000-0000-00000000000a');
    const b = tab(be, '/c/bbbbbbbb-0000-0000-0000-00000000000b');
    await Promise.all([a.send('to a'), b.send('to b')]);
    await Promise.all([a.settle(), b.settle()]);
    const events = await allEvents(be);
    assert.equal(events.length, 4);
    for (const conv of ['aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbbb-0000-0000-0000-00000000000b']) {
      const evs = events.filter((e) => e.conversationId === conv);
      assert.equal(evs.length, 2);
      assert.equal(evs[1].requestMessageId, evs[0].messageId);
    }
    // A third tab opens conversation A: its history must not be re-recorded.
    const c = tab(be, '/c/aaaaaaaa-0000-0000-0000-00000000000a');
    c.w.document.getElementById('thread').innerHTML = a.w.document.getElementById('thread').innerHTML;
    await c.settle();
    assert.equal((await allEvents(be)).length, 4);
    // Both tabs report the same events again (e.g. a retry): still deduplicated.
    for (const e of events) {
      await be.sendMessage({ type: 'tracker:event', payload: { kind: 'event', event: e, conversation: { id: e.conversationId } } });
    }
    assert.equal((await allEvents(be)).length, 4);
    a.close(); b.close(); c.close();
  });

  test('service worker suspension mid-session and browser restart keep history', async () => {
    const factory = new IDBFactory();
    const be = backend(factory);
    const t = tab(be, '/c/aaaaaaaa-0000-0000-0000-00000000000c');
    await t.send('one');
    await t.settle();
    be.restart(); // worker suspended; next message restarts it
    await t.send('two');
    await t.settle();
    assert.equal((await allEvents(be)).length, 4);
    t.close();
    be.restart();
    // "Browser restart": a new backend on the same persistent storage.
    const be2 = backend(factory);
    const evs = await allEvents(be2);
    assert.equal(evs.length, 4);
    const rows = buildRows(await (await be2.db()).listConversations(), evs);
    assert.equal(rows[0].intervals.length, 2);
    be2.restart();
  });
});

describe('2026-10 layout specifics', () => {
  const layout = LAYOUTS[1];

  test('the response id appearing mid-stream yields one response with the real id', async (ctx) => {
    const be = backend();
    const t = makeTab(be, '/c/bbbbbbbb-0000-0000-0000-000000000026', layout, { assistantIdAfterTokens: 3, tokens: 8 });
    ctx.after(() => t.close());
    await t.send('hola');
    await t.settle();
    const events = await allEvents(be);
    assert.deepEqual(events.map((e) => e.type), [EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_COMPLETED]);
    assert.ok(!events[1].messageId.endsWith(':assistant'), `real id, got ${events[1].messageId}`);
    assert.equal(events[1].requestMessageId, events[0].messageId);
    assert.equal(events[1].responseKind, 'initial');
  });

  test('works from the localized stop button alone if the turn state never shows streaming', async (ctx) => {
    const be = backend();
    const t = makeTab(be, '/c/bbbbbbbb-0000-0000-0000-000000000027', layout, { streamingState: 'complete', tokens: 10, tokenMs: 30 });
    ctx.after(() => t.close());
    const sentAt = Date.now();
    await t.send('hola');
    const doneAt = Date.now();
    await t.settle();
    const events = await allEvents(be);
    assert.deepEqual(events.map((e) => e.type), [EventType.USER_MESSAGE, EventType.ASSISTANT_RESPONSE_COMPLETED]);
    // Completion is at the end of generation, not when the response first appeared.
    assert.ok(events[1].timestamp >= doneAt - 100, `${events[1].timestamp - sentAt} ms after send`);
  });
});
