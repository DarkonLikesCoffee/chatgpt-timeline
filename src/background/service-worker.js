// Manifest V3 service worker. Stateless by design: every message is handled
// by opening (or reusing) the IndexedDB connection and writing immediately,
// so the worker can be suspended or restarted at any time without losing data.

import { TimelineDB } from '../shared/db.js';
import { Msg } from '../shared/constants.js';
import { handleMessage } from './handlers.js';

// Lets status consumers (and tests) see when the worker was last (re)started.
const workerStartedAt = Date.now();
let dbPromise = null;
function getDB() {
  if (!dbPromise) {
    dbPromise = TimelineDB.open().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function notifyChanged() {
  // Open dashboards refresh on this; no receiver is not an error.
  chrome.runtime.sendMessage({ type: Msg.DB_CHANGED }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.type === Msg.DB_CHANGED) return false;
  // Only accept tracker messages from our own content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(message, {
    getDB,
    notifyChanged,
    workerStartedAt,
    openDashboard: () => chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') }),
  })
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});
