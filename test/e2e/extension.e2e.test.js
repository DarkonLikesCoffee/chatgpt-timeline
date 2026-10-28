// End-to-end: loads the unpacked extension into Chromium (Playwright), serves
// a simulated ChatGPT page at https://chatgpt.com via request interception
// (no network access to OpenAI; this is NOT the live site), and checks
// recording, the dashboard, service-worker restart and browser restart.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  /* Playwright not installed: tests are skipped */
}

const EXT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const mockScript = readFileSync(new URL('../fixtures/mock-chatgpt.js', import.meta.url), 'utf8');
const NONCE = 'e2eNonce123';
const CONV_A = '68f00000-aaaa-4000-8000-00000000000a';
const CONV_B = '68f00000-bbbb-4000-8000-00000000000b';

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<script nonce="${NONCE}">window.MOCK_CONFIG = { assignIdMs: 150, firstTokenMs: 120, tokenMs: 60, tokens: 6 };</script>
<script nonce="${NONCE}">${mockScript}</script></body></html>`;
}

async function launch(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // Every chatgpt.com URL (including SPA paths on reload) serves the mock, with
  // a strict nonce-based CSP like the real site.
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'content-security-policy': `script-src 'nonce-${NONCE}' 'strict-dynamic'; object-src 'none'; base-uri 'none'` },
      body: pageHtml(),
    }),
  );
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  return { context, extId };
}

async function openChat(context, path) {
  const page = await context.newPage();
  await page.goto(`https://chatgpt.com${path}`);
  await page.waitForTimeout(800); // content script (document_idle + module import)
  return page;
}

async function sendMessage(page, text, opts = {}) {
  await page.evaluate(([t, o]) => {
    window.__nextSendOptions = o;
    window.mockChat.type(t);
    window.__done = new Promise((r) => window.addEventListener('mock:done', r, { once: true }));
  }, [text, opts]);
  await page.click('#composer-submit-button');
  await page.evaluate(() => window.__done);
  await page.waitForTimeout(1200); // confirmation + delivery
}

async function openDashboard(context, extId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`chrome-extension://${extId}/src/dashboard/dashboard.html`);
  await page.waitForFunction(() => window.__timeline);
  return page;
}

const storedEvents = (dash) =>
  dash.evaluate(async () => {
    await window.__timeline.reload();
    return window.__timeline.state.events.map((e) => ({ ...e })).sort((a, b) => a.timestamp - b.timestamp);
  });

const status = (page) => page.evaluate(() => chrome.runtime.sendMessage({ type: 'status:get' }));

describe('extension in Chromium', { skip: !chromium && 'playwright not available' }, () => {
  let dir;
  let ctx;
  let extId;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cgpt-timeline-e2e-'));
    ({ context: ctx, extId } = await launch(dir));
  });

  after(async () => {
    await ctx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('records messages and completions from a new chat despite a strict page CSP', async () => {
    const page = await openChat(ctx, '/');
    await sendMessage(page, 'hello');
    await sendMessage(page, 'second');
    const cid = new URL(page.url()).pathname.split('/c/')[1];
    const dash = await openDashboard(ctx, extId);
    const events = await storedEvents(dash);
    assert.deepEqual(events.map((e) => e.type), ['USER_MESSAGE', 'ASSISTANT_RESPONSE_COMPLETED', 'USER_MESSAGE', 'ASSISTANT_RESPONSE_COMPLETED']);
    assert.ok(events.every((e) => e.conversationId === cid));
    assert.equal(events[1].requestMessageId, events[0].messageId);
    assert.ok(events[1].timestamp - events[0].timestamp >= 400, 'interval spans the simulated generation');
    await dash.close();
    await page.close();
  });

  test('the content script answers diagnostics requests (used by the popup)', async () => {
    const page = await openChat(ctx, `/c/${CONV_A}`);
    const dash = await openDashboard(ctx, extId);
    const diags = await dash.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const out = [];
      for (const t of tabs) {
        const d = await chrome.tabs.sendMessage(t.id, { type: 'diagnostics:get' }).catch(() => null);
        if (d) out.push(d);
      }
      return out;
    });
    assert.equal(diags.length >= 1, true);
    const d = diags.find((x) => x.page.path === '/c/<id>');
    assert.ok(d.ok);
    assert.equal(d.page.conversationIdFound, true);
    assert.ok(d.snapshots >= 1);
    assert.equal(d.transport.dead, false);
    assert.ok(Array.isArray(d.page.composerButtons) && d.page.composerButtons.length >= 1);
    // The popup's plain-language summary of these diagnostics.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    const summary = await popup.evaluate(async (diag) => (await import('./popup.js')).summarize(diag), d);
    assert.deepEqual(summary[0], ['Tracker running on this tab', 'ok']);
    assert.deepEqual(summary[1][1], 'bad', 'empty page: no messages found');
    assert.equal(await popup.locator('#copyDiag').isVisible(), false, 'hidden when the active tab has no tracker');
    await Promise.all([page.close(), dash.close(), popup.close()]);
  });

  test('concurrent conversations in two tabs, stop and failure outcomes', async () => {
    const a = await openChat(ctx, `/c/${CONV_A}`);
    const b = await openChat(ctx, `/c/${CONV_B}`);
    await Promise.all([sendMessage(a, 'to A'), sendMessage(b, 'to B', { fail: true })]);
    // Stop a response in tab A.
    await a.evaluate(() => {
      window.__nextSendOptions = { tokens: 200 };
      window.mockChat.type('stop me');
      window.__done = new Promise((r) => window.addEventListener('mock:done', r, { once: true }));
    });
    await a.click('#composer-submit-button');
    await a.waitForSelector('[data-testid="stop-button"]');
    await a.waitForTimeout(250);
    await a.click('[data-testid="stop-button"]');
    await a.evaluate(() => window.__done);
    await a.waitForTimeout(1200);
    const dash = await openDashboard(ctx, extId);
    const events = await storedEvents(dash);
    const ofA = events.filter((e) => e.conversationId === CONV_A).map((e) => e.type);
    const ofB = events.filter((e) => e.conversationId === CONV_B).map((e) => e.type);
    assert.deepEqual(ofA, ['USER_MESSAGE', 'ASSISTANT_RESPONSE_COMPLETED', 'USER_MESSAGE', 'ASSISTANT_RESPONSE_INTERRUPTED']);
    assert.deepEqual(ofB, ['USER_MESSAGE', 'ASSISTANT_RESPONSE_FAILED']);
    await Promise.all([a.close(), b.close(), dash.close()]);
  });

  test('reloading a conversation does not re-record its history', async () => {
    const page = await openChat(ctx, `/c/${CONV_A}`);
    await page.evaluate(() => window.mockChat.navigate(location.pathname, 8));
    await page.waitForTimeout(1500);
    const dash = await openDashboard(ctx, extId);
    assert.equal((await storedEvents(dash)).filter((e) => e.conversationId === CONV_A).length, 4);
    await Promise.all([page.close(), dash.close()]);
  });

  test('dashboard renders rows, markers and intervals; selection shows exact timestamps', async () => {
    const dash = await openDashboard(ctx, extId);
    await dash.click('[data-view="week"]');
    await dash.click('#today');
    await dash.waitForSelector('.row');
    assert.equal(await dash.locator('.row').count(), 3);
    assert.ok((await dash.locator('#rows .mk.user').count()) === 5);
    assert.ok((await dash.locator('#rows .mk.done').count()) >= 3);
    assert.ok((await dash.locator('#rows .iv.completed').count()) >= 3);
    assert.equal(await dash.locator('#rows .iv.interrupted').count(), 1);
    assert.equal(await dash.locator('#rows .mk.failed').count(), 1);
    // Conversation title links to the original conversation.
    const href = await dash.locator(`.row[data-row="${CONV_A}"] .label a`).getAttribute('href');
    assert.equal(href, `https://chatgpt.com/c/${CONV_A}`);
    await dash.locator(`.row[data-row="${CONV_A}"] .mk.done`).first().dispatchEvent('click');
    const details = await dash.locator('#details').innerText();
    assert.match(details, /Response completed/);
    assert.match(details, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    await dash.locator(`.row[data-row="${CONV_A}"] .iv.completed`).first().dispatchEvent('click');
    assert.match(await dash.locator('#details').innerText(), /Message sent[\s\S]*Response completed[\s\S]*Duration/);
    // Search and empty state.
    await dash.fill('#search', 'no such conversation');
    await dash.waitForSelector('#empty:not([hidden])');
    await dash.fill('#search', '');
    await dash.click('#prev');
    await dash.click('#prev');
    await dash.waitForSelector('#empty:not([hidden]) [data-action="latest"]');
    await dash.click('[data-action="latest"]');
    await dash.waitForSelector('.row');
    await dash.close();
  });

  test('service worker suspension: the restarted worker keeps recording', async () => {
    const page = await openChat(ctx, `/c/${CONV_B}`);
    const dash = await openDashboard(ctx, extId);
    const before = await status(dash);
    const cdp = await ctx.newCDPSession(dash);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await new Promise((r) => setTimeout(r, 500));
    await sendMessage(page, 'after suspension');
    const afterStatus = await status(dash);
    assert.notEqual(afterStatus.workerStartedAt, before.workerStartedAt, 'worker was restarted');
    const ofB = (await storedEvents(dash)).filter((e) => e.conversationId === CONV_B);
    assert.equal(ofB.length, 4);
    assert.equal(ofB[3].type, 'ASSISTANT_RESPONSE_COMPLETED');
    await Promise.all([page.close(), dash.close()]);
  });

  test('history survives a browser restart; export and deletion work', async () => {
    await ctx.close();
    ({ context: ctx, extId } = await launch(dir));
    const dash = await openDashboard(ctx, extId);
    const events = await storedEvents(dash);
    assert.equal(events.length, 12);

    // Popup shows the status.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('Tracking'));
    assert.match(await popup.locator('#stats').innerText(), /12/);
    await popup.close();

    // Export JSON.
    await dash.click('#dataBtn');
    const [download] = await Promise.all([dash.waitForEvent('download'), dash.click('#exportBtn')]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.events.length, 12);
    assert.equal(exported.conversations.length, 3);
    assert.ok(!JSON.stringify(exported).includes('hello'), 'no message text is stored');

    // Delete one conversation (confirmation accepted).
    dash.on('dialog', (d) => d.accept());
    await dash.click(`#convTable button[data-action="deleteConv"][data-id="${CONV_B}"]`);
    await dash.waitForFunction((id) => !window.__timeline.state.rows.some((r) => r.id === id), CONV_B);
    assert.equal((await storedEvents(dash)).length, 8);

    // Clear everything (two confirmations).
    await dash.click('#clearBtn');
    await dash.waitForFunction(() => window.__timeline.state.events.length === 0);
    await dash.keyboard.press('Escape');
    await dash.waitForSelector('#empty:not([hidden])');
    assert.match(await dash.locator('#empty').innerText(), /No activity recorded yet/);
    await dash.close();
  });
});
