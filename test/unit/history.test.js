import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadHistoryScript } from './history-harness.js';
import { ConversationBuilder, fakeBackend } from '../fixtures/backend-api.js';

const DAY = 86400e3;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

// n conversations, conversation i last active i days ago.
function convs(n) {
  return Array.from({ length: n }, (_, i) => {
    const b = new ConversationBuilder({ title: `Conv ${i}`, createdAt: NOW - i * DAY - 3600e3 });
    b.exchange(NOW - i * DAY - 600e3, NOW - i * DAY - 590e3, NOW - i * DAY - 500e3);
    return b;
  });
}

async function run(backend, opts) {
  const { fetchHistory } = loadHistoryScript();
  const posted = [];
  const stats = await fetchHistory({ fetchImpl: backend.fetchImpl, doc: { cookie: 'oai-did=device-1' }, post: (m) => posted.push(JSON.parse(JSON.stringify(m))), ...opts });
  return { stats, posted, conversations: posted.filter((m) => m.type === 'conversation').map((m) => m.conversation) };
}

describe('reading history from chatgpt.com (content script)', () => {
  test('lists across pages, stops at the start of the period, fetches each conversation', async () => {
    const all = convs(40); // 28 per page -> two pages
    const backend = fakeBackend(all);
    const { stats, conversations, posted } = await run(backend, { since: NOW - 30.5 * DAY });
    assert.equal(stats.listed, 31, 'conversations 0..30 days old');
    assert.equal(stats.fetched, 31);
    assert.equal(conversations.length, 31);
    const lists = backend.calls.filter((c) => c.url.includes('/backend-api/conversations?'));
    assert.equal(lists.length, 2, 'stops paging once a page ends before the period');
    assert.ok(backend.calls.filter((c) => c.url.includes('/backend-api/')).every((c) => c.auth === 'Bearer tok'));
    assert.equal(posted.at(-1).type, 'done');
  });

  test('only a short period: one list page, few detail requests', async () => {
    const backend = fakeBackend(convs(40));
    const { stats } = await run(backend, { since: NOW - 2.5 * DAY });
    assert.equal(stats.listed, 3);
    assert.equal(backend.calls.filter((c) => c.url.includes('/backend-api/conversation/')).length, 3);
  });

  test('conversations unchanged since the last load are not fetched again', async () => {
    const all = convs(5);
    const known = { [all[0].id]: all[0].updatedAt, [all[1].id]: all[1].updatedAt - 5000 };
    const backend = fakeBackend(all);
    const { stats, posted } = await run(backend, { since: NOW - 10 * DAY, known });
    assert.equal(stats.unchanged, 1);
    assert.equal(stats.fetched, 4);
    assert.ok(posted.some((m) => m.type === 'unchanged' && m.id === all[0].id));
    assert.ok(!backend.calls.some((c) => c.url.endsWith(`/conversation/${all[0].id}`)));
  });

  test('message text never leaves the content script', async () => {
    const backend = fakeBackend(convs(3));
    const { posted } = await run(backend, { since: NOW - 10 * DAY });
    const json = JSON.stringify(posted);
    for (const text of ['private question', 'private answer', 'secret text', 'tok']) assert.ok(!json.includes(text), text);
    const node = posted.find((m) => m.type === 'conversation').conversation.nodes.find((n) => n.role === 'assistant');
    assert.deepEqual(Object.keys(node).sort(), ['children', 'content_type', 'create_time', 'finish_type', 'hidden', 'id', 'parent', 'role', 'status', 'update_time']);
  });

  test('signed out: a clear error and no API calls', async () => {
    const backend = fakeBackend(convs(2), { signedIn: false });
    await assert.rejects(run(backend, { since: 0 }), (err) => err.code === 'auth' && /signed in/i.test(err.message));
    assert.equal(backend.calls.filter((c) => c.url.includes('/backend-api/')).length, 0);
  });

  test('rate limiting is retried after the requested delay', async () => {
    const backend = fakeBackend(convs(2), { rateLimitOnce: true });
    const { stats } = await run(backend, { since: NOW - 10 * DAY });
    assert.equal(stats.fetched, 2);
  });

  test('one conversation that cannot be read does not stop the others', async () => {
    const all = convs(3);
    const backend = fakeBackend(all, { failDetail: { [all[1].id]: 400 } });
    const { stats, conversations } = await run(backend, { since: NOW - 10 * DAY });
    assert.equal(stats.failed, 1);
    assert.equal(conversations.length, 2);
  });

  test('authorization failures stop the load', async () => {
    const all = convs(3);
    const backend = fakeBackend(all, { failDetail: { [all[0].id]: 401 } });
    await assert.rejects(run(backend, { since: NOW - 10 * DAY }), (err) => err.code === 'auth');
  });

  test('cancelling aborts the load', async () => {
    const all = convs(10);
    const backend = fakeBackend(all);
    const ctrl = new AbortController();
    const slow = { fetchImpl: async (...a) => { await new Promise((r) => setTimeout(r, 20)); return backend.fetchImpl(...a); } };
    setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(run({ ...backend, ...slow }, { since: 0, signal: ctrl.signal }));
  });
});
