// Converts stored events into what the timeline draws. Independent of zoom:
// all values are absolute epoch-millisecond instants.

import { EventType, RESPONSE_TYPES, ResponseKind, PROVISIONAL_PREFIX } from '../shared/constants.js';

const STATUS = {
  [EventType.ASSISTANT_RESPONSE_COMPLETED]: 'completed',
  [EventType.ASSISTANT_RESPONSE_INTERRUPTED]: 'interrupted',
  [EventType.ASSISTANT_RESPONSE_FAILED]: 'failed',
};

const responseTypes = new Set(RESPONSE_TYPES);

// Pair one conversation's events.
// Returns { markers, intervals, unpaired, pending }:
//   markers   - every event, { event, t, type }
//   intervals - { id, start, end, status, attempt, regenerated, request, response, lane }
//               one per response whose initiating user message was recorded
//   unpaired  - response events whose request was not recorded (no interval)
//   pending   - user messages with no recorded response outcome
export function pairEvents(events) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const users = new Map();
  const responsesByRequest = new Map();
  const unpaired = [];
  for (const e of sorted) {
    if (e.type === EventType.USER_MESSAGE) {
      if (e.messageId) users.set(e.messageId, e);
    } else if (responseTypes.has(e.type)) {
      if (!e.requestMessageId) {
        unpaired.push(e);
        continue;
      }
      if (!responsesByRequest.has(e.requestMessageId)) responsesByRequest.set(e.requestMessageId, []);
      responsesByRequest.get(e.requestMessageId).push(e);
    }
  }

  const intervals = [];
  const answered = new Set();
  for (const [requestId, responses] of responsesByRequest) {
    const request = users.get(requestId);
    if (!request) {
      unpaired.push(...responses);
      continue;
    }
    answered.add(requestId);
    responses.sort((a, b) => (a.startedAt ?? a.timestamp) - (b.startedAt ?? b.timestamp) || a.timestamp - b.timestamp);
    responses.forEach((response, i) => {
      const regenerated = i > 0 || response.responseKind === ResponseKind.REGENERATED;
      // A regenerated attempt starts when its generation was observed, not at
      // the original message (which already has its own interval).
      const start = regenerated ? Math.max(request.timestamp, response.startedAt ?? request.timestamp) : request.timestamp;
      intervals.push({
        id: response.id,
        start,
        end: Math.max(start, response.timestamp),
        status: STATUS[response.type],
        attempt: i + 1,
        regenerated,
        request,
        response,
      });
    });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  assignLanes(intervals);

  const pending = sorted.filter((e) => e.type === EventType.USER_MESSAGE && !answered.has(e.messageId));
  const markers = sorted.map((event) => ({ event, t: event.timestamp, type: event.type }));
  unpaired.sort((a, b) => a.timestamp - b.timestamp);
  return { markers, intervals, unpaired, pending };
}

// Overlapping intervals in one conversation get separate lanes so each stays
// visible and clickable. Mutates and returns the number of lanes.
export function assignLanes(intervals) {
  const laneEnds = [];
  for (const iv of intervals) {
    let lane = laneEnds.findIndex((end) => end <= iv.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(iv.end);
    } else {
      laneEnds[lane] = iv.end;
    }
    iv.lane = lane;
  }
  return laneEnds.length;
}

// Build one row per conversation. Conversations without events still get a
// row (they can exist after a partial delete or import).
export function buildRows(conversations, events) {
  const byConv = new Map();
  for (const e of events) {
    if (!byConv.has(e.conversationId)) byConv.set(e.conversationId, []);
    byConv.get(e.conversationId).push(e);
  }
  const convMap = new Map(conversations.map((c) => [c.id, c]));
  for (const id of byConv.keys()) {
    if (!convMap.has(id)) convMap.set(id, { id, title: '', url: '', firstObservedAt: null, lastActivityAt: null });
  }
  const rows = [];
  for (const conversation of convMap.values()) {
    const evs = byConv.get(conversation.id) || [];
    const paired = pairEvents(evs);
    let first = Infinity;
    let last = -Infinity;
    for (const e of evs) {
      if (e.timestamp < first) first = e.timestamp;
      if (e.timestamp > last) last = e.timestamp;
    }
    rows.push({
      id: conversation.id,
      conversation,
      title: displayTitle(conversation),
      events: paired.markers.map((m) => m.event),
      ...paired,
      lanes: paired.intervals.reduce((n, iv) => Math.max(n, iv.lane + 1), 1),
      firstActivityAt: evs.length ? first : conversation.firstObservedAt,
      lastActivityAt: evs.length ? last : conversation.lastActivityAt,
    });
  }
  return rows;
}

export function displayTitle(conversation) {
  if (conversation.title) return conversation.title;
  if (conversation.id.startsWith(PROVISIONAL_PREFIX)) return 'New chat (no conversation id yet)';
  return 'Untitled conversation';
}

// Short, stable suffix that tells apart conversations with equal titles.
export function shortId(id) {
  return id.startsWith(PROVISIONAL_PREFIX) ? 'unsaved' : id.slice(0, 8);
}

export function rowHasActivityIn(row, start, end) {
  if (row.markers.some((m) => m.t >= start && m.t < end)) return true;
  return row.intervals.some((iv) => iv.start < end && iv.end >= start);
}

// Search, filter and sort rows. Does not modify rows.
//   query        - case-insensitive title substring (also matches the id)
//   sort         - 'recent' (latest activity first) | 'chronological' (first activity first) | 'title'
//   window       - { start, end } visible range; with onlyActiveInWindow hides rows without activity there
//   activeFrom/activeTo - date filter (epoch ms, end exclusive); keeps rows with any event in range
export function selectRows(rows, { query = '', sort = 'recent', window, onlyActiveInWindow = false, activeFrom, activeTo } = {}) {
  const q = query.trim().toLowerCase();
  let out = rows.filter((r) => !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  if (activeFrom != null || activeTo != null) {
    const from = activeFrom ?? -Infinity;
    const to = activeTo ?? Infinity;
    out = out.filter((r) => rowHasActivityIn(r, from, to));
  }
  if (onlyActiveInWindow && window) out = out.filter((r) => rowHasActivityIn(r, window.start, window.end));
  const cmp = {
    recent: (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
    chronological: (a, b) => (a.firstActivityAt ?? Infinity) - (b.firstActivityAt ?? Infinity),
    title: (a, b) => a.title.localeCompare(b.title),
  }[sort] || (() => 0);
  return out.sort((a, b) => cmp(a, b) || a.id.localeCompare(b.id));
}

// Items of a row that are visible in [start, end).
export function visibleItems(row, start, end) {
  return {
    intervals: row.intervals.filter((iv) => iv.start < end && iv.end >= start),
    markers: row.markers.filter((m) => m.t >= start && m.t < end),
  };
}
