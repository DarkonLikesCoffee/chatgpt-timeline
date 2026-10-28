// Values shared by the content script, dashboard, popup and tests.

export const EventType = Object.freeze({
  USER_MESSAGE: 'USER_MESSAGE',
  ASSISTANT_RESPONSE_COMPLETED: 'ASSISTANT_RESPONSE_COMPLETED',
  // Outcomes that are not a completed response. They never produce a
  // "completed" interval on the timeline.
  ASSISTANT_RESPONSE_INTERRUPTED: 'ASSISTANT_RESPONSE_INTERRUPTED',
  ASSISTANT_RESPONSE_FAILED: 'ASSISTANT_RESPONSE_FAILED',
});

export const RESPONSE_TYPES = Object.freeze([
  EventType.ASSISTANT_RESPONSE_COMPLETED,
  EventType.ASSISTANT_RESPONSE_INTERRUPTED,
  EventType.ASSISTANT_RESPONSE_FAILED,
]);

// Where an event's timestamp comes from (all from ChatGPT's stored history).
export const TimestampSource = Object.freeze({
  // The message's own creation time: exact for messages you sent.
  SERVER_CREATE: 'server-create-time',
  // The last update of the response's final message: close to completion.
  SERVER_UPDATE: 'server-update-time',
});

// How a response was associated with the user message that initiated it.
export const Association = Object.freeze({
  // The response is a descendant of the user message in the conversation tree.
  SERVER_TREE: 'server-tree',
});

export const ResponseKind = Object.freeze({
  INITIAL: 'initial',
  REGENERATED: 'regenerated',
});

// Port between the dashboard and the content script on a chatgpt.com tab.
export const HISTORY_PORT = 'chatgpt-history';

export const PROVISIONAL_PREFIX = 'tmp-';
