import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadHistory } from '../../src/dashboard/loader.js';
import { loadHistoryScript } from './history-harness.js';
import { ConversationBuilder, fakeBackend } from '../fixtures/backend-api.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

function event() {
  const fns = new Set();
  return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), fire: (...a) => [...fns].forEach((f) => f(...a)) };
}

// Fake chrome.tabs where tabs whose `ready` flag is set run the real content
// script logic against `backend`.
function fakeTabs(backend, { existing = [], readyAfterMs = 0 } = {}) {
  const { fetchHistory } = loadHistoryScript();
  const tabs = existing.map((t, i) => ({ id: i + 1, url: 'https://chatgpt.com/c/x', discarded: false, ready: true, ...t }));
  const removed = [];
  const api = {
    tabs,
    removed,
    async query() {
      return tabs.filter((t) => !removed.includes(t.id));
    },
    async create({ url }) {
      const tab = { id: 100 + tabs.length, url, ready: false };
      tabs.push(tab);
      setTimeout(() => (tab.ready = true), readyAfterMs);
      return tab;
    },
    async remove(id) {
      removed.push(id);
    },
    connect(tabId) {
      const tab = tabs.find((t) => t.id === tabId);
      const toPage = event();
      const toExt = event();
      const disconnect = event();
      let open = true;
      const ctrl = new AbortController();
      const port = {
        onMessage: toExt,
        onDisconnect: disconnect,
        postMessage(m) {
          if (!open) return;
          setTimeout(() => toPage.fire(m), 0);
        },
        disconnect() {
          open = false;
          ctrl.abort();
        },
      };
      if (!tab || !tab.ready) {
        setTimeout(() => disconnect.fire(), 0);
        return port;
      }
      const post = (m) => open && setTimeout(() => toExt.fire(JSON.parse(JSON.stringify(m))), 0);
      toPage.addListener(async (m) => {
        if (m.type === 'hello') post({ type: 'hello' });
        if (m.type === 'fetch') {
          try {
            await fetchHistory({ since: m.since, known: m.known, fetchImpl: backend.fetchImpl, doc: { cookie: '' }, post, signal: ctrl.signal });
          } catch (err) {
            post({ type: 'error', code: err.code, message: err.message });
          }
        }
      });
      return port;
    },
  };
  return api;
}

function convs(n) {
  return Array.from({ length: n }, (_, i) => {
    const b = new ConversationBuilder({ createdAt: NOW - i * 3600e3 - 60e3 });
    b.exchange(NOW - i * 3600e3 - 50e3, NOW - i * 3600e3 - 40e3, NOW - i * 3600e3 - 30e3);
    return b;
  });
}

describe('dashboard loader', () => {
  test('uses an open chatgpt.com tab and delivers every conversation', async () => {
    const tabs = fakeTabs(fakeBackend(convs(4)), { existing: [{}] });
    const got = [];
    const stats = await loadHistory({ since: NOW - 86400e3, known: {}, tabs, onConversation: async (c) => got.push(c.id) });
    assert.equal(stats.fetched, 4);
    assert.equal(got.length, 4);
    assert.deepEqual(tabs.removed, [], 'does not close the user\'s tab');
  });

  test('opens chatgpt.com in a background tab when none is usable, then closes it', async () => {
    const tabs = fakeTabs(fakeBackend(convs(2)), { existing: [{ discarded: true }], readyAfterMs: 1000 });
    const statuses = [];
    const stats = await loadHistory({ since: NOW - 86400e3, known: {}, tabs, onConversation: async () => {}, onProgress: (p) => statuses.push(p.phase) });
    assert.equal(stats.fetched, 2);
    assert.equal(tabs.tabs.length, 2);
    assert.deepEqual(tabs.removed, [tabs.tabs[1].id]);
    assert.ok(statuses.includes('connect'));
  });

  test('errors from chatgpt.com are reported (signed out)', async () => {
    const tabs = fakeTabs(fakeBackend(convs(2), { signedIn: false }), { existing: [{}] });
    await assert.rejects(loadHistory({ since: 0, known: {}, tabs, onConversation: async () => {} }), (e) => e.code === 'auth');
  });

  test('waits for each conversation to be stored before reporting completion', async () => {
    const tabs = fakeTabs(fakeBackend(convs(3)), { existing: [{}] });
    let stored = 0;
    await loadHistory({ since: 0, known: {}, tabs, onConversation: async () => { await new Promise((r) => setTimeout(r, 20)); stored++; } });
    assert.equal(stored, 3);
  });

  test('cancel during loading stops it', async () => {
    const tabs = fakeTabs(fakeBackend(convs(30)), { existing: [{}] });
    const ctrl = new AbortController();
    let stored = 0;
    const onConversation = async () => {
      stored++;
      if (stored === 2) ctrl.abort();
      await new Promise((r) => setTimeout(r, 5));
    };
    await assert.rejects(loadHistory({ since: 0, known: {}, tabs, signal: ctrl.signal, onConversation }), (e) => e.code === 'aborted');
    assert.ok(stored < 30);
  });

  test('cancel while still connecting is honoured', async () => {
    const tabs = fakeTabs(fakeBackend(convs(3)), { existing: [{}] });
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(loadHistory({ since: 0, known: {}, tabs, signal: ctrl.signal, onConversation: async () => {} }), (e) => e.code === 'aborted');
  });
});
