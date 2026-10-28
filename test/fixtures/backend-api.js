// Builds responses shaped like ChatGPT's /backend-api conversation endpoints
// (message tree in `mapping`, times in epoch seconds, text in content.parts)
// for tests. Field names follow the web app's API; values are synthetic.

let seq = 0;
const nid = (p) => `${p}-${(++seq).toString(16).padStart(4, '0')}-4000-8000-${Date.now().toString(16).slice(-12).padStart(12, '0')}`;

export class ConversationBuilder {
  constructor({ id = nid('conv'), title = 'Test conversation', createdAt }) {
    this.id = id;
    this.title = title;
    this.mapping = {};
    this.rootId = nid('root');
    this.mapping[this.rootId] = { id: this.rootId, message: null, parent: null, children: [] };
    // ChatGPT starts trees with a hidden system message.
    this.lastId = this.node(this.rootId, { role: 'system', t: createdAt / 1000, hidden: true, text: '' });
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  node(parent, { role, t, updated = null, text = 'secret text', status = 'finished_successfully', finish = 'stop', hidden = false, contentType = 'text', id = nid(role) }) {
    this.mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role, name: null, metadata: {} },
        create_time: t,
        update_time: updated,
        content: { content_type: contentType, parts: [text] },
        status,
        end_turn: role === 'assistant' ? true : null,
        weight: 1,
        metadata: { ...(finish ? { finish_details: { type: finish } } : {}), ...(hidden ? { is_visually_hidden_from_conversation: true } : {}) },
        recipient: 'all',
      },
    };
    this.mapping[parent].children.push(id);
    const ms = (updated ?? t) * 1000;
    if (ms > this.updatedAt) this.updatedAt = ms;
    return id;
  }

  // A user message (ms) and its response: [startMs, endMs]. Returns ids.
  exchange(sentMs, startMs, endMs, { parent = this.lastId, status, finish, withUpdate = true, tool = false } = {}) {
    const u = this.node(parent, { role: 'user', t: sentMs / 1000, text: 'private question', finish: null });
    let p = u;
    if (tool) {
      p = this.node(p, { role: 'assistant', t: startMs / 1000, text: 'call', contentType: 'code', finish: null });
      p = this.node(p, { role: 'tool', t: (startMs + 500) / 1000, text: 'tool output' });
    }
    const a = this.node(p, {
      role: 'assistant',
      t: (tool ? startMs + 1000 : startMs) / 1000,
      updated: withUpdate ? endMs / 1000 : null,
      text: 'private answer',
      status,
      finish,
    });
    this.lastId = a;
    return { user: u, assistant: tool ? this.mapping[u].children[0] : a, last: a };
  }

  // Another response attempt for the same user message (regenerate).
  regenerate(userId, startMs, endMs) {
    const a = this.node(userId, { role: 'assistant', t: startMs / 1000, updated: endMs / 1000, text: 'other answer' });
    this.lastId = a;
    return a;
  }

  detail() {
    return {
      conversation_id: this.id,
      title: this.title,
      create_time: this.createdAt / 1000,
      update_time: this.updatedAt / 1000,
      mapping: this.mapping,
      current_node: this.lastId,
      moderation_results: [],
      is_archived: false,
    };
  }

  listItem() {
    return {
      id: this.id,
      title: this.title,
      create_time: new Date(this.createdAt).toISOString(),
      update_time: new Date(this.updatedAt).toISOString(),
      is_archived: false,
    };
  }
}

// A fake fetch serving /api/auth/session and /backend-api for `convs`.
export function fakeBackend(convs, { token = 'tok', signedIn = true, failDetail = {}, rateLimitOnce = false } = {}) {
  const calls = [];
  let limited = false;
  const json = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization });
    const u = new URL(url, 'https://chatgpt.com');
    if (u.pathname === '/api/auth/session') return json(signedIn ? { user: { id: 'u' }, accessToken: token } : {});
    if (init.headers?.Authorization !== `Bearer ${token}`) return json({ detail: 'Unauthorized' }, 401);
    if (rateLimitOnce && !limited) {
      limited = true;
      return json({}, 429, { 'retry-after': '0.01' });
    }
    if (u.pathname === '/backend-api/conversations') {
      const offset = Number(u.searchParams.get('offset'));
      const limit = Number(u.searchParams.get('limit'));
      const sorted = [...convs].sort((a, b) => b.updatedAt - a.updatedAt);
      return json({ items: sorted.slice(offset, offset + limit).map((c) => c.listItem()), total: sorted.length, limit, offset });
    }
    const m = /^\/backend-api\/conversation\/(.+)$/.exec(u.pathname);
    if (m) {
      if (failDetail[m[1]]) return json({}, failDetail[m[1]]);
      const c = convs.find((x) => x.id === decodeURIComponent(m[1]));
      return c ? json(c.detail()) : json({ detail: 'not found' }, 404);
    }
    return json({}, 404);
  };
  return { fetchImpl, calls };
}
