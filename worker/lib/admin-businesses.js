// Rome's Joy admin Worker: /api/admin/businesses — details, weekly hours and one-off exceptions.
import { bad, conflict, notFound, readBody } from './http.js';
import { all, batch, first, insertRow, pick, run, sqlNow, stmt, updateRow, withIsoTimes } from './db.js';
import { readFields, readHoursRow } from './validate.js';
import { assertCanEdit, canEdit, requireBusiness } from './auth.js';
import { audit, changedKeys, fieldLabels, listWords } from './audit.js';
import { DAY_LABELS, hoursSummary, hoursText, shapeHours, shortDate } from './time.js';
import { parseFeatures, shapeException } from './public.js';

export const BUSINESS_FIELDS = {
  name: { type: 'text', required: true, max: 120 },
  short_name: { type: 'text', max: 60 },
  tagline: { type: 'text', max: 200 },
  description: { type: 'text', max: 2000 },
  address1: { type: 'text', max: 200, label: 'address' },
  address2: { type: 'text', max: 200 },
  city: { type: 'text', required: true, max: 80 },
  state: { type: 'text', required: true, max: 40 },
  zip: { type: 'text', max: 20, label: 'ZIP code' },
  phone: { type: 'text', max: 40 },
  public_email: { type: 'email' },
  inquiry_emails: { type: 'emails' },
  website_url: { type: 'url' },
  instagram_url: { type: 'url' },
  facebook_url: { type: 'url' },
  map_url: { type: 'url' },
  order_url: { type: 'url' },
  book_url: { type: 'url' },
  hours_note: { type: 'text', max: 200 },
  notice: { type: 'text', max: 300 },
  notice_until: { type: 'date' },
};
export const BUSINESS_EDITABLE = Object.keys(BUSINESS_FIELDS);

const shapeBusiness = (row) => withIsoTimes(row);
const displayName = (b) => b.short_name || b.name;

/** Artworks per business (all, and status "available"); none until the artworks migration has run, so the admin keeps working. */
async function artworkCounts(env) {
  try {
    return await all(env, "SELECT business_slug, COUNT(*) AS n, SUM(status = 'available') AS available FROM artworks GROUP BY business_slug");
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return [];
    throw err;
  }
}

/** GET /api/admin/businesses */
export async function list(ctx) {
  const today = ctx.now.date;
  const [biz, hours, inquiries, events, features] = await batch(ctx.env, [
    stmt(ctx.env, 'SELECT * FROM businesses ORDER BY sort_order, slug'),
    stmt(ctx.env, 'SELECT * FROM hours'),
    stmt(ctx.env, "SELECT business_slug, COUNT(*) AS n FROM inquiries WHERE status = 'new' GROUP BY business_slug"),
    stmt(ctx.env, `SELECT business_slug, SUM(start_date > ?) AS upcoming, SUM(start_date <= ? AND COALESCE(end_date, start_date) >= ?) AS current
      FROM events WHERE published = 1 AND COALESCE(end_date, start_date) >= ? GROUP BY business_slug`, [today, today, today, today]),
    stmt(ctx.env, "SELECT key, value_json FROM settings WHERE key LIKE 'features:%'"),
  ]);
  const artworks = await artworkCounts(ctx.env);
  const count = (rows, slug, col = 'n') => rows.find((r) => r.business_slug === slug)?.[col] || 0;
  const featureJson = new Map(features.results.map((r) => [r.key.slice('features:'.length), r.value_json]));
  const businesses = biz.results.filter((b) => canEdit(ctx.user, b.slug)).map((b) => ({
    ...shapeBusiness(b),
    hours_summary: hoursSummary(shapeHours(hours.results.filter((h) => h.business_slug === b.slug))),
    features: parseFeatures(featureJson.get(b.slug)),
    // Published events only, as the public sites bucket them: upcoming starts after today, current is on now.
    // Artworks count every piece whatever its status or published flag; artworks_available those marked available.
    counts: {
      new_inquiries: count(inquiries.results, b.slug),
      upcoming_events: count(events.results, b.slug, 'upcoming'),
      current_events: count(events.results, b.slug, 'current'),
      artworks: count(artworks, b.slug),
      artworks_available: count(artworks, b.slug, 'available'),
    },
  }));
  return { businesses };
}

/** GET /api/admin/businesses/:slug */
export async function get(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const [hours, exceptions] = await batch(ctx.env, [
    stmt(ctx.env, 'SELECT * FROM hours WHERE business_slug = ?', [business.slug]),
    stmt(ctx.env, 'SELECT * FROM hours_exceptions WHERE business_slug = ? AND date >= ? ORDER BY date', [business.slug, ctx.now.date]),
  ]);
  return { business: shapeBusiness(business), hours: shapeHours(hours.results), exceptions: exceptions.results.map(shapeException) };
}

/** PATCH /api/admin/businesses/:slug */
export async function patch(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), BUSINESS_FIELDS, 'patch');
  const changed = changedKeys(business, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'businesses', { ...values, updated_at: sqlNow() }, 'slug = ?', [business.slug]);
    await audit(ctx, {
      business_slug: business.slug, entity: 'business', entity_id: business.slug, action: 'update',
      summary: `Changed ${fieldLabels(changed)} for ${displayName(business)}`,
      before: pick(business, changed), after: values,
    });
  }
  return { business: shapeBusiness(await first(ctx.env, 'SELECT * FROM businesses WHERE slug = ?', [business.slug])) };
}

/** PUT /api/admin/businesses/:slug/hours — all 7 days at once. */
export async function putHours(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const body = await readBody(ctx.request);
  if (!Array.isArray(body.hours) || body.hours.length !== 7) throw bad('Send hours for all 7 days.', 'invalid_field');
  const rows = [];
  const seen = new Set();
  for (const raw of body.hours) {
    const weekday = Number(raw?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || seen.has(weekday)) throw bad('Each weekday 0–6 must appear exactly once.', 'invalid_field');
    seen.add(weekday);
    rows.push({ weekday, ...readHoursRow(raw, `${DAY_LABELS[weekday]} hours`) });
  }
  rows.sort((a, b) => a.weekday - b.weekday);
  const current = await all(ctx.env, 'SELECT weekday, closed, open_min, close_min FROM hours WHERE business_slug = ? ORDER BY weekday', [business.slug]);
  await saveHours(ctx.env, business.slug, rows);
  const before = shapeHours(current);
  const after = shapeHours(rows);
  const changedDays = after.filter((day, i) => day.text !== before[i].text);
  if (changedDays.length) {
    const summary = changedDays.length === 1
      ? `Changed ${changedDays[0].label} hours to ${changedDays[0].text} for ${displayName(business)}`
      : `Changed ${listWords(changedDays.map((d) => d.label))} hours for ${displayName(business)}`;
    await audit(ctx, {
      business_slug: business.slug, entity: 'hours', entity_id: business.slug, action: 'update', summary,
      before: before.map(plainHours), after: after.map(plainHours),
    });
  }
  return { hours: after };
}

const plainHours = (h) => ({ weekday: h.weekday, closed: h.closed ? 1 : 0, open_min: h.open_min, close_min: h.close_min });

/** Replaces the 7 weekly rows (also used by History → Restore). */
export function saveHours(env, slug, rows) {
  return batch(env, rows.map((r) => stmt(env,
    'INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES (?, ?, ?, ?, ?)',
    [slug, r.weekday, r.closed ? 1 : 0, r.closed ? null : r.open_min, r.closed ? null : r.close_min])));
}

/** GET /api/admin/businesses/:slug/hours/exceptions — today and later. */
export async function listExceptions(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const rows = await all(ctx.env, 'SELECT * FROM hours_exceptions WHERE business_slug = ? AND date >= ? ORDER BY date', [business.slug, ctx.now.date]);
  return { exceptions: rows.map(shapeException) };
}

const exceptionSummary = (row) => `${shortDate(row.date)}: ${hoursText(row)}${row.label ? ` (${row.label})` : ''}`;

/** POST /api/admin/businesses/:slug/hours/exceptions */
export async function createException(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const body = await readBody(ctx.request);
  const { date, label } = readFields(body, { date: { type: 'date', required: true }, label: { type: 'text', max: 120 } });
  const closed = body.closed === undefined ? body.open_min == null && body.open == null : body.closed;
  const hours = readHoursRow({ ...body, closed }, 'Special hours');
  const existing = await first(ctx.env, 'SELECT id FROM hours_exceptions WHERE business_slug = ? AND date = ?', [business.slug, date]);
  if (existing) throw conflict(`There are already special hours for ${shortDate(date)}. Remove them first.`, 'duplicate_date');
  const id = await insertRow(ctx.env, 'hours_exceptions', { business_slug: business.slug, date, label, ...hours });
  const row = await first(ctx.env, 'SELECT * FROM hours_exceptions WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: business.slug, entity: 'hours_exception', entity_id: id, action: 'create',
    summary: `Added special hours for ${exceptionSummary(row)}`, after: row,
  });
  return { exception: shapeException(row) };
}

/** DELETE /api/admin/hours/exceptions/:id */
export async function deleteException(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM hours_exceptions WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such special hours entry.');
  assertCanEdit(ctx.user, row.business_slug);
  await run(ctx.env, 'DELETE FROM hours_exceptions WHERE id = ?', [row.id]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'hours_exception', entity_id: row.id, action: 'delete',
    summary: `Removed special hours for ${shortDate(row.date)}${row.label ? ` (${row.label})` : ''}`, before: row,
  });
  return { ok: true };
}
