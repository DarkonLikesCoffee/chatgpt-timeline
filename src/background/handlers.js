// Message handling for the service worker, separated from chrome.* wiring so
// it can be tested with an in-memory database.

import { Msg, PROVISIONAL_PREFIX } from '../shared/constants.js';

const PAUSED = 'paused';

function cleanConversation(c, fallbackId) {
  const id = typeof c?.id === 'string' && c.id ? c.id : fallbackId;
  return {
    id,
    title: typeof c?.title === 'string' ? c.title.slice(0, 300) : '',
    url: typeof c?.url === 'string' && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(c.url) ? c.url : '',
  };
}

// Only the documented metadata fields are persisted, whatever the sender adds.
const EVENT_FIELDS = [
  'id', 'conversationId', 'type', 'timestamp', 'timestampSource', 'messageId', 'requestMessageId',
  'requestEventId', 'association', 'responseKind', 'previousResponseId', 'startedAt', 'revisionOf',
];

function cleanEvent(e) {
  const out = {};
  for (const k of EVENT_FIELDS) if (e[k] !== undefined) out[k] = e[k];
  out.recordedAt = Date.now();
  return out;
}

export async function handleMessage(message, { getDB, notifyChanged = () => {}, openDashboard = () => {}, workerStartedAt = null }) {
  const p = message.payload || {};
  switch (message.type) {
    case Msg.TRACKER_EVENT: {
      const db = await getDB();
      if (await db.getSetting(PAUSED, false)) return { ok: true, stored: false, paused: true };
      const event = cleanEvent(p.event || {});
      const { stored } = await db.recordEvent(event, cleanConversation(p.conversation, event.conversationId));
      if (stored) notifyChanged();
      return { ok: true, stored };
    }
    case Msg.TRACKER_REBIND: {
      if (typeof p.from !== 'string' || !p.from.startsWith(PROVISIONAL_PREFIX) || typeof p.to !== 'string') {
        return { ok: false, error: 'invalid rebind' };
      }
      const db = await getDB();
      const moved = await db.rebindConversation(p.from, p.to, cleanConversation(p.conversation, p.to));
      notifyChanged();
      return { ok: true, moved };
    }
    case Msg.TRACKER_META: {
      const db = await getDB();
      const changed = await db.updateConversationMeta(cleanConversation(p.conversation));
      if (changed) notifyChanged();
      return { ok: true, changed };
    }
    case Msg.GET_STATUS: {
      const db = await getDB();
      return { ok: true, paused: await db.getSetting(PAUSED, false), workerStartedAt, ...(await db.stats()) };
    }
    case Msg.SET_PAUSED: {
      const db = await getDB();
      await db.setSetting(PAUSED, !!p.paused);
      return { ok: true, paused: !!p.paused };
    }
    case Msg.OPEN_DASHBOARD:
      await openDashboard();
      return { ok: true };
    default:
      return { ok: false, error: `unknown message ${message.type}` };
  }
}
