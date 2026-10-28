// Loads the classic content script src/content/history.js into an isolated
// VM context (no chrome APIs, so it only defines globalThis.ChatGPTHistory).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/content/history.js', import.meta.url), 'utf8');

export function loadHistoryScript() {
  const ctx = vm.createContext({ setTimeout, clearTimeout, AbortController, URL, console, Promise, Date, Math, JSON });
  vm.runInContext(source, ctx, { filename: 'history.js' });
  return ctx.ChatGPTHistory;
}

export function loadStripper() {
  const { strip } = loadHistoryScript();
  // Round-trip through JSON like a port message, dropping VM-realm prototypes.
  return (detail) => JSON.parse(JSON.stringify(strip(detail, detail.conversation_id)));
}
