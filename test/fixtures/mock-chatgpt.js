// A small simulation of ChatGPT's conversation UI, using the markup the
// adapter expects (see src/content/chatgpt-adapter.js). It is NOT ChatGPT; it
// reproduces the observable behaviours the tracker relies on: optimistic user
// turns with message ids, the send/stop control swap, streaming assistant
// turns, URL assignment for new chats, regeneration, errors and SPA navigation.
(function () {
  const cfg = Object.assign({ assignIdMs: 200, firstTokenMs: 150, tokenMs: 40, tokens: 8 }, window.MOCK_CONFIG || {});
  const d = document;
  let counter = 0;
  let active = null; // the generation in progress

  const uuid = () =>
    (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now().toString(16)}-${(++counter).toString(16)}-0000-0000`);

  d.body.innerHTML = `
    <nav id="sidebar"></nav>
    <main>
      <div class="thread" id="thread"></div>
      <form id="composer" onsubmit="return false">
        <div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div>
        <button type="button" id="composer-submit-button" data-testid="send-button" aria-label="Send prompt">↑</button>
      </form>
    </main>`;
  const thread = d.getElementById('thread');
  const composer = d.getElementById('prompt-textarea');
  const button = d.getElementById('composer-submit-button');

  function setGenerating(on) {
    button.setAttribute('data-testid', on ? 'stop-button' : 'send-button');
    button.setAttribute('aria-label', on ? 'Stop streaming' : 'Send prompt');
  }

  function turn(role, id, html) {
    const a = d.createElement('article');
    a.setAttribute('data-testid', `conversation-turn-${thread.children.length + 1}`);
    a.innerHTML = `<div data-message-author-role="${role}" data-message-id="${id}"><div class="${role === 'assistant' ? 'markdown' : 'whitespace-pre-wrap'}">${html}</div></div>`;
    thread.appendChild(a);
    return a;
  }

  function conversationId() {
    const m = /\/c\/([^/]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function stream(article, { fail = false, tokens = cfg.tokens } = {}) {
    const body = article.querySelector('.markdown');
    body.classList.add('result-streaming');
    let n = 0;
    const gen = { article, timer: null, finish };
    active = gen;
    function finish(reason) {
      clearTimeout(gen.timer);
      body.classList.remove('result-streaming');
      if (reason === 'fail') article.insertAdjacentHTML('beforeend', '<div class="text-token-text-error">Something went wrong while generating the response.</div>');
      else article.insertAdjacentHTML('beforeend', '<div><button data-testid="copy-turn-action-button">Copy</button></div>');
      setGenerating(false);
      active = null;
      const id = conversationId();
      if (id && !d.querySelector(`#sidebar a[href="/c/${id}"]`)) {
        d.getElementById('sidebar').insertAdjacentHTML('afterbegin', `<a href="/c/${id}">Chat ${id.slice(0, 4)}</a>`);
        d.title = `Chat ${id.slice(0, 4)}`;
      }
      window.dispatchEvent(new CustomEvent('mock:done', { detail: { reason: reason || 'done' } }));
    }
    function tick() {
      if (n === 3 && fail) return finish('fail');
      if (n++ >= tokens) return finish();
      body.textContent += ` token${n}`;
      gen.timer = setTimeout(tick, cfg.tokenMs);
    }
    gen.timer = setTimeout(tick, cfg.tokenMs);
  }

  function respond(opts = {}) {
    setGenerating(true);
    setTimeout(() => stream(turn('assistant', uuid(), ''), opts), cfg.firstTokenMs);
  }

  function send(opts = {}) {
    if (active) return;
    const text = composer.textContent.trim();
    if (!text) return;
    composer.textContent = '';
    turn('user', uuid(), 'message');
    setGenerating(true);
    if (!conversationId()) setTimeout(() => history.pushState({}, '', `/c/${uuid()}`), cfg.assignIdMs);
    respond(opts);
  }

  d.addEventListener('click', (e) => {
    const b = e.target.closest('#composer-submit-button');
    if (!b) return;
    if (b.getAttribute('data-testid') === 'stop-button') active && active.finish('stopped');
    else send(window.__nextSendOptions || {});
  });
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(window.__nextSendOptions || {});
    }
  });

  window.mockChat = {
    type(text) { composer.textContent = text; },
    // Regenerate the last response: replace the assistant turn with a new one.
    regenerate() {
      const last = thread.lastElementChild;
      if (last && last.querySelector('[data-message-author-role="assistant"]')) last.remove();
      respond();
    },
    // SPA navigation to another conversation with static history.
    navigate(path, turns = 2) {
      if (active) { clearTimeout(active.timer); active = null; setGenerating(false); }
      history.pushState({}, '', path);
      thread.innerHTML = '';
      for (let i = 0; i < turns; i++) turn(i % 2 ? 'assistant' : 'user', uuid(), 'history');
    },
    get generating() { return !!active; },
  };
})();
