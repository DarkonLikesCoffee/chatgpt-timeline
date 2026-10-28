import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationTracker } from '../../src/content/tracker.js';
import { EventType } from '../../src/shared/constants.js';

const U = (id) => ({ role: 'user', id });
const A = (id, extra = {}) => ({ role: 'assistant', id, length: 10, ...extra });

function setup(options = {}) {
  const out = [];
  let n = 0;
  const tracker = new ConversationTracker({ emit: (m) => out.push(m), newId: () => `p${++n}`, options });
  const snap = (at, turns, extra = {}) =>
    tracker.process({ at, conversationId: 'c1', url: 'https://chatgpt.com/c/c1', title: 'Conv 1', generating: false, trailingError: false, turns, ...extra });
  const events = () => out.filter((m) => m.kind === 'event').map((m) => m.event);
  return { tracker, out, snap, events };
}

// Simulates one complete exchange on top of existing turns.
function exchange(ctx, { history, user, assistant, sendAt, doneAt }) {
  ctx.tracker.noteSubmitIntent(sendAt);
  ctx.snap(sendAt + 30, [...history, U(user)], { generating: true });
  ctx.snap(sendAt + 400, [...history, U(user), A(assistant, { length: 5 })], { generating: true });
  ctx.snap(doneAt, [...history, U(user), A(assistant, { length: 50 })], { generating: false });
  ctx.snap(doneAt + 1000, [...history, U(user), A(assistant, { length: 50 })], { generating: false });
}

describe('user messages', () => {
  test('creates USER_MESSAGE at the send-intent time once the message renders', () => {
    const ctx = setup();
    ctx.snap(1000, []);
    ctx.tracker.noteSubmitIntent(5000);
    ctx.snap(5040, [U('m1')], { generating: true });
    const [e] = ctx.events();
    assert.equal(e.type, EventType.USER_MESSAGE);
    assert.equal(e.timestamp, 5000);
    assert.equal(e.timestampSource, 'submit-intent');
    assert.equal(e.messageId, 'm1');
    assert.equal(e.id, 'user:m1');
    assert.equal(e.conversationId, 'c1');
  });

  test('history rendered after load is never recorded', () => {
    const ctx = setup();
    ctx.snap(1000, []);
    ctx.snap(1200, [U('a'), A('b'), U('c'), A('d')]);
    ctx.snap(9000, [U('a'), A('b'), U('c'), A('d')]);
    assert.deepEqual(ctx.events(), []);
  });

  test('a single re-rendered message without intent or generation is not recorded', () => {
    const ctx = setup();
    ctx.snap(1000, [U('a'), A('b')]);
    ctx.snap(5000, [U('a'), A('b'), U('c')]); // e.g. lazily rendered
    ctx.snap(20000, [U('a'), A('b'), U('c')]);
    assert.deepEqual(ctx.events(), []);
  });

  test('falls back to DOM time when no intent was captured but generation starts', () => {
    const ctx = setup();
    ctx.snap(1000, []);
    ctx.snap(5000, [], { generating: false });
    ctx.snap(6000, [U('m1')], { generating: false });
    ctx.snap(6100, [U('m1')], { generating: true });
    const [e] = ctx.events();
    assert.equal(e.timestamp, 6000);
    assert.equal(e.timestampSource, 'dom-observed');
  });

  test('generation already running when the page loads is not a new message', () => {
    const ctx = setup();
    ctx.snap(1000, [U('a'), A('b')], { generating: true });
    ctx.snap(1500, [U('a'), A('b')], { generating: true });
    assert.equal(ctx.events().filter((e) => e.type === EventType.USER_MESSAGE).length, 0);
  });

  test('a stale intent (Enter on an empty composer) is not reused for a later message', () => {
    const ctx = setup();
    ctx.snap(1000, []);
    ctx.tracker.noteSubmitIntent(2000);
    ctx.tracker.noteSubmitIntent(7000);
    ctx.snap(7050, [U('m1')], { generating: true });
    assert.equal(ctx.events()[0].timestamp, 7000);
    // The 2000 intent was discarded too, so it cannot time a later message.
    ctx.snap(9000, [U('m1'), A('r1')], { generating: false });
    ctx.snap(9900, [U('m1'), A('r1')]);
    ctx.snap(15000, [U('m1'), A('r1'), U('m2')]);
    assert.equal(ctx.events().filter((e) => e.type === EventType.USER_MESSAGE).length, 1);
  });

  test('edited and resubmitted message records a new event referencing the original', () => {
    const ctx = setup();
    ctx.snap(0, []);
    exchange(ctx, { history: [], user: 'm1', assistant: 'r1', sendAt: 1000, doneAt: 3000 });
    ctx.tracker.noteSubmitIntent(10000);
    ctx.snap(10050, [U('m1b')], { generating: true });
    ctx.snap(12000, [U('m1b'), A('r1b')], { generating: false });
    ctx.snap(13000, [U('m1b'), A('r1b')]);
    const users = ctx.events().filter((e) => e.type === EventType.USER_MESSAGE);
    assert.deepEqual(users.map((e) => [e.messageId, e.revisionOf ?? null, e.timestamp]), [['m1', null, 1000], ['m1b', 'm1', 10000]]);
    const done = ctx.events().filter((e) => e.type === EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.deepEqual(done.map((e) => [e.messageId, e.requestMessageId]), [['r1', 'm1'], ['r1b', 'm1b']]);
  });
});

describe('assistant responses', () => {
  test('completion is recorded at the moment generation ended, after confirmation', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1030, [U('m1')], { generating: true });
    ctx.snap(1500, [U('m1'), A('r1', { length: 3 })], { generating: true });
    ctx.snap(2000, [U('m1'), A('r1', { length: 30 })], { generating: true });
    ctx.snap(4000, [U('m1'), A('r1', { length: 60 })], { generating: false });
    assert.equal(ctx.events().length, 1, 'not yet confirmed');
    assert.ok(ctx.tracker.hasPendingConfirmation());
    ctx.snap(4800, [U('m1'), A('r1', { length: 60 })]);
    const r = ctx.events()[1];
    assert.equal(r.type, EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.equal(r.timestamp, 4000);
    assert.equal(r.requestMessageId, 'm1');
    assert.equal(r.requestEventId, 'user:m1');
    assert.equal(r.association, 'dom-adjacent');
    assert.equal(r.startedAt, 1500);
    assert.equal(r.id, 'resp:r1');
    assert.ok(!ctx.tracker.hasPendingConfirmation());
  });

  test('intermediate rendering (streaming class, brief pauses) is not completion', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1030, [U('m1')], { generating: true });
    // Stop button flickers off for one snapshot while streaming continues.
    ctx.snap(1500, [U('m1'), A('r1', { streaming: true, length: 5 })], { generating: false });
    ctx.snap(2000, [U('m1'), A('r1', { streaming: true, length: 9 })], { generating: false });
    // Not streaming but text still growing: candidate restarts.
    ctx.snap(2500, [U('m1'), A('r1', { length: 20 })]);
    ctx.snap(3000, [U('m1'), A('r1', { length: 40 })]);
    ctx.snap(3500, [U('m1'), A('r1', { length: 40 })]);
    assert.equal(ctx.events().filter((e) => e.type !== EventType.USER_MESSAGE).length, 0);
    ctx.snap(3900, [U('m1'), A('r1', { length: 40 })]);
    const r = ctx.events().find((e) => e.type === EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.equal(r.timestamp, 3000);
  });

  test('without a stop control ever seen, completion waits for the longer quiet period', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1030, [U('m1')]);
    ctx.snap(1500, [U('m1'), A('r1', { length: 20 })]);
    ctx.snap(2500, [U('m1'), A('r1', { length: 20 })]);
    assert.equal(ctx.events().length, 1);
    ctx.snap(4600, [U('m1'), A('r1', { length: 20 })]);
    assert.equal(ctx.events()[1].timestamp, 1500);
  });

  test('stop control appearing before the new user turn does not complete an old response', () => {
    const ctx = setup();
    ctx.snap(0, [U('a'), A('b', { length: 30 })]);
    ctx.tracker.noteSubmitIntent(5000);
    ctx.snap(5005, [U('a'), A('b', { length: 30 })], { generating: true });
    ctx.snap(5040, [U('a'), A('b', { length: 30 }), U('m1')], { generating: true });
    ctx.snap(5500, [U('a'), A('b', { length: 30 }), U('m1'), A('r1', { length: 5 })], { generating: true });
    ctx.snap(7000, [U('a'), A('b', { length: 30 }), U('m1'), A('r1', { length: 40 })]);
    ctx.snap(8000, [U('a'), A('b', { length: 30 }), U('m1'), A('r1', { length: 40 })]);
    const outcomes = ctx.events().filter((e) => e.type !== EventType.USER_MESSAGE);
    assert.deepEqual(outcomes.map((e) => e.messageId), ['r1']);
  });

  test('"continue generating" on a rendered response records its completion', () => {
    const ctx = setup();
    ctx.snap(0, [U('a'), A('b', { length: 30 })]);
    ctx.snap(5000, [U('a'), A('b', { length: 30 })], { generating: true });
    ctx.snap(5300, [U('a'), A('b', { length: 45 })], { generating: true });
    ctx.snap(6000, [U('a'), A('b', { length: 60 })]);
    ctx.snap(7000, [U('a'), A('b', { length: 60 })]);
    const [r] = ctx.events();
    assert.equal(r.messageId, 'b');
    assert.equal(r.timestamp, 6000);
  });

  test('history responses are never recorded as completions', () => {
    const ctx = setup();
    ctx.snap(1000, [U('a'), A('b')]);
    ctx.snap(5000, [U('a'), A('b')]);
    assert.deepEqual(ctx.events(), []);
  });

  test('sending again before the previous response finished keeps both associations', () => {
    // ChatGPT normally blocks this in one conversation, but the tracker must not
    // assume the latest response belongs to the latest message.
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1010, [U('m1')], { generating: true });
    ctx.snap(1200, [U('m1'), A('r1', { streaming: true })], { generating: true });
    ctx.tracker.noteSubmitIntent(1500);
    ctx.snap(1510, [U('m1'), A('r1', { streaming: true }), U('m2')], { generating: true });
    ctx.snap(1700, [U('m1'), A('r1', { streaming: true }), U('m2'), A('r2', { streaming: true })], { generating: true });
    // r2 finishes first, r1 later.
    ctx.snap(2000, [U('m1'), A('r1', { streaming: true }), U('m2'), A('r2')], { generating: false });
    ctx.snap(2900, [U('m1'), A('r1', { streaming: true }), U('m2'), A('r2')]);
    ctx.snap(3000, [U('m1'), A('r1'), U('m2'), A('r2')]);
    ctx.snap(4000, [U('m1'), A('r1'), U('m2'), A('r2')]);
    const done = ctx.events().filter((e) => e.type === EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.deepEqual(done.map((e) => [e.messageId, e.requestMessageId, e.timestamp]), [['r2', 'm2', 2000], ['r1', 'm1', 3000]]);
    const users = ctx.events().filter((e) => e.type === EventType.USER_MESSAGE);
    assert.deepEqual(users.map((e) => [e.messageId, e.timestamp]), [['m1', 1000], ['m2', 1500]]);
  });

  test('stop click turns the outcome into ASSISTANT_RESPONSE_INTERRUPTED', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1010, [U('m1')], { generating: true });
    ctx.snap(1500, [U('m1'), A('r1')], { generating: true });
    ctx.tracker.noteStopIntent(2500);
    ctx.snap(2550, [U('m1'), A('r1')], { generating: false });
    ctx.snap(3500, [U('m1'), A('r1')]);
    const r = ctx.events()[1];
    assert.equal(r.type, EventType.ASSISTANT_RESPONSE_INTERRUPTED);
    assert.equal(r.timestamp, 2550);
  });

  test('an error inside the response records ASSISTANT_RESPONSE_FAILED', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1010, [U('m1')], { generating: true });
    ctx.snap(1500, [U('m1'), A('r1')], { generating: true });
    ctx.snap(2000, [U('m1'), A('r1')], { generating: false });
    ctx.snap(2300, [U('m1'), A('r1', { error: true })]);
    ctx.snap(4000, [U('m1'), A('r1', { error: true })]);
    const outcomes = ctx.events().filter((e) => e.type !== EventType.USER_MESSAGE);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].type, EventType.ASSISTANT_RESPONSE_FAILED);
    assert.equal(outcomes[0].timestamp, 2000);
  });

  test('an error with no response turn records a failed outcome once', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1010, [U('m1')], { generating: true });
    ctx.snap(3000, [U('m1')], { generating: false, trailingError: true });
    ctx.snap(4000, [U('m1')], { generating: false, trailingError: true });
    const failed = ctx.events().filter((e) => e.type === EventType.ASSISTANT_RESPONSE_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].requestMessageId, 'm1');
    assert.equal(failed[0].messageId, null);
  });

  test('regenerated response is a separate attempt linked to the same request', () => {
    const ctx = setup();
    ctx.snap(0, []);
    exchange(ctx, { history: [], user: 'm1', assistant: 'r1', sendAt: 1000, doneAt: 3000 });
    // Regenerate: the response turn is replaced by a new one, streaming.
    ctx.snap(10000, [U('m1'), A('r2', { length: 1 })], { generating: true });
    ctx.snap(12000, [U('m1'), A('r2', { length: 80 })], { generating: false });
    ctx.snap(13000, [U('m1'), A('r2', { length: 80 })]);
    const done = ctx.events().filter((e) => e.type === EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.equal(done.length, 2);
    assert.equal(done[0].responseKind, 'initial');
    assert.equal(done[1].responseKind, 'regenerated');
    assert.equal(done[1].requestMessageId, 'm1');
    assert.equal(done[1].previousResponseId, 'r1');
    assert.equal(done[1].startedAt, 10000);
    assert.equal(done[1].timestamp, 12000);
    assert.equal(ctx.events().filter((e) => e.type === EventType.USER_MESSAGE).length, 1);
  });

  test('switching to an older alternative response is not a new attempt', () => {
    const ctx = setup();
    ctx.snap(0, []);
    exchange(ctx, { history: [], user: 'm1', assistant: 'r1', sendAt: 1000, doneAt: 3000 });
    ctx.snap(10000, [U('m1'), A('r0')]); // "< 1/2" branch navigation
    ctx.snap(12000, [U('m1'), A('r0')]);
    assert.equal(ctx.events().filter((e) => e.type !== EventType.USER_MESSAGE).length, 1);
  });

  test('response without a preceding user turn is recorded with association none', () => {
    const ctx = setup();
    ctx.snap(0, [A('sys')]);
    ctx.snap(500, [A('sys'), A('r1')], { generating: true });
    ctx.snap(1500, [A('sys'), A('r1')], { generating: false });
    ctx.snap(2500, [A('sys'), A('r1')]);
    const [r] = ctx.events();
    assert.equal(r.association, 'none');
    assert.equal(r.requestMessageId, null);
  });

  test('repeated identical snapshots never duplicate events', () => {
    const ctx = setup();
    ctx.snap(0, []);
    exchange(ctx, { history: [], user: 'm1', assistant: 'r1', sendAt: 1000, doneAt: 3000 });
    for (let t = 5000; t < 20000; t += 700) ctx.snap(t, [U('m1'), A('r1', { length: 50 })]);
    assert.equal(ctx.events().length, 2);
  });
});

describe('conversation identity and navigation', () => {
  test('a new chat is recorded provisionally and rebound when its id appears', () => {
    const ctx = setup();
    const at = (t, turns, conversationId, extra) =>
      ctx.tracker.process({ at: t, conversationId, url: conversationId ? `https://chatgpt.com/c/${conversationId}` : '', title: '', generating: false, trailingError: false, turns, ...extra });
    at(0, [], null);
    ctx.tracker.noteSubmitIntent(1000);
    at(1010, [U('m1')], null, { generating: true });
    at(1800, [U('m1'), A('r1')], 'new-conv', { generating: true });
    at(3000, [U('m1'), A('r1')], 'new-conv', { title: 'Fresh title' });
    at(4000, [U('m1'), A('r1')], 'new-conv', { title: 'Fresh title' });
    const [first, rebind, meta, done] = ctx.out;
    assert.equal(first.kind, 'event');
    assert.equal(first.event.conversationId, 'tmp-p1');
    assert.deepEqual([rebind.kind, rebind.from, rebind.to], ['rebind', 'tmp-p1', 'new-conv']);
    assert.equal(meta.kind, 'meta');
    assert.equal(meta.conversation.title, 'Fresh title');
    assert.equal(done.event.conversationId, 'new-conv');
    assert.equal(done.event.requestMessageId, 'm1');
  });

  test('SPA navigation to another conversation resets state without recording its history', () => {
    const ctx = setup();
    const at = (t, turns, conversationId, extra) =>
      ctx.tracker.process({ at: t, conversationId, url: `https://chatgpt.com/c/${conversationId}`, title: conversationId, generating: false, trailingError: false, turns, ...extra });
    at(0, [], 'c1');
    ctx.tracker.noteSubmitIntent(1000);
    at(1010, [U('m1')], 'c1', { generating: true });
    at(1500, [U('m1'), A('r1')], 'c1', { generating: true });
    at(2000, [U('m1'), A('r1')], 'c1');
    // Navigate before confirmation: the observed completion is flushed to c1.
    at(2100, [], 'c2');
    at(2400, [U('x1'), A('x2'), U('x3'), A('x4')], 'c2');
    at(9000, [U('x1'), A('x2'), U('x3'), A('x4')], 'c2');
    const evs = ctx.events();
    assert.deepEqual(evs.map((e) => [e.type, e.conversationId]), [
      [EventType.USER_MESSAGE, 'c1'],
      [EventType.ASSISTANT_RESPONSE_COMPLETED, 'c1'],
    ]);
    assert.equal(evs[1].timestamp, 2000);
  });

  test('returning to a conversation that is still generating records the completion', () => {
    const ctx = setup();
    const at = (t, turns, conversationId, extra) =>
      ctx.tracker.process({ at: t, conversationId, url: '', title: '', generating: false, trailingError: false, turns, ...extra });
    at(0, [], 'c2');
    at(500, [U('m1'), A('r1', { length: 10 })], 'c1', { generating: true });
    at(1500, [U('m1'), A('r1', { length: 40 })], 'c1', { generating: true });
    at(2000, [U('m1'), A('r1', { length: 70 })], 'c1', { generating: false });
    at(3000, [U('m1'), A('r1', { length: 70 })], 'c1');
    const evs = ctx.events();
    assert.equal(evs.length, 1, 'the user message is not re-recorded');
    assert.equal(evs[0].type, EventType.ASSISTANT_RESPONSE_COMPLETED);
    assert.equal(evs[0].requestMessageId, 'm1');
    assert.equal(evs[0].timestamp, 2000);
  });

  test('title changes are reported as meta updates', () => {
    const ctx = setup();
    ctx.snap(0, [], { title: 'Old' });
    ctx.snap(10, [], { title: 'New' });
    assert.deepEqual(ctx.out.map((m) => [m.kind, m.conversation.title]), [['meta', 'New']]);
  });

  test('two trackers (two tabs) on different conversations stay independent', () => {
    const a = setup();
    const b = setup();
    a.snap(0, []);
    b.tracker.process({ at: 0, conversationId: 'c2', url: '', title: '', generating: false, trailingError: false, turns: [] });
    a.tracker.noteSubmitIntent(1000);
    b.tracker.noteSubmitIntent(1100);
    a.snap(1010, [U('a1')], { generating: true });
    b.tracker.process({ at: 1110, conversationId: 'c2', url: '', title: '', generating: true, trailingError: false, turns: [U('b1')] });
    b.tracker.process({ at: 1500, conversationId: 'c2', url: '', title: '', generating: false, trailingError: false, turns: [U('b1'), A('b2')] });
    b.tracker.process({ at: 2500, conversationId: 'c2', url: '', title: '', generating: false, trailingError: false, turns: [U('b1'), A('b2')] });
    a.snap(3000, [U('a1'), A('a2')]);
    a.snap(4000, [U('a1'), A('a2')]);
    assert.deepEqual(a.events().map((e) => [e.conversationId, e.messageId, e.requestMessageId ?? null]), [['c1', 'a1', null], ['c1', 'a2', 'a1']]);
    assert.deepEqual(b.events().map((e) => [e.conversationId, e.messageId, e.requestMessageId ?? null]), [['c2', 'b1', null], ['c2', 'b2', 'b1']]);
  });

  test('flush finalizes an observed but unconfirmed completion (page hidden or closed)', () => {
    const ctx = setup();
    ctx.snap(0, []);
    ctx.tracker.noteSubmitIntent(1000);
    ctx.snap(1010, [U('m1')], { generating: true });
    ctx.snap(1500, [U('m1'), A('r1')], { generating: true });
    ctx.snap(2000, [U('m1'), A('r1')], { generating: false });
    ctx.tracker.flush(2100);
    assert.equal(ctx.events()[1].timestamp, 2000);
    ctx.tracker.flush(2200);
    assert.equal(ctx.events().length, 2);
  });
});
