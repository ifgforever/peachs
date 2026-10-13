// Rome's Joy admin Worker: /api/admin inquiries — the inbox of website form submissions.
import { bad, idParam, intParam, notFound, readBody } from './http.js';
import { all, first, parseJson, updateRow, withIsoTimes } from './db.js';
import { requireBusiness } from './auth.js';
import { audit } from './audit.js';
import { deliverInquiry } from './email.js';

export const INQUIRY_STATUSES = ['new', 'handled', 'spam'];

/**
 * An inquiry with its extra fields parsed (as `fields`, and `fields_json` for readers of the contract's wording).
 * The visitor's IP stays in the database (for the form rate limit only) and never reaches the admin.
 */
export function shapeInquiry(row) {
  const { fields_json, ip, ...rest } = withIsoTimes(row);
  const fields = parseJson(fields_json, {});
  return { ...rest, fields, fields_json: fields };
}

async function loadInquiry(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM inquiries WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such inquiry.');
  const business = await requireBusiness(ctx, row.business_slug);
  return { row, business };
}

/** GET /api/admin/businesses/:slug/inquiries?status=new|handled|spam|all&limit=50&before=<id> */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const status = ctx.url.searchParams.get('status') || 'all';
  if (status !== 'all' && !INQUIRY_STATUSES.includes(status)) throw bad('status must be new, handled, spam or all.');
  const limit = intParam(ctx.url, 'limit', 50);
  const before = idParam(ctx.url, 'before');
  const where = ['business_slug = ?'];
  const binds = [business.slug];
  if (status !== 'all') { where.push('status = ?'); binds.push(status); }
  if (before) { where.push('id < ?'); binds.push(before); }
  const rows = await all(ctx.env, `SELECT * FROM inquiries WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...binds, limit]);
  return { inquiries: rows.map(shapeInquiry) };
}

/** GET /api/admin/inquiries/:id → { inquiry } (for the deep link in notification emails) */
export async function get(ctx) {
  const { row } = await loadInquiry(ctx);
  return { inquiry: shapeInquiry(row) };
}

/** PATCH /api/admin/inquiries/:id { status } */
export async function patch(ctx) {
  const { row } = await loadInquiry(ctx);
  const body = await readBody(ctx.request);
  if (!INQUIRY_STATUSES.includes(body.status)) throw bad('status must be new, handled or spam.', 'invalid_field');
  if (body.status !== row.status) {
    await updateRow(ctx.env, 'inquiries', { status: body.status }, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'inquiry', entity_id: row.id, action: 'update',
      summary: `Marked inquiry #${row.id} ${body.status}`, before: { status: row.status }, after: { status: body.status },
    });
  }
  return { inquiry: shapeInquiry(await first(ctx.env, 'SELECT * FROM inquiries WHERE id = ?', [row.id])) };
}

/** POST /api/admin/inquiries/:id/resend — tries the notification email again. */
export async function resend(ctx) {
  const { row, business } = await loadInquiry(ctx);
  const result = await deliverInquiry(ctx.env, business, row);
  const fresh = await first(ctx.env, 'SELECT emailed_at, email_error FROM inquiries WHERE id = ?', [row.id]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'inquiry', entity_id: row.id, action: 'update',
    summary: result.sent ? `Re-sent inquiry #${row.id} by email` : `Tried to re-send inquiry #${row.id} by email (${result.reason})`,
    before: { emailed_at: row.emailed_at, email_error: row.email_error }, after: fresh,
  });
  return { emailed: result.sent, error: result.sent ? null : result.reason };
}
