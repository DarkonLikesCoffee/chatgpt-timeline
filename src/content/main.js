// Content-script runtime: observes the ChatGPT page, feeds snapshots and
// intents to the tracker, and forwards tracker output to the service worker.

import { readSnapshot, classifyIntent, diagnose } from './chatgpt-adapter.js';
import { ConversationTracker, DEFAULTS } from './tracker.js';
import { Transport } from './transport.js';
import { Msg } from '../shared/constants.js';

const KIND_TO_MSG = { event: Msg.TRACKER_EVENT, rebind: Msg.TRACKER_REBIND, meta: Msg.TRACKER_META };
const LOG = '[ChatGPT Timeline]';

export function createRuntime({ doc = document, win = window, sendMessage, now = () => Date.now(), options, log = console } = {}) {
  let observer = null;
  let timer = null;
  let urlTimer = null;
  let lastMutationAt = null;
  let lastHref = win.location.href;
  const stats = {
    startedAt: now(),
    snapshots: 0,
    snapshotErrors: 0,
    lastSnapshotError: null,
    intents: { submit: 0, stop: 0, lastSubmitAt: null },
    emitted: {},
  };

  const transport = new Transport({
    send: async (m) => {
      const res = await sendMessage({ type: KIND_TO_MSG[m.kind], payload: m });
      if (res && res.ok === false) throw new Error(res.error || 'rejected');
    },
    onDead: () => stop(),
  });

  function emit(m) {
    const key = m.kind === 'event' ? m.event.type : m.kind;
    stats.emitted[key] = (stats.emitted[key] || 0) + 1;
    log.debug?.(LOG, key, m.kind === 'event' ? new Date(m.event.timestamp).toISOString() : '', m.kind === 'event' ? m.event.id : '');
    transport.send(m);
  }

  const tracker = new ConversationTracker({ emit, options });
  const confirmMs = (options && options.CONFIRM_MS) || DEFAULTS.CONFIRM_MS;

  function run() {
    timer = null;
    // A snapshot reflects the DOM as of the last mutation; a confirmation
    // tick with no new mutation reflects "now".
    const at = lastMutationAt ?? now();
    lastMutationAt = null;
    lastHref = win.location.href;
    try {
      tracker.process(readSnapshot(doc, win.location, at));
      stats.snapshots++;
    } catch (err) {
      stats.snapshotErrors++;
      stats.lastSnapshotError = String(err?.stack || err).slice(0, 500);
      if (stats.snapshotErrors <= 3) log.warn(LOG, 'snapshot failed', err);
    }
    if (tracker.hasPendingConfirmation()) schedule(confirmMs);
  }

  function schedule(delay) {
    if (timer != null) return;
    timer = win.setTimeout(run, delay);
  }

  function onMutations() {
    lastMutationAt = now();
    schedule(50);
  }

  function onIntent(e) {
    const kind = classifyIntent(e);
    if (kind === 'submit') {
      stats.intents.submit++;
      stats.intents.lastSubmitAt = now();
      tracker.noteSubmitIntent(now());
    } else if (kind === 'stop') {
      stats.intents.stop++;
      tracker.noteStopIntent(now());
    }
  }

  function onPageHide() {
    if (timer != null) {
      win.clearTimeout(timer);
      run();
    }
    tracker.flush(now());
  }

  function checkUrl() {
    if (win.location.href !== lastHref) {
      lastMutationAt = lastMutationAt ?? now();
      schedule(0);
    }
  }

  function start() {
    observer = new win.MutationObserver(onMutations);
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'data-message-id', 'data-turn-id', 'aria-label', 'data-is-streaming'],
    });
    // Window capture phase: runs before any page handler can stop propagation.
    win.addEventListener('keydown', onIntent, true);
    win.addEventListener('click', onIntent, true);
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('popstate', checkUrl);
    urlTimer = win.setInterval(checkUrl, 1000);
    run();
  }

  function stop() {
    observer?.disconnect();
    win.removeEventListener('keydown', onIntent, true);
    win.removeEventListener('click', onIntent, true);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('popstate', checkUrl);
    if (timer != null) win.clearTimeout(timer);
    if (urlTimer != null) win.clearInterval(urlTimer);
  }

  // Troubleshooting data for the popup. Contains no message text.
  function diagnostics() {
    let page;
    try {
      page = diagnose(doc, win.location);
    } catch (err) {
      page = { error: String(err) };
    }
    return {
      startedAt: new Date(stats.startedAt).toISOString(),
      now: new Date(now()).toISOString(),
      snapshots: stats.snapshots,
      snapshotErrors: stats.snapshotErrors,
      lastSnapshotError: stats.lastSnapshotError,
      intents: { ...stats.intents, lastSubmitAt: stats.intents.lastSubmitAt && new Date(stats.intents.lastSubmitAt).toISOString() },
      emitted: { ...stats.emitted },
      transport: { ...transport.stats, pending: transport.pending, dead: transport.dead },
      tracker: {
        provisional: !tracker.realId,
        sawStopControl: !!tracker.sawGenerating,
        knownUserTurns: tracker.users?.size ?? 0,
        liveUserMessages: tracker.liveUserIds?.size ?? 0,
        trackedResponses: tracker.responses?.size ?? 0,
      },
      page,
    };
  }

  return { start, stop, run, tracker, transport, diagnostics };
}

export function start() {
  if (globalThis.__chatgptTimelineStarted) return;
  globalThis.__chatgptTimelineStarted = true;
  const runtime = createRuntime({ sendMessage: (m) => chrome.runtime.sendMessage(m) });
  runtime.start();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === Msg.GET_DIAGNOSTICS) {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ...runtime.diagnostics() });
    }
    return false;
  });
  console.info(LOG, `v${chrome.runtime.getManifest().version} tracking this tab. Open the extension popup for status and diagnostics.`);
}
