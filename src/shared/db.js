// IndexedDB persistence for conversations and events.
//
// The database is owned by the extension origin, so the service worker and the
// dashboard open the same database. Every write is a single IndexedDB
// transaction; nothing is kept only in memory, so service-worker suspension
// cannot lose data.

import { SOURCE_RANK, RESPONSE_TYPES } from './constants.js';

export const DB_NAME = 'chatgpt-activity-timeline';

// Each migration upgrades the schema from version (index) to (index + 1).
// Never edit a released migration; append a new one instead.
export const MIGRATIONS = [
  // v1: initial stores.
  (db) => {
    const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
    conversations.createIndex('lastActivityAt', 'lastActivityAt');
    const events = db.createObjectStore('events', { keyPath: 'id' });
    events.createIndex('conversationId', 'conversationId');
    events.createIndex('timestamp', 'timestamp');
  },
  // v2: lookups by request message, per-conversation time ranges, settings.
  (db, tx) => {
    const events = tx.objectStore('events');
    events.createIndex('requestMessageId', 'requestMessageId');
    events.createIndex('conversationId_timestamp', ['conversationId', 'timestamp']);
    db.createObjectStore('meta', { keyPath: 'key' });
  },
];

export const DB_VERSION = MIGRATIONS.length;

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export function openDatabase({ factory = globalThis.indexedDB, name = DB_NAME, migrations = MIGRATIONS } = {}) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, migrations.length);
    request.onupgradeneeded = (e) => {
      const db = request.result;
      const tx = request.transaction;
      for (let v = e.oldVersion; v < migrations.length; v++) migrations[v](db, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version of the extension (e.g. another open dashboard) upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database upgrade blocked by another open connection'));
  });
}

// Decide which of two reports of the same event to keep. Better timestamp
// sources win; between equal sources the earliest observation wins.
export function preferEvent(existing, incoming) {
  if (!existing) return incoming;
  const a = SOURCE_RANK[existing.timestampSource] || 0;
  const b = SOURCE_RANK[incoming.timestampSource] || 0;
  if (b !== a) return b > a ? incoming : existing;
  return incoming.timestamp < existing.timestamp ? incoming : existing;
}

function mergeConversation(existing, conv, activityAt) {
  const base = existing || {
    id: conv.id,
    title: '',
    url: '',
    firstObservedAt: activityAt ?? Date.now(),
    lastActivityAt: activityAt ?? 0,
  };
  const next = { ...base };
  if (conv.title) next.title = conv.title;
  if (conv.url) next.url = conv.url;
  if (activityAt != null) {
    next.firstObservedAt = Math.min(next.firstObservedAt, activityAt);
    next.lastActivityAt = Math.max(next.lastActivityAt || 0, activityAt);
  }
  return next;
}

export class TimelineDB {
  constructor(db) {
    this.db = db;
  }

  static async open(options) {
    return new TimelineDB(await openDatabase(options));
  }

  close() {
    this.db.close();
  }

  // Store one event and update its conversation. Returns { stored, event }.
  // `stored` is false when an equal or better report already existed.
  async recordEvent(event, conversation) {
    validateEvent(event);
    const tx = this.db.transaction(['events', 'conversations'], 'readwrite');
    const events = tx.objectStore('events');
    const convs = tx.objectStore('conversations');
    const existing = await req(events.get(event.id));
    const keep = preferEvent(existing, event);
    const stored = keep === event;
    if (stored) {
      events.put(keep);
      const conv = await req(convs.get(event.conversationId));
      convs.put(mergeConversation(conv, { ...conversation, id: event.conversationId }, event.timestamp));
    } else if (conversation?.title) {
      const conv = await req(convs.get(event.conversationId));
      if (conv && conv.title !== conversation.title) convs.put({ ...conv, title: conversation.title });
    }
    await done(tx);
    return { stored, event: keep };
  }

  // Update title/url of a conversation that already has activity. Visiting a
  // conversation never creates a record by itself.
  async updateConversationMeta(conversation) {
    const tx = this.db.transaction('conversations', 'readwrite');
    const store = tx.objectStore('conversations');
    const existing = await req(store.get(conversation.id));
    let changed = false;
    if (existing) {
      const next = mergeConversation(existing, conversation, null);
      changed = next.title !== existing.title || next.url !== existing.url;
      if (changed) store.put(next);
    }
    await done(tx);
    return changed;
  }

  // Move events recorded under a provisional id (a new chat before ChatGPT
  // assigned its URL) to the real conversation id.
  async rebindConversation(fromId, toId, conversation = {}) {
    if (fromId === toId) return 0;
    const tx = this.db.transaction(['events', 'conversations'], 'readwrite');
    const events = tx.objectStore('events');
    const convs = tx.objectStore('conversations');
    const moved = await req(events.index('conversationId').getAll(fromId));
    for (const e of moved) events.put({ ...e, conversationId: toId });
    const from = await req(convs.get(fromId));
    let to = await req(convs.get(toId));
    if (from) {
      to = mergeConversation(to, { id: toId }, from.firstObservedAt);
      to = mergeConversation(to, { id: toId }, from.lastActivityAt);
      if (!to.title && from.title) to.title = from.title;
      convs.delete(fromId);
    }
    if (to || moved.length) {
      to = mergeConversation(to, { ...conversation, id: toId }, null);
      convs.put(to);
    }
    await done(tx);
    return moved.length;
  }

  async getConversation(id) {
    return req(this.db.transaction('conversations').objectStore('conversations').get(id));
  }

  async listConversations() {
    return req(this.db.transaction('conversations').objectStore('conversations').getAll());
  }

  async getEvent(id) {
    return req(this.db.transaction('events').objectStore('events').get(id));
  }

  // All events, or those with from <= timestamp < to.
  async listEvents({ from, to } = {}) {
    const index = this.db.transaction('events').objectStore('events').index('timestamp');
    if (from == null && to == null) return req(index.getAll());
    const range = IDBKeyRangeFor(index, from ?? -Infinity, to ?? Infinity);
    return req(index.getAll(range));
  }

  async listConversationEvents(conversationId) {
    const store = this.db.transaction('events').objectStore('events');
    const range = IDBKeyRangeFor(store, [conversationId, -Infinity], [conversationId, Infinity]);
    return req(store.index('conversationId_timestamp').getAll(range));
  }

  async deleteConversation(id) {
    const tx = this.db.transaction(['events', 'conversations'], 'readwrite');
    const events = tx.objectStore('events');
    const keys = await req(events.index('conversationId').getAllKeys(id));
    for (const k of keys) events.delete(k);
    tx.objectStore('conversations').delete(id);
    await done(tx);
    return keys.length;
  }

  async clearAll() {
    const tx = this.db.transaction(['events', 'conversations'], 'readwrite');
    tx.objectStore('events').clear();
    tx.objectStore('conversations').clear();
    await done(tx);
  }

  async exportAll() {
    const tx = this.db.transaction(['events', 'conversations']);
    const [conversations, events] = await Promise.all([
      req(tx.objectStore('conversations').getAll()),
      req(tx.objectStore('events').index('timestamp').getAll()),
    ]);
    return {
      format: 'chatgpt-activity-timeline',
      schemaVersion: this.db.version,
      exportedAt: new Date().toISOString(),
      conversations,
      events,
    };
  }

  async stats() {
    const tx = this.db.transaction(['events', 'conversations']);
    const [conversations, events, last] = await Promise.all([
      req(tx.objectStore('conversations').count()),
      req(tx.objectStore('events').count()),
      new Promise((resolve, reject) => {
        const r = tx.objectStore('events').index('timestamp').openCursor(null, 'prev');
        r.onsuccess = () => resolve(r.result ? r.result.value : null);
        r.onerror = () => reject(r.error);
      }),
    ]);
    return { conversations, events, lastEventAt: last ? last.timestamp : null };
  }

  async getSetting(key, fallback) {
    const row = await req(this.db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : fallback;
  }

  async setSetting(key, value) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await done(tx);
  }
}

// Builds a key range using the IDBKeyRange that belongs to the same
// IndexedDB implementation as `source` (matters for tests with fake-indexeddb).
function IDBKeyRangeFor(source, lower, upper) {
  const KR = globalThis.IDBKeyRange;
  const fix = (v) => (v === -Infinity ? -Number.MAX_VALUE : v === Infinity ? Number.MAX_VALUE : v);
  const lo = Array.isArray(lower) ? lower.map(fix) : fix(lower);
  const hi = Array.isArray(upper) ? upper.map(fix) : fix(upper);
  return KR.bound(lo, hi, false, !Array.isArray(upper) && upper !== Infinity);
}

const EVENT_TYPES = new Set(['USER_MESSAGE', ...RESPONSE_TYPES]);

export function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new TypeError('event must be an object');
  if (typeof e.id !== 'string' || !e.id) throw new TypeError('event.id required');
  if (typeof e.conversationId !== 'string' || !e.conversationId) throw new TypeError('event.conversationId required');
  if (!EVENT_TYPES.has(e.type)) throw new TypeError(`unknown event type ${e.type}`);
  if (!Number.isFinite(e.timestamp)) throw new TypeError('event.timestamp must be epoch milliseconds');
}
