import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { convertConversation, toMs } from '../../src/shared/convert.js';
import { EventType } from '../../src/shared/constants.js';
import { ConversationBuilder } from '../fixtures/backend-api.js';
import { buildRows } from '../../src/timeline/model.js';
import { loadStripper } from './history-harness.js';

const T0 = Date.UTC(2026, 9, 27, 14, 0, 0);
const strip = loadStripper();
const convert = (b) => convertConversation(strip(b.detail()));

describe('time parsing', () => {
  test('epoch seconds, epoch ms and ISO strings', () => {
    assert.equal(toMs(1730000000.5), 1730000000500);
    assert.equal(toMs(1730000000500), 1730000000500);
    assert.equal(toMs('2026-10-27T14:00:00.123456Z'), Date.UTC(2026, 9, 27, 14, 0, 0, 123));
    assert.equal(toMs('1730000000'), 1730000000000);
    assert.equal(toMs(null), null);
    assert.equal(toMs('garbage'), null);
  });
});

describe('converting a conversation tree to events', () => {
  test('messages and completed responses, hidden system message ignored', () => {
    const b = new ConversationBuilder({ title: 'Parser', createdAt: T0 });
    const e1 = b.exchange(T0 + 1000, T0 + 2000, T0 + 9000);
    const e2 = b.exchange(T0 + 60000, T0 + 61000, T0 + 75000);
    const { conversation, events, stats } = convert(b);
    assert.deepEqual(events.map((e) => [e.type, e.timestamp]), [
      [EventType.USER_MESSAGE, T0 + 1000],
      [EventType.ASSISTANT_RESPONSE_COMPLETED, T0 + 9000],
      [EventType.USER_MESSAGE, T0 + 60000],
      [EventType.ASSISTANT_RESPONSE_COMPLETED, T0 + 75000],
    ]);
    assert.equal(events[1].requestMessageId, e1.user);
    assert.equal(events[1].messageId, e1.assistant);
    assert.equal(events[1].startedAt, T0 + 2000);
    assert.equal(events[1].timestampSource, 'server-update-time');
    assert.equal(events[3].requestMessageId, e2.user);
    assert.equal(events[0].id, `user:${e1.user}`);
    assert.deepEqual(conversation, {
      id: b.id,
      title: 'Parser',
      url: `https://chatgpt.com/c/${b.id}`,
      firstObservedAt: T0,
      lastActivityAt: T0 + 75000,
      serverUpdateTime: T0 + 75000,
      convertVersion: 2,
    });
    assert.deepEqual(stats, { messages: 2, responses: 2, withUpdateTime: 2, updateTimeIgnored: 0, inProgress: 0 });
  });

  test('without a stored update time, completion falls back to the final message creation time', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.exchange(T0 + 1000, T0 + 2000, null, { withUpdate: false });
    const [, r] = convert(b).events;
    assert.equal(r.timestamp, T0 + 2000);
    assert.equal(r.timestampSource, 'server-create-time');
  });

  test('an update time later than the next message is ignored (ChatGPT bumps it on later activity)', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    const e1 = b.exchange(T0 + 1000, T0 + 2000, T0 + 5 * 86400e3); // "updated" days later
    b.exchange(T0 + 60000, T0 + 61000, T0 + 70000);
    const { events, stats } = convert(b);
    const r1 = events.find((x) => x.messageId === e1.assistant);
    assert.equal(r1.timestamp, T0 + 2000, 'falls back to the creation time');
    assert.equal(r1.timestampSource, 'server-create-time');
    assert.equal(r1.updateTimeIgnored, true);
    assert.equal(stats.updateTimeIgnored, 1);
    assert.equal(stats.withUpdateTime, 1);
  });

  test('an update time more than an hour after the response started is ignored, even for the last message', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.exchange(T0 + 1000, T0 + 2000, T0 + 2 * 3600e3);
    const [, r] = convert(b).events;
    assert.equal(r.timestamp, T0 + 2000);
    assert.equal(r.updateTimeIgnored, true);
  });

  test('regression: bumped update times no longer merge a week of exchanges into one session', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    const last = T0 + 6 * 86400e3;
    for (let d = 0; d < 6; d++) b.exchange(T0 + d * 86400e3, T0 + d * 86400e3 + 1000, last); // all "updated" on the last day
    const { events, conversation } = convert(b);
    const [row] = buildRows([conversation], events);
    assert.equal(row.sessions.length, 6);
    assert.ok(row.intervals.every((iv) => iv.end - iv.start < 60e3));
  });

  test('tool calls and reasoning form one response; completion is the final answer', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    const e = b.exchange(T0 + 1000, T0 + 2000, T0 + 30000, { tool: true });
    const { events } = convert(b);
    assert.equal(events.length, 2);
    assert.equal(events[1].messageId, e.assistant, 'response id = first message of the attempt');
    assert.equal(events[1].startedAt, T0 + 2000);
    assert.equal(events[1].timestamp, T0 + 30000);
  });

  test('regenerated responses are separate attempts for the same message', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    const e = b.exchange(T0 + 1000, T0 + 2000, T0 + 9000);
    const r2 = b.regenerate(e.user, T0 + 60000, T0 + 70000);
    const { events } = convert(b);
    const responses = events.filter((x) => x.type !== EventType.USER_MESSAGE);
    assert.deepEqual(responses.map((x) => [x.messageId, x.responseKind, x.previousResponseId, x.startedAt]), [
      [e.assistant, 'initial', null, T0 + 2000],
      [r2, 'regenerated', e.assistant, T0 + 60000],
    ]);
    const [row] = buildRows([{ id: b.id, title: '' }], events);
    assert.deepEqual(row.intervals.map((iv) => [iv.attempt, iv.regenerated, iv.start, iv.end]), [
      [1, false, T0 + 1000, T0 + 9000],
      [2, true, T0 + 60000, T0 + 70000],
    ]);
  });

  test('edited messages are new messages marked as revisions; both branches keep their responses', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    const parent = b.lastId;
    const original = b.exchange(T0 + 1000, T0 + 2000, T0 + 9000, { parent });
    const edited = b.exchange(T0 + 30000, T0 + 31000, T0 + 40000, { parent });
    const { events } = convert(b);
    const users = events.filter((x) => x.type === EventType.USER_MESSAGE);
    assert.deepEqual(users.map((u) => [u.messageId, u.revisionOf ?? null]), [[original.user, null], [edited.user, original.user]]);
    assert.equal(events.filter((x) => x.type === EventType.ASSISTANT_RESPONSE_COMPLETED).length, 2);
  });

  test('interrupted, failed and in-progress responses', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.exchange(T0 + 1000, T0 + 2000, T0 + 3000, { finish: 'interrupted' });
    b.exchange(T0 + 10000, T0 + 11000, T0 + 12000, { status: 'finished_partial_completion', finish: null });
    b.exchange(T0 + 20000, T0 + 21000, T0 + 22000, { status: 'error' });
    b.exchange(T0 + 30000, T0 + 31000, T0 + 32000, { status: 'in_progress', finish: null });
    const { events, stats } = convert(b);
    assert.deepEqual(events.filter((x) => x.type !== EventType.USER_MESSAGE).map((x) => x.type), [
      EventType.ASSISTANT_RESPONSE_INTERRUPTED,
      EventType.ASSISTANT_RESPONSE_INTERRUPTED,
      EventType.ASSISTANT_RESPONSE_FAILED,
    ]);
    assert.equal(stats.inProgress, 1);
    assert.equal(events.filter((x) => x.type === EventType.USER_MESSAGE).length, 4, 'the in-progress message is still shown');
  });

  test('a message without any response has no outcome event', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.lastId = b.node(b.lastId, { role: 'user', t: (T0 + 1000) / 1000, finish: null });
    const { events } = convert(b);
    assert.deepEqual(events.map((x) => x.type), [EventType.USER_MESSAGE]);
  });

  test('hidden and context user messages are not messages you sent', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.lastId = b.node(b.lastId, { role: 'user', t: (T0 + 500) / 1000, contentType: 'user_editable_context', finish: null });
    b.lastId = b.node(b.lastId, { role: 'user', t: (T0 + 600) / 1000, hidden: true, finish: null });
    b.exchange(T0 + 1000, T0 + 2000, T0 + 3000);
    assert.equal(convert(b).events.filter((x) => x.type === EventType.USER_MESSAGE).length, 1);
  });

  test('a response never ends before its message was sent', () => {
    const b = new ConversationBuilder({ createdAt: T0 });
    b.exchange(T0 + 5000, T0 + 1000, T0 + 2000); // clock skew in stored data
    const [u, r] = convert(b).events;
    assert.ok(r.timestamp >= u.timestamp && r.startedAt >= u.timestamp);
  });
});
