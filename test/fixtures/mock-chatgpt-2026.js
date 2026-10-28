// Simulation of the chatgpt.com conversation UI as observed in a user's
// diagnostics on 2026-10-28 (Spanish UI): turns keyed by the user message id
// (data-turn-key) holding a user unit and an assistant unit, a per-turn state
// attribute (data-talvt-turn-state), no data-testid on composer buttons, and
// localized labels on the primary composer button, which is replaced (not
// relabelled) when it changes between voice / send / stop.
//
// Unknowns are configurable: what the turn state is while streaming
// (cfg.streamingState) and when the assistant message id appears
// (cfg.assistantIdAfterTokens). It is NOT ChatGPT.
(function () {
  const cfg = Object.assign(
    { assignIdMs: 200, firstTokenMs: 150, tokenMs: 40, tokens: 8, streamingState: 'streaming', assistantIdAfterTokens: 2 },
    window.MOCK_CONFIG || {},
  );
  const d = document;
  let counter = 0;
  let turnIndex = 0;
  let active = null;
  const uuid = () =>
    (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${(++counter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);

  d.body.innerHTML = `
    <main data-app-shell-main-surface="browser">
      <div class="thread-scroll-container" role="region">
        <div data-thread-find-target="conversation"><div class="flex flex-col" id="thread"></div></div>
      </div>
      <div data-thread-scroll-footer="true">
        <form data-chatgpt-composer="" onsubmit="return false">
          <div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Chatea con ChatGPT"><p></p></div>
          <div class="ComposerLayoutFooter-_8IVRO" id="footer">
            <button type="button" aria-label="Añadir archivos y más"></button>
            <button type="button" aria-label="Dictar"></button>
          </div>
        </form>
      </div>
    </main>
    <div hidden inert><section role="dialog" aria-label="Chat flotante">
      <div data-turn-key="99999999-0000-4000-8000-000000000009"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="99999999-0000-4000-8000-000000000009"></div></div>
    </section></div>`;
  const thread = d.getElementById('thread');
  const footer = d.getElementById('footer');
  const composer = d.querySelector('.ProseMirror');

  // The primary button is a new element each time its role changes.
  function setPrimary(kind) {
    footer.querySelector('.size-token-button-composer')?.remove();
    const label = { voice: 'Iniciar Voz', send: 'Enviar mensaje', stop: 'Detener' }[kind];
    footer.insertAdjacentHTML('beforeend', `<button type="button" class="cursor-interaction size-token-button-composer flex shrink-0" aria-label="${label}" data-kind="${kind}"><svg><path d=""></path></svg></button>`);
  }
  setPrimary('voice');

  function conversationId() {
    const m = /\/c\/([^/]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function userUnit(i, id) {
    return `<div class="block-BQZwFn"><h4 class="sr-only" data-conversation-role="user"><span>Has dicho:</span></h4>
      <div class="group/user-message" data-chatgpt-search-unit-key="fallback-turn-${i}:0:user" data-chatgpt-search-message-ids="${id}">
        <div class="w-full" data-content-search-unit-key="fallback-turn-${i}:0:user"><div data-user-message-bubble="true"><div>mensaje</div></div></div>
      </div></div>`;
  }

  function assistantUnit(i, id) {
    const idAttr = id ? ` data-chatgpt-selection-message-id="${id}"` : '';
    return `<div class="block-BQZwFn assistant"><span hidden data-chatgpt-agent-turn-start=""></span>
      <div data-content-search-unit-key="fallback-turn-${i}:1:assistant" data-chatgpt-search-unit-key="fallback-turn-${i}:1:assistant" data-chatgpt-search-message-ids="">
        <h4 class="sr-only" data-conversation-role="assistant"><span>ChatGPT ha dicho:</span></h4>
        <div><div class="group flex min-w-0 flex-col"${idAttr}><div class="MarkdownRoot-rZKhxa" data-markdown-text-style="assistant-message"><p></p></div></div></div>
      </div></div>`;
  }

  function addTurn(userId, state) {
    const i = turnIndex++;
    const wrap = d.createElement('div');
    wrap.innerHTML = `<div data-turn-key="${userId}"><div data-content-search-turn-key="fallback-turn-${i}"><div class="flex flex-col gap-1.5">
      <div class="group flex flex-col" data-talvt-turn-state="${state}"><div class="flex flex-col gap-3 blocks">${userUnit(i, userId)}</div></div>
    </div></div></div>`;
    thread.appendChild(wrap);
    return { wrap, i, stateEl: wrap.querySelector('[data-talvt-turn-state]'), blocks: wrap.querySelector('.blocks') };
  }

  function stream(turn, { fail = false, tokens = cfg.tokens } = {}) {
    turn.blocks.querySelector('.assistant')?.remove();
    turn.blocks.insertAdjacentHTML('beforeend', assistantUnit(turn.i, cfg.assistantIdAfterTokens === 0 ? uuid() : null));
    turn.stateEl.setAttribute('data-talvt-turn-state', cfg.streamingState);
    const unit = turn.blocks.querySelector('.assistant');
    const body = unit.querySelector('p');
    let n = 0;
    const gen = { timer: null, finish };
    active = gen;
    function finish(reason) {
      clearTimeout(gen.timer);
      if (!unit.querySelector('[data-chatgpt-selection-message-id]')) unit.querySelector('.group').setAttribute('data-chatgpt-selection-message-id', uuid());
      if (reason === 'fail') {
        turn.stateEl.setAttribute('data-talvt-turn-state', 'error');
        unit.insertAdjacentHTML('beforeend', '<div class="text-token-text-error">Algo salió mal.</div>');
      } else {
        turn.stateEl.setAttribute('data-talvt-turn-state', 'complete');
        turn.stateEl.insertAdjacentHTML('beforeend', '<div class="actionRow-nqqZbm turn-action-controls"><button type="button" aria-label="Copiar"></button><button type="button" aria-label="Regenerar respuesta"></button></div>');
      }
      setPrimary(composer.textContent.trim() ? 'send' : 'voice');
      active = null;
      if (conversationId()) d.title = `Chat ${conversationId().slice(0, 4)}`;
      window.dispatchEvent(new CustomEvent('mock:done', { detail: { reason: reason || 'done' } }));
    }
    function tick() {
      if (n === 3 && fail) return finish('fail');
      if (n++ >= tokens) return finish();
      if (n === cfg.assistantIdAfterTokens) unit.querySelector('.group').setAttribute('data-chatgpt-selection-message-id', uuid());
      body.insertAdjacentHTML('beforeend', `<span data-d-stream-word="">palabra${n} </span>`);
      gen.timer = setTimeout(tick, cfg.tokenMs);
    }
    gen.timer = setTimeout(tick, cfg.tokenMs);
  }

  let lastTurn = null;
  function send(opts = {}) {
    if (active) return;
    if (!composer.textContent.trim()) return;
    composer.innerHTML = '<p></p>';
    lastTurn = addTurn(uuid(), 'pending');
    setPrimary('stop');
    if (!conversationId()) setTimeout(() => history.pushState({}, '', `/c/${uuid()}`), cfg.assignIdMs);
    const t = lastTurn;
    setTimeout(() => stream(t, opts), cfg.firstTokenMs);
  }

  d.addEventListener('click', (e) => {
    const b = e.target.closest('.size-token-button-composer');
    if (!b) return;
    if (b.dataset.kind === 'stop') active && active.finish('stopped');
    else if (b.dataset.kind === 'send') send(window.__nextSendOptions || {});
  });
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(window.__nextSendOptions || {});
    }
  });

  window.mockChat = {
    primarySelector: '.size-token-button-composer',
    type(text) {
      composer.innerHTML = `<p>${text}</p>`;
      if (!active) setPrimary('send');
    },
    regenerate() {
      setPrimary('stop');
      const t = lastTurn;
      setTimeout(() => stream(t), cfg.firstTokenMs);
    },
    navigate(path, turns = 2) {
      if (active) { clearTimeout(active.timer); active = null; setPrimary('voice'); }
      history.pushState({}, '', path);
      thread.innerHTML = '';
      turnIndex = 0;
      for (let k = 0; k < Math.ceil(turns / 2); k++) {
        const t = addTurn(uuid(), 'complete');
        t.blocks.insertAdjacentHTML('beforeend', assistantUnit(t.i, uuid()));
        lastTurn = t;
      }
    },
    get generating() { return !!active; },
  };
})();
