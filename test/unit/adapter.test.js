import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { readSnapshot, conversationIdFromPath, classifyIntent, readTitle, diagnose } from '../../src/content/chatgpt-adapter.js';

const fixture = readFileSync(new URL('../fixtures/chatgpt-conversation.html', import.meta.url), 'utf8');
const CID = '68f1a2b3-0000-8000-9999-000000000001';

function load(path = `/c/${CID}`) {
  const dom = new JSDOM(fixture, { url: `https://chatgpt.com${path}` });
  return dom.window;
}

describe('conversation ids from URLs', () => {
  test('recognises regular, GPT and project conversation URLs', () => {
    assert.equal(conversationIdFromPath(`/c/${CID}`), CID);
    assert.equal(conversationIdFromPath(`/g/g-abc123-my-gpt/c/${CID}`), CID);
    assert.equal(conversationIdFromPath(`/g/g-p-6789abcd-project/c/${CID}`), CID);
  });
  test('pages without a conversation have no id', () => {
    for (const p of ['/', '/gpts', '/g/g-abc123-my-gpt', '/g/g-p-123/project', `/share/${CID}`, '/c/', '/c/x']) {
      assert.equal(conversationIdFromPath(p), null, p);
    }
  });
});

describe('snapshot', () => {
  test('reads turns in order, grouping multi-message responses into one turn', () => {
    const w = load();
    const s = readSnapshot(w.document, w.location, 123);
    assert.equal(s.at, 123);
    assert.equal(s.conversationId, CID);
    assert.equal(s.url, `https://chatgpt.com/c/${CID}`);
    assert.deepEqual(s.turns.map((t) => [t.role, t.id]), [['user', 'u-1'], ['assistant', 'a-1'], ['user', 'u-2'], ['assistant', 'a-2']]);
    assert.equal(s.turns[1].streaming, false);
    assert.equal(s.turns[3].streaming, true, 'streaming marker anywhere in the turn');
    assert.equal(s.turns[3].length, 'Searching…'.length + 'Partial answer'.length);
    assert.equal(s.generating, true);
    assert.equal(s.trailingError, false);
  });

  test('snapshot carries no message text', () => {
    const w = load();
    const json = JSON.stringify(readSnapshot(w.document, w.location, 1));
    for (const text of ['Hello there', 'Hi! How can I help', 'Partial answer', 'draft text']) assert.ok(!json.includes(text), text);
  });

  test('generation ended: no stop button and no streaming marker', () => {
    const w = load();
    w.document.querySelector('[data-testid="stop-button"]').remove();
    w.document.querySelector('.result-streaming').classList.remove('result-streaming');
    const s = readSnapshot(w.document, w.location, 1);
    assert.equal(s.generating, false);
    assert.equal(s.turns[3].streaming, false);
  });

  test('error notices inside a turn and after the last turn are detected', () => {
    const w = load();
    const d = w.document;
    d.querySelector('[data-testid="conversation-turn-4"]').insertAdjacentHTML('beforeend', '<div class="text-token-text-error">Something went wrong</div>');
    assert.equal(readSnapshot(d, w.location, 1).turns[3].error, true);
    d.querySelector('[data-testid="conversation-turn-4"]').remove();
    d.querySelector('.thread').insertAdjacentHTML('beforeend', '<div class="text-token-text-error">Network error</div>');
    const s = readSnapshot(d, w.location, 1);
    assert.equal(s.turns.at(-1).role, 'user');
    assert.equal(s.trailingError, true);
  });

  test('new chat has no conversation id and no URL', () => {
    const w = load('/');
    const s = readSnapshot(w.document, w.location, 1);
    assert.equal(s.conversationId, null);
    assert.equal(s.url, '');
  });

  test('title comes from the sidebar link, falling back to document.title', () => {
    const w = load();
    assert.equal(readTitle(w.document, CID), 'Refactoring the parser');
    w.document.querySelector('nav').remove();
    w.document.title = 'ChatGPT - Another title';
    assert.equal(readTitle(w.document, CID), 'Another title');
    w.document.title = 'ChatGPT';
    assert.equal(readTitle(w.document, CID), '');
  });
});

describe('markup variants', () => {
  const page = (body) => new JSDOM(`<!doctype html><body><main>${body}</main></body>`, { url: `https://chatgpt.com/c/${CID}` }).window;

  test('turns marked only with data-turn / data-turn-id', () => {
    const w = page(`
      <section data-turn="user" data-turn-id="t-u1"><div>hi</div></section>
      <section data-turn="assistant" data-turn-id="t-a1"><div class="markdown">answer</div></section>`);
    const s = readSnapshot(w.document, w.location, 1);
    assert.deepEqual(s.turns.map((t) => [t.role, t.id]), [['user', 't-u1'], ['assistant', 't-a1']]);
    assert.equal(s.turns[1].length, 'answer'.length);
  });

  test('message id on a descendant of the role element', () => {
    const w = page(`
      <div data-testid="conversation-turn-1"><div data-message-author-role="user"><div data-message-id="u1">hi</div></div></div>
      <div data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div data-message-id="a1">yo</div></div></div>`);
    const s = readSnapshot(w.document, w.location, 1);
    assert.deepEqual(s.turns.map((t) => [t.role, t.id]), [['user', 'u1'], ['assistant', 'a1']]);
  });

  test('stop control recognised by aria-label', () => {
    const w = page('<form><button aria-label="Stop answering"></button></form>');
    assert.equal(readSnapshot(w.document, w.location, 1).generating, true);
  });
});

describe('diagnostics', () => {
  test('describes structure without any message text, titles or links', () => {
    const w = load();
    const d = diagnose(w.document, w.location);
    assert.equal(d.counts['[data-message-author-role]'], 6);
    assert.equal(d.snapshot.users, 2);
    assert.equal(d.snapshot.assistants, 2);
    assert.equal(d.snapshot.generating, true);
    assert.ok(d.composerButtons.some((b) => b.testid === 'stop-button'));
    assert.equal(d.path, '/c/<id>');
    assert.ok(d.mainOutline.some((l) => l.includes('data-message-author-role=assistant')));
    assert.ok(d.mainOutline.some((l) => /text:\d+/.test(l)), 'text lengths, not text');
    const json = JSON.stringify(d);
    for (const text of ['Hello there', 'How can I help', 'Partial answer', 'draft text', 'Refactoring the parser', 'Other chat', CID]) {
      assert.ok(!json.includes(text), text);
    }
  });
});

describe('structural outline', () => {
  test('sections, attributes and button labels without any text', () => {
    const w = new JSDOM(`<!doctype html><body><main><div class="thread">
      <section class="turn a b" data-foo="x1" aria-describedby="secret words here"><div><p>Private user text</p></div></section>
      <section class="turn"><div data-kind="answer"><p>Private answer</p><p>More</p><p>More</p></div></section>
      </div><form><div contenteditable="true" role="textbox" class="ProseMirror"><p>draft secret</p></div>
      <button aria-label="Enviar mensaje" type="button"></button></form></main></body>`, { url: 'https://chatgpt.com/c/68f1a2b3-0000-8000-9999-000000000001' }).window;
    const d = diagnose(w.document, w.location);
    assert.equal(d.structure.sections, 2);
    assert.equal(d.structure.dataAttrs['data-foo'], 1);
    assert.equal(d.lastSections.length, 2);
    assert.ok(d.lastSections[0].outline[0].startsWith('section.turn.a.b [data-foo=x1 aria-describedby]'));
    assert.ok(d.lastSections[1].outline.some((l) => l.includes('×1 more like the above')));
    assert.ok(d.composerButtons.some((b) => b.ariaLabel === 'Enviar mensaje'));
    const json = JSON.stringify(d);
    for (const text of ['Private', 'secret', 'More']) assert.ok(!json.includes(text), text);
  });
});

describe('intents', () => {
  const key = (w, target, init) => {
    const e = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init });
    Object.defineProperty(e, 'target', { value: target });
    return classifyIntent(e);
  };
  const click = (w, target) => {
    const e = new w.MouseEvent('click', { bubbles: true });
    Object.defineProperty(e, 'target', { value: target });
    return classifyIntent(e);
  };

  test('Enter in a non-empty composer is a submit; Shift+Enter, IME and empty are not', () => {
    const w = load();
    const composer = w.document.querySelector('#prompt-textarea');
    assert.equal(key(w, composer), 'submit');
    assert.equal(key(w, composer, { shiftKey: true }), null);
    assert.equal(key(w, composer, { isComposing: true }), null);
    composer.textContent = '   ';
    assert.equal(key(w, composer), null);
    assert.equal(key(w, w.document.body), null);
  });

  test('send and stop buttons are classified', () => {
    const w = load();
    const d = w.document;
    assert.equal(click(w, d.querySelector('[data-testid="stop-button"]')), 'stop');
    d.querySelector('form').insertAdjacentHTML('beforeend', '<button data-testid="send-button"><svg><path id="p"></path></svg></button>');
    assert.equal(click(w, d.getElementById('p')), 'submit');
    assert.equal(click(w, d.querySelector('[data-testid="copy-turn-action-button"]')), null);
  });

  test('the Send button of an inline message edit is a submit', () => {
    const w = load();
    const d = w.document;
    d.querySelector('[data-testid="conversation-turn-3"]').innerHTML = '<div data-message-author-role="user" data-message-id="u-2"><textarea>edited</textarea><button>Cancel</button><button id="s">Send</button></div>';
    assert.equal(click(w, d.getElementById('s')), 'submit');
    assert.equal(click(w, d.querySelector('[data-testid="conversation-turn-3"] button')), null);
  });
});
