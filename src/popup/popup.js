import { TimelineDB } from '../shared/db.js';

const $ = (s) => document.querySelector(s);

async function showStats() {
  const db = await TimelineDB.open();
  const s = await db.stats();
  const lastLoad = await db.getSetting('lastLoad', null);
  db.close();
  const rows = [
    ['Conversations', String(s.conversations)],
    ['Events', String(s.events)],
    ['Last loaded', lastLoad ? new Date(lastLoad.at).toLocaleString() : 'never'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    $('#stats').append(dt, dd);
  }
}

$('#open').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
});

showStats().catch((err) => {
  $('#stats').textContent = `Could not read local data: ${err.message || err}`;
});
