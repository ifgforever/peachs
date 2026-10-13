// Rome's Joy admin Worker: /api/admin menu — sections, items and ordering.
import { bad, notFound, readBody } from './http.js';
import { all, batch, first, insertRow, pick, run, stmt, updateRow } from './db.js';
import { readFields } from './validate.js';
import { requireBusiness } from './auth.js';
import { audit, changedKeys, fieldLabels, quote } from './audit.js';
import { nestMenu, shapeMenuItem, shapeSection } from './public.js';

export const SECTION_FIELDS = {
  title: { type: 'text', required: true, max: 120 },
  short_title: { type: 'text', max: 40 },
  description: { type: 'text', max: 1000 },
  published: { type: 'bool', default: 1 },
  sort_order: { type: 'int', min: -1000000, max: 1000000 },
};
export const SECTION_COLUMNS = ['business_slug', ...Object.keys(SECTION_FIELDS)];

// Body keys → columns: tags → tags_json, allergens → allergens_json, prices → prices_json.
export const ITEM_FIELDS = {
  name: { type: 'text', required: true, max: 160 },
  portion: { type: 'text', max: 80 },
  price: { type: 'number', min: 0 },
  prices: { type: 'prices' },
  description: { type: 'text', max: 1000 },
  tags: { type: 'list', max: 10, label: 'dietary tags' },
  allergens: { type: 'list', max: 30 },
  featured: { type: 'bool' },
  available: { type: 'bool', default: 1 },
  sort_order: { type: 'int', min: -1000000, max: 1000000 },
};
const ITEM_RENAMES = { prices: 'prices_json', tags: 'tags_json', allergens: 'allergens_json' };
export const ITEM_COLUMNS = ['section_id', 'name', 'portion', 'price', 'prices_json', 'description', 'tags_json', 'allergens_json', 'featured', 'available', 'sort_order'];

/** Validated item fields → column names (also used by change sets). */
export function itemColumns(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[ITEM_RENAMES[k] || k] = v;
  return out;
}

const adminOpts = { admin: true };

async function loadSection(ctx, id = ctx.params.id) {
  const row = await first(ctx.env, 'SELECT * FROM menu_sections WHERE id = ?', [Number(id) || 0]);
  if (!row) throw notFound('No such menu section.');
  await requireBusiness(ctx, row.business_slug);
  return row;
}

async function loadItem(ctx) {
  const row = await first(ctx.env, `SELECT i.*, s.business_slug, s.title AS section_title FROM menu_items i
    JOIN menu_sections s ON s.id = i.section_id WHERE i.id = ?`, [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such menu item.');
  await requireBusiness(ctx, row.business_slug);
  const { business_slug, section_title, ...item } = row;
  return { item, business_slug, section_title };
}

/** GET /api/admin/businesses/:slug/menu — everything, including unpublished and unavailable. */
export async function list(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const [sections, items] = await batch(ctx.env, [
    stmt(ctx.env, 'SELECT * FROM menu_sections WHERE business_slug = ? ORDER BY sort_order, id', [business.slug]),
    stmt(ctx.env, `SELECT i.* FROM menu_items i JOIN menu_sections s ON s.id = i.section_id
      WHERE s.business_slug = ? ORDER BY i.sort_order, i.id`, [business.slug]),
  ]);
  return { sections: nestMenu(sections.results, items.results, adminOpts) };
}

/** POST /api/admin/businesses/:slug/menu/sections */
export async function createSection(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const fields = readFields(await readBody(ctx.request), SECTION_FIELDS, 'create');
  if (fields.sort_order == null) {
    const { n } = await first(ctx.env, 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_sections WHERE business_slug = ?', [business.slug]);
    fields.sort_order = n;
  }
  const id = await insertRow(ctx.env, 'menu_sections', { business_slug: business.slug, ...fields });
  const row = await first(ctx.env, 'SELECT * FROM menu_sections WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: business.slug, entity: 'menu_section', entity_id: id, action: 'create',
    summary: `Added menu section ${quote(row.title)}`, after: row,
  });
  return { section: shapeSection(row, [], adminOpts) };
}

/** PATCH /api/admin/menu/sections/:id */
export async function patchSection(ctx) {
  const row = await loadSection(ctx);
  const fields = readFields(await readBody(ctx.request), SECTION_FIELDS, 'patch');
  const changed = changedKeys(row, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'menu_sections', values, 'id = ?', [row.id]);
    await audit(ctx, {
      business_slug: row.business_slug, entity: 'menu_section', entity_id: row.id, action: 'update',
      summary: `Changed ${fieldLabels(changed)} of menu section ${quote(row.title)}`, before: pick(row, changed), after: values,
    });
  }
  const fresh = await first(ctx.env, 'SELECT * FROM menu_sections WHERE id = ?', [row.id]);
  const items = await all(ctx.env, 'SELECT * FROM menu_items WHERE section_id = ? ORDER BY sort_order, id', [row.id]);
  return { section: shapeSection(fresh, items.map((i) => shapeMenuItem(i, adminOpts)), adminOpts) };
}

/** DELETE /api/admin/menu/sections/:id — takes its items with it (they come back on Restore). */
export async function deleteSection(ctx) {
  const row = await loadSection(ctx);
  const items = await all(ctx.env, 'SELECT * FROM menu_items WHERE section_id = ? ORDER BY sort_order, id', [row.id]);
  await batch(ctx.env, [
    stmt(ctx.env, 'DELETE FROM menu_items WHERE section_id = ?', [row.id]),
    stmt(ctx.env, 'DELETE FROM menu_sections WHERE id = ?', [row.id]),
  ]);
  await audit(ctx, {
    business_slug: row.business_slug, entity: 'menu_section', entity_id: row.id, action: 'delete',
    summary: `Deleted menu section ${quote(row.title)}${items.length ? ` (${items.length} item${items.length === 1 ? '' : 's'})` : ''}`,
    before: { ...row, items },
  });
  return { ok: true };
}

/** POST /api/admin/menu/sections/:id/items */
export async function createItem(ctx) {
  const section = await loadSection(ctx);
  const fields = itemColumns(readFields(await readBody(ctx.request), ITEM_FIELDS, 'create'));
  if (fields.sort_order == null) {
    const { n } = await first(ctx.env, 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_items WHERE section_id = ?', [section.id]);
    fields.sort_order = n;
  }
  const id = await insertRow(ctx.env, 'menu_items', { section_id: section.id, ...fields });
  const row = await first(ctx.env, 'SELECT * FROM menu_items WHERE id = ?', [id]);
  await audit(ctx, {
    business_slug: section.business_slug, entity: 'menu_item', entity_id: id, action: 'create',
    summary: `Added ${quote(row.name)} to ${section.title}`, after: row,
  });
  return { item: shapeMenuItem(row, adminOpts) };
}

/** PATCH /api/admin/menu/items/:id */
export async function patchItem(ctx) {
  const { item, business_slug } = await loadItem(ctx);
  const fields = itemColumns(readFields(await readBody(ctx.request), ITEM_FIELDS, 'patch'));
  const changed = changedKeys(item, fields);
  if (changed.length) {
    const values = pick(fields, changed);
    await updateRow(ctx.env, 'menu_items', values, 'id = ?', [item.id]);
    await audit(ctx, {
      business_slug, entity: 'menu_item', entity_id: item.id, action: 'update',
      summary: `Changed ${fieldLabels(changed)} of ${quote(item.name)}`, before: pick(item, changed), after: values,
    });
  }
  return { item: shapeMenuItem(await first(ctx.env, 'SELECT * FROM menu_items WHERE id = ?', [item.id]), adminOpts) };
}

/** DELETE /api/admin/menu/items/:id */
export async function deleteItem(ctx) {
  const { item, business_slug, section_title } = await loadItem(ctx);
  await run(ctx.env, 'DELETE FROM menu_items WHERE id = ?', [item.id]);
  await audit(ctx, {
    business_slug, entity: 'menu_item', entity_id: item.id, action: 'delete',
    summary: `Removed ${quote(item.name)} from ${section_title}`, before: item,
  });
  return { ok: true };
}

const idList = (value, what) => {
  if (!Array.isArray(value)) throw bad(`${what} must be a list of ids.`, 'invalid_field');
  const ids = value.map(Number);
  if (ids.some((n) => !Number.isInteger(n)) || new Set(ids).size !== ids.length) throw bad(`${what} must be distinct ids.`, 'invalid_field');
  return ids;
};

/** Writes sort_order = position for each id (shared with History → Restore). */
export function orderStatements(env, table, ids) {
  return ids.map((id, i) => stmt(env, `UPDATE ${table} SET sort_order = ? WHERE id = ?`, [i, id]));
}

/** POST /api/admin/businesses/:slug/menu/reorder { sections: [ids], items: { sectionId: [ids] } } */
export async function reorder(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  const body = await readBody(ctx.request);
  const sections = await all(ctx.env, 'SELECT id FROM menu_sections WHERE business_slug = ? ORDER BY sort_order, id', [business.slug]);
  const sectionIds = new Set(sections.map((s) => s.id));
  const before = { sections: null, items: {} };
  const after = { sections: null, items: {} };
  const statements = [];

  if (body.sections !== undefined) {
    const ids = idList(body.sections, 'sections');
    if (ids.some((id) => !sectionIds.has(id))) throw bad('One of those sections belongs to another business.', 'invalid_field');
    before.sections = sections.map((s) => s.id);
    after.sections = ids;
    statements.push(...orderStatements(ctx.env, 'menu_sections', ids));
  }
  if (body.items !== undefined) {
    if (!body.items || typeof body.items !== 'object' || Array.isArray(body.items)) throw bad('items must map section ids to item id lists.', 'invalid_field');
    for (const [sectionKey, list] of Object.entries(body.items)) {
      const sectionId = Number(sectionKey);
      if (!sectionIds.has(sectionId)) throw bad('One of those sections belongs to another business.', 'invalid_field');
      const ids = idList(list, `items for section ${sectionId}`);
      const current = await all(ctx.env, 'SELECT id FROM menu_items WHERE section_id = ? ORDER BY sort_order, id', [sectionId]);
      const currentIds = new Set(current.map((i) => i.id));
      if (ids.some((id) => !currentIds.has(id))) throw bad(`One of those items is not in section ${sectionId}.`, 'invalid_field');
      before.items[sectionId] = current.map((i) => i.id);
      after.items[sectionId] = ids;
      statements.push(...orderStatements(ctx.env, 'menu_items', ids));
    }
  }
  if (!statements.length) throw bad('Nothing to reorder.', 'nothing_to_change');
  await batch(ctx.env, statements);
  const what = after.sections ? 'the menu sections' : 'menu items';
  await audit(ctx, {
    business_slug: business.slug, entity: 'menu', entity_id: business.slug, action: 'update',
    summary: `Reordered ${what} for ${business.short_name || business.name}`, before, after,
  });
  return { ok: true };
}
