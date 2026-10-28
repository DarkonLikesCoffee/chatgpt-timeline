# ChatGPT Activity Timeline

A Chrome extension (Manifest V3) that records **when you send a message to ChatGPT** and **when ChatGPT finishes responding**, and shows that history as a Gantt-style timeline with one row per conversation.

- Each row is one ChatGPT conversation, identified by the id in its URL (`/c/<id>`), so conversations with identical titles stay separate.
- **●** marks the moment you sent a message, **◆** marks the moment the response finished, and a colored bar connects them.
- Stopped responses (■) and failed ones (✕) are shown, but never as completed intervals.
- Everything stays in your browser. No message text is stored, and nothing is sent anywhere.

> **Verification status.** The extension is tested against a *simulated* ChatGPT page in a real Chromium build, plus unit and DOM-fixture tests. It has **not** been tested against the live chatgpt.com site, because the development environment could not reach chatgpt.com. The ChatGPT selectors were cross-checked against public open-source trackers updated in October 2026, but treat live behavior as unverified until you run the manual checklist in [Verifying on live ChatGPT](#verifying-on-live-chatgpt).

---

## Installation (unpacked)

Requirements: Chrome or Chromium 116 or later. No build step is needed to run the extension.

1. Get the code: `git clone <this repo>`, or download and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder, i.e. the one containing `manifest.json`.
5. Optional: pin **ChatGPT Activity Timeline** from the puzzle-piece menu.
6. Reload any chatgpt.com tabs that were already open, since content scripts only attach to newly loaded pages.

To update after pulling new code, click the reload icon on the extension's card in `chrome://extensions`, then reload your ChatGPT tabs.

## Usage

1. Use ChatGPT at https://chatgpt.com as usual.
2. Click the extension icon to see its status (active or paused, number of conversations and events, time of the last event). Click **Open timeline** to open the dashboard.

### Dashboard

| Control | What it does |
|---|---|
| **Hour / Day / Week / Month** (or keys `1`–`4`) | Zoom level. Windows align to your local calendar: hours, midnights, Monday-start weeks, months. |
| **‹ Now ›** (or `←` / `→`) | Move back or forward by one window, or jump to the window containing the current time. |
| Double-click a track | Zoom into the next finer level at that time. |
| **Search titles** | Filters rows by title (also matches the conversation id). |
| **Sort** | *Recent activity* (latest event first), *Chronological* (earliest first activity first), or *Title*. |
| **Active in view** | Hides conversations with no recorded activity in the visible window. Turn it off to see every conversation. |
| **Dates** | Keeps only conversations with activity between two dates. |
| Conversation title | Opens the original conversation on chatgpt.com in a new tab. |
| Click the row label area | Shows conversation details, its event list, its raw stored data, and a delete button. |
| Click a marker | Shows the event type, exact local timestamp with milliseconds and time zone, the ISO/UTC instant, how the timestamp was obtained, and the associated request or response. |
| Click a bar | Shows send time, completion (or stop/failure) time, duration, attempt number and association. |
| **Data** | Statistics, **Export JSON**, **Delete all activity…**, and a table of conversations with per-conversation *Inspect* and *Delete* buttons. |

Visual encoding:
- Green bar: message → completed response.
- Purple bar: a regenerated response attempt. It starts when the regeneration was observed.
- Grey hatched bar: an outcome that is not a completion (stopped or failed).
- Faded marker: a response whose initiating message is unknown.
- Overlapping intervals in one conversation are drawn in separate lanes, so each stays clickable.
- The red vertical line is "now".

If the selected period has no activity, the dashboard offers **Jump to latest activity**, **Show all conversations** and **Clear filters**.

The dashboard virtualizes rows (only visible rows are in the DOM). A test confirms that building and filtering 3,000 conversations with 60,000 events runs well within interactive limits.

## What is recorded

| Event | When | Timestamp |
|---|---|---|
| `USER_MESSAGE` | You submit a message (send button, Enter, or the *Send* button of an inline edit) **and** the message appears in the conversation. | The time of the send action (`timestampSource: "submit-intent"`). If no send action was captured, the time it appeared (`"dom-observed"`), but only when generation visibly followed: the stop control appeared within 3 s, or the response right after it streamed within 15 s. |
| `ASSISTANT_RESPONSE_COMPLETED` | The response stopped streaming, ChatGPT's stop control disappeared, and the response text stopped changing. | The moment that state was first observed (`"dom-transition"`). It is held for 0.8 s (3 s if the stop control has never been seen on the page) to rule out pauses; the timestamp is not the confirmation time. |
| `ASSISTANT_RESPONSE_INTERRUPTED` | Same as completed, but you clicked ChatGPT's stop button during that generation. | When generation ended. |
| `ASSISTANT_RESPONSE_FAILED` | An error notice appeared in the response, or after your message with no response. | When generation ended, or when the error appeared. |

**Not recorded:** message or response text, attachments, reading time, tab focus or visibility, mouse or keyboard activity (Enter and button clicks only timestamp a message that then actually appears), idle time, open tabs, cookies, credentials, and any site other than chatgpt.com / chat.openai.com. Opening or reading a conversation records nothing. Past conversations are never imported: only activity observed live after installation is recorded.

Gaps between bars do not mean you were inactive; the timeline only shows recorded message/response events.

## How detection works (investigation summary)

ChatGPT has no public API for this, and the extension deliberately does **not** call ChatGPT's internal backend endpoints. It observes the rendered page with a `MutationObserver`. All ChatGPT-specific selectors are in one file, `src/content/chatgpt-adapter.js`, with fallbacks, so a UI change means updating one file.

| Question | Finding / approach |
|---|---|
| Conversation identity | The URL path: `/c/<id>`, `/g/<gpt-or-project>/c/<id>`. A new chat starts at `/` with no id. Events are stored under a provisional id (`tmp-…`) and moved to the real id when ChatGPT pushes `/c/<id>` (detected because the same message elements are still rendered). Titles come from the sidebar link for that id, or `document.title`. |
| Messages | Each message element has `data-message-author-role="user|assistant"` and a stable `data-message-id`. Turns are grouped by `[data-testid^="conversation-turn-"]` (or `article`), so one response made of several messages (tool calls plus answer) counts as one response, identified by its first assistant message id. |
| Submission | Capture-phase listeners classify Enter in a non-empty composer, clicks on `[data-testid="send-button"]` / `#composer-submit-button`, and inline-edit *Send* buttons. These only provide a timestamp. An event is created only when a *new* user message id then renders as the last turn, within 20 s. |
| Generation state | `[data-testid="stop-button"]` (and aria-label fallbacks) exists only while generating. Per-response streaming markers (`.result-streaming`, `.streaming-animation`, `[data-is-streaming="true"]`, …) are also checked, along with whether the response's text length is still changing. |
| Completion vs intermediate rendering | Complete only when *all* of these hold: no streaming marker, no stop control (if this is the last turn), text length unchanged, and the state persists for the hold period. A flicker of the stop control, or text still growing, restarts the check. |
| Edits | Editing creates a new user message id at the same position (a new branch). It is recorded as a new `USER_MESSAGE` with `revisionOf` set to the replaced message id. |
| Regeneration | A new assistant message id after the same user message, observed generating. It is recorded as another outcome with `responseKind: "regenerated"`, `previousResponseId`, and its own `startedAt`. Switching between existing alternatives with `‹ 1/2 ›` is not generation, so it records nothing. |
| Stop / errors | A click on the stop control during a generation turns its outcome into `INTERRUPTED`. Error notices (`.text-token-text-error`, …) produce `FAILED`. |
| History vs live | A message counts as live only if it is the newest user turn and either a send action preceded it or generation visibly followed it. Several messages appearing at once without a send action are history (page load, branch switch, lazy rendering). Turns that render within 3 s after navigation are never considered live, so a page load is not mistaken for a send. If a just-sent message is re-rendered under a new id, it is treated as the same message. |
| SPA navigation | URL changes are detected via mutations, `popstate` and a 1 s poll. On navigation, completions that were observed but not yet confirmed are saved for the old conversation; tracking state then resets. |
| Same conversation in several tabs | Event ids are deterministic (`user:<messageId>`, `resp:<responseMessageId>`, `fail:<messageId>`). The service worker keeps one record per id, preferring the better timestamp source, then the earliest time. |
| Association | A response is linked to the user turn **immediately preceding it in the rendered thread** (`association: "dom-adjacent"`), never "the latest user message". Pairing in the timeline uses message ids, so out-of-order completions across tabs or conversations pair correctly. If no user turn precedes the response, it is stored with `association: "none"` and shown faded, without an interval. |

## Architecture

```
manifest.json                 MV3 manifest (no permissions; content script on chatgpt.com / chat.openai.com)
src/content/loader.js         classic content script → dynamically imports the ES-module implementation
src/content/main.js           runtime: MutationObserver, intent listeners, timers → tracker → transport
src/content/chatgpt-adapter.js all ChatGPT DOM knowledge: DOM → snapshot, intent classification, URL → id
src/content/tracker.js        pure state machine: snapshots + intents → events (no DOM, fully unit-tested)
src/content/transport.js      ordered delivery to the service worker with retry/backoff
src/background/service-worker.js  stateless MV3 worker: routes messages to handlers
src/background/handlers.js    validation/whitelisting, pause setting, writes via the DB layer
src/shared/db.js              IndexedDB schema, migrations, queries, dedupe/merge policy
src/shared/constants.js       event types, message names, enums
src/timeline/model.js         events → rows, intervals, lanes; search/sort/filter
src/timeline/scale.js         local-calendar windows, ticks (DST-aware), pixel mapping, formatting
src/timeline/layout.js        per-row pixel layout (markers/bars/lanes)
src/dashboard/                timeline page (virtualized rows, details panel, data dialog)
src/popup/                    status, pause/resume, open dashboard
scripts/check.js              static build checks; scripts/make-icons.js regenerates icons
test/unit/                    node:test unit + jsdom integration tests
test/e2e/                     Playwright: real Chromium + unpacked extension + simulated ChatGPT page
```

Main decisions:
- **No build step and no runtime dependencies.** The code is plain ES modules. Manifest content scripts cannot be modules, so a 10-line classic `loader.js` dynamically imports `main.js`. For that reason the content-script modules are listed in `web_accessible_resources` for chatgpt.com only. `npm run check` verifies that every imported module is covered.
- **The tracker is pure.** The DOM adapter reduces the page to a small snapshot (`turns`, `generating`, ids, lengths); the tracker turns snapshots into events. This makes edge cases (out-of-order completion, edits, regeneration, navigation, multi-tab) testable without a browser.
- **The service worker is stateless.** Every message is one IndexedDB transaction. MV3 suspension or restart cannot lose anything. A message that fails during worker startup is retried by the content script. Deterministic ids make retries and duplicate reports harmless.
- **The dashboard reads IndexedDB directly** (same extension origin) and refreshes when the worker broadcasts `db:changed`.

## Data model

Database `chatgpt-activity-timeline` (IndexedDB, extension origin), schema version **2**:

- `conversations` (key `id`): `{ id, title, url, firstObservedAt, lastActivityAt }`. Index: `lastActivityAt`.
- `events` (key `id`):
  ```js
  {
    id: 'user:<messageId>' | 'resp:<responseId>' | 'fail:<messageId>',
    conversationId, type,          // USER_MESSAGE | ASSISTANT_RESPONSE_COMPLETED | _INTERRUPTED | _FAILED
    timestamp,                     // epoch milliseconds (UTC instant)
    timestampSource,               // submit-intent | dom-transition | dom-observed
    messageId,                     // ChatGPT message id of this message/response
    requestMessageId, requestEventId,   // responses: the initiating user message (if identifiable)
    association,                   // dom-adjacent | none
    responseKind, previousResponseId,   // initial | regenerated (+ the attempt it replaced)
    startedAt,                     // responses: when generation was first observed
    revisionOf,                    // edited messages: the message id it replaced
    recordedAt                     // when the worker stored it
  }
  ```
  Indexes: `conversationId`, `timestamp`, `requestMessageId`, `[conversationId, timestamp]`.
- `meta` (key `key`): settings, currently `paused`.

Timestamps are always epoch milliseconds, i.e. exact instants. The dashboard displays them in the browser's local time zone and also shows the ISO/UTC form. Migrations live in `MIGRATIONS` in `src/shared/db.js`. Each entry upgrades one version, and released entries are never edited. The upgrade from v1 to v2 is tested on a v1 database containing data.

Export format (`Data → Export JSON`): `{ format: "chatgpt-activity-timeline", schemaVersion, exportedAt, conversations: [...], events: [...] }`.

## Permissions

The manifest requests **no Chrome permissions and no host permissions**. It declares:
- a content script for `https://chatgpt.com/*` and `https://chat.openai.com/*` (Chrome will say it can "read and change your data on chatgpt.com"; that is required to observe the page);
- `web_accessible_resources` for the extension's own content-script modules, on those two sites only.

There is no remote code, analytics, network request or `externally_connectable`. The extension pages' CSP is `script-src 'self'`.

## Privacy and data management

- Inspect: **Data** lists every conversation with event counts. **Inspect** or clicking a row shows its events and **Show stored data** (raw JSON). You can also open DevTools on the dashboard → Application → IndexedDB → `chatgpt-activity-timeline`.
- Export: **Data → Export JSON**.
- Delete one conversation's activity: select the row → **Delete this conversation's activity**, or **Data → Delete** (with confirmation). This never touches the conversation in ChatGPT.
- Delete everything: **Data → Delete all activity…** (two confirmations).
- Pause: popup → **Pause tracking**. While paused, the worker discards incoming events.
- Uninstalling the extension deletes its IndexedDB data.

The content script sends only ids, timestamps, the conversation title and URL. The worker additionally whitelists stored fields, drops anything else, and accepts only chatgpt.com / chat.openai.com URLs.

## Testing

```bash
npm install          # dev-only: jsdom, fake-indexeddb (no runtime dependencies)
npm run check        # manifest/files/syntax/web-accessible-module checks
npm test             # unit + jsdom integration tests (node:test)
npm run test:e2e     # Playwright + Chromium; skipped if Playwright is not installed
npm run test:all     # all of the above
```

Coverage:
- **Event processing** (`test/unit/tracker.test.js`): message creation and timing, fallback timing, history is never recorded, stale intents, completion vs intermediate rendering, quiet-period fallback, overlapping and out-of-order responses, stop and failure (inside a response and with no response), regeneration and branch switching, edits, association `none`, duplicate prevention, provisional-id rebind, SPA navigation, returning to a generating conversation, title updates, two independent tabs, flush on page hide.
- **DOM adapter** (`test/unit/adapter.test.js`, fixture `test/fixtures/chatgpt-conversation.html`): URL id parsing, turn grouping, streaming and stop detection, errors, titles, intent classification, and a check that snapshots contain no message text.
- **Persistence** (`test/unit/db.test.js`, `handlers.test.js`): schema creation, the v1→v2 upgrade keeping data, save and query, dedupe and merge policy, title updates, rebind, export, clear, per-conversation delete, validation, field whitelisting, pause, and worker restart.
- **Timeline** (`test/unit/timeline.test.js`): pairing, out-of-order pairing, pending and unpaired, regeneration, lanes for overlaps, pixel positions and clipping, zoom invariance of timestamps, local windows and DST days (23 h / 25 h) in `America/New_York`, time-zone display, search, sort and filter, same-title rows, empty and large datasets.
- **Integration** (`test/unit/runtime.test.js`): the real runtime on a simulated ChatGPT page in jsdom (`test/fixtures/mock-chatgpt.js`) feeding the real handler and IndexedDB. Covers new chat → id rebind, stop, failure, regeneration, SPA navigation, multiple tabs (same and different conversations), worker suspension and "browser restart".
- **End-to-end** (`test/e2e/extension.e2e.test.js`): the unpacked extension in Chromium. `https://chatgpt.com/**` is intercepted and served the simulated page with a strict nonce-based CSP. Covers recording, two concurrent tabs, stop and failure, reload not re-recording history, dashboard rendering and selection, worker suspension via DevTools Protocol `ServiceWorker.stopAllWorkers` (verified by a changed worker start time), and a browser restart with the same profile keeping history. Also covers the popup, JSON export (checked to contain no message text), per-conversation delete and delete-all.

The simulated page reproduces the markup and behavior the adapter relies on. It is not ChatGPT.

## Verifying on live ChatGPT

Because live testing was not possible here, please run this checklist once after installing:

1. Open the dashboard in one tab and chatgpt.com in another.
2. Send a message in a new chat. Within about 1 s of the response finishing, a row should appear (it may first show as "New chat") with ● → bar → ◆. The title should update after ChatGPT names the chat.
3. Send in two different conversations in two tabs at once. Each row should get its own bar.
4. Click **Stop** during a response: you should get a ■ and a hatched bar.
5. Regenerate a response: you should get a purple bar starting at the regeneration.
6. Edit a previous message and resubmit: you should get a new ●. Its details should show "Edited version of".
7. Reload a long conversation, and switch branches with ‹ 1/2 ›: nothing new should be recorded.

If any step fails, see [Troubleshooting](#troubleshooting).

## Troubleshooting

**1. Is the tracker running on the tab?** When the extension starts on a ChatGPT tab, the page's DevTools console shows one line:
`[ChatGPT Timeline] v0.1.2 tracking this tab. …`. Other console messages on chatgpt.com, such as `Feature is disabled`, Statsig warnings, or CSP errors from `runner.html`, come from ChatGPT itself or from other extensions and are unrelated. If the line is missing:
- reload the ChatGPT tab (required after installing, updating or reloading the extension);
- check that the extension is enabled in `chrome://extensions` and shows no errors there.

**2. Open the popup on the ChatGPT tab.** Under **This tab** it lists:
- whether the tracker is running;
- how many of your messages and responses it can see on the page;
- how many send actions it detected;
- whether it has recognized ChatGPT's stop button;
- what it has recorded so far.

**3. Copy diagnostics.** If messages are not detected, send a message, wait about 10 seconds for the response, then click **Copy diagnostics** (or **Save diagnostics file**) in the popup and include it in a bug report. It contains:
- an outline of the page's element structure: tag names, class names, `data-*`/role attributes, button labels, and text *lengths*;
- what the page added in the 10 s after your last send, with button states at 0, 0.4, 2 and 6 s;
- counters.

It never contains message text, titles or links. With it, the selectors in `src/content/chatgpt-adapter.js` can be fixed.

**4. Verbose log.** In the ChatGPT tab's console, enable the *Verbose* level to see one `[ChatGPT Timeline]` debug line per recorded event.

## Known limitations

- **Not verified against live chatgpt.com** (see above). ChatGPT's markup changes without notice, and any selector in `chatgpt-adapter.js` may need updating.
- **Known incompatibility (October 2026):** a user's live chatgpt.com page (Spanish UI) had none of the message markers the adapter uses. That includes `data-message-author-role`, `data-message-id`, `conversation-turn` test ids and `#prompt-textarea`; the composer buttons also had no `data-testid`. As a result, sends were detected but no messages or responses were. Version 0.1.2 collects the structural diagnostics needed to adapt the selectors (see [Troubleshooting](#troubleshooting)). Until then, recording does not work on that page version.
- **Only live activity is recorded.** Messages sent before installation, on other devices or browsers, from the mobile or desktop apps, or while tracking is paused do not appear. A response to such a message (for example, finishing in a tab you opened later) is stored without an interval and shown faded.
- **Navigating away or closing the tab during generation** loses that response's completion: the page no longer shows it. The message remains, marked "no response outcome recorded". If you return while it is still generating, the completion is recorded. If you return after it finished, it is not.
- **Background tabs:** Chrome throttles hidden tabs. The completion timestamp comes from the DOM mutation that ended generation, which stays accurate as long as ChatGPT keeps updating the DOM in the background. Saving can be delayed by throttled timers, and a completion observed but not yet confirmed is saved immediately when the page is closed or navigated away.
- **Timestamp precision:** send times come from the send action (milliseconds). Completion times are within about 50 ms of the DOM change in a foreground tab.
- **Regeneration start time** is when the new response element first appears, which is slightly after the click. If ChatGPT re-renders a regenerated response without a new message id, it cannot be told apart from the original.
- **Message-id stability:** association relies on ChatGPT keeping a message's `data-message-id` stable. If a client-side id were replaced by a server id after rendering, that message would be missed rather than duplicated.
- **Sending without a recognized control** (voice mode, a new kind of button) falls back to the "message appeared and generation started within 3 s" rule, with a less precise `dom-observed` timestamp. Voice conversations are otherwise untested.
- **Temporary chats** never get a conversation URL. They stay under a provisional id shown as "New chat (no conversation id yet)".
- **Error detection** uses ChatGPT's error-text styling (`.text-token-text-error`), which is a heuristic.
- **Web-accessible modules:** because the content script loads ES modules, chatgpt.com could detect that this extension is installed by probing its module URLs. It cannot read your data that way.
- Concurrent generations within one conversation are handled by the tracker and model, but ChatGPT normally prevents them.

## Next improvements

1. Run the live verification checklist and adjust `chatgpt-adapter.js` selectors as needed. Add a small "diagnostics" view to the popup showing which selectors matched on the current tab.
2. Import from a previously exported JSON file (export already exists).
3. Per-day activity summaries (count of exchanges, total waiting time) and a minimap for long ranges.
4. Optional per-project grouping of rows using ChatGPT project URLs (`/g/g-p-…`).
