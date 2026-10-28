// Pixel layout of one timeline row for a given window and width. Pure, so
// marker and interval placement can be tested without a browser.

import { EventType } from '../shared/constants.js';
import { xFor, intervalPixels } from './scale.js';
import { visibleItems } from './model.js';

export const ROW_HEIGHT = 30;
const BAR_H = 6;
const TOP_PAD = 6;
const USABLE = ROW_HEIGHT - 2 * TOP_PAD - BAR_H; // span between first and last lane

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
  const items = [];
  for (const iv of intervals) {
    const px = intervalPixels(iv.start, iv.end, start, end, width);
    if (!px) continue;
    const cy = laneCenter(iv.lane, lanes);
    laneOfEvent.set(iv.response.id, iv.lane);
    if (!laneOfEvent.has(iv.request.id) || iv.attempt === 1) laneOfEvent.set(iv.request.id, iv.lane);
    items.push({
      kind: 'interval',
      id: iv.id,
      x: px.x,
      w: Math.max(px.w, 2),
      y: cy - BAR_H / 2,
      cls: ['iv', iv.status, iv.regenerated && iv.status === 'completed' ? 'regenerated' : ''].filter(Boolean).join(' '),
    });
  }
  const unpaired = new Set(row.unpaired.map((e) => e.id));
  for (const m of markers) {
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
