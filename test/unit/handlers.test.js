import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineDB } from '../../src/shared/db.js';
import { handleMessage } from '../../src/background/handlers.js';
import { Msg, EventType } from '../../src/shared/constants.js';

// A "service worker instance": its own lazily opened DB connection, like the
// real worker. Creating a new one simulates suspension and restart.
function worker(factory) {
  let db = null;
  const changes = [];
  const ctx = {
    getDB: async () => (db ??= await TimelineDB.open({ factory })),
    notifyChanged: () => changes.push(1),
  };
  return { send: (type, payload) => handleMessage({ type, payload }, ctx), changes, close: () => db?.close() };
}

const userEvent = (id, conv, t) => ({ kind: 'event', event: { id: `user:${id}`, conversationId: conv, type: EventType.USER_MESSAGE, timestamp: t, timestampSource: 'submit-intent', messageId: id }, conversation: { id: conv, title: 'T', url: `https://chatgpt.com/c/${conv}` } });

describe('service worker message handling', () => {
  test('stores events and reports status', async () => {
    const w = worker(new IDBFactory());
    const res = await w.send(Msg.TRACKER_EVENT, userEvent('m1', 'c1', 1000));
    assert.deepEqual(res, { ok: true, stored: true });
    assert.equal(w.changes.length, 1);
    const status = await w.send(Msg.GET_STATUS);
    assert.equal(status.events, 1);
    assert.equal(status.lastEventAt, 1000);
    assert.equal(status.paused, false);
    w.close();
  });

  test('only whitelisted metadata is persisted', async () => {
    const factory = new IDBFactory();
    const w = worker(factory);
    const m = userEvent('m1', 'c1', 1000);
    m.event.text = 'secret message body';
    m.conversation.url = 'javascript:alert(1)';
    await w.send(Msg.TRACKER_EVENT, m);
    const db = await TimelineDB.open({ factory });
    const [e] = await db.listEvents();
    assert.equal(e.text, undefined);
    assert.equal((await db.getConversation('c1')).url, '');
    db.close();
    w.close();
  });

  test('paused tracking drops events', async () => {
    const w = worker(new IDBFactory());
    await w.send(Msg.SET_PAUSED, { paused: true });
    const res = await w.send(Msg.TRACKER_EVENT, userEvent('m1', 'c1', 1000));
    assert.equal(res.stored, false);
    assert.equal((await w.send(Msg.GET_STATUS)).events, 0);
    w.close();
  });

  test('rebind only accepts provisional source ids', async () => {
    const w = worker(new IDBFactory());
    assert.equal((await w.send(Msg.TRACKER_REBIND, { from: 'c-real', to: 'c2' })).ok, false);
    await w.send(Msg.TRACKER_EVENT, userEvent('m1', 'tmp-x', 1000));
    assert.equal((await w.send(Msg.TRACKER_REBIND, { from: 'tmp-x', to: 'c2', conversation: { id: 'c2', title: 'New' } })).moved, 1);
    w.close();
  });

  test('suspension and restart: a new worker instance sees and dedupes earlier data', async () => {
    const factory = new IDBFactory();
    const w1 = worker(factory);
    await w1.send(Msg.TRACKER_EVENT, userEvent('m1', 'c1', 1000));
    w1.close(); // worker suspended
    const w2 = worker(factory); // worker restarted by the next message
    const again = await w2.send(Msg.TRACKER_EVENT, userEvent('m1', 'c1', 1000));
    assert.equal(again.stored, false, 'the content script retrying after restart does not duplicate');
    await w2.send(Msg.TRACKER_EVENT, userEvent('m2', 'c1', 2000));
    assert.equal((await w2.send(Msg.GET_STATUS)).events, 2);
    w2.close();
  });

  test('unknown messages are rejected', async () => {
    const w = worker(new IDBFactory());
    assert.equal((await w.send('nope')).ok, false);
    w.close();
  });
});
