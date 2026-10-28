// Converts one conversation, as delivered by the content script (ChatGPT's
// message tree with text already removed), into timeline events.
//
// Input:
//   { id, title, create_time, update_time,
//     nodes: [{ id, parent, children, role, create_time, update_time, status,
//               finish_type, hidden, content_type }] }
// Times may be epoch seconds, epoch milliseconds or ISO strings.
//
// Rules:
// - Every visible user message is a USER_MESSAGE at its creation time.
// - Each non-user child of a user message starts one response attempt; the
//   attempt is that child's subtree up to the next user message (tool calls,
//   reasoning and the answer). More than one attempt = regenerated responses.
// - Attempt outcome comes from its last assistant message: in progress (no
//   event), interrupted, failed, or completed. The completion time is the
//   latest update (or, if ChatGPT stored none, creation) time of the
//   attempt's assistant messages.
// - A user message whose parent already had an earlier user child is an
//   edit of that message (revisionOf).

import { EventType, TimestampSource, Association, ResponseKind } from './constants.js';

// User-role nodes that are context, not messages the user sent.
const NON_MESSAGE_USER_TYPES = new Set(['user_editable_context', 'model_editable_context']);
const RESPONSE_ROLES = new Set(['assistant', 'tool']);

export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? Math.round(v * 1000) : Math.round(v)) : null;
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function conversationUrl(id) {
  return `https://chatgpt.com/c/${id}`;
}

function isUserMessage(n) {
  return n.role === 'user' && !n.hidden && !NON_MESSAGE_USER_TYPES.has(n.content_type) && toMs(n.create_time) != null;
}

function outcome(last) {
  const status = String(last.status || '');
  if (status === 'in_progress') return null;
  if (last.finish_type === 'interrupted' || status === 'finished_partial_completion') return EventType.ASSISTANT_RESPONSE_INTERRUPTED;
  if (/error|fail/i.test(status) || last.finish_type === 'error') return EventType.ASSISTANT_RESPONSE_FAILED;
  return EventType.ASSISTANT_RESPONSE_COMPLETED;
}

export function convertConversation(conv) {
  const nodes = new Map((conv.nodes || []).map((n) => [n.id, n]));
  const users = [...nodes.values()].filter(isUserMessage);
  const userIds = new Set(users.map((u) => u.id));
  const events = [];
  const stats = { messages: 0, responses: 0, withUpdateTime: 0, inProgress: 0 };

  // Non-user nodes in the subtree of `rootId`, stopping at user messages.
  const attemptNodes = (rootId) => {
    const out = [];
    const stack = [rootId];
    while (stack.length) {
      const n = nodes.get(stack.pop());
      if (!n || userIds.has(n.id) || n.role === 'user') continue;
      out.push(n);
      for (const c of n.children || []) stack.push(c);
    }
    return out;
  };

  for (const u of users) {
    const sentAt = toMs(u.create_time);
    // Edit: an earlier visible user sibling under the same parent.
    const parent = u.parent ? nodes.get(u.parent) : null;
    const earlierSiblings = parent
      ? (parent.children || [])
          .map((id) => nodes.get(id))
          .filter((s) => s && s.id !== u.id && isUserMessage(s) && toMs(s.create_time) < sentAt)
          .sort((a, b) => toMs(a.create_time) - toMs(b.create_time))
      : [];
    events.push({
      id: `user:${u.id}`,
      conversationId: conv.id,
      type: EventType.USER_MESSAGE,
      timestamp: sentAt,
      timestampSource: TimestampSource.SERVER_CREATE,
      messageId: u.id,
      ...(earlierSiblings.length ? { revisionOf: earlierSiblings[earlierSiblings.length - 1].id } : {}),
    });
    stats.messages++;

    const attempts = [];
    for (const childId of u.children || []) {
      const child = nodes.get(childId);
      if (!child || userIds.has(childId)) continue;
      const parts = attemptNodes(childId).filter((n) => RESPONSE_ROLES.has(n.role) && toMs(n.create_time) != null);
      const assistants = parts.filter((n) => n.role === 'assistant');
      if (!assistants.length) continue;
      const startedAt = Math.min(...parts.map((n) => toMs(n.create_time)));
      const last = assistants.reduce((a, b) => (toMs(b.create_time) >= toMs(a.create_time) ? b : a));
      let end = -Infinity;
      let fromUpdate = false;
      for (const n of assistants) {
        const c = toMs(n.create_time);
        const up = toMs(n.update_time);
        if (up != null && up >= c && up > end) {
          end = up;
          fromUpdate = true;
        } else if (c > end) {
          end = c;
          fromUpdate = false;
        }
      }
      attempts.push({ id: childId, startedAt, end, fromUpdate, type: outcome(last) });
    }
    attempts.sort((a, b) => a.startedAt - b.startedAt);
    attempts.forEach((a, i) => {
      if (!a.type) {
        stats.inProgress++;
        return;
      }
      stats.responses++;
      if (a.fromUpdate) stats.withUpdateTime++;
      events.push({
        id: `resp:${a.id}`,
        conversationId: conv.id,
        type: a.type,
        timestamp: Math.max(a.end, sentAt),
        timestampSource: a.fromUpdate ? TimestampSource.SERVER_UPDATE : TimestampSource.SERVER_CREATE,
        messageId: a.id,
        requestMessageId: u.id,
        requestEventId: `user:${u.id}`,
        association: Association.SERVER_TREE,
        responseKind: i === 0 ? ResponseKind.INITIAL : ResponseKind.REGENERATED,
        previousResponseId: i === 0 ? null : attempts[i - 1].id,
        startedAt: Math.max(a.startedAt, sentAt),
      });
    });
  }

  const rank = (e) => (e.type === EventType.USER_MESSAGE ? 0 : 1);
  events.sort((a, b) => a.timestamp - b.timestamp || rank(a) - rank(b) || a.id.localeCompare(b.id));
  const times = events.map((e) => e.timestamp);
  const createdAt = toMs(conv.create_time);
  const updatedAt = toMs(conv.update_time);
  const conversation = {
    id: conv.id,
    title: typeof conv.title === 'string' ? conv.title.slice(0, 300) : '',
    url: conversationUrl(conv.id),
    firstObservedAt: createdAt ?? (times.length ? times[0] : null),
    lastActivityAt: times.length ? times[times.length - 1] : updatedAt,
    serverUpdateTime: updatedAt,
  };
  return { conversation, events, stats };
}
