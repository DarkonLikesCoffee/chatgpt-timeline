// Content script on chatgpt.com. Idle until the extension's dashboard
// connects; then it reads the signed-in user's conversation history through
// the same internal endpoints the ChatGPT web app uses, strips all message
// text, and streams the result back over the port.
//
// Privacy: the session token stays in this function's memory and is never
// sent to the extension. Only ids, roles, timestamps, statuses and
// conversation titles leave this script.
//
// Note: /backend-api is ChatGPT's internal, undocumented API. It can change
// or reject requests at any time; errors are reported to the dashboard.
(() => {
  const PORT = 'chatgpt-history';
  const PAGE_SIZE = 28;
  const MAX_PAGES = 300;
  const CONCURRENCY = 3;

  class HistoryError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? Math.round(v * 1000) : Math.round(v)) : null;
    if (typeof v === 'string') {
      if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : null;
    }
    return null;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new HistoryError('aborted', 'Cancelled'));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new HistoryError('aborted', 'Cancelled'));
      }, { once: true });
    });
  }

  function deviceId(doc) {
    const m = /(?:^|;\s*)oai-did=([^;]+)/.exec((doc && doc.cookie) || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function getJson(fetchImpl, url, headers, signal, retries = 4) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new HistoryError('aborted', 'Cancelled');
      let res;
      try {
        res = await fetchImpl(url, { headers, credentials: 'include', signal });
      } catch (err) {
        if (signal?.aborted) throw new HistoryError('aborted', 'Cancelled');
        if (attempt < retries) {
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        throw new HistoryError('network', `Network error for ${url}: ${err && err.message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1500 * 2 ** attempt, signal);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new HistoryError('auth', `ChatGPT refused the request (${res.status}). Make sure you are signed in at chatgpt.com, then reload that tab.`, res.status);
      }
      if (res.status === 404) return null;
      if (res.status === 429) throw new HistoryError('rate-limited', 'ChatGPT is rate-limiting requests. Try again in a few minutes, or load a shorter period.', 429);
      if (!res.ok) throw new HistoryError('http', `ChatGPT answered ${res.status} for ${url.split('?')[0]}.`, res.status);
      const type = res.headers.get('content-type') || '';
      if (!type.includes('json')) throw new HistoryError('unexpected', `Unexpected response for ${url.split('?')[0]} (not JSON). You may be signed out or shown a verification page.`);
      return res.json();
    }
  }

  // Keep only what the timeline needs; no message content.
  function strip(detail, fallbackId) {
    const nodes = [];
    for (const [key, node] of Object.entries((detail && detail.mapping) || {})) {
      const m = node && node.message;
      nodes.push({
        id: (node && node.id) || key,
        parent: (node && node.parent) ?? null,
        children: Array.isArray(node && node.children) ? node.children.slice() : [],
        role: (m && m.author && m.author.role) ?? null,
        create_time: (m && m.create_time) ?? null,
        update_time: (m && m.update_time) ?? null,
        status: (m && m.status) ?? null,
        finish_type: (m && m.metadata && m.metadata.finish_details && m.metadata.finish_details.type) ?? null,
        hidden: !!(m && m.metadata && m.metadata.is_visually_hidden_from_conversation),
        content_type: (m && m.content && m.content.content_type) ?? null,
      });
    }
    return {
      id: (detail && detail.conversation_id) || fallbackId,
      title: detail && typeof detail.title === 'string' ? detail.title : '',
      create_time: (detail && detail.create_time) ?? null,
      update_time: (detail && detail.update_time) ?? null,
      nodes,
    };
  }

  // Lists conversations updated at or after `since` (epoch ms), then fetches
  // each one that changed since the stored copy (`known`: id -> update ms).
  async function fetchHistory({ since, known = {}, fetchImpl, doc, post, signal }) {
    const session = await getJson(fetchImpl, '/api/auth/session', {}, signal);
    const token = session && session.accessToken;
    if (!token) throw new HistoryError('auth', 'Not signed in to ChatGPT in this browser. Sign in at chatgpt.com and try again.');
    const headers = { Authorization: `Bearer ${token}` };
    const did = deviceId(doc);
    if (did) headers['oai-device-id'] = did;

    const items = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const data = await getJson(fetchImpl, `/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated`, headers, signal);
      const list = (data && Array.isArray(data.items) && data.items) || [];
      for (const it of list) {
        const updated = toMs(it.update_time) ?? toMs(it.create_time);
        if (it && it.id && (updated == null || updated >= since)) items.push({ id: it.id, updated });
      }
      offset += list.length;
      post({ type: 'progress', phase: 'list', listed: items.length });
      // Sorted by last update: once a page ends before `since`, the rest is older.
      const last = list[list.length - 1];
      const lastUpdated = last ? toMs(last.update_time) ?? toMs(last.create_time) : null;
      if (!list.length || (lastUpdated != null && lastUpdated < since) || (data && data.total != null && offset >= data.total)) break;
    }

    const todo = [];
    let unchanged = 0;
    for (const it of items) {
      const k = known[it.id];
      if (k != null && it.updated != null && Math.abs(k - it.updated) < 2) {
        unchanged++;
        post({ type: 'unchanged', id: it.id });
      } else {
        todo.push(it);
      }
    }

    let fetched = 0;
    let missing = 0;
    let failed = 0;
    let next = 0;
    post({ type: 'progress', phase: 'details', done: 0, total: todo.length, unchanged });
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        let detail;
        try {
          detail = await getJson(fetchImpl, `/backend-api/conversation/${encodeURIComponent(it.id)}`, headers, signal);
        } catch (err) {
          // Stop on problems that affect every request; skip a single bad one.
          if (['auth', 'aborted', 'rate-limited'].includes(err.code)) throw err;
          failed++;
          detail = undefined;
        }
        if (detail === undefined) {
          // counted in `failed`
        } else if (!detail) missing++;
        else {
          fetched++;
          post({ type: 'conversation', conversation: strip(detail, it.id) });
        }
        post({ type: 'progress', phase: 'details', done: fetched + missing + failed, total: todo.length, unchanged });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    const stats = { listed: items.length, fetched, unchanged, missing, failed };
    post({ type: 'done', stats });
    return stats;
  }

  globalThis.ChatGPTHistory = { fetchHistory, strip, toMs, HistoryError };

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT) return;
      const ctrl = new AbortController();
      port.onDisconnect.addListener(() => ctrl.abort());
      const post = (m) => {
        if (!ctrl.signal.aborted) port.postMessage(m);
      };
      port.onMessage.addListener(async (msg) => {
        if (!msg) return;
        if (msg.type === 'hello') post({ type: 'hello' });
        else if (msg.type === 'fetch') {
          try {
            await fetchHistory({ since: msg.since, known: msg.known || {}, fetchImpl: fetch.bind(globalThis), doc: document, post, signal: ctrl.signal });
          } catch (err) {
            post({ type: 'error', code: err.code || 'unexpected', message: err.message || String(err), status: err.status ?? null });
          }
        }
      });
    });
  }
})();
