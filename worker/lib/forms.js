// Rome's Joy admin Worker: website form submissions → inquiries table → email.
import { bad, json, notFound, readBody, tooMany } from './http.js';
import { first, insertRow } from './db.js';
import { isEmail } from './validate.js';
import { deliverInquiry } from './email.js';

const MAX_FIELDS = 20;
const MAX_FIELD_LENGTH = 5000;
const RATE_LIMIT = { count: 10, minutes: 10 };
const KNOWN = new Set(['name', 'email', 'phone', 'message', 'website', 'source_url']);

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();

/** POST /api/forms/:slug/:type — accepts JSON or a plain HTML form post. */
export async function submit(ctx) {
  const { slug, type } = ctx.params;
  const contentType = (ctx.request.headers.get('Content-Type') || '').toLowerCase();
  const isForm = contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
  const body = await readBody(ctx.request);

  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(type)) throw bad('Unknown form type.', 'unknown_form');
  const keys = Object.keys(body);
  if (keys.length > MAX_FIELDS) throw bad(`Forms may send at most ${MAX_FIELDS} fields.`, 'too_many_fields');
  const values = {};
  for (const key of keys) {
    const text = asText(body[key]);
    if (text.length > MAX_FIELD_LENGTH) throw bad(`The "${key}" field is too long (max ${MAX_FIELD_LENGTH} characters).`, 'field_too_long');
    values[key] = text;
  }

  // A plain <form> can ask to land back on a same-site page.
  const redirect = isForm && typeof values._redirect === 'string' && /^\/(?!\/)/.test(values._redirect) ? values._redirect : null;
  const finish = (payload) => (redirect
    ? new Response(null, { status: 303, headers: { Location: new URL(redirect, ctx.url).toString() } })
    : json(payload));

  // Honeypot: bots fill the hidden "website" field. Pretend it worked.
  if (values.website) return finish({ ok: true });

  const business = await first(ctx.env, 'SELECT * FROM businesses WHERE slug = ?', [slug]);
  if (!business) throw notFound('No such business.', 'unknown_business');

  const email = values.email ? values.email.toLowerCase() : null;
  if (!values.message && !email) throw bad('Please include a message or an email address.', 'missing_fields');
  if (email && !isEmail(email)) throw bad('That email address does not look right.', 'invalid_email');

  const recent = await first(ctx.env, `SELECT COUNT(*) AS n FROM inquiries WHERE ip = ? AND created_at > datetime('now', '-${RATE_LIMIT.minutes} minutes')`, [ctx.ip]);
  if (recent.n >= RATE_LIMIT.count) throw tooMany('Too many submissions. Please try again in a few minutes.');

  const extra = {};
  for (const [key, value] of Object.entries(values)) {
    if (KNOWN.has(key) || key.startsWith('_') || !value) continue;
    extra[key] = value;
  }
  const id = await insertRow(ctx.env, 'inquiries', {
    business_slug: slug,
    form_type: type,
    name: values.name || null,
    email,
    phone: values.phone || null,
    message: values.message || null,
    fields_json: JSON.stringify(extra),
    source_url: values.source_url || ctx.request.headers.get('Referer') || null,
    ip: ctx.ip,
  });
  const inquiry = await first(ctx.env, 'SELECT * FROM inquiries WHERE id = ?', [id]);
  const result = await deliverInquiry(ctx.env, business, inquiry);
  return finish({ ok: true, id, emailed: result.sent });
}
