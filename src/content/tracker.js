// Turns a sequence of page snapshots (produced by the site adapter) into
// conversation events. Pure logic: no DOM, no chrome APIs, no timers. The
// content script feeds it snapshots and user intents; tests do the same with
// hand-written snapshots.
//
// Snapshot shape:
//   {
//     at: number,                  // epoch ms of the DOM state (last mutation)
//     conversationId: string|null, // from the URL; null for a new, unsaved chat
//     url: string, title: string,
//     generating: boolean,         // ChatGPT shows its "stop generating" control
//     trailingError: boolean,      // an error notice follows the last turn
//     turns: [{ role: 'user'|'assistant', id: string, streaming?: boolean,
//               error?: boolean, length?: number }]   // length: rendered text length, never stored
//   }
//
// Rules (see README "Event semantics"):
// - A user message is recorded only if it appears live in this tab: a send
//   intent (send click / Enter) shortly before it rendered, or, failing that,
//   generation visibly starting right after it rendered (stop control
//   appearing, or the response after it streaming). Messages rendered from
//   history are never recorded. A just-sent message re-rendered under a new
//   id is the same message.
// - A response is associated with the user turn that immediately precedes it
//   in the rendered thread (never "the latest user message").
// - A response is complete when it is no longer streaming, ChatGPT's
//   generation control is gone and its rendered length stops changing, and
//   that state holds for CONFIRM_MS (QUIET_MS if the stop control has never
//   been seen, i.e. its selector may be outdated). The timestamp is the moment the state was first observed, not
//   the confirmation time.

import {
  EventType,
  TimestampSource,
  Association,
  ResponseKind,
  PROVISIONAL_PREFIX,
} from '../shared/constants.js';

export const DEFAULTS = Object.freeze({
  INTENT_WINDOW_MS: 20000, // send intent -> rendered user message
  FALLBACK_WINDOW_MS: 3000, // rendered user message -> generation start
  GROWTH_WINDOW_MS: 15000, // rendered user message -> its response visibly streaming
  ALIAS_WINDOW_MS: 10000, // a just-sent message re-rendered under a new id
  SETTLE_MS: 3000, // ignore generation-start fallback right after navigation
  CONFIRM_MS: 800, // completion must hold this long
  QUIET_MS: 3000, // completion hold time while the stop control has never been seen on this page
  STOP_WINDOW_MS: 5000, // stop click -> end of generation counts as interruption
});

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class ConversationTracker {
  constructor({ emit, newId = defaultId, options = {} } = {}) {
    this.emit = emit;
    this.newId = newId;
    this.opt = { ...DEFAULTS, ...options };
    this.key = null;
    this.submitIntents = [];
    this.stopIntents = [];
    this.sawGenerating = false; // page lifetime, survives navigation
  }

  noteSubmitIntent(at) {
    this.submitIntents.push(at);
    if (this.submitIntents.length > 20) this.submitIntents.shift();
  }

  noteStopIntent(at) {
    this.stopIntents.push(at);
    if (this.stopIntents.length > 20) this.stopIntents.shift();
  }

  get conversationKey() {
    return this.key;
  }

  // True while a completion has been observed but not yet confirmed; the
  // caller should process another snapshot after CONFIRM_MS.
  hasPendingConfirmation() {
    if (!this.responses) return false;
    for (const r of this.responses.values()) if (r.live && !r.final && r.candidateAt != null) return true;
    return false;
  }

  process(s) {
    this.syncConversation(s);
    const at = s.at;
    const turns = s.turns.filter((t) => t && t.id && (t.role === 'user' || t.role === 'assistant'));

    // Generation start, as a transition observed in this tab (not on the
    // first snapshot after navigation, which may show an ongoing generation).
    if (this.prevGenerating === false && s.generating && at - this.resetAt >= this.opt.SETTLE_MS) {
      this.lastGenStartAt = at;
    }
    this.prevGenerating = !!s.generating;
    if (s.generating) this.sawGenerating = true;

    this.processUsers(s, turns, at);
    this.processAssistants(s, turns, at);
    this.processTrailingError(s, turns, at);
    this.prevUserOrder = turns.filter((t) => t.role === 'user').map((t) => t.id);
  }

  // Finalize completions that were observed but not yet confirmed (page is
  // being hidden or left).
  flush(at) {
    if (!this.responses) return;
    for (const [id, r] of this.responses) {
      if (r.live && !r.final && r.candidateAt != null) this.finalize(id, r, EventType.ASSISTANT_RESPONSE_COMPLETED, r.candidateAt, at);
    }
  }

  // ---- conversation identity -------------------------------------------

  reset(s) {
    this.realId = s.conversationId || null;
    this.key = this.realId || PROVISIONAL_PREFIX + this.newId();
    this.keyUsed = false;
    this.resetAt = s.at;
    this.users = new Map(); // id -> { firstSeenAt }
    this.liveUserIds = new Set();
    this.responses = new Map(); // id -> response state
    this.responsesByRequest = new Map(); // user id -> Set(response ids)
    this.failedRequests = new Set();
    this.prevUserOrder = [];
    this.prevGenerating = null;
    this.lastGenStartAt = -Infinity;
    this.unconfirmedUser = null;
    this.aliases = new Map(); // re-rendered message id -> recorded message id
    this.submitIntents = this.submitIntents.filter((t) => s.at - t <= this.opt.INTENT_WINDOW_MS && t >= s.at - 2000);
    this.stopIntents = [];
    this.meta = { title: s.title || '', url: s.url || '' };
  }

  syncConversation(s) {
    const id = s.conversationId || null;
    if (this.key == null) return this.reset(s);
    if (id === this.realId) return this.updateMeta(s);

    if (this.realId == null && id) {
      // A new chat just received its id. It is the same thread if any turn we
      // already know is still rendered.
      const carried = s.turns.some((t) => t && (this.users.has(t.id) || this.responses.has(t.id)));
      if (carried) {
        const from = this.key;
        this.realId = id;
        this.key = id;
        this.meta = { title: s.title || '', url: s.url || '' };
        if (this.keyUsed) this.emit({ kind: 'rebind', from, to: id, conversation: this.conversation() });
        return;
      }
    }
    // Navigated to another conversation (or to a new chat).
    this.flush(s.at);
    this.reset(s);
  }

  updateMeta(s) {
    const title = s.title || '';
    const url = s.url || '';
    if (title === this.meta.title && url === this.meta.url) return;
    this.meta = { title, url };
    if (this.realId) this.emit({ kind: 'meta', conversation: this.conversation() });
  }

  conversation() {
    return { id: this.key, title: this.meta.title, url: this.realId ? this.meta.url : '' };
  }

  emitEvent(event) {
    this.keyUsed = true;
    this.emit({ kind: 'event', event: { conversationId: this.key, ...event }, conversation: this.conversation() });
  }

  // ---- user messages ----------------------------------------------------

  takeSubmitIntent(at) {
    // The latest intent before the message rendered; older ones (e.g. Enter
    // pressed on an empty composer) are discarded so they cannot be reused.
    let best = -1;
    this.submitIntents.forEach((t, i) => {
      if (t <= at + 50 && at - t <= this.opt.INTENT_WINDOW_MS) best = i;
    });
    if (best < 0) return null;
    const t = this.submitIntents[best];
    this.submitIntents.splice(0, best + 1);
    return t;
  }

  processUsers(s, turns, at) {
    const userTurns = turns.filter((t) => t.role === 'user');
    const fresh = userTurns.filter((t) => !this.users.has(t.id));
    for (const t of fresh) this.users.set(t.id, { firstSeenAt: at });

    // Only the last rendered user turn can be a live submission.
    const last = userTurns[userTurns.length - 1];
    if (last && fresh.includes(last)) {
      const replaced = this.prevUserOrder[userTurns.length - 1];
      const intent = this.takeSubmitIntent(at);
      if (intent != null) {
        this.recordUser(last, userTurns, intent, TimestampSource.SUBMIT_INTENT);
      } else if (
        replaced && replaced !== last.id && this.liveUserIds.has(replaced) &&
        !userTurns.some((t) => t.id === replaced) && at - this.users.get(replaced).firstSeenAt <= this.opt.ALIAS_WINDOW_MS
      ) {
        // The message just sent was re-rendered under a new id (e.g. a
        // client-side id replaced by the server's): same message, no new event.
        this.aliases.set(last.id, this.resolve(replaced));
      } else if (fresh.length === 1 && at - this.resetAt >= this.opt.SETTLE_MS) {
        // Several user turns rendering at once is history (load, branch
        // switch), and so are turns rendered right after navigation.
        this.unconfirmedUser = { id: last.id, seenAt: at };
      } else {
        this.unconfirmedUser = null;
      }
    }

    // Fallback 1: no intent was captured (e.g. a control we do not
    // recognise), but generation started right after the message rendered.
    // (Fallback 2, a response visibly streaming, is in processAssistants.)
    const u = this.unconfirmedUser;
    if (u && !this.liveUserIds.has(u.id)) {
      if (last && last.id === u.id && this.lastGenStartAt >= u.seenAt - 1000 && this.lastGenStartAt - u.seenAt < this.opt.FALLBACK_WINDOW_MS) {
        this.recordUser(last, userTurns, u.seenAt, TimestampSource.DOM_OBSERVED);
        this.unconfirmedUser = null;
      } else if (at - u.seenAt > this.opt.GROWTH_WINDOW_MS || !last || last.id !== u.id) {
        this.unconfirmedUser = null;
      }
    }
  }

  resolve(id) {
    return this.aliases.get(id) ?? id;
  }

  recordUser(turn, userTurns, timestamp, source) {
    this.liveUserIds.add(turn.id);
    // Edited and resubmitted: a new message id at the position of a message
    // that is no longer rendered.
    const pos = userTurns.indexOf(turn);
    const before = this.prevUserOrder[pos];
    const revisionOf = before && before !== turn.id && !userTurns.some((t) => t.id === before) ? before : null;
    this.emitEvent({
      id: `user:${turn.id}`,
      type: EventType.USER_MESSAGE,
      timestamp,
      timestampSource: source,
      messageId: turn.id,
      ...(revisionOf ? { revisionOf } : {}),
    });
  }

  // ---- assistant responses ------------------------------------------------

  processAssistants(s, turns, at) {
    turns.forEach((turn, i) => {
      if (turn.role !== 'assistant') return;
      const isLast = i === turns.length - 1;
      const inProgress = !!turn.streaming || (!!s.generating && isLast);
      let r = this.responses.get(turn.id);
      if (!r) {
        const prev = turns[i - 1];
        const requestMessageId = prev && prev.role === 'user' ? this.resolve(prev.id) : null;
        const siblings = requestMessageId ? this.responsesByRequest.get(requestMessageId) || new Set() : new Set();
        const previousResponseId = [...siblings].pop() || null;
        r = {
          requestMessageId,
          association: requestMessageId ? Association.DOM_ADJACENT : Association.NONE,
          // A new response under a request that already had one rendered.
          kind: previousResponseId ? ResponseKind.REGENERATED : ResponseKind.INITIAL,
          previousResponseId,
          startedAt: at,
          live: (requestMessageId != null && this.liveUserIds.has(requestMessageId) && !previousResponseId) || inProgress,
          candidateAt: null,
          lastLength: turn.length ?? null,
          final: false,
        };
        this.responses.set(turn.id, r);
        if (requestMessageId) this.responsesByRequest.set(requestMessageId, siblings.add(turn.id));
      }
      const len = turn.length ?? null;
      const grew = r.lastLength != null && len != null && len !== r.lastLength;
      r.lastLength = len;
      // An already-rendered response becomes live only with evidence of its
      // own generation (e.g. "continue generating"). The stop control alone is
      // not enough: right after a send it can appear one frame before the new
      // user turn, while an old response is still the last turn.
      if (!r.live && !r.final && (turn.streaming || (inProgress && grew))) r.live = true;
      // Fallback 2: the unconfirmed user message right before this response
      // was sent live if the response is visibly generating (text growing),
      // even when neither a send action nor the stop control was recognised.
      const u = this.unconfirmedUser;
      const prev = turns[i - 1];
      if (u && !r.final && prev && prev.role === 'user' && prev.id === u.id && (r.live || grew)) {
        this.recordUser(prev, turns.filter((t) => t.role === 'user'), u.seenAt, TimestampSource.DOM_OBSERVED);
        this.unconfirmedUser = null;
        r.live = true;
      }
      if (!r.live || r.final) return;

      if (turn.error) {
        this.finalize(turn.id, r, EventType.ASSISTANT_RESPONSE_FAILED, r.candidateAt ?? at, at);
      } else if (inProgress) {
        r.candidateAt = null;
      } else {
        if (r.candidateAt == null || grew) r.candidateAt = at;
        const hold = this.sawGenerating ? this.opt.CONFIRM_MS : this.opt.QUIET_MS;
        if (at - r.candidateAt >= hold) {
          this.finalize(turn.id, r, EventType.ASSISTANT_RESPONSE_COMPLETED, r.candidateAt, at);
        }
      }
    });
  }

  finalize(id, r, type, timestamp) {
    r.final = true;
    if (type === EventType.ASSISTANT_RESPONSE_COMPLETED) {
      const stopped = this.stopIntents.some((t) => t >= r.startedAt - 1000 && t <= timestamp + 500 && timestamp - t <= this.opt.STOP_WINDOW_MS);
      if (stopped) type = EventType.ASSISTANT_RESPONSE_INTERRUPTED;
    }
    this.emitEvent({
      id: `resp:${id}`,
      type,
      timestamp,
      timestampSource: TimestampSource.DOM_TRANSITION,
      messageId: id,
      requestMessageId: r.requestMessageId,
      requestEventId: r.requestMessageId ? `user:${r.requestMessageId}` : null,
      association: r.association,
      responseKind: r.kind,
      previousResponseId: r.previousResponseId,
      startedAt: r.startedAt,
    });
  }

  // An error shown after the last user turn with no response turn at all.
  processTrailingError(s, turns, at) {
    if (!s.trailingError) return;
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn || lastTurn.role !== 'user') return;
    const last = { id: this.resolve(lastTurn.id) };
    if (!this.liveUserIds.has(last.id) || this.failedRequests.has(last.id)) return;
    this.failedRequests.add(last.id);
    this.emitEvent({
      id: `fail:${last.id}`,
      type: EventType.ASSISTANT_RESPONSE_FAILED,
      timestamp: at,
      timestampSource: TimestampSource.DOM_OBSERVED,
      messageId: null,
      requestMessageId: last.id,
      requestEventId: `user:${last.id}`,
      association: Association.DOM_ADJACENT,
      responseKind: ResponseKind.INITIAL,
      previousResponseId: null,
      startedAt: at,
    });
  }
}
