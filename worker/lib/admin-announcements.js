// Rome's Joy admin Worker: /api/admin announcements — news and promos per business or family-wide.
import { bad, notFound, readBody } from './http.js';
import { all, first, insertRow, pick, run, sqlNow, updateRow } from './db.js';
import { readFields } from './validate.js';
import { requireBusiness, requireManager } from './auth.js';
import { audit, changedKeys, fieldLabels, quote } from './audit.js';
import { shapeAnnouncement } from './public.js';

export const ANNOUNCEMENT_FIELDS = {
  title: { type: 'text', required: true, max: 200 },
  body: { type: 'text', max: 2000 },
  link_url: { type: 'url' },
  link_label: { type: 'text', max: 80 },
  image_url: { type: 'url' },
  starts_at: { type: 'date' },
  ends_at: { type: 'date' },
  show_on_tv: { type: 'bool', default: 1 },
  published: { type: 'bool', default: 1 },
};
export const ANNOUNCEMENT_COLUMNS = ['business_slug', ...Object.keys(ANNOUNCEMENT_FIELDS), 'created_at', 'updated_at'];

const shape = (row) => shapeAnnouncement(row, { admin: true });
const describe = (row) => `${row.business_slug ? '' : 'family-wide '}announcement ${quote(row.title)}`;

/** The end date must not come before the start (also used by change sets). */
export function checkDates(a) {
  if (a.ends_at && a.starts_at && a.ends_at < a.starts_at) throw bad('The end date cannot be before the start date.', 'invalid_dates');
}

/** Family-wide rows need an owner or admin; business rows need edit rights for that business. */
async function authorize(ctx, slug) {
  if (slug) return requireBusiness(ctx, slug);
  requireManager(ctx.user, 'change family-wide announcements');
  return null;
}

async function loadAnnouncement(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM announcements WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such announcement.');
  await authorize(ctx, row.business_slug);
  return row;
}

/** GET /api/admin/businesses/:slug/announcements */
export async function listBusiness(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const rows = await all(ctx.env, 'SELECT * FROM announcements WHERE business_slug = ? ORDER BY starts_at DESC, id DESC', [business.slug]);
  return { announcements: rows.map(shape) };
}

/** GET /api/admin/announcements?scope=family */
export async function listFamily(ctx) {
  const scope = ctx.url.searchParams.get('scope') || 'family';
  if (scope !== 'family') throw bad('Use ?scope=family, or the per-business route.');
  requireManager(ctx.user, 'see family-wide announcements');
  const rows = await all(ctx.env, 'SELECT * FROM announcements WHERE business_slug IS NULL ORDER BY starts_at DESC, id DESC');
  return { announcements: rows.map(shape) };
}

async function createFor(ctx, slug) {
  await authorize(ctx, slug);
  const fields = readFields(await readBody(ctx.request), ANNOUNCEMENT_FIELDS, 'create');
  if (!fields.starts_at) fields.starts_at = ctx.now.date;
  checkDates(fields);
  const id = await insertRow(ctx.env, 'announcements', { business_slug: slug, ...fields });
  const row = await first(ctx.env, 'SELECT * FROM announcements WHERE id = ?', [id]);
  await audit(ctx, { business_slug: slug, entity: 'announcement', entity_id: id, action: 'create', summary: `Added ${describe(row)}`, after: row });
  return { announcement: shape(row) };
}

/** POST /api/admin/businesses/:slug/announcements */
export const createBusiness = (ctx) => createFor(ctx, ctx.params.slug);
/** POST /api/admin/announcements (family-wide) */
export const createFamily = (ctx) => createFor(ctx, null);

/** PATCH /api/admin/announcements/:id */
export async function patch(ctx) {
  const row = await loadAnnouncement(ctx);
  const fields = readFields(await readBody(ctx.request), ANNOUNCEMENT_FIELDS, 'patch');
  checkDates({ ...row, ...fields });
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'announcements', { ...values, updated_at: sqlNow() }, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'announcement', entity_id: row.id, action: 'update',
      summary: `Changed ${fieldLabels(changed)} of ${describe(row)}`, before: pick(row, changed), after: values,
    });
  }
  return { announcement: shape(await first(ctx.env, 'SELECT * FROM announcements WHERE id = ?', [row.id])) };
}

/** DELETE /api/admin/announcements/:id */
export async function remove(ctx) {
  const row = await loadAnnouncement(ctx);
  await run(ctx.env, 'DELETE FROM announcements WHERE id = ?', [row.id]);
  await audit(ctx, { business_slug: row.business_slug, entity: 'announcement', entity_id: row.id, action: 'delete', summary: `Deleted ${describe(row)}`, before: row });
  return { ok: true };
}
