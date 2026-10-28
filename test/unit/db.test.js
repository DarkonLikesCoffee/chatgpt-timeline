import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineDB, openDatabase, MIGRATIONS, DB_VERSION } from '../../src/shared/db.js';
import { EventType } from '../../src/shared/constants.js';

const fresh = () => TimelineDB.open({ factory: new IDBFactory() });

const user = (id, conv, t, extra = {}) => ({
  id: `user:${id}`, conversationId: conv, type: EventType.USER_MESSAGE, timestamp: t, timestampSource: 'server-create-time', messageId: id, ...extra,
});
const done = (id, req, conv, t, extra = {}) => ({
  id: `resp:${id}`, conversationId: conv, type: EventType.ASSISTANT_RESPONSE_COMPLETED, timestamp: t, timestampSource: 'server-update-time',
  messageId: id, requestMessageId: req, association: 'server-tree', startedAt: t - 100, ...extra,
});
const conv = (id, extra = {}) => ({ id, title: `Title ${id}`, url: `https://chatgpt.com/c/${id}`, firstObservedAt: 1000, lastActivityAt: 4000, serverUpdateTime: 4000, ...extra });

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

  test('saves a conversation with its events and retrieves them', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000), done('r1', 'm1', 'c1', 4000)]);
    const stored = await db.getConversation('c1');
    assert.equal(stored.title, 'Title c1');
    assert.equal(stored.serverUpdateTime, 4000);
    assert.ok(stored.fetchedAt > 0);
    assert.deepEqual((await db.listConversationEvents('c1')).map((e) => e.id), ['user:m1', 'resp:r1']);
    assert.deepEqual((await db.listEvents({ from: 2000, to: 5000 })).map((e) => e.id), ['resp:r1']);
    assert.deepEqual((await db.listEvents({ from: 1000, to: 4000 })).map((e) => e.id), ['user:m1'], 'end is exclusive');
    db.close();
  });

  test('loading a conversation again replaces its events (no duplicates, removed branches go away) and updates the title', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000), user('m2', 'c1', 2000)]);
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000)]);
    await db.replaceConversation(conv('c1', { title: 'Renamed', serverUpdateTime: 9000 }), [user('m1', 'c1', 1000), done('r1', 'm1', 'c1', 3000)]);
    assert.deepEqual((await db.listEvents()).map((e) => e.id), ['user:m1', 'resp:r1']);
    assert.equal((await db.getConversation('c1')).title, 'Renamed');
    db.close();
  });

  test('replacing one conversation leaves the others alone', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000)]);
    await db.replaceConversation(conv('c2'), [user('m2', 'c2', 1000)]);
    await db.replaceConversation(conv('c1'), []);
    assert.deepEqual((await db.listEvents()).map((e) => e.id), ['user:m2']);
    db.close();
  });

  test('reports stored update times so unchanged conversations can be skipped', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1', { serverUpdateTime: 111 }), []);
    await db.replaceConversation(conv('c2', { serverUpdateTime: null }), []);
    assert.deepEqual(await db.knownUpdateTimes(), { c1: 111 });
    db.close();
  });

  test('exports everything and clears everything', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000), done('r1', 'm1', 'c1', 2000)]);
    const data = await db.exportAll();
    assert.equal(data.format, 'chatgpt-activity-timeline');
    assert.equal(data.schemaVersion, DB_VERSION);
    assert.equal(data.conversations.length, 1);
    assert.deepEqual(data.events.map((e) => e.id), ['user:m1', 'resp:r1']);
    await db.clearAll();
    assert.deepEqual(await db.stats(), { conversations: 0, events: 0, lastEventAt: null });
    db.close();
  });

  test('deletes one conversation and only its events', async () => {
    const db = await fresh();
    await db.replaceConversation(conv('c1'), [user('m1', 'c1', 1000)]);
    await db.replaceConversation(conv('c2'), [user('m2', 'c2', 1100)]);
    assert.equal(await db.deleteConversation('c1'), 1);
    assert.deepEqual((await db.listEvents()).map((e) => e.conversationId), ['c2']);
    assert.deepEqual((await db.listConversations()).map((c) => c.id), ['c2']);
    db.close();
  });

  test('rejects malformed events', async () => {
    const db = await fresh();
    await assert.rejects(db.replaceConversation(conv('c'), [{ id: 'x', conversationId: 'c', type: 'NOPE', timestamp: 1 }]));
    await assert.rejects(db.replaceConversation(conv('c'), [{ id: 'x', conversationId: 'c', type: EventType.USER_MESSAGE, timestamp: '2024-01-01' }]));
    await assert.rejects(db.replaceConversation(conv('c'), [user('m', 'other', 1)]), /another conversation/);
    assert.equal(await db.getConversation('c'), undefined, 'nothing written');
    db.close();
  });
});
