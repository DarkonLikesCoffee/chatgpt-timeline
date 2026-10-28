// Time windows, axis ticks and pixel mapping. Windows align to local
// calendar boundaries (the browser's time zone); stored instants never change.

export const VIEWS = ['hour', 'day', 'week', 'month'];

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export function startOfView(view, t) {
  const d = new Date(t);
  switch (view) {
    case 'hour':
      d.setMinutes(0, 0, 0);
      return d.getTime();
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case 'week': {
      const monday = (d.getDay() + 6) % 7; // ISO week starts Monday
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - monday).getTime();
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    default:
      throw new Error(`unknown view ${view}`);
  }
}

// Adds n view-units to a window start using calendar arithmetic, so a "day"
// spans 23 or 25 hours across DST changes.
export function addUnits(view, start, n) {
  const d = new Date(start);
  switch (view) {
    case 'hour':
      return start + n * HOUR;
    case 'day':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
    case 'week':
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * n).getTime();
    case 'month':
      return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
    default:
      throw new Error(`unknown view ${view}`);
  }
}

export function windowFor(view, anchor) {
  const start = startOfView(view, anchor);
  return { view, start, end: addUnits(view, start, 1) };
}

// A window fitted to an arbitrary range (e.g. zoom to a session).
export function customWindow(start, end) {
  return { view: 'custom', start, end: Math.max(end, start + 1000) };
}

export function shiftWindow(win, dir) {
  if (win.view === 'custom') {
    const span = win.end - win.start;
    return customWindow(win.start + dir * span, win.end + dir * span);
  }
  const start = addUnits(win.view, win.start, dir);
  return { view: win.view, start, end: addUnits(win.view, start, 1) };
}

// Switch zoom level keeping a reference instant (default: window middle) in view.
export function changeView(win, view, focus = (win.start + win.end) / 2) {
  return windowFor(view, focus);
}

export function xFor(t, start, end, width) {
  return ((t - start) / (end - start)) * width;
}

export function tFor(x, start, end, width) {
  return start + (x / width) * (end - start);
}

// Clip [a, b] to the window; returns pixel { x, w } or null.
export function intervalPixels(a, b, start, end, width) {
  if (b < start || a >= end) return null;
  const x0 = xFor(Math.max(a, start), start, end, width);
  const x1 = xFor(Math.min(b, end), start, end, width);
  return { x: x0, w: Math.max(0, x1 - x0) };
}

function fmt(options, locale) {
  return new Intl.DateTimeFormat(locale, options);
}

// Ticks for the axis: { t, label, major }. Minor ticks only draw grid lines.
const CUSTOM_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);

function customTicks(start, end, locale) {
  const span = end - start;
  const step = CUSTOM_STEPS.find((st) => span / st <= 12) || 86400e3;
  const fmt = new Intl.DateTimeFormat(locale, step < 60e3 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  // Align to local wall-clock multiples of the step.
  const d = new Date(start);
  const offset = -d.getTimezoneOffset() * 60e3;
  let t = Math.ceil((start + offset) / step) * step - offset;
  const out = [];
  for (; t <= end; t += step) out.push({ t, major: true, label: fmt.format(t) });
  return out;
}

export function ticks(win, locale) {
  const { view, start, end } = win;
  if (view === 'custom') return customTicks(start, end, locale);
  const out = [];
  const time = fmt({ hour: '2-digit', minute: '2-digit' }, locale);
  if (view === 'hour') {
    for (let t = start; t <= end; t += 5 * MIN) {
      const major = new Date(t).getMinutes() % 15 === 0;
      out.push({ t, major, label: major ? time.format(t) : '' });
    }
  } else if (view === 'day') {
    // Step by real hours so DST days show 23/25 ticks with true local labels.
    for (let t = start; t <= end; t += HOUR) {
      const h = new Date(t).getHours();
      const major = h % 3 === 0;
      out.push({ t, major, label: major ? time.format(t) : '' });
    }
  } else if (view === 'week') {
    const day = fmt({ weekday: 'short', day: 'numeric', month: 'short' }, locale);
    for (let i = 0; ; i++) {
      const d0 = addUnits('day', start, i);
      if (d0 > end) break;
      out.push({ t: d0, major: true, label: d0 < end ? day.format(d0) : '' });
      for (const h of [6, 12, 18]) {
        const d = new Date(d0);
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
        if (t < end) out.push({ t, major: false, label: '' });
      }
    }
  } else if (view === 'month') {
    const day = fmt({ day: 'numeric' }, locale);
    const wd = fmt({ weekday: 'narrow' }, locale);
    for (let i = 0; ; i++) {
      const t = addUnits('day', start, i);
      if (t > end) break;
      const isMonday = new Date(t).getDay() === 1;
      out.push({ t, major: isMonday, label: t < end ? `${wd.format(t)} ${day.format(t)}` : '' });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function formatWindow(win, locale) {
  const { view, start, end } = win;
  if (view === 'custom') {
    const full = fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }, locale);
    const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
    return `${full.format(start)} – ${(sameDay ? fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' }, locale) : full).format(end)}`;
  }
  if (view === 'hour') {
    return `${fmt({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, locale).format(start)} – ${fmt({ hour: '2-digit', minute: '2-digit' }, locale).format(end)}`;
  }
  if (view === 'day') return fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }, locale).format(start);
  if (view === 'week') {
    const d = fmt({ year: 'numeric', month: 'short', day: 'numeric' }, locale);
    return `${d.format(start)} – ${d.format(end - 1)}`;
  }
  return fmt({ year: 'numeric', month: 'long' }, locale).format(start);
}

// Exact timestamp for details: local date/time with milliseconds and zone.
export function formatInstant(t, { locale, timeZone } = {}) {
  const local = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    timeZoneName: 'short', timeZone,
  }).format(t);
  return local;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m} min ${rs} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
