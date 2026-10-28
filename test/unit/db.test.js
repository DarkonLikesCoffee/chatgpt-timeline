import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineDB, openDatabase, MIGRATIONS, DB_VERSION, preferEvent } from '../../src/shared/db.js';
import { EventType } from '../../src/shared/constants.js';

const fresh = () => TimelineDB.open({ factory: new IDBFactory() });

const user = (id, conv, t, extra = {}) => ({
  id: `user:${id}`, conversationId: conv, type: EventType.USER_MESSAGE, timestamp: t, timestampSource: 'submit-intent', messageId: id, ...extra,
});
const done = (id, req, conv, t, extra = {}) => ({
  id: `resp:${id}`, conversationId: conv, type: EventType.ASSISTANT_RESPONSE_COMPLETED, timestamp: t, timestampSource: 'dom-transition',
  messageId: id, requestMessageId: req, association: 'dom-adjacent', startedAt: t - 100, ...extra,
});

describe('database', () => {
  test('initializes the current schema with stores and indexes', async () => {
    const db = await fresh();
    assert.equal(db.db.version, DB_VERSION);
    assert.deepEqual([...db.db.objectStoreNames].sort(), ['conversations', 'events', 'meta']);
    const tx = db.db.transaction('events');
    assert.deepEqual([...tx.objectStore('events').indexNames].sort(), ['conversationId', 'conversationId_timestamp', 'requestMessageId', 'timestamp']);
    db.close();
  });

  test('upgrading from v1 keeps existing data and adds new indexes', async () => {
    const factory = new IDBFactory();
    const v1 = await openDatabase({ factory, migrations: MIGRATIONS.slice(0, 1) });
    assert.equal(v1.version, 1);
    await new Promise((resolve, reject) => {
      const tx = v1.transaction(['events', 'conversations'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c1', title: 'Old', url: '', firstObservedAt: 1, lastActivityAt: 1 });
      tx.objectStore('events').put(user('m1', 'c1', 1000));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    v1.close();
    const db = await TimelineDB.open({ factory });
    assert.equal(db.db.version, DB_VERSION);
    assert.equal((await db.listEvents()).length, 1);
    assert.equal((await db.getConversation('c1')).title, 'Old');
    assert.equal((await db.listConversationEvents('c1')).length, 1, 'new compound index is populated');
    await db.setSetting('paused', true);
    assert.equal(await db.getSetting('paused'), true);
    db.close();
  });

  test('saves and retrieves events and creates the conversation', async () => {
    const db = await fresh();
    await db.recordEvent(user('m1', 'c1', 1000), { title: 'Parser', url: 'https://chatgpt.com/c/c1' });
    await db.recordEvent(done('r1', 'm1', 'c1', 4000), { title: 'Parser' });
    const conv = await db.getConversation('c1');
    assert.deepEqual(conv, { id: 'c1', title: 'Parser', url: 'https://chatgpt.com/c/c1', firstObservedAt: 1000, lastActivityAt: 4000 });
    const evs = await db.listConversationEvents('c1');
    assert.deepEqual(evs.map((e) => e.id), ['user:m1', 'resp:r1']);
    assert.deepEqual((await db.listEvents({ from: 2000, to: 5000 })).map((e) => e.id), ['resp:r1']);
    assert.deepEqual((await db.listEvents({ from: 1000, to: 4000 })).map((e) => e.id), ['user:m1'], 'end is exclusive');
    db.close();
  });

  test('repeated events are stored once; a better timestamp source replaces a worse one', async () => {
    const db = await fresh();
    assert.equal((await db.recordEvent(user('m1', 'c1', 1500, { timestampSource: 'dom-observed' }), {})).stored, true);
    assert.equal((await db.recordEvent(user('m1', 'c1', 1500, { timestampSource: 'dom-observed' }), {})).stored, false);
    assert.equal((await db.recordEvent(user('m1', 'c1', 1400), {})).stored, true);
    assert.equal((await db.recordEvent(user('m1', 'c1', 1300, { timestampSource: 'dom-observed' }), {})).stored, false);
    const evs = await db.listEvents();
    assert.equal(evs.length, 1);
    assert.equal(evs[0].timestamp, 1400);
    db.close();
  });

  test('preferEvent keeps the earliest of equal-quality reports', () => {
    const a = done('r', 'm', 'c', 2000);
    const b = done('r', 'm', 'c', 2100);
    assert.equal(preferEvent(a, b), a);
    assert.equal(preferEvent(b, a), a);
    assert.equal(preferEvent(undefined, b), b);
  });

  test('updates conversation titles only for conversations with activity', async () => {
    const db = await fresh();
    assert.equal(await db.updateConversationMeta({ id: 'visited', title: 'Just visited' }), false);
    assert.equal(await db.getConversation('visited'), undefined);
    await db.recordEvent(user('m1', 'c1', 1000), { title: 'New chat' });
    assert.equal(await db.updateConversationMeta({ id: 'c1', title: 'Generated title', url: 'https://chatgpt.com/c/c1' }), true);
    assert.equal((await db.getConversation('c1')).title, 'Generated title');
    assert.equal(await db.updateConversationMeta({ id: 'c1', title: 'Generated title' }), false);
    // A duplicate event still refreshes a changed title.
    await db.recordEvent(user('m1', 'c1', 1000), { title: 'Renamed' });
    assert.equal((await db.getConversation('c1')).title, 'Renamed');
    db.close();
  });

  test('rebinds provisional conversations to the real id', async () => {
    const db = await fresh();
    await db.recordEvent(user('m1', 'tmp-1', 1000), {});
    assert.equal(await db.rebindConversation('tmp-1', 'c9', { title: 'Real', url: 'https://chatgpt.com/c/c9' }), 1);
    assert.equal(await db.getConversation('tmp-1'), undefined);
    const conv = await db.getConversation('c9');
    assert.equal(conv.title, 'Real');
    assert.equal(conv.firstObservedAt, 1000);
    assert.equal((await db.listConversationEvents('c9'))[0].id, 'user:m1');
    db.close();
  });

  test('exports everything and clears everything', async () => {
    const db = await fresh();
    await db.recordEvent(user('m1', 'c1', 1000), { title: 'A' });
    await db.recordEvent(done('r1', 'm1', 'c1', 2000), {});
    const data = await db.exportAll();
    assert.equal(data.format, 'chatgpt-activity-timeline');
    assert.equal(data.schemaVersion, DB_VERSION);
    assert.equal(data.conversations.length, 1);
    assert.deepEqual(data.events.map((e) => e.id), ['user:m1', 'resp:r1']);
    assert.ok(JSON.parse(JSON.stringify(data)));
    await db.clearAll();
    assert.deepEqual(await db.stats(), { conversations: 0, events: 0, lastEventAt: null });
    db.close();
  });

  test('deletes one conversation and only its events', async () => {
    const db = await fresh();
    await db.recordEvent(user('m1', 'c1', 1000), {});
    await db.recordEvent(user('m2', 'c2', 1100), {});
    assert.equal(await db.deleteConversation('c1'), 1);
    assert.deepEqual((await db.listEvents()).map((e) => e.conversationId), ['c2']);
    assert.deepEqual((await db.listConversations()).map((c) => c.id), ['c2']);
    db.close();
  });

  test('rejects malformed events', async () => {
    const db = await fresh();
    await assert.rejects(db.recordEvent({ id: 'x', conversationId: 'c', type: 'NOPE', timestamp: 1 }, {}));
    await assert.rejects(db.recordEvent({ id: 'x', conversationId: 'c', type: EventType.USER_MESSAGE, timestamp: '2024-01-01' }, {}));
    db.close();
  });
});
