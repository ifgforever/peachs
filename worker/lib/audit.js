// Rome's Joy admin Worker: the audit log behind the History page and "Restore".
import { run } from './db.js';

/**
 * Records one change. `before` and `after` are stored as JSON so the entry can be restored later;
 * `summary` is the plain-English line staff read, e.g. "Changed Saturday hours to 8 am – 3 pm".
 * Change sets (worker/lib/changesets.js) set ctx.auditSource ("Assistant", "Claude app"), which prefixes the
 * summary ("Assistant: Changed …"), and ctx.auditIds, an array that collects the id of every row written.
 */
export async function audit(ctx, { business_slug = null, entity, entity_id = null, action, summary, before = null, after = null }) {
  const { meta } = await run(ctx.env, `INSERT INTO audit_log (user_id, user_email, business_slug, entity, entity_id, action, summary, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    ctx.user?.id ?? null, ctx.user?.email ?? null, business_slug, entity,
    entity_id == null ? null : String(entity_id), action, ctx.auditSource ? `${ctx.auditSource}: ${summary}` : summary,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
  ]);
  if (Array.isArray(ctx.auditIds)) ctx.auditIds.push(meta.last_row_id);
}

/** 'Hangover Plate' with curly-safe quotes for summaries. */
export const quote = (s) => `'${String(s ?? '').trim() || 'untitled'}'`;

/** ["a"] → "a"; ["a","b"] → "a and b"; ["a","b","c"] → "a, b and c". */
export function listWords(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The keys whose values differ between two rows (used to say what changed). */
export function changedKeys(before, after) {
  return Object.keys(after).filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

/** Friendly names for columns, used in "Changed X: phone number, notice". */
const FIELD_LABELS = {
  name: 'name', short_name: 'short name', tagline: 'tagline', description: 'description', address1: 'address',
  address2: 'address line 2', city: 'city', state: 'state', zip: 'ZIP code', phone: 'phone number',
  public_email: 'public email', inquiry_emails: 'inquiry inboxes', website_url: 'website link', instagram_url: 'Instagram link',
  facebook_url: 'Facebook link', map_url: 'map link', order_url: 'ordering link', book_url: 'booking link',
  hours_note: 'hours note', notice: 'notice', notice_until: 'notice end date', kind: 'type', title: 'title', subtitle: 'subtitle',
  start_date: 'start date', end_date: 'end date', start_time: 'start time', end_time: 'end time', location: 'location',
  link_url: 'link', link_label: 'link label', image_url: 'photo', featured: 'featured', published: 'published',
  sort_order: 'order', body: 'text', starts_at: 'start date', ends_at: 'end date', show_on_tv: 'show on TV',
  portion: 'portion', price: 'price', prices_json: 'prices', tags_json: 'dietary tags', allergens_json: 'allergens',
  available: 'availability', status: 'status', role: 'role', businesses_json: 'businesses', active: 'active',
  password_hash: 'password', must_change_password: 'password reset', email: 'email',
  dimensions: 'size', price_display: 'price display', event_id: 'exhibition', alt: 'photo description',
};
export const fieldLabel = (key) => FIELD_LABELS[key] || key.replace(/_/g, ' ');
export const fieldLabels = (keys) => listWords(keys.map(fieldLabel));
