// Rome's Joy admin Worker: /api/admin history — who changed what, and "Restore".
// Restore puts the `before` state back for update and delete entries (recreating a deleted row with its
// original id) and removes the row for create entries. Each restore writes its own entry.
import { bad, conflict, forbidden, idParam, intParam, notFound } from './http.js';
import { all, batch, first, insertStmt, isoTime, parseJson, pick, run, updateRow } from './db.js';
import { assertCanEdit, requireBusiness, requireManager } from './auth.js';
import { audit } from './audit.js';
import { BUSINESS_EDITABLE, saveHours } from './admin-businesses.js';
import { EVENT_COLUMNS } from './admin-events.js';
import { ITEM_COLUMNS, SECTION_COLUMNS, orderStatements } from './admin-menu.js';
import { ANNOUNCEMENT_COLUMNS } from './admin-announcements.js';
import { USER_COLUMNS, isLastActiveOwner } from './admin-users.js';
import { writeSetting } from './admin-settings.js';

const EXCEPTION_COLUMNS = ['business_slug', 'date', 'closed', 'open_min', 'close_min', 'label'];
const INQUIRY_COLUMNS = ['status', 'emailed_at', 'email_error'];

/* -------------------------------------------------------------------------
   Restorers: (ctx, entry, before, after) → the state being replaced, for the restore entry
   ------------------------------------------------------------------------- */
const missing = () => conflict('That item no longer exists, so there is nothing to restore it onto.', 'restore_target_missing');
const alreadyBack = () => conflict('That item already exists again.', 'restore_conflict');

async function recreate(ctx, table, values) {
  try {
    await insertStmt(ctx.env, table, values).run();
  } catch (err) {
    const why = /FOREIGN KEY/i.test(err.message) ? 'what it belonged to is gone' : /UNIQUE/i.test(err.message) ? 'something else now uses its place' : err.message;
    throw conflict(`It could not be recreated: ${why}.`, 'restore_conflict');
  }
}

/** The common case: a table with an integer id and a known set of columns. */
function tableRestorer(table, columns, hooks = {}) {
  return async (ctx, entry, before, after) => {
    const id = Number(entry.entity_id);
    const current = await first(ctx.env, `SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (hooks.check) await hooks.check(ctx, entry, current, before);
    if (entry.action === 'update') {
      if (!current) throw missing();
      const values = pick(before || {}, columns);
      if (!Object.keys(values).length) throw bad('There is nothing to restore in this entry.', 'not_restorable');
      await updateRow(ctx.env, table, values, 'id = ?', [id]);
      return pick(current, Object.keys(values));
    }
    if (entry.action === 'delete') {
      if (current) throw alreadyBack();
      await recreate(ctx, table, { id, ...pick(before || {}, columns) });
      if (hooks.afterRecreate) await hooks.afterRecreate(ctx, before);
      return null;
    }
    if (!current) throw conflict('That item was already removed.', 'restore_target_missing');
    const snapshot = hooks.beforeRemove ? await hooks.beforeRemove(ctx, current) : current;
    await run(ctx.env, `DELETE FROM ${table} WHERE id = ?`, [id]);
    return snapshot;
  };
}

const RESTORERS = {
  async business(ctx, entry, before) {
    if (entry.action !== 'update') throw bad('Businesses can only be restored from an update.', 'not_restorable');
    const current = await first(ctx.env, 'SELECT * FROM businesses WHERE slug = ?', [entry.entity_id]);
    if (!current) throw missing();
    const values = pick(before || {}, BUSINESS_EDITABLE);
    if (!Object.keys(values).length) throw bad('There is nothing to restore in this entry.', 'not_restorable');
    await updateRow(ctx.env, 'businesses', values, 'slug = ?', [entry.entity_id]);
    return pick(current, Object.keys(values));
  },

  async hours(ctx, entry, before) {
    if (entry.action !== 'update' || !Array.isArray(before)) throw bad('Hours can only be restored from an update.', 'not_restorable');
    const current = await all(ctx.env, 'SELECT weekday, closed, open_min, close_min FROM hours WHERE business_slug = ? ORDER BY weekday', [entry.entity_id]);
    await saveHours(ctx.env, entry.entity_id, before);
    return current;
  },

  hours_exception: tableRestorer('hours_exceptions', EXCEPTION_COLUMNS),
  event: tableRestorer('events', EVENT_COLUMNS),
  announcement: tableRestorer('announcements', ANNOUNCEMENT_COLUMNS),
  inquiry: tableRestorer('inquiries', INQUIRY_COLUMNS),

  menu_section: tableRestorer('menu_sections', SECTION_COLUMNS, {
    // A deleted section comes back with its items; removing a created section takes its items along.
    async afterRecreate(ctx, before) {
      const items = Array.isArray(before?.items) ? before.items : [];
      for (const item of items) await recreate(ctx, 'menu_items', { id: item.id, ...pick(item, ITEM_COLUMNS) });
    },
    async beforeRemove(ctx, current) {
      const items = await all(ctx.env, 'SELECT * FROM menu_items WHERE section_id = ?', [current.id]);
      await run(ctx.env, 'DELETE FROM menu_items WHERE section_id = ?', [current.id]);
      return { ...current, items };
    },
  }),
  menu_item: tableRestorer('menu_items', ITEM_COLUMNS),

  async menu(ctx, entry, before) {
    if (entry.action !== 'update' || !before) throw bad('Menu order can only be restored from a reorder.', 'not_restorable');
    const statements = [];
    const snapshot = { sections: null, items: {} };
    if (Array.isArray(before.sections)) {
      const current = await all(ctx.env, 'SELECT id FROM menu_sections WHERE business_slug = ? ORDER BY sort_order, id', [entry.entity_id]);
      snapshot.sections = current.map((s) => s.id);
      statements.push(...orderStatements(ctx.env, 'menu_sections', before.sections));
    }
    for (const [sectionId, ids] of Object.entries(before.items || {})) {
      const current = await all(ctx.env, 'SELECT id FROM menu_items WHERE section_id = ? ORDER BY sort_order, id', [Number(sectionId)]);
      snapshot.items[sectionId] = current.map((i) => i.id);
      if (Array.isArray(ids)) statements.push(...orderStatements(ctx.env, 'menu_items', ids));
    }
    await batch(ctx.env, statements);
    return snapshot;
  },

  user: tableRestorer('users', USER_COLUMNS, {
    async check(ctx, entry, current, before) {
      requireManager(ctx.user, 'restore user changes');
      const touchesOwner = current?.role === 'owner' || before?.role === 'owner';
      if (touchesOwner && ctx.user.role !== 'owner') throw forbidden('Only an owner can restore changes to an owner.', 'owner_only');
      const removes = entry.action === 'create';
      const demotes = entry.action === 'update' && current && ((before?.role && before.role !== 'owner') || before?.active === 0 || before?.active === false);
      if ((removes || demotes) && current && await isLastActiveOwner(ctx.env, current)) throw conflict('There must always be one active owner.', 'last_owner');
      if (removes && current?.id === ctx.user.id) throw bad('You cannot remove your own account.', 'cannot_delete_self');
    },
    async beforeRemove(ctx, current) {
      await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ?', [current.id]);
      return current;
    },
  }),

  async settings(ctx, entry, before) {
    if (entry.action !== 'update') throw bad('Settings can only be restored from an update.', 'not_restorable');
    const current = await first(ctx.env, 'SELECT value_json FROM settings WHERE key = ?', [entry.entity_id]);
    await writeSetting(ctx.env, entry.entity_id, before);
    return current ? parseJson(current.value_json, null) : null;
  },
};

const canRestore = (row) => row.action !== 'restore' && row.entity in RESTORERS
  && (row.action === 'create' ? row.entity_id != null : row.before_json != null);

/** Strips password hashes out of stored rows before they leave the API. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'password_hash' ? '[hidden]' : redact(v);
    return out;
  }
  return value;
}

export function shapeEntry(row) {
  return {
    id: row.id,
    user_email: row.user_email,
    business_slug: row.business_slug,
    entity: row.entity,
    entity_id: row.entity_id,
    action: row.action,
    summary: row.summary,
    created_at: isoTime(row.created_at),
    can_restore: canRestore(row),
  };
}

async function page(ctx, whereSql, binds) {
  const limit = intParam(ctx.url, 'limit', 50);
  const before = idParam(ctx.url, 'before');
  const where = [whereSql, before ? 'id < ?' : null].filter(Boolean).join(' AND ');
  const rows = await all(ctx.env, `SELECT * FROM audit_log${where ? ` WHERE ${where}` : ''} ORDER BY id DESC LIMIT ?`, [...binds, ...(before ? [before] : []), limit]);
  return { entries: rows.map(shapeEntry) };
}

/** GET /api/admin/businesses/:slug/history */
export async function listBusiness(ctx) {
  const business = await requireBusiness(ctx, ctx.params.slug);
  return page(ctx, 'business_slug = ?', [business.slug]);
}

/** GET /api/admin/history — everything (owner/admin). */
export async function listAll(ctx) {
  requireManager(ctx.user, 'see the full history');
  return page(ctx, '', []);
}

async function loadEntry(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM audit_log WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such history entry.');
  if (row.business_slug) assertCanEdit(ctx.user, row.business_slug);
  else requireManager(ctx.user, 'see family-wide history');
  return row;
}

/** GET /api/admin/history/:id — the entry with before_json and after_json parsed (also as before / after). */
export async function get(ctx) {
  const row = await loadEntry(ctx);
  const before = redact(parseJson(row.before_json, null));
  const after = redact(parseJson(row.after_json, null));
  const entry = { ...shapeEntry(row), before, after, before_json: before, after_json: after };
  return { ...entry, entry };
}

/** POST /api/admin/history/:id/restore */
export async function restore(ctx) {
  const row = await loadEntry(ctx);
  if (!canRestore(row)) throw bad('This entry cannot be restored.', 'not_restorable');
  const before = parseJson(row.before_json, null);
  const after = parseJson(row.after_json, null);
  const replaced = await RESTORERS[row.entity](ctx, row, before, after);
  await audit(ctx, {
    business_slug: row.business_slug, entity: row.entity, entity_id: row.entity_id, action: 'restore',
    summary: `Undid "${row.summary}"`, before: replaced, after: row.action === 'create' ? null : before,
  });
  return { ok: true };
}
