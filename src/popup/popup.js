import { Msg } from '../shared/constants.js';

const $ = (s) => document.querySelector(s);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: Msg.GET_STATUS });
  if (!s || !s.ok) {
    $('#status').textContent = 'Status unavailable';
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

$('#open').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: Msg.OPEN_DASHBOARD });
  window.close();
});

refresh();
