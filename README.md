# ChatGPT Activity Timeline

A Chrome extension (Manifest V3) that **reads your ChatGPT conversation history for a period you choose** (last 24 hours … last 365 days) and shows it as a Gantt-style timeline: one row per conversation, a marker when you sent each message, a marker when the response finished, and a bar between them.

- Nothing runs while you chat. History is read only when you click **Load from ChatGPT**.
- Rows are identified by the conversation id in its URL (`/c/<id>`), so conversations with identical titles stay separate.
- **●** marks when you sent a message, **◆** when the response finished, and a bar connects them. Stopped (■) and failed (✕) responses are shown, but never as completed intervals. Regenerated responses get their own (purple) bar.
- Everything is stored locally in your browser. No message text is stored or leaves the chatgpt.com tab.

> **How it gets the data, and the caveat.** ChatGPT's page does not show message timestamps, and there is no official API for your chat history. The extension therefore reads your conversations the way the ChatGPT web app itself does: through chatgpt.com's internal, **undocumented** `/backend-api` endpoints, using your signed-in session, from inside a chatgpt.com tab. These endpoints can change or start refusing requests at any time without notice, and automated access may conflict with OpenAI's terms of use. Use it at your own discretion. Development was done without access to chatgpt.com: the request and response formats follow the publicly known shape of these endpoints and are tested against fixtures, **not against the live service**. See [Known limitations](#known-limitations).

---

## Installation (unpacked)

Requirements: Chrome or Chromium 116 or later. No build step.

1. Get the code: `git clone <this repo>`, or download and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Optional: pin **ChatGPT Activity Timeline** from the puzzle-piece menu.
5. Reload any chatgpt.com tabs that were already open, since the content script only attaches to newly loaded pages.

To update after pulling new code, click the reload icon on the extension's card in `chrome://extensions`, then reload your ChatGPT tabs.

## Usage

1. Make sure you are signed in at https://chatgpt.com in this browser.
2. Click the extension icon, then **Open timeline**.
3. Choose a period (**Last 24 hours**, 3, 7, 30, 90 or 365 days) and click **Load from ChatGPT**.
   - If a chatgpt.com tab is open, it is used. Otherwise chatgpt.com is opened in a background tab and closed when loading finishes.
   - Progress shows below the toolbar ("Listing conversations…", "Reading conversations 5/12…"). You can **Cancel**; conversations read so far are kept.
   - Loading again is fast: conversations that have not changed since the last load are skipped.

### Dashboard

| Control | What it does |
|---|---|
| **Period + Load from ChatGPT** | Reads conversations updated in that period, with all of their messages. |
| **Hour / Day / Week / Month** (or keys `1`–`4`) | Zoom level. Windows align to your local calendar (Monday-start weeks). |
| **‹ Now ›** (or `←` / `→`) | Move back or forward by one window, or jump to now. |
| Double-click a track | Zoom into the next finer level at that time (from the Hour view: a fitted window a third as wide). |
| Session band (click / double-click) | Session summary (span, messages, time spent waiting for responses) / zoom to fit the session exactly, with second-level ticks. |
| **Search titles** | Filters rows by title (also matches the conversation id). |
| **Sort** | *Recent activity*, *Chronological* (earliest first activity first), or *Title*. |
| **Active in view** | Hides conversations with no activity in the visible window. |
| **Dates** | Keeps only conversations with activity between two dates. |
| Conversation title | Opens the conversation on chatgpt.com. |
| Click the row label area | Conversation details, its events, raw stored data, delete button. |
| Click a marker | Event type, exact local time with milliseconds and time zone, ISO/UTC instant, where the time comes from. |
| Click a bar | Send time, completion (or stop/failure) time, duration, attempt number. |
| **Data** | Statistics, summary of the last load, **Export JSON**, **Delete all…**, per-conversation *Inspect* / *Delete*. |

**Reading it when zoomed out.** Most responses take seconds to a couple of minutes, which is less than a pixel in a Day, Week or Month view. So that the timeline stays readable:
- **Sessions:** messages less than 15 minutes apart form a session, drawn as a light green band from the first message to the last response. Idle time between sessions stays empty.
- **Compact bars:** when a message → response bar would be narrower than its two markers (under 14 px), the markers are hidden and a thicker bar (at least 4 px) represents the exchange. Clicking it still shows both exact times. Zoom in (Hour view, a fitted session, or double-click) to see the individual ● and ◆ markers.

Bars: green = message → completed response; purple = regenerated attempt (starts when that attempt started); grey hatched = stopped or failed (not a completion). Overlapping intervals in one conversation get separate lanes. The red line is "now". Gaps between bars only mean there are no messages; they say nothing about whether you were active. The dashboard virtualizes rows and handles thousands of conversations.

## What is read and how it becomes a timeline

For each conversation updated in the chosen period, the content script reads its message tree, the same data the web app uses to display a conversation, and keeps only:

| Kept | Not kept |
|---|---|
| conversation id, title, creation and update time | message text, attachments, images, files |
| per message: id, parent/children ids, author role (user / assistant / tool / system), creation and update time, status, finish type, whether it is hidden, content type | model names, tool inputs and outputs, metadata, your account details |

The session token used for the requests stays in the chatgpt.com tab's memory and is never stored or passed to the extension.

Conversion rules (`src/shared/convert.js`):

- **`USER_MESSAGE`**: every visible message you sent, at its creation time (exact, from ChatGPT). Hidden context messages (e.g. custom instructions) are skipped.
- **Response**: each non-user child of your message starts one response attempt. The attempt is that branch up to your next message, including tool calls, reasoning steps and the final answer.
  - **Completion time**: the latest plausible *update* time stored for the attempt's assistant messages, otherwise the *creation* time of the final message. The creation time is earlier than the true completion: it is when the final message started.
  - **Implausible update times are ignored.** ChatGPT also bumps update times on later activity (continuing the chat, feedback, read-aloud, …). An update time therefore counts only if it is no later than the next message you sent after that response, and within 60 minutes of the message's creation. Without this rule, a reply from Tuesday could appear to end on Monday and merge a week into one session. The details panel and the Data dialog say which time was used and how many update times were ignored.
  - When the conversion rules change, conversations stored by the old rules are read again on the next load.
  - **Outcome**: from the attempt's last assistant message. `in_progress` gives no event; interrupted / partial gives `ASSISTANT_RESPONSE_INTERRUPTED`; an error status gives `ASSISTANT_RESPONSE_FAILED`; anything else gives `ASSISTANT_RESPONSE_COMPLETED`.
- **Regeneration**: several attempts for one message are separate responses (`responseKind: "regenerated"`, ordered by start time).
- **Edits**: an edited message is a new message on a new branch, marked `revisionOf` the earlier one. **All branches are shown**, not only the one currently displayed in ChatGPT.
- **Association** is exact: a response belongs to the user message it descends from in the tree (`association: "server-tree"`).

## Architecture

```
manifest.json                content script on chatgpt.com, host access to chatgpt.com, no service worker
src/content/history.js       classic content script: idle until the dashboard connects; reads
                             /api/auth/session and /backend-api, strips text, streams results back
src/dashboard/loader.js      finds or opens a chatgpt.com tab, connects (chrome.tabs.connect), relays progress
src/dashboard/               timeline page (load controls, virtualized rows, details, data dialog)
src/shared/convert.js        message tree → events (pure, unit-tested)
src/shared/db.js             IndexedDB schema, migrations, queries
src/timeline/                pairing, windows/ticks (DST-aware), pixel layout (pure)
src/popup/                   stats and "Open timeline"
scripts/check.js             static checks; scripts/make-icons.js regenerates icons
test/unit/                   node:test unit tests (converter, content script in a VM, loader, DB, timeline)
test/e2e/                    Playwright: real Chromium + the unpacked extension + a local HTTPS stand-in for chatgpt.com
```

Design decisions:
- **Requests come from a chatgpt.com tab**, not from the extension. They are then ordinary same-origin requests with your session, and pass the site's own protections like the web app's requests do.
- **Text is removed at the source.** Only structure and timestamps cross from the tab to the extension.
- **Incremental loads.** Each conversation's update time is stored, and unchanged conversations are skipped. A changed conversation is replaced as a whole, so edits, regenerations and deletions inside it are reflected.
- **Polite fetching.** At most 3 conversation requests run at a time. Rate limiting (HTTP 429) and server errors are retried with backoff (honouring `Retry-After`). One unreadable conversation is skipped; sign-in problems or persistent rate limiting stop the load with a clear message.
- **No build step, no runtime dependencies, no service worker.** The dashboard and popup open IndexedDB directly.

## Data model

Database `chatgpt-activity-timeline` (IndexedDB, extension origin), schema version 2:

- `conversations` (key `id`): `{ id, title, url, firstObservedAt (creation time), lastActivityAt, serverUpdateTime, fetchedAt }`.
- `events` (key `id`):
  ```js
  {
    id: 'user:<messageId>' | 'resp:<firstMessageIdOfAttempt>',
    conversationId, type,          // USER_MESSAGE | ASSISTANT_RESPONSE_COMPLETED | _INTERRUPTED | _FAILED
    timestamp,                     // epoch milliseconds (UTC instant)
    timestampSource,               // server-create-time | server-update-time
    messageId,
    requestMessageId, requestEventId, association,   // responses
    responseKind, previousResponseId, startedAt,      // responses
    revisionOf                     // edited messages
  }
  ```
  Indexes: `conversationId`, `timestamp`, `requestMessageId`, `[conversationId, timestamp]`.
- `meta`: `lastLoad` (time, period, counts).

Times are stored as instants and displayed in your local time zone (ISO/UTC also shown). Migrations live in `MIGRATIONS` in `src/shared/db.js`, one entry per version; released entries are never edited.

## Permissions

- **Host access to `https://chatgpt.com/*`**: injects the content script, and lets the dashboard find an open ChatGPT tab. Chrome describes this as "read and change your data on chatgpt.com".
- No other permissions. There are no remote servers, analytics or external network requests: the only requests go to chatgpt.com, from a chatgpt.com tab, when you click Load. The extension pages' CSP is `script-src 'self'`.

## Privacy and data management

- Inspect: **Data** lists every conversation with event counts. **Inspect** (or clicking a row) shows its events and **Show stored data** (raw JSON). You can also use DevTools on the dashboard → Application → IndexedDB.
- Export: **Data → Export JSON**.
- Delete one conversation's data: select the row → **Delete this conversation's activity**, or **Data → Delete** (with confirmation). It is read again by a later load if it is still in the period. This never touches the conversation in ChatGPT.
- Delete everything: **Data → Delete all activity…** (two confirmations).
- Uninstalling the extension deletes its data.

## Testing

```bash
npm install          # dev-only: jsdom, fake-indexeddb
npm run check        # manifest, files, syntax, classic content script, permissions
npm test             # unit tests (node:test)
npm run test:e2e     # Playwright + Chromium (skipped if Playwright is not installed); needs openssl
npm run test:all
```

- `convert.test.js`: messages, completions (update time vs creation-time fallback), tool/reasoning chains, regenerations, edits (all branches), interrupted / failed / in-progress, hidden context messages, clock skew, time formats.
- `history.test.js`: the real content script in a VM against a fake backend. Covers pagination and the period cut-off, skipping unchanged conversations, that no message text or token leaves the script, signed out, rate-limit retry, one bad conversation, authorization failure, cancel.
- `loader.test.js`: uses an open tab, otherwise opens a background tab and closes it; error propagation; waits for storage; cancel.
- `db.test.js`: schema creation, the v1→v2 upgrade keeping data, replace per conversation, unchanged-update lookup, export, clear, delete, validation.
- `timeline.test.js`: pairing, lanes for overlaps, positions, zoom invariance, local windows and DST days, time zones, search/sort/filter, same titles, empty and large datasets (3,000 conversations / 60,000 events).
- `extension.e2e.test.js`: the unpacked extension in Chromium. A local HTTPS server stands in for chatgpt.com (`--host-resolver-rules`, self-signed certificate) and serves fixture conversations shaped like the API. Covers:
  - a load through a background tab, which is then closed;
  - a second load through an open tab that skips unchanged conversations;
  - rendering, details and links;
  - the signed-out message;
  - persistence across a browser restart, plus the popup, export, delete and clear.

## Known limitations

- **Undocumented API, not verified against the live site.** The endpoints (`/api/auth/session`, `/backend-api/conversations?offset&limit&order=updated`, `/backend-api/conversation/<id>`) and fields (`mapping`, `author.role`, `create_time`, `update_time`, `status`, `metadata.finish_details`, `is_visually_hidden_from_conversation`) follow the publicly known shape of ChatGPT's web API. They were not observed live during development. If ChatGPT changes them, or requires extra headers or anti-automation tokens, loading fails with the HTTP status shown in the dashboard.
- **Completion times are approximate.** ChatGPT stores when messages were *created*. Its update times are also changed by later activity, so they are used only when plausible (see above). Otherwise the final message's creation time is used, which marks when the final answer started, not when it finished, so bars for long answers are too short. The Data dialog reports how many responses used each.
- **Projects, custom GPTs, archived and temporary chats:** only conversations returned by the main conversation list are read. Archived chats are excluded, temporary chats are never stored by ChatGPT, and some project conversations may not appear in that list.
- **Deleted conversations** disappear from ChatGPT but stay in the timeline until you delete them here.
- **Very long periods** mean many requests (one per conversation). Loading 365 days of heavy use can take minutes and may hit rate limits; reloading later only fetches conversations that changed.
- All times come from ChatGPT's servers, so they don't depend on your computer's clock. They are shown in your browser's time zone.

## Next improvements

1. Confirm the endpoints and fields against the live site, and adjust `history.js` / `convert.js` if needed (in particular whether `update_time` is reliably set on assistant messages).
2. Read project (`/g/g-p-…`) conversations explicitly if the main list omits them.
3. Optionally show only the branch currently displayed in ChatGPT instead of all branches.
4. Import from a ChatGPT data export as an official, offline alternative source.
