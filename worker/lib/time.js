// Rome's Joy admin Worker: Chicago time, hours text, open/closed status, event dates.
// Weekdays use JavaScript's numbering (0 = Sunday). Times of day are minutes after midnight.

export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday → Sunday, the order hours are listed in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const chicagoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const chicagoLongFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short',
});

/** "Now" in America/Chicago: { date: 'YYYY-MM-DD', weekday: 0–6, minutes, iso }. */
export function chicagoNow(date = new Date()) {
  const parts = {};
  for (const p of chicagoFmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: DAY_SHORT.indexOf(parts.weekday),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), // some engines print midnight as 24
    iso: date.toISOString(),
  };
}

/** "Tuesday, October 13, 2026 at 10:00 AM" in Chicago, for emails. */
export const chicagoLong = (date = new Date()) => chicagoLongFmt.format(date);

/* -------------------------------------------------------------------------
   Calendar dates (YYYY-MM-DD) without the Date time-zone traps
   ------------------------------------------------------------------------- */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d, weekday: dt.getUTCDay(), time: t };
}

const pad2 = (n) => String(n).padStart(2, '0');
export const formatDate = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;

export function addDays(dateStr, days) {
  const p = parseDate(dateStr);
  return p ? formatDate(new Date(p.time + days * 86400000)) : null;
}

export const weekdayOf = (dateStr) => parseDate(dateStr)?.weekday ?? null;

/** "Thu, Nov 26" for audit summaries. */
export function shortDate(dateStr) {
  const p = parseDate(dateStr);
  return p ? `${DAY_SHORT[p.weekday]}, ${MONTH_SHORT[p.m - 1]} ${p.d}` : String(dateStr);
}

/* -------------------------------------------------------------------------
   Times of day
   ------------------------------------------------------------------------- */
/** 480 → "8 am", 510 → "8:30 am", 720 → "12 pm", 0 or 1440 → "12 am". */
export function minutesToText(min) {
  if (min == null || Number.isNaN(Number(min))) return null;
  const m = ((Number(min) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const period = h24 < 12 ? 'am' : 'pm';
  const h = h24 % 12 || 12;
  return mm ? `${h}:${pad2(mm)} ${period}` : `${h} ${period}`;
}

/** "08:30" → 510. Returns null for anything that is not HH:MM. */
export function timeToMinutes(s) {
  const m = typeof s === 'string' && /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

export const hoursText = (row) => (row.closed || row.open_min == null || row.close_min == null
  ? 'Closed'
  : `${minutesToText(row.open_min)} – ${minutesToText(row.close_min)}`);

/**
 * The 7 weekly rows in Monday → Sunday order, ready to print. Missing weekdays count as closed.
 * Input rows are the raw `hours` table rows (any order).
 */
export function shapeHours(rows) {
  const byDay = new Map((rows || []).map((r) => [Number(r.weekday), r]));
  return WEEK_ORDER.map((weekday) => {
    const r = byDay.get(weekday) || { closed: 1, open_min: null, close_min: null };
    const closed = Boolean(r.closed) || r.open_min == null || r.close_min == null;
    const open_min = closed ? null : Number(r.open_min);
    const close_min = closed ? null : Number(r.close_min);
    return {
      weekday,
      label: DAY_LABELS[weekday],
      short: DAY_SHORT[weekday],
      closed,
      open_min,
      close_min,
      open: closed ? null : minutesToText(open_min),
      close: closed ? null : minutesToText(close_min),
      text: closed ? 'Closed' : `${minutesToText(open_min)} – ${minutesToText(close_min)}`,
    };
  });
}

/** Joins "Mon – Wed", "Sat" ... → "Mon – Wed & Sat"; three pieces → "Mon, Wed & Fri". */
function joinDays(pieces) {
  if (pieces.length <= 1) return pieces.join('');
  return `${pieces.slice(0, -1).join(', ')} & ${pieces[pieces.length - 1]}`;
}

/**
 * Groups days that share the same hours: "Wed – Sun · 8 am – 2 pm", "Sat & Sun · 11 am – 3 pm",
 * "Wed – Fri & Sun · 8 am – 2 pm · Sat · 8 am – 3 pm". Closed days are left out; all closed → "Closed".
 */
export function hoursSummary(shaped) {
  const groups = new Map(); // hours text → [positions in WEEK_ORDER]
  shaped.forEach((h, i) => {
    if (h.closed) return;
    if (!groups.has(h.text)) groups.set(h.text, []);
    groups.get(h.text).push(i);
  });
  if (!groups.size) return shaped.length ? 'Closed' : '';
  const parts = [];
  for (const [text, positions] of groups) {
    // Split the positions into runs of consecutive days.
    const runs = [];
    for (const pos of positions) {
      const last = runs[runs.length - 1];
      if (last && pos === last[last.length - 1] + 1) last.push(pos); else runs.push([pos]);
    }
    const pieces = [];
    for (const run of runs) {
      const names = run.map((pos) => shaped[pos].short);
      if (run.length >= 3) pieces.push(`${names[0]} – ${names[names.length - 1]}`);
      else if (run.length === 2 && runs.length === 1) pieces.push(`${names[0]} & ${names[1]}`);
      else pieces.push(...names);
    }
    parts.push(`${joinDays(pieces)} · ${text}`);
  }
  return parts.join(' · ');
}

/**
 * Open/closed right now. Today's exception wins over the weekly hours, then the next 7 days are
 * checked (with their exceptions) for the "opens Wed 8 am" text.
 */
export function openNow(shaped, exceptions, now) {
  const byDate = new Map((exceptions || []).map((e) => [e.date, e]));
  const byDay = new Map(shaped.map((h) => [h.weekday, h]));
  const effective = (date, weekday) => {
    const ex = byDate.get(date);
    const src = ex || byDay.get(weekday);
    if (!src || src.closed || src.open_min == null || src.close_min == null) return null;
    return { open_min: Number(src.open_min), close_min: Number(src.close_min) };
  };
  const checked_at = now.iso;
  const today = effective(now.date, now.weekday);
  if (today) {
    if (now.minutes >= today.open_min && now.minutes < today.close_min) {
      return { open: true, text: `Open now · until ${minutesToText(today.close_min)}`, checked_at };
    }
    if (now.minutes < today.open_min) {
      return { open: false, text: `Closed · opens today ${minutesToText(today.open_min)}`, checked_at };
    }
  }
  for (let i = 1; i <= 7; i++) {
    const weekday = (now.weekday + i) % 7;
    const next = effective(addDays(now.date, i), weekday);
    if (next) return { open: false, text: `Closed · opens ${DAY_SHORT[weekday]} ${minutesToText(next.open_min)}`, checked_at };
  }
  return { open: false, text: 'Closed today', checked_at };
}

/* -------------------------------------------------------------------------
   Events
   ------------------------------------------------------------------------- */
/** past when the last day is before today, upcoming when it starts after today, otherwise current. */
export function eventStatus(ev, today) {
  const last = ev.end_date || ev.start_date;
  if (last < today) return 'past';
  if (ev.start_date > today) return 'upcoming';
  return 'current';
}

/** "Oct 24, 2026", "Oct 24 – Dec 5, 2026", "Oct 24 – 26, 2026", "Dec 28, 2026 – Jan 4, 2027". */
export function eventDateText(start, end) {
  const s = parseDate(start);
  if (!s) return null;
  const e = end && end !== start ? parseDate(end) : null;
  const ms = MONTH_SHORT[s.m - 1];
  if (!e) return `${ms} ${s.d}, ${s.y}`;
  const me = MONTH_SHORT[e.m - 1];
  if (s.y !== e.y) return `${ms} ${s.d}, ${s.y} – ${me} ${e.d}, ${e.y}`;
  if (s.m !== e.m) return `${ms} ${s.d} – ${me} ${e.d}, ${s.y}`;
  return `${ms} ${s.d} – ${e.d}, ${s.y}`;
}

/** "5–8 pm", "5:30–8 pm", "11 am – 3 pm", "7 pm", "until 8 pm", or null without times. */
export function eventTimeText(start, end) {
  const a = timeToMinutes(start);
  const b = timeToMinutes(end);
  if (a == null && b == null) return null;
  if (a != null && b == null) return minutesToText(a);
  if (a == null) return `until ${minutesToText(b)}`;
  const ta = minutesToText(a);
  const tb = minutesToText(b);
  const [clockA, periodA] = ta.split(' ');
  const [clockB, periodB] = tb.split(' ');
  return periodA === periodB ? `${clockA}–${clockB} ${periodA}` : `${ta} – ${tb}`;
}
