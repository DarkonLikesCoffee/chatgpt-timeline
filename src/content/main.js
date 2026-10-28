// Content-script runtime: observes the ChatGPT page, feeds snapshots and
// intents to the tracker, and forwards tracker output to the service worker.

import { readSnapshot, classifyIntent } from './chatgpt-adapter.js';
import { ConversationTracker, DEFAULTS } from './tracker.js';
import { Transport } from './transport.js';
import { Msg } from '../shared/constants.js';

const KIND_TO_MSG = { event: Msg.TRACKER_EVENT, rebind: Msg.TRACKER_REBIND, meta: Msg.TRACKER_META };

export function createRuntime({ doc = document, win = window, sendMessage, now = () => Date.now(), options } = {}) {
  let observer = null;
  let timer = null;
  let urlTimer = null;
  let lastMutationAt = null;
  let lastHref = win.location.href;

  const transport = new Transport({
    send: async (m) => {
      const res = await sendMessage({ type: KIND_TO_MSG[m.kind], payload: m });
      if (res && res.ok === false) throw new Error(res.error || 'rejected');
    },
    onDead: () => stop(),
  });
  const tracker = new ConversationTracker({ emit: (m) => transport.send(m), options });
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
    } catch (err) {
      console.warn('[ChatGPT Timeline] snapshot failed', err);
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
    if (kind === 'submit') tracker.noteSubmitIntent(now());
    else if (kind === 'stop') tracker.noteStopIntent(now());
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
      attributeFilter: ['class', 'data-testid', 'data-message-id', 'aria-label', 'data-is-streaming'],
    });
    doc.addEventListener('keydown', onIntent, true);
    doc.addEventListener('click', onIntent, true);
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('popstate', checkUrl);
    urlTimer = win.setInterval(checkUrl, 1000);
    run();
  }

  function stop() {
    observer?.disconnect();
    doc.removeEventListener('keydown', onIntent, true);
    doc.removeEventListener('click', onIntent, true);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('popstate', checkUrl);
    if (timer != null) win.clearTimeout(timer);
    if (urlTimer != null) win.clearInterval(urlTimer);
  }

  return { start, stop, run, tracker, transport };
}

export function start() {
  if (globalThis.__chatgptTimelineStarted) return;
  globalThis.__chatgptTimelineStarted = true;
  const runtime = createRuntime({ sendMessage: (m) => chrome.runtime.sendMessage(m) });
  runtime.start();
}
