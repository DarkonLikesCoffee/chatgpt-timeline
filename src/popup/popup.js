import { Msg } from '../shared/constants.js';

const $ = (s) => document.querySelector(s);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: Msg.GET_STATUS }).catch((e) => ({ ok: false, error: String(e) }));
  if (!s || !s.ok) {
    $('#status').textContent = `Background unavailable${s && s.error ? `: ${s.error}` : ''}`;
    return;
  }
  $('#status').textContent = s.paused ? 'Tracking paused' : 'Tracking active';
  $('#status').className = `status ${s.paused ? 'off' : 'on'}`;
  const last = s.lastEventAt ? new Date(s.lastEventAt).toLocaleString() : '—';
  $('#stats').innerHTML = '';
  for (const [k, v] of [['Conversations', s.conversations], ['Events', s.events], ['Last event', last]]) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    $('#stats').append(dt, dd);
  }
  $('#pause').textContent = s.paused ? 'Resume tracking' : 'Pause tracking';
  $('#pause').onclick = async () => {
    await chrome.runtime.sendMessage({ type: Msg.SET_PAUSED, payload: { paused: !s.paused } });
    refresh();
  };
}

function line(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  return li;
}

// Plain-language reading of the content script's diagnostics.
export function summarize(d) {
  const out = [];
  const p = d.page || {};
  const snap = p.snapshot || {};
  out.push(['Tracker running on this tab', 'ok']);
  out.push(snap.turns
    ? [`Found ${snap.users} of your messages and ${snap.assistants} responses on the page`, 'ok']
    : ['No messages found on the page (open a conversation, or ChatGPT\'s page structure changed)', 'bad']);
  if (snap.withoutId) out.push([`${snap.withoutId} messages have no message id`, 'bad']);
  out.push([`Send actions detected: ${d.intents.submit}`, d.intents.submit ? 'ok' : '']);
  out.push([d.tracker.sawStopControl ? 'Stop button recognized' : 'Stop button not seen yet on this page', d.tracker.sawStopControl ? 'ok' : '']);
  const sent = Object.entries(d.emitted).map(([k, v]) => `${k}: ${v}`).join(', ');
  out.push([`Recorded on this page: ${sent || 'nothing yet'}`, sent ? 'ok' : '']);
  if (d.transport.failedAttempts) out.push([`Delivery problems: ${d.transport.lastError}`, 'bad']);
  if (d.transport.dead) out.push(['Extension was reloaded: reload this tab', 'bad']);
  if (d.snapshotErrors) out.push([`Errors reading the page: ${d.snapshotErrors}`, 'bad']);
  return out;
}

async function tabDiagnostics() {
  const list = $('#tabStatus');
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  let d = null;
  let err = null;
  if (tab && tab.id != null) {
    d = await chrome.tabs.sendMessage(tab.id, { type: Msg.GET_DIAGNOSTICS }).catch((e) => {
      err = e;
      return null;
    });
  }
  list.innerHTML = '';
  if (!d || !d.ok) {
    list.append(line('Tracker is not running on this tab.', 'bad'));
    list.append(line('Open chatgpt.com in this tab. If it is already open, reload the tab (needed after installing or reloading the extension).'));
    if (err) console.debug('diagnostics unavailable', err);
    return;
  }
  for (const [text, cls] of summarize(d)) list.append(line(text, cls));
  const btn = $('#copyDiag');
  btn.hidden = false;
  btn.onclick = async () => {
    await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
    $('#copied').hidden = false;
  };
}

$('#open').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: Msg.OPEN_DASHBOARD });
  window.close();
});

refresh();
tabDiagnostics();
