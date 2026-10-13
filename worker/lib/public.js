// Rome's Joy admin Worker: the public bundles every site and TV screen renders from, plus the row shapes
// the admin routes reuse (events, menu items, announcements, artworks).
import { PUBLIC_CACHE, json, notFound } from './http.js';
import { all, batch, first, isoTime, parseJson, stmt, withIsoTimes } from './db.js';
import { addDays, eventDateText, eventStatus, eventTimeText, hoursSummary, minutesToText, openNow, shapeHours } from './time.js';

export const DIETARY = { GF: 'Gluten free', V: 'Vegetarian', DF: 'Dairy free' };
const EXCEPTION_WINDOW_DAYS = 60;
const PAST_EVENTS = 20;

/** "773.966.5801" → "tel:+17739665801". */
export function phoneHref(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `tel:+1${digits}`;
  return `tel:+${digits}`;
}

export function formatAddress(row) {
  const cityLine = [row.city, [row.state, row.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [row.address1, row.address2, cityLine].filter(Boolean).join(', ') || null;
}

/** The business block of a public bundle. The notice hides itself after notice_until. */
export function shapeBusinessPublic(row, today) {
  const noticeLive = row.notice && (!row.notice_until || row.notice_until >= today);
  return {
    slug: row.slug,
    name: row.name,
    short_name: row.short_name,
    tagline: row.tagline,
    description: row.description,
    address: {
      line1: row.address1, line2: row.address2, city: row.city, state: row.state, zip: row.zip, formatted: formatAddress(row),
    },
    phone: row.phone,
    phone_href: phoneHref(row.phone),
    public_email: row.public_email,
    website_url: row.website_url,
    instagram_url: row.instagram_url,
    facebook_url: row.facebook_url,
    map_url: row.map_url,
    order_url: row.order_url,
    book_url: row.book_url,
    hours_note: row.hours_note,
    notice: noticeLive ? { text: row.notice, until: row.notice_until } : null,
  };
}

export function shapeException(row) {
  const closed = Boolean(row.closed) || row.open_min == null || row.close_min == null;
  return {
    id: row.id,
    date: row.date,
    closed,
    open_min: closed ? null : row.open_min,
    close_min: closed ? null : row.close_min,
    open: closed ? null : minutesToText(row.open_min),
    close: closed ? null : minutesToText(row.close_min),
    label: row.label,
    text: closed ? 'Closed' : `${minutesToText(row.open_min)} – ${minutesToText(row.close_min)}`,
  };
}

/** An event with its computed status and printable dates; `admin` adds the columns only staff see. */
export function shapeEvent(row, today, { admin = false } = {}) {
  const ev = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    start_date: row.start_date,
    end_date: row.end_date,
    start_time: row.start_time,
    end_time: row.end_time,
    date_text: eventDateText(row.start_date, row.end_date),
    time_text: eventTimeText(row.start_time, row.end_time),
    location: row.location,
    link_url: row.link_url,
    link_label: row.link_label,
    image_url: row.image_url,
    featured: Boolean(row.featured),
    status: eventStatus(row, today),
  };
  if (admin) {
    const t = withIsoTimes(row);
    Object.assign(ev, { business_slug: row.business_slug, published: Boolean(row.published), sort_order: row.sort_order, created_at: t.created_at, updated_at: t.updated_at });
  }
  return ev;
}

export function shapeMenuItem(row, { admin = false } = {}) {
  const item = {
    id: row.id,
    name: row.name,
    portion: row.portion,
    price: row.price,
    prices: parseJson(row.prices_json, null),
    description: row.description,
    tags: parseJson(row.tags_json, []),
    allergens: parseJson(row.allergens_json, []),
    featured: Boolean(row.featured),
  };
  if (admin) Object.assign(item, { section_id: row.section_id, available: Boolean(row.available), sort_order: row.sort_order });
  return item;
}

export function shapeSection(row, items, { admin = false } = {}) {
  const section = { id: row.id, title: row.title, short_title: row.short_title, description: row.description, items };
  if (admin) Object.assign(section, { business_slug: row.business_slug, published: Boolean(row.published), sort_order: row.sort_order });
  return section;
}

export function shapeAnnouncement(row, { admin = false } = {}) {
  const a = {
    id: row.id,
    business_slug: row.business_slug,
    title: row.title,
    body: row.body,
    link_url: row.link_url,
    link_label: row.link_label,
    image_url: row.image_url,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    show_on_tv: Boolean(row.show_on_tv),
  };
  if (admin) {
    const t = withIsoTimes(row);
    Object.assign(a, { published: Boolean(row.published), created_at: t.created_at, updated_at: t.updated_at });
  }
  return a;
}

/* -------------------------------------------------------------------------
   Feature flags (settings "features:<slug>", e.g. { "artworks": true }) and the artwork catalog
   ------------------------------------------------------------------------- */

/** A features setting's JSON → a plain object ({} when unset or not an object); `artworks` is a boolean. */
export function parseFeatures(valueJson) {
  const value = parseJson(valueJson, {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return 'artworks' in value ? { ...value, artworks: Boolean(value.artworks) } : { ...value };
}

export const ARTWORK_STATUS_TEXT = { available: 'Available', reserved: 'Reserved', sold: 'Sold', not_for_sale: 'Not for sale' };

/** 1800 → "$1,800", 950.5 → "$950.50" (cents only when there are any). */
export function formatUsd(amount) {
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * What a site may say about the price: the amount only when staff chose "show" and set one, never for a piece
 * that is sold or not for sale (what it went for stays private), "Price on request", or nothing.
 */
export function artworkPrice(row) {
  if (row.status === 'sold' || row.status === 'not_for_sale') return { price: null, price_text: null };
  if (row.price_display === 'show') return row.price == null ? { price: null, price_text: null } : { price: row.price, price_text: formatUsd(row.price) };
  if (row.price_display === 'on_request') return { price: null, price_text: 'Price on request' };
  return { price: null, price_text: null };
}

/** One photo of a piece; `admin` adds the columns only staff see. A missing thumbnail falls back to the full image. */
export function shapeArtworkImage(row, { admin = false } = {}) {
  const img = { id: row.id, url: row.url, thumb_url: row.thumb_url || row.url, alt: row.alt, width: row.width, height: row.height };
  if (admin) Object.assign(img, { artwork_id: row.artwork_id, thumb_url: row.thumb_url, sort_order: row.sort_order, created_at: isoTime(row.created_at) });
  return img;
}

/** A published piece as the sites show it (price rules above), with its photos in order. */
export function shapeArtworkPublic(row, images) {
  return {
    id: row.id,
    event_id: row.event_id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    medium: row.medium,
    dimensions: row.dimensions,
    description: row.description,
    status: row.status,
    status_text: ARTWORK_STATUS_TEXT[row.status] || row.status,
    ...artworkPrice(row),
    featured: Boolean(row.featured),
    images: images.map((i) => shapeArtworkImage(i)),
  };
}

/** Groups image rows by artwork_id (rows arrive already in sort order). */
export function imagesByArtwork(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.artwork_id)) map.set(row.artwork_id, []);
    map.get(row.artwork_id).push(row);
  }
  return map;
}

/**
 * The pieces a site may show, for queries over `artworks a LEFT JOIN events e ON e.id = a.event_id`: published,
 * and not hanging in an exhibition that is still a draft (a show being prepared stays private, prices included).
 */
export const PUBLIC_ARTWORK_SQL = 'a.published = 1 AND (a.event_id IS NULL OR e.published = 1)';

/** Published artworks of a business with their photos, featured first. */
async function publicArtworks(env, slug) {
  let artworks;
  let images;
  try {
    [artworks, images] = await batch(env, [
      stmt(env, `SELECT a.* FROM artworks a LEFT JOIN events e ON e.id = a.event_id
        WHERE a.business_slug = ? AND ${PUBLIC_ARTWORK_SQL} ORDER BY a.featured DESC, a.sort_order, a.id`, [slug]),
      stmt(env, `SELECT i.* FROM artwork_images i JOIN artworks a ON a.id = i.artwork_id LEFT JOIN events e ON e.id = a.event_id
        WHERE a.business_slug = ? AND ${PUBLIC_ARTWORK_SQL} ORDER BY i.sort_order, i.id`, [slug]),
    ]);
  } catch (err) {
    // Switched on before the artworks migration ran: no catalog, but the hours, events and TV keep working.
    if (/no such table/i.test(String(err?.message))) return [];
    throw err;
  }
  const byArtwork = imagesByArtwork(images.results);
  return artworks.results.map((row) => shapeArtworkPublic(row, byArtwork.get(row.id) || []));
}

/** Sorts public events into the three buckets the sites show. */
export function bucketEvents(rows, today) {
  const events = rows.map((r) => shapeEvent(r, today));
  const byStart = (a, b) => a.start_date.localeCompare(b.start_date) || (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id;
  return {
    current: events.filter((e) => e.status === 'current').sort(byStart),
    upcoming: events.filter((e) => e.status === 'upcoming').sort(byStart),
    past: events.filter((e) => e.status === 'past').sort((a, b) => byStart(b, a)).slice(0, PAST_EVENTS),
  };
}

/** Groups item rows under their sections, in sort order. */
export function nestMenu(sections, items, opts) {
  const bySection = new Map(sections.map((s) => [s.id, []]));
  for (const item of items) bySection.get(item.section_id)?.push(shapeMenuItem(item, opts));
  return sections.map((s) => shapeSection(s, bySection.get(s.id) || [], opts));
}

/** Everything a site needs for one business. Returns null when the slug is unknown. */
export async function buildBundle(env, slug, now) {
  const today = now.date;
  const [biz, hours, exceptions, announcements, events, sections, items, featureRow] = await batch(env, [
    stmt(env, 'SELECT * FROM businesses WHERE slug = ?', [slug]),
    stmt(env, 'SELECT * FROM hours WHERE business_slug = ?', [slug]),
    stmt(env, 'SELECT * FROM hours_exceptions WHERE business_slug = ? AND date >= ? AND date <= ? ORDER BY date', [slug, today, addDays(today, EXCEPTION_WINDOW_DAYS)]),
    stmt(env, `SELECT * FROM announcements WHERE (business_slug = ? OR business_slug IS NULL) AND published = 1
      AND starts_at <= ? AND (ends_at IS NULL OR ends_at >= ?) ORDER BY starts_at DESC, id DESC`, [slug, today, today]),
    stmt(env, 'SELECT * FROM events WHERE business_slug = ? AND published = 1 ORDER BY start_date, sort_order, id', [slug]),
    stmt(env, 'SELECT * FROM menu_sections WHERE business_slug = ? AND published = 1 ORDER BY sort_order, id', [slug]),
    stmt(env, `SELECT i.* FROM menu_items i JOIN menu_sections s ON s.id = i.section_id
      WHERE s.business_slug = ? AND s.published = 1 AND i.available = 1 ORDER BY i.sort_order, i.id`, [slug]),
    stmt(env, 'SELECT value_json FROM settings WHERE key = ?', [`features:${slug}`]),
  ]);
  const business = biz.results[0];
  if (!business) return null;
  const shaped = shapeHours(hours.results);
  const features = parseFeatures(featureRow.results[0]?.value_json);
  const data = {
    generated_at: now.iso,
    today: { date: today, weekday: now.weekday },
    business: shapeBusinessPublic(business, today),
    hours: shaped,
    hours_summary: hoursSummary(shaped),
    exceptions: exceptions.results.map(shapeException),
    open_now: openNow(shaped, exceptions.results, now),
    announcements: announcements.results.map((r) => shapeAnnouncement(r)),
    events: bucketEvents(events.results, today),
    menu: { sections: nestMenu(sections.results, items.results) },
    dietary: DIETARY,
    features,
  };
  // The artwork catalog only appears where it is switched on; each event then says how many pieces hang in it.
  if (features.artworks) {
    data.artworks = await publicArtworks(env, slug);
    const perEvent = new Map();
    for (const a of data.artworks) if (a.event_id != null) perEvent.set(a.event_id, (perEvent.get(a.event_id) || 0) + 1);
    for (const list of Object.values(data.events)) for (const ev of list) ev.artwork_count = perEvent.get(ev.id) || 0;
  }
  return data;
}

/** Every business with its hours summary and open/closed status, for the hub and the TV "family" strip. */
export async function listBusinesses(env, now) {
  const [biz, hours, exceptions] = await batch(env, [
    stmt(env, 'SELECT * FROM businesses ORDER BY sort_order, slug'),
    stmt(env, 'SELECT * FROM hours'),
    stmt(env, 'SELECT * FROM hours_exceptions WHERE date >= ? AND date <= ?', [now.date, addDays(now.date, 7)]),
  ]);
  return biz.results.map((row) => {
    const shaped = shapeHours(hours.results.filter((h) => h.business_slug === row.slug));
    const pub = shapeBusinessPublic(row, now.date);
    return {
      slug: row.slug,
      name: row.name,
      short_name: row.short_name,
      tagline: row.tagline,
      phone: row.phone,
      phone_href: pub.phone_href,
      address: pub.address,
      hours_summary: hoursSummary(shaped),
      open_now: openNow(shaped, exceptions.results.filter((e) => e.business_slug === row.slug), now),
    };
  });
}

/* -------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */
export async function businesses(ctx) {
  return json({ businesses: await listBusinesses(ctx.env, ctx.now) }, 200, PUBLIC_CACHE);
}

export async function bundle(ctx) {
  const data = await buildBundle(ctx.env, ctx.params.slug, ctx.now);
  if (!data) throw notFound('No such business.', 'unknown_business');
  return json(data, 200, PUBLIC_CACHE);
}

export async function signage(ctx) {
  const data = await buildBundle(ctx.env, ctx.params.slug, ctx.now);
  if (!data) throw notFound('No such business.', 'unknown_business');
  const [setting, family] = await Promise.all([
    first(ctx.env, 'SELECT value_json FROM settings WHERE key = ?', [`signage:${ctx.params.slug}`]),
    listBusinesses(ctx.env, ctx.now),
  ]);
  data.signage = parseJson(setting?.value_json, {}) ?? {};
  data.family = family.map((b) => ({ slug: b.slug, name: b.name, tagline: b.tagline, hours_summary: b.hours_summary }));
  return json(data, 200, PUBLIC_CACHE);
}

export const allBusinessRows = (env) => all(env, 'SELECT * FROM businesses ORDER BY sort_order, slug');
