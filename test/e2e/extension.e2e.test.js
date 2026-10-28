// End-to-end: loads the unpacked extension into Chromium (Playwright) and
// serves https://chatgpt.com (page, /api/auth/session and /backend-api) from
// a local HTTPS server with a self-signed certificate; Chromium resolves
// chatgpt.com to it. (Playwright request interception would not cover tabs
// the extension opens itself.) No request reaches OpenAI; the fixtures
// imitate the shape of ChatGPT's API, not its exact behaviour.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationBuilder } from '../fixtures/backend-api.js';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  /* Playwright not installed: tests are skipped */
}

const EXT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const HOUR = 3600e3;

// Server state shared with the route handler.
const server = { convs: [], signedIn: true, detailRequests: [], listRequests: 0 };

function seed() {
  const now = Date.now();
  const make = (title, hoursAgo, exchanges) => {
    const b = new ConversationBuilder({ title, createdAt: now - hoursAgo * HOUR });
    for (const [sent, start, end, opts] of exchanges) b.exchange(now - hoursAgo * HOUR + sent, now - hoursAgo * HOUR + start, now - hoursAgo * HOUR + end, opts);
    return b;
  };
  server.convs = [
    make('Refactor parser', 2, [[60e3, 62e3, 90e3], [300e3, 302e3, 360e3]]),
    make('Refactor parser', 5, [[10e3, 12e3, 40e3, { finish: 'interrupted' }]]), // same title, different conversation
    make('Calculus exam prep', 30, [[10e3, 11e3, 70e3]]),
    make('Old conversation', 24 * 20, [[10e3, 11e3, 20e3]]), // outside 7 days
  ];
}

function handle(req, res) {
  const url = new URL(req.url, 'https://chatgpt.com');
  const json = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/auth/session') return json(server.signedIn ? { accessToken: 'tok-e2e', user: { id: 'u' } } : {});
  if (url.pathname.startsWith('/backend-api/')) {
    if (req.headers.authorization !== 'Bearer tok-e2e') return json({ detail: 'Unauthorized' }, 401);
    if (url.pathname === '/backend-api/conversations') {
      server.listRequests++;
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const sorted = [...server.convs].sort((a, b) => b.updatedAt - a.updatedAt);
      return json({ items: sorted.slice(offset, offset + limit).map((c) => c.listItem()), total: sorted.length, limit, offset });
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    server.detailRequests.push(id);
    const c = server.convs.find((x) => x.id === id);
    return c ? json(c.detail()) : json({ detail: 'not found' }, 404);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>ChatGPT</title><main>ChatGPT</main>');
}

async function startServer(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chatgpt.com',
    '-addext', 'subjectAltName=DNS:chatgpt.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const https = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, handle);
  await new Promise((r) => https.listen(0, '127.0.0.1', r));
  return https;
}

async function launch(userDataDir, port) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  // The extension has no service worker; read its id from chrome://extensions.
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  const extId = await page.evaluate(() => {
    const items = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot.querySelectorAll('extensions-item');
    return [...items].map((i) => i.id)[0];
  });
  await page.close();
  return { context, extId };
}

async function openDashboard(context, extId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`chrome-extension://${extId}/src/dashboard/dashboard.html`);
  await page.waitForFunction(() => window.__timeline);
  return page;
}

async function load(dash, days = '7') {
  await dash.selectOption('#loadRange', days);
  await dash.click('#loadBtn');
  await dash.waitForFunction(() => !window.__timeline.state.loading, null, { timeout: 60000 });
  return dash.locator('#loadStatus').innerText();
}

const storedEvents = (dash) =>
  dash.evaluate(async () => {
    await window.__timeline.reload();
    return window.__timeline.state.events.map((e) => ({ ...e }));
  });

describe('extension in Chromium', { skip: !chromium && 'playwright not available' }, () => {
  let dir;
  let ctx;
  let extId;
  let https;

  before(async () => {
    seed();
    dir = mkdtempSync(join(tmpdir(), 'cgpt-timeline-e2e-'));
    https = await startServer(dir);
    ({ context: ctx, extId } = await launch(join(dir, 'profile'), https.address().port));
  });

  after(async () => {
    await ctx?.close();
    https?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('loads the last 7 days through a background chatgpt.com tab and closes it', async () => {
    const dash = await openDashboard(ctx, extId);
    assert.match(await dash.locator('#empty').innerText(), /No activity loaded yet/);
    const status = await load(dash, '7');
    assert.match(status, /Loaded 3 conversations from the last 7 days \(3 read, 0 unchanged\)/);
    assert.ok(!ctx.pages().some((p) => p.url().startsWith('https://chatgpt.com')), 'background tab closed');
    const events = await storedEvents(dash);
    assert.equal(events.length, 8, '4 messages + 4 outcomes');
    assert.ok(!server.detailRequests.includes(server.convs[3].id), 'conversation outside the period not read');
    // Rows: two same-titled conversations stay separate.
    await dash.click('[data-view="week"]');
    await dash.click('#today');
    await dash.waitForSelector('.row');
    assert.equal(await dash.locator('.row').count(), 3);
    assert.equal(await dash.locator('#rows .iv.completed').count(), 3);
    assert.equal(await dash.locator('#rows .iv.interrupted').count(), 1);
    assert.ok(!JSON.stringify(events).includes('private'), 'no message text stored');
    if (process.env.SCREENSHOT_DIR) {
      await dash.click('[data-view="day"]');
      await dash.locator('#rows .iv.completed').first().dispatchEvent('click');
      await dash.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'dashboard-loaded.png') });
    }
    await dash.close();
  });

  test('a second load uses an open chatgpt.com tab and skips unchanged conversations', async () => {
    const chat = await ctx.newPage();
    await chat.goto('https://chatgpt.com/');
    await chat.waitForTimeout(800);
    // One conversation got a new exchange since the last load.
    const changed = server.convs[0];
    changed.exchange(Date.now() - 60e3, Date.now() - 58e3, Date.now() - 30e3);
    server.detailRequests = [];
    const dash = await openDashboard(ctx, extId);
    const status = await load(dash, '7');
    assert.match(status, /\(1 read, 2 unchanged\)/);
    assert.deepEqual(server.detailRequests, [changed.id]);
    assert.ok(!chat.isClosed(), 'the user\'s own tab is left open');
    const ofChanged = (await storedEvents(dash)).filter((e) => e.conversationId === changed.id);
    assert.equal(ofChanged.length, 6);
    await Promise.all([dash.close(), chat.close()]);
  });

  test('details show exact times for a message → response interval and link to ChatGPT', async () => {
    const dash = await openDashboard(ctx, extId);
    await dash.click('[data-view="week"]');
    await dash.click('#today');
    const id = server.convs[0].id;
    const href = await dash.locator(`.row[data-row="${id}"] .label a`).getAttribute('href');
    assert.equal(href, `https://chatgpt.com/c/${id}`);
    await dash.locator(`.row[data-row="${id}"] .iv.completed`).first().dispatchEvent('click');
    const details = await dash.locator('#details').innerText();
    assert.match(details, /Message sent[\s\S]*Response completed[\s\S]*Duration/);
    assert.match(details, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    await dash.close();
  });

  test('signed out: a clear message, nothing changes', async () => {
    server.signedIn = false;
    try {
      const dash = await openDashboard(ctx, extId);
      const before = (await storedEvents(dash)).length;
      const status = await load(dash, '7');
      assert.match(status, /Not signed in to ChatGPT/);
      assert.equal((await storedEvents(dash)).length, before);
      await dash.close();
    } finally {
      server.signedIn = true;
    }
  });

  test('data survives a browser restart; popup, export and deletion work', async () => {
    await ctx.close();
    ({ context: ctx, extId } = await launch(join(dir, 'profile'), https.address().port));
    const dash = await openDashboard(ctx, extId);
    assert.equal((await storedEvents(dash)).length, 10);

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#stats').textContent.includes('Events'));
    assert.match(await popup.locator('#stats').innerText(), /Conversations\s+3[\s\S]*Events\s+10/);
    await popup.close();

    await dash.click('#dataBtn');
    await dash.waitForFunction(() => document.querySelector('#lastLoad').textContent.length > 0);
    assert.match(await dash.locator('#lastLoad').innerText(), /Last load:/);
    const [download] = await Promise.all([dash.waitForEvent('download'), dash.click('#exportBtn')]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.events.length, 10);
    assert.ok(!JSON.stringify(exported).includes('private'));

    dash.on('dialog', (d) => d.accept());
    const id = server.convs[1].id;
    await dash.click(`#convTable button[data-action="deleteConv"][data-id="${id}"]`);
    await dash.waitForFunction((cid) => !window.__timeline.state.rows.some((r) => r.id === cid), id);
    await dash.click('#clearBtn');
    await dash.waitForFunction(() => window.__timeline.state.events.length === 0);
    await dash.keyboard.press('Escape');
    assert.match(await dash.locator('#empty').innerText(), /No activity loaded yet/);
    await dash.close();
  });
});
