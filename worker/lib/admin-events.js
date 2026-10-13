// Rome's Joy admin Worker: /api/admin events — exhibitions, receptions, classes, programs.
import { bad, notFound, readBody } from './http.js';
import { all, first, insertRow, pick, run, sqlNow, updateRow } from './db.js';
import { readFields } from './validate.js';
import { requireBusiness } from './auth.js';
import { audit, changedKeys, fieldLabels, quote } from './audit.js';
import { eventStatus, timeToMinutes } from './time.js';
import { shapeEvent } from './public.js';

export const EVENT_KINDS = ['event', 'exhibition', 'program'];
export const EVENT_FIELDS = {
  kind: { type: 'text', oneOf: EVENT_KINDS, default: 'event' },
  title: { type: 'text', required: true, max: 200 },
  subtitle: { type: 'text', max: 200 },
  description: { type: 'text', max: 5000 },
  start_date: { type: 'date', required: true },
  end_date: { type: 'date' },
  start_time: { type: 'time' },
  end_time: { type: 'time' },
  location: { type: 'text', max: 200 },
  link_url: { type: 'url' },
  link_label: { type: 'text', max: 80 },
  image_url: { type: 'url' },
  featured: { type: 'bool' },
  published: { type: 'bool', default: 1 },
  sort_order: { type: 'int', default: 0, min: -1000000, max: 1000000 },
};
export const EVENT_COLUMNS = ['business_slug', ...Object.keys(EVENT_FIELDS), 'created_at', 'updated_at'];

function checkDates(ev) {
  if (ev.end_date && ev.end_date < ev.start_date) throw bad('The end date cannot be before the start date.', 'invalid_dates');
  const sameDay = !ev.end_date || ev.end_date === ev.start_date;
  if (sameDay && ev.start_time && ev.end_time && timeToMinutes(ev.end_time) <= timeToMinutes(ev.start_time)) {
    throw bad('The end time must be after the start time.', 'invalid_dates');
  }
}

const shape = (row, ctx) => shapeEvent(row, ctx.now.date, { admin: true });

async function loadEvent(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM events WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such event.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

/** GET /api/admin/businesses/:slug/events?status=all|current|upcoming|past */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const wanted = ctx.url.searchParams.get('status') || 'all';
  if (!['all', 'current', 'upcoming', 'past'].includes(wanted)) throw bad('status must be all, current, upcoming or past.');
  const rows = await all(ctx.env, 'SELECT * FROM events WHERE business_slug = ? ORDER BY start_date, sort_order, id', [business.slug]);
  const today = ctx.now.date;
  const byStatus = (s) => rows.filter((r) => eventStatus(r, today) === s);
  // Current and upcoming soonest first, past most recent first.
  const ordered = wanted === 'all'
    ? [...byStatus('current'), ...byStatus('upcoming'), ...byStatus('past').reverse()]
    : (wanted === 'past' ? byStatus('past').reverse() : byStatus(wanted));
  return { events: ordered.map((r) => shape(r, ctx)) };
}

/** POST /api/admin/businesses/:slug/events */
export async function create(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), EVENT_FIELDS, 'create');
  checkDates(fields);
  const id = await insertRow(ctx.env, 'events', { business_slug: business.slug, ...fields });
  const row = await first(ctx.env, 'SELECT * FROM events WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: business.slug, entity: 'event', entity_id: id, action: 'create',
    summary: `Added ${row.kind} ${quote(row.title)}`, after: row,
  });
  return { event: shape(row, ctx) };
}

/** PATCH /api/admin/events/:id */
export async function patch(ctx) {
  const row = await loadEvent(ctx);
  const fields = readFields(await readBody(ctx.request), EVENT_FIELDS, 'patch');
  checkDates({ ...row, ...fields });
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'events', { ...values, updated_at: sqlNow() }, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'event', entity_id: row.id, action: 'update',
      summary: `Changed ${fieldLabels(changed)} of ${row.kind} ${quote(row.title)}`,
      before: pick(row, changed), after: values,
    });
  }
  return { event: shape(await first(ctx.env, 'SELECT * FROM events WHERE id = ?', [row.id]), ctx) };
}

/** DELETE /api/admin/events/:id */
export async function remove(ctx) {
  const row = await loadEvent(ctx);
  await run(ctx.env, 'DELETE FROM events WHERE id = ?', [row.id]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'event', entity_id: row.id, action: 'delete',
    summary: `Deleted ${row.kind} ${quote(row.title)}`, before: row,
  });
  return { ok: true };
}
