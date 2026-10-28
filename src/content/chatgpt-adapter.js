// Everything that depends on ChatGPT's markup lives here. The tracker only
// sees the snapshot this module produces, so when ChatGPT changes its UI this
// is the file to update. Each signal tries several selectors, most specific
// first. Message text is never returned; only its length is measured.

export const SELECTORS = Object.freeze({
  // Each rendered message carries its role and a stable message id.
  message: '[data-message-author-role][data-message-id]',
  // Container of one turn (one user message, or one assistant response that
  // may consist of several messages such as tool calls plus the answer).
  turn: ['[data-testid^="conversation-turn-"]', 'article'],
  // Present only while a response is being generated.
  stop: [
    '[data-testid="stop-button"]',
    '#composer-submit-button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
  ],
  send: ['[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt"]'],
  // Streaming markers inside a response (current and older ChatGPT versions).
  streaming: [
    '.result-streaming',
    '.streaming-animation',
    '[data-is-streaming="true"]',
    '[data-streaming-response-status="streaming"]',
  ],
  // Error notices shown instead of, or inside, a response.
  error: ['.text-token-text-error', '[data-testid="message-error"]', '[data-testid="conversation-error"]'],
  composer: ['#prompt-textarea', 'form [contenteditable="true"]', 'form textarea'],
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

export function isGenerating(doc) {
  return query(doc, SELECTORS.stop) != null;
}

function turnContainer(el) {
  for (const sel of SELECTORS.turn) {
    const t = el.closest(sel);
    if (t) return t;
  }
  return el;
}

export function readTurns(doc) {
  const turns = [];
  let current = null;
  for (const el of doc.querySelectorAll(SELECTORS.message)) {
    const role = el.getAttribute('data-message-author-role');
    const id = el.getAttribute('data-message-id');
    const container = turnContainer(el);
    if (current && current.container === container) {
      if (role === 'assistant') current.length += (el.textContent || '').length;
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue; // e.g. a tool message without a turn
    current = { container, role, id, length: role === 'assistant' ? (el.textContent || '').length : 0 };
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
    if (!editable || !editable.closest('form, main, [data-message-author-role="user"]')) return null;
    return hasText(editable) ? 'submit' : null;
  }
  if (event.type === 'click') {
    const button = target.closest('button, [role="button"]');
    if (!button) return null;
    if (SELECTORS.stop.some((s) => button.matches(s))) return 'stop';
    if (SELECTORS.send.some((s) => button.matches(s))) return 'submit';
    // The "Send" button of an inline message edit.
    const inTurn = button.closest('[data-message-author-role="user"], [data-testid^="conversation-turn-"], article');
    if (inTurn && inTurn.querySelector('textarea, [contenteditable="true"]') && /^(send|submit|save)$/i.test((button.textContent || '').trim())) {
      return 'submit';
    }
  }
  return null;
}
