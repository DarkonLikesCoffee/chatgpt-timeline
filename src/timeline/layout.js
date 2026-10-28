// Pixel layout of one timeline row for a given window and width. Pure, so
// marker and interval placement can be tested without a browser.

import { EventType } from '../shared/constants.js';
import { xFor, intervalPixels } from './scale.js';
import { visibleItems } from './model.js';

export const ROW_HEIGHT = 30;
const BAR_H = 6;
const TOP_PAD = 6;
const USABLE = ROW_HEIGHT - 2 * TOP_PAD - BAR_H; // span between first and last lane
// A bar narrower than this hides its send/finish markers (they would cover
// it); the bar then represents the exchange on its own, drawn thicker.
export const MARKER_MIN_PX = 14;
const COMPACT_H = 10;
const COMPACT_MIN_W = 4;
const SESSION_TOP = 3;

export const MARKER_CLASS = {
  [EventType.USER_MESSAGE]: 'user',
  [EventType.ASSISTANT_RESPONSE_COMPLETED]: 'done',
  [EventType.ASSISTANT_RESPONSE_INTERRUPTED]: 'interrupted',
  [EventType.ASSISTANT_RESPONSE_FAILED]: 'failed',
};

// Vertical center (px from row top) of a lane.
export function laneCenter(lane, lanes) {
  if (lanes <= 1) return ROW_HEIGHT / 2;
  return TOP_PAD + BAR_H / 2 + (lane * USABLE) / (lanes - 1);
}

export function layoutRow(row, win, width) {
  const { start, end } = win;
  const { intervals, markers } = visibleItems(row, start, end);
  const lanes = row.lanes || 1;
  const laneOfEvent = new Map();
  const hidden = new Set(); // markers represented by a compact bar
  const items = [];

  // Sessions with more than one item, drawn behind everything else.
  for (const s of row.sessions || []) {
    if (s.items < 2) continue;
    const px = intervalPixels(s.start, s.end, start, end, width);
    if (!px) continue;
    items.push({ kind: 'session', id: s.id, x: px.x, w: Math.max(px.w, COMPACT_MIN_W), y: SESSION_TOP, h: ROW_HEIGHT - 2 * SESSION_TOP, cls: 'session' });
  }

  for (const iv of intervals) {
    const px = intervalPixels(iv.start, iv.end, start, end, width);
    if (!px) continue;
    const cy = laneCenter(iv.lane, lanes);
    laneOfEvent.set(iv.response.id, iv.lane);
    if (!laneOfEvent.has(iv.request.id) || iv.attempt === 1) laneOfEvent.set(iv.request.id, iv.lane);
    const fullWidth = xFor(iv.end, start, end, width) - xFor(iv.start, start, end, width);
    const compact = fullWidth < MARKER_MIN_PX;
    if (compact) {
      hidden.add(iv.response.id);
      if (iv.attempt === 1) hidden.add(iv.request.id);
    }
    const h = compact ? COMPACT_H : BAR_H;
    items.push({
      kind: 'interval',
      id: iv.id,
      x: px.x,
      w: Math.max(px.w, compact ? COMPACT_MIN_W : 2),
      y: cy - h / 2,
      h,
      cls: ['iv', iv.status, iv.regenerated && iv.status === 'completed' ? 'regenerated' : '', compact ? 'compact' : ''].filter(Boolean).join(' '),
    });
  }
  const unpaired = new Set(row.unpaired.map((e) => e.id));
  for (const m of markers) {
    if (hidden.has(m.event.id)) continue;
    const lane = laneOfEvent.get(m.event.id) ?? 0;
    const uncertain = unpaired.has(m.event.id) || m.event.association === 'none';
    items.push({
      kind: 'marker',
      id: m.event.id,
      x: xFor(m.t, start, end, width),
      y: laneCenter(lane, lanes),
      cls: ['mk', MARKER_CLASS[m.type], uncertain ? 'uncertain' : ''].filter(Boolean).join(' '),
    });
  }
  return items;
}
