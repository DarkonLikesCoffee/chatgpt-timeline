// Everything that depends on ChatGPT's markup lives here. The tracker only
// sees the snapshot this module produces, so when ChatGPT changes its UI this
// is the file to update. Each signal tries several selectors, most specific
// first. Message text is never returned; only its length is measured.

export const SELECTORS = Object.freeze({
  // Each rendered message carries its role (and normally a stable message id).
  message: '[data-message-author-role]',
  // Fallback when messages are not marked: turn containers carrying the role.
  turnWithRole: '[data-turn="user"], [data-turn="assistant"]',
  // Container of one turn (one user message, or one assistant response that
  // may consist of several messages such as tool calls plus the answer).
  turn: ['[data-testid^="conversation-turn-"]', '[data-turn-id]', '[data-turn]', 'article'],
  // Present only while a response is being generated.
  stop: [
    '[data-testid="stop-button"]',
    '#composer-submit-button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop answering"]',
    'button[aria-label="Stop response"]',
  ],
  send: [
    '[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'form button[type="submit"]',
  ],
  // Streaming markers inside a response (current and older ChatGPT versions).
  streaming: [
    '.result-streaming',
    '.streaming-animation',
    '[data-is-streaming="true"]',
    '[data-streaming-response-status="streaming"]',
  ],
  // Error notices shown instead of, or inside, a response.
  error: ['.text-token-text-error', '[data-testid="message-error"]', '[data-testid="conversation-error"]'],
  // 2026 layout: each turn holds a user unit and an assistant unit.
  unit: ['[data-chatgpt-search-unit-key]', '[data-content-search-unit-key]'],
  turnKey: ['[data-turn-key]', '[data-content-search-turn-key]'],
  turnState: 'data-talvt-turn-state',
  assistantId: ['[data-chatgpt-selection-message-id]', '[data-dil-message-id]'],
  // The main conversation (excludes the floating "quick chat" window).
  thread: ['[data-thread-find-target="conversation"]', 'main'],
  composerRoot: ['[data-chatgpt-composer]', '[data-testid="composer"]'],
  // The composer's primary action button (send / stop / voice), any language.
  primaryButton: ['button.size-token-button-composer', '#composer-submit-button', '[data-testid="send-button"]', '[data-testid="stop-button"]'],
  composer: ['#prompt-textarea', 'form [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '.ProseMirror[contenteditable="true"]', 'form textarea'],
});

// Paths look like /c/<id>, /g/<gpt-or-project>/c/<id>. Anything else (/, /gpts,
// /g/<gpt> without a chat, /share/...) has no conversation id yet.
const CONVERSATION_PATH = /^\/(?:g\/[^/]+\/)?c\/([0-9a-zA-Z][0-9a-zA-Z-]{7,})\/?$/;

export function conversationIdFromPath(pathname) {
  const m = CONVERSATION_PATH.exec(pathname || '');
  return m ? m[1] : null;
}

function query(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function matchesAny(el, selectors) {
  return selectors.some((sel) => el.matches?.(sel));
}

// Accessible names of ChatGPT's stop control in common UI languages.
export const STOP_LABEL = /^(stop|detener|parar|interromper|arr[êe]ter|stopp|anhalten|interrompi|ferma|zatrzymaj|stoppa|stoppen|остановить|зупинити|停止|中止|중지|durdur|hentikan|berhenti|dừng|หยุด|עצור|إيقاف|रोकें)/i;

const SEND_LABEL = /^(send|submit|save|enviar|guardar|envoyer|enregistrer|senden|speichern|invia|salva|wyślij|zapisz|отправить|сохранить|发送|保存|送信|보내기|저장|gönder|kaydet|kirim|simpan|gửi|lưu)$/i;

function threadRoot(doc) {
  return query(doc, SELECTORS.thread) || doc;
}

export function composerRoot(doc) {
  const root = query(doc, SELECTORS.composerRoot);
  if (root) return root;
  const composer = query(doc, SELECTORS.composer);
  return composer ? composer.closest('form') || composer.parentElement : null;
}

function primaryButtons(doc) {
  const root = composerRoot(doc);
  if (!root) return [];
  const primary = root.querySelectorAll(SELECTORS.primaryButton.join(', '));
  return primary.length ? [...primary] : [...root.querySelectorAll('button')];
}

export function isStopButton(button) {
  return SELECTORS.stop.some((s) => button.matches(s)) || STOP_LABEL.test((button.getAttribute('aria-label') || '').trim());
}

export function isGenerating(doc) {
  if (query(doc, SELECTORS.stop) != null) return true;
  return primaryButtons(doc).some(isStopButton);
}

function turnContainer(el) {
  for (const sel of SELECTORS.turn) {
    const t = el.closest(sel);
    if (t) return t;
  }
  return el;
}

// A message id: on the message element, on a descendant, or on its turn.
function idOf(el, container) {
  return (
    el.getAttribute('data-message-id') ||
    el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
    container.getAttribute('data-turn-id') ||
    null
  );
}

function firstToken(v) {
  return (v || '').split(/[\s,]+/).find(Boolean) || null;
}

function unitRole(u) {
  const key = u.getAttribute('data-chatgpt-search-unit-key') || u.getAttribute('data-content-search-unit-key') || '';
  const m = /:(user|assistant)$/.exec(key);
  if (m) return m[1];
  return u.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role') || null;
}

const DONE_STATES = /^(complete|completed|done|finished|idle|static|error|failed)$/i;

// 2026 layout. Returns null when the page does not use it.
function readUnitTurns(root) {
  let units = [];
  for (const sel of SELECTORS.unit) {
    units = [...root.querySelectorAll(sel)];
    if (units.length) break;
  }
  if (!units.length) return null;
  const unitSel = SELECTORS.unit.join(', ');
  const turns = [];
  let current = null;
  for (const u of units) {
    if (u.parentElement && u.parentElement.closest(unitSel) && root.contains(u.parentElement.closest(unitSel))) continue; // nested
    const role = unitRole(u);
    if (role !== 'user' && role !== 'assistant') continue;
    const turnEl = SELECTORS.turnKey.map((sel) => u.closest(sel)).find(Boolean) || u.parentElement;
    const turnKey = turnEl.getAttribute('data-turn-key') || turnEl.getAttribute('data-content-search-turn-key') || null;
    const stateEl = u.closest(`[${SELECTORS.turnState}]`) || turnEl.querySelector(`[${SELECTORS.turnState}]`);
    const state = stateEl ? stateEl.getAttribute(SELECTORS.turnState) : null;
    const length = role === 'assistant' ? (u.textContent || '').length : 0;
    if (current && current.role === 'assistant' && role === 'assistant' && current.turnEl === turnEl) {
      current.length += length; // several assistant units (e.g. tool calls) form one response
      continue;
    }
    let id;
    if (role === 'user') {
      id = firstToken(u.getAttribute('data-chatgpt-search-message-ids')) || turnKey;
    } else {
      const idEl = query(u, SELECTORS.assistantId);
      id =
        (idEl && (idEl.getAttribute('data-chatgpt-selection-message-id') || idEl.getAttribute('data-dil-message-id'))) ||
        firstToken(u.getAttribute('data-chatgpt-search-message-ids')) ||
        (turnKey ? `${turnKey}:assistant` : null);
    }
    current = { role, id, length, turnEl, element: u, state };
    turns.push(current);
  }
  return turns.map(({ role, id, length, element, state }) => {
    const turn = { role, id, element };
    if (role === 'assistant') {
      turn.length = length;
      turn.streaming = (state != null && !DONE_STATES.test(state)) || query(element, SELECTORS.streaming) != null;
      turn.error = (state != null && /error|fail/i.test(state)) || query(element, SELECTORS.error) != null;
      if (state != null) turn.state = state;
    }
    return turn;
  });
}

function messageElements(doc) {
  const marked = doc.querySelectorAll(SELECTORS.message);
  if (marked.length) return [...marked].map((el) => ({ el, role: el.getAttribute('data-message-author-role') }));
  return [...doc.querySelectorAll(SELECTORS.turnWithRole)].map((el) => ({ el, role: el.getAttribute('data-turn') }));
}

export function readTurns(doc) {
  const root = threadRoot(doc);
  const unitTurns = readUnitTurns(root);
  if (unitTurns) return unitTurns;
  return readMessageTurns(root);
}

function readMessageTurns(doc) {
  const turns = [];
  let current = null;
  for (const { el, role } of messageElements(doc)) {
    const container = turnContainer(el);
    if (current && current.container === container) {
      if (role === 'assistant' && current.role === 'assistant') current.length += (el.textContent || '').length;
      if (!current.id) current.id = idOf(el, container);
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue; // e.g. a tool message without a turn
    current = { container, role, id: idOf(el, container), length: role === 'assistant' ? (el.textContent || '').length : 0 };
    turns.push(current);
  }
  return turns.map(({ container, role, id, length }) => {
    const turn = { role, id };
    if (role === 'assistant') {
      turn.length = length;
      turn.streaming = matchesAny(container, SELECTORS.streaming) || query(container, SELECTORS.streaming) != null;
      turn.error = query(container, SELECTORS.error) != null;
    }
    turn.element = container;
    return turn;
  });
}

function trailingError(doc, turns) {
  const last = turns[turns.length - 1];
  if (!last) return false;
  for (const sel of SELECTORS.error) {
    for (const el of doc.querySelectorAll(sel)) {
      if (last.element.contains(el)) continue;
      // DOCUMENT_POSITION_FOLLOWING = 4
      if (last.element.compareDocumentPosition(el) & 4) return true;
    }
  }
  return false;
}

export function readTitle(doc, conversationId) {
  if (conversationId) {
    for (const a of doc.querySelectorAll(`nav a[href*="/c/${CSS_escape(conversationId)}"]`)) {
      const text = (a.textContent || '').trim();
      if (text) return text;
    }
  }
  let t = (doc.title || '').trim();
  t = t.replace(/^ChatGPT\s*[-–|:]\s*/i, '').replace(/\s*[-–|]\s*ChatGPT$/i, '');
  return /^chatgpt$/i.test(t) ? '' : t;
}

function CSS_escape(s) {
  return s.replace(/["\\]/g, '\\$&');
}

export function readSnapshot(doc, loc, at) {
  const conversationId = conversationIdFromPath(loc.pathname);
  const turns = readTurns(doc);
  return {
    at,
    conversationId,
    url: conversationId ? loc.origin + loc.pathname : '',
    title: readTitle(doc, conversationId),
    generating: isGenerating(doc),
    trailingError: trailingError(doc, turns),
    turns: turns.map(({ element, ...t }) => t),
  };
}

// The editable element (textarea or contenteditable root) containing el.
function editableRoot(el) {
  if (el.tagName === 'TEXTAREA') return el;
  return el.closest('[contenteditable="true"], [contenteditable=""]') || (el.isContentEditable ? el : null);
}

function hasText(el) {
  const v = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
  return (v || '').trim().length > 0;
}

// Classify a user input event as a send ("submit") or stop request, or null.
// Used only to timestamp a message that subsequently renders; an intent on
// its own never creates an event.
export function classifyIntent(event) {
  const target = event.target;
  if (!target || !target.closest) return null;
  if (event.type === 'keydown') {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return null;
    const editable = editableRoot(target);
    return editable && hasText(editable) ? 'submit' : null;
  }
  if (event.type === 'click') {
    const button = target.closest('button, [role="button"]');
    if (!button) return null;
    if (isStopButton(button)) return 'stop';
    if (SELECTORS.send.slice(0, 4).some((s) => button.matches(s))) return 'submit';
    // The composer's primary button is "send" only when there is text to send
    // (when empty, the same slot starts voice mode).
    const root = button.closest(SELECTORS.composerRoot.join(', ')) || button.closest('form');
    if (root && (button.matches(SELECTORS.primaryButton.join(', ')) || button.matches('button[type="submit"]'))) {
      const editor = query(root, SELECTORS.composer);
      return editor && hasText(editor) ? 'submit' : null;
    }
    // The "Send" button of an inline message edit.
    const inTurn = button.closest('[data-message-author-role="user"], [data-testid^="conversation-turn-"], [data-turn], [data-turn-key], article');
    if (inTurn && inTurn.querySelector('textarea, [contenteditable="true"]') && SEND_LABEL.test((button.textContent || button.getAttribute('aria-label') || '').trim())) {
      return 'submit';
    }
  }
  return null;
}

// ---- diagnostics -----------------------------------------------------------
// Structural description of the page for troubleshooting selectors. Contains
// counts, tag names, attribute names and a few whitelisted attribute values
// (ids are truncated). It never includes message text, titles or links.

const PROBES = [
  '[data-message-author-role]',
  '[data-message-author-role="user"]',
  '[data-message-author-role="assistant"]',
  '[data-message-id]',
  '[data-testid^="conversation-turn-"]',
  '[data-turn]',
  '[data-turn-id]',
  'article',
  'section',
  '#prompt-textarea',
  '[data-testid="composer"]',
  'form',
  '[contenteditable="true"]',
  'textarea',
  '[data-testid="send-button"]',
  '#composer-submit-button',
  '[data-testid="stop-button"]',
  '[data-testid="composer-speech-button"]',
  '.result-streaming',
  '.streaming-animation',
  '[data-is-streaming]',
  '[data-message-model-slug]',
  '[data-testid="copy-turn-action-button"]',
  '.text-token-text-error',
];

const SAFE_ATTRS = ['id', 'data-testid', 'data-message-author-role', 'data-turn', 'data-message-id', 'data-turn-id', 'type', 'role', 'contenteditable', 'class'];

function describe(el, depth = 0) {
  if (!el) return null;
  const attrs = {};
  for (const name of SAFE_ATTRS) {
    const v = el.getAttribute(name);
    if (v != null) attrs[name] = name === 'class' ? v.slice(0, 120) : /id$/.test(name) && v.length > 12 ? `${v.slice(0, 8)}…` : v;
  }
  return {
    tag: el.tagName.toLowerCase(),
    attrs,
    attrNames: [...el.attributes].map((a) => a.name).filter((n) => !SAFE_ATTRS.includes(n)),
    children: depth < 1 ? [...el.children].slice(0, 6).map((c) => describe(c, depth + 1)) : el.children.length,
  };
}

function ancestors(el, n) {
  const out = [];
  for (let p = el && el.parentElement; p && out.length < n && p !== el.ownerDocument.body; p = p.parentElement) {
    out.push(describe(p, 1));
  }
  return out;
}

export function diagnose(doc, loc) {
  const counts = {};
  for (const sel of PROBES) counts[sel] = doc.querySelectorAll(sel).length;
  const msgs = doc.querySelectorAll('[data-message-author-role], [data-turn]');
  const lastMsg = msgs[msgs.length - 1] || null;
  const composer = query(doc, SELECTORS.composer);
  const composerRoot = composer ? composer.closest('form, [data-testid="composer"]') || composer.parentElement : null;
  const buttons = composerRoot
    ? [...composerRoot.querySelectorAll('button, [role="button"]')].slice(0, 15).map((b) => ({
        testid: b.getAttribute('data-testid'),
        id: b.id || null,
        ariaLabel: b.getAttribute('aria-label'),
        type: b.getAttribute('type'),
        disabled: b.disabled === true,
      }))
    : [];
  const snapshot = readSnapshot(doc, loc, Date.now());
  return {
    path: loc.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<id>'),
    conversationIdFound: snapshot.conversationId != null,
    counts,
    snapshot: {
      generating: snapshot.generating,
      trailingError: snapshot.trailingError,
      turns: snapshot.turns.length,
      users: snapshot.turns.filter((t) => t.role === 'user').length,
      assistants: snapshot.turns.filter((t) => t.role === 'assistant').length,
      withoutId: snapshot.turns.filter((t) => !t.id).length,
      last: snapshot.turns.slice(-3).map((t) => ({ role: t.role, hasId: !!t.id, streaming: t.streaming, length: t.length })),
    },
    lastMessage: describe(lastMsg),
    lastMessageAncestors: ancestors(lastMsg, 5),
    composer: describe(composer, 1),
    composerButtons: buttons,
    structure: census(doc),
    // The conversation area: <main>, or the composer's closest large ancestor.
    mainOutline: outline(doc.querySelector('main') || doc.body, { maxDepth: 16, maxLines: 450 }),
    // Turns appear to be <section>s on some versions: the last few in full.
    lastSections: [...doc.querySelectorAll('section')].slice(-4).map((el) => ({
      ancestors: ancestorSignatures(el, 8),
      outline: outline(el, { maxDepth: 14, maxLines: 150 }),
    })),
  };
}

// ---- structural outline (troubleshooting) ---------------------------------
// Renders an element tree as indented lines: tag, id, first class names,
// data-* / role / type attributes (values only if they look like short
// identifiers), names of other attributes, button aria-labels, and the
// length of direct text. Never the text itself.

const IDENT = /^[\w:./-]{1,40}$/;

// Shorten id-like values (uuids, long hex) so diagnostics stay compact.
function shortVal(v) {
  return /[0-9a-f]{8}-[0-9a-f]{4}/i.test(v) || v.length > 32 ? `${v.slice(0, 8)}…` : v;
}

// Signature of an element and its descendants to a small depth; siblings are
// collapsed only when their shapes are identical.
function shape(el, depth = 2) {
  const kids = depth > 0 ? [...el.children].slice(0, 12).map((c) => shape(c, depth - 1)).join(',') : el.children.length;
  return `${signature(el)}{${kids}}`;
}

export function signature(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${shortVal(el.id)}`;
  const cls = (el.getAttribute('class') || '').trim();
  if (cls) s += `.${cls.split(/\s+/).slice(0, 4).map((c) => c.slice(0, 30)).join('.')}`;
  const attrs = [];
  for (const a of el.attributes) {
    if (a.name === 'id' || a.name === 'class' || a.name === 'style') continue;
    const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    if (a.name.startsWith('data-') || ['role', 'type', 'contenteditable', 'dir', 'tabindex'].includes(a.name)) {
      attrs.push(IDENT.test(a.value) ? `${a.name}=${shortVal(a.value)}` : a.name);
    } else if (a.name === 'aria-label' && isButton) {
      attrs.push(`aria-label="${a.value.slice(0, 40)}"`);
    } else {
      attrs.push(a.name);
    }
  }
  if (attrs.length) s += ` [${attrs.join(' ')}]`;
  let text = 0;
  for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent.trim().length;
  if (text) s += ` text:${text}`;
  if (el.shadowRoot) s += ' #shadow';
  return s;
}

export function outline(root, { maxDepth = 14, maxChildren = 8, maxLines = 400 } = {}) {
  const lines = [];
  const walk = (el, depth) => {
    if (lines.length >= maxLines) return;
    lines.push(`${'  '.repeat(depth)}${signature(el)}`);
    if (depth >= maxDepth) {
      if (el.children.length) lines.push(`${'  '.repeat(depth + 1)}… ${el.children.length} children, ${el.querySelectorAll('*').length} descendants`);
      return;
    }
    const kids = [...el.children];
    if (el.shadowRoot) kids.unshift(...el.shadowRoot.children);
    let shown = 0;
    for (let i = 0; i < kids.length && lines.length < maxLines; i++) {
      // Collapse runs of identical siblings (e.g. list items, code lines).
      let j = i;
      const key = shape(kids[i]);
      while (j + 1 < kids.length && shape(kids[j + 1]) === key) j++;
      if (shown++ >= maxChildren) {
        lines.push(`${'  '.repeat(depth + 1)}… ${kids.length - i} more children`);
        break;
      }
      walk(kids[i], depth + 1);
      if (j > i) lines.push(`${'  '.repeat(depth + 1)}… ×${j - i} more like the above`);
      i = j;
    }
  };
  if (root) walk(root, 0);
  if (lines.length >= maxLines) lines.push('… (truncated)');
  return lines;
}

// Census of data-* attribute names and custom element tags in the document.
export function census(doc) {
  const dataAttrs = {};
  const customTags = {};
  let shadowHosts = 0;
  for (const el of doc.querySelectorAll('*')) {
    for (const a of el.attributes) if (a.name.startsWith('data-')) dataAttrs[a.name] = (dataAttrs[a.name] || 0) + 1;
    if (el.tagName.includes('-')) customTags[el.tagName.toLowerCase()] = (customTags[el.tagName.toLowerCase()] || 0) + 1;
    if (el.shadowRoot) shadowHosts++;
  }
  return { dataAttrs, customTags, shadowHosts, iframes: doc.querySelectorAll('iframe').length, sections: doc.querySelectorAll('section').length };
}

export function composerButtons(doc) {
  const composer = query(doc, SELECTORS.composer);
  const root = composer ? composer.closest('form, [data-testid="composer"]') || composer.parentElement : null;
  return root ? [...root.querySelectorAll('button, [role="button"]')].slice(0, 15).map(signature) : [];
}

export function ancestorSignatures(el, n) {
  const out = [];
  for (let p = el && el.parentElement; p && out.length < n; p = p.parentElement) out.push(signature(p));
  return out;
}
