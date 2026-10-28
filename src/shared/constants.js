// Values shared by the content script, service worker, dashboard and tests.

export const EventType = Object.freeze({
  USER_MESSAGE: 'USER_MESSAGE',
  ASSISTANT_RESPONSE_COMPLETED: 'ASSISTANT_RESPONSE_COMPLETED',
  // Outcomes that are observed but are not a completed response. They never
  // produce a "completed" interval on the timeline.
  ASSISTANT_RESPONSE_INTERRUPTED: 'ASSISTANT_RESPONSE_INTERRUPTED',
  ASSISTANT_RESPONSE_FAILED: 'ASSISTANT_RESPONSE_FAILED',
});

export const RESPONSE_TYPES = Object.freeze([
  EventType.ASSISTANT_RESPONSE_COMPLETED,
  EventType.ASSISTANT_RESPONSE_INTERRUPTED,
  EventType.ASSISTANT_RESPONSE_FAILED,
]);

// How an event's timestamp was obtained, best first. Used to merge the same
// event reported by more than one tab.
export const TimestampSource = Object.freeze({
  SUBMIT_INTENT: 'submit-intent', // send click / Enter in the composer, confirmed by the rendered message
  DOM_TRANSITION: 'dom-transition', // the DOM change that ended generation
  DOM_OBSERVED: 'dom-observed', // first time the element was seen (less precise)
});

export const SOURCE_RANK = Object.freeze({
  [TimestampSource.SUBMIT_INTENT]: 3,
  [TimestampSource.DOM_TRANSITION]: 2,
  [TimestampSource.DOM_OBSERVED]: 1,
});

// How a response was associated with the user message that initiated it.
export const Association = Object.freeze({
  // The response turn immediately follows the user turn in the rendered thread.
  DOM_ADJACENT: 'dom-adjacent',
  // No user turn precedes the response turn; the request is unknown.
  NONE: 'none',
});

export const ResponseKind = Object.freeze({
  INITIAL: 'initial',
  REGENERATED: 'regenerated',
});

export const Msg = Object.freeze({
  TRACKER_EVENT: 'tracker:event',
  TRACKER_REBIND: 'tracker:rebind',
  TRACKER_META: 'tracker:meta',
  GET_STATUS: 'status:get',
  SET_PAUSED: 'status:set-paused',
  OPEN_DASHBOARD: 'dashboard:open',
  GET_DIAGNOSTICS: 'diagnostics:get', // popup -> content script of a tab
  DB_CHANGED: 'db:changed',
});

export const PROVISIONAL_PREFIX = 'tmp-';
