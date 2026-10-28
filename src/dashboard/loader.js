// Talks to the content script on a chatgpt.com tab to read history. Uses an
// open ChatGPT tab if there is one, otherwise opens one in the background
// and closes it afterwards.

import { HISTORY_PORT } from '../shared/constants.js';

const CHATGPT_URL = 'https://chatgpt.com/';

export class LoadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Connect to the content script in a tab; resolves with a port that answered
// "hello", or null if it did not within `ms`.
function tryConnect(tabs, tabId, ms) {
  return new Promise((resolve) => {
    let port;
    try {
      port = tabs.connect(tabId, { name: HISTORY_PORT });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      port.disconnect();
      resolve(null);
    }, ms);
    const onMessage = (m) => {
      if (m && m.type === 'hello') {
        clearTimeout(timer);
        port.onMessage.removeListener(onMessage);
        resolve(port);
      }
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve(null);
    });
    port.postMessage({ type: 'hello' });
  });
}

function checkAborted(signal) {
  if (signal?.aborted) throw new LoadError('aborted', 'Cancelled');
}

async function connectToChatGPT(tabs, { waitMs = 30000, onStatus = () => {}, signal } = {}) {
  const existing = (await tabs.query({ url: `${CHATGPT_URL}*` })).filter((t) => !t.discarded);
  for (const t of existing) {
    checkAborted(signal);
    const port = await tryConnect(tabs, t.id, 1500);
    if (port) return { port, tabId: t.id, created: false };
  }
  checkAborted(signal);
  onStatus('Opening chatgpt.com in a background tab…');
  const tab = await tabs.create({ url: CHATGPT_URL, active: false });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const port = await tryConnect(tabs, tab.id, 1500);
    if (port) return { port, tabId: tab.id, created: true };
    await new Promise((r) => setTimeout(r, 700));
  }
  await tabs.remove(tab.id).catch(() => {});
  checkAborted(signal);
  throw new LoadError('no-tab', 'Could not reach chatgpt.com. Open chatgpt.com, make sure you are signed in, reload that tab, and try again.');
}

// Reads conversations updated since `since`. `onConversation(conv)` is called
// for each changed conversation (text already removed); returns stats.
export async function loadHistory({ since, known, onConversation, onProgress = () => {}, tabs = chrome.tabs, signal }) {
  const { port, tabId, created } = await connectToChatGPT(tabs, { signal, onStatus: (s) => onProgress({ phase: 'connect', message: s }) });
  try {
    return await new Promise((resolve, reject) => {
      let pending = Promise.resolve();
      const abort = () => {
        port.disconnect();
        reject(new LoadError('aborted', 'Cancelled'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      port.onDisconnect.addListener(() => reject(new LoadError('disconnected', 'The chatgpt.com tab was closed or reloaded during loading. Try again.')));
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'progress') onProgress(m);
        else if (m.type === 'conversation') pending = pending.then(() => onConversation(m.conversation));
        else if (m.type === 'done') pending.then(() => resolve(m.stats), reject);
        else if (m.type === 'error') reject(new LoadError(m.code, m.message));
      });
      port.postMessage({ type: 'fetch', since, known });
    });
  } finally {
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    if (created) await tabs.remove(tabId).catch(() => {});
  }
}
