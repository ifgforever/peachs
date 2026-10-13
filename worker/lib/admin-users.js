// Rome's Joy admin Worker: /api/admin/users — staff accounts (owners and admins only).
import { bad, conflict, forbidden, notFound, readBody } from './http.js';
import { all, first, insertRow, pick, run, updateRow } from './db.js';
import { isEmail } from './validate.js';
import { ROLES, allSlugs, checkPasswordStrength, hashPassword, publicUserRow, requireManager } from './auth.js';
import { audit, fieldLabels, listWords } from './audit.js';

export const USER_COLUMNS = ['email', 'name', 'password_hash', 'role', 'businesses_json', 'active', 'must_change_password', 'created_at', 'last_login_at'];

/** Admins may not touch owners (owners may touch anyone). */
function checkRoleReach(actor, role, verb) {
  if (actor.role !== 'owner' && role === 'owner') throw forbidden(`Only an owner can ${verb} an owner.`, 'owner_only');
}

async function readBusinesses(env, value) {
  if (value == null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const slugs = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  const known = new Set(await allSlugs(env));
  for (const s of slugs) if (!known.has(s)) throw bad(`Unknown business "${s}".`, 'unknown_business');
  return slugs;
}

/** True when `row` is the only active owner, so it must stay an active owner. */
export async function isLastActiveOwner(env, row) {
  if (row.role !== 'owner' || !row.active) return false;
  const { n } = await first(env, "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id <> ?", [row.id]);
  return n === 0;
}

const describe = (row) => `${row.role} ${row.email}`;

/** GET /api/admin/users */
export async function list(ctx) {
  requireManager(ctx.user, 'manage users');
  const rows = await all(ctx.env, "SELECT * FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, email");
  return { users: rows.map(publicUserRow) };
}

/** POST /api/admin/users { email, name, role, businesses, password } */
export async function create(ctx) {
  requireManager(ctx.user, 'add users');
  const body = await readBody(ctx.request);
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw bad('Please enter a valid email address.', 'invalid_field');
  const role = ROLES.includes(body.role) ? body.role : 'editor';
  checkRoleReach(ctx.user, role, 'add');
  const businesses = role === 'editor' ? await readBusinesses(ctx.env, body.businesses) : [];
  checkPasswordStrength(body.password);
  if (await first(ctx.env, 'SELECT id FROM users WHERE email = ?', [email])) throw conflict('There is already an account with that email.', 'email_taken');
  const id = await insertRow(ctx.env, 'users', {
    email, name: String(body.name || '').trim().slice(0, 120) || null, password_hash: await hashPassword(body.password),
    role, businesses_json: JSON.stringify(businesses), active: 1, must_change_password: 1,
  });
  const row = await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [id]);
  await audit(ctx, {
    entity: 'user', entity_id: id, action: 'create',
    summary: `Added ${describe(row)}${businesses.length ? ` for ${listWords(businesses)}` : ''}`, after: publicUserRow(row),
  });
  return { user: publicUserRow(row) };
}

async function loadUser(ctx) {
  const row = await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [Number(ctx.params.id) || 0]);
  if (!row) throw notFound('No such user.');
  return row;
}

/** PATCH /api/admin/users/:id { name, role, businesses, active, password } */
export async function patch(ctx) {
  requireManager(ctx.user, 'edit users');
  const row = await loadUser(ctx);
  checkRoleReach(ctx.user, row.role, 'change');
  const body = await readBody(ctx.request);
  const values = {};
  if ('name' in body) values.name = String(body.name || '').trim().slice(0, 120) || null;
  if ('role' in body) {
    if (!ROLES.includes(body.role)) throw bad('role must be owner, admin or editor.', 'invalid_field');
    checkRoleReach(ctx.user, body.role, 'promote someone to');
    values.role = body.role;
  }
  if ('businesses' in body) values.businesses_json = JSON.stringify(await readBusinesses(ctx.env, body.businesses));
  if ('active' in body) values.active = body.active && body.active !== 'false' && body.active !== '0' ? 1 : 0;
  if ('password' in body && body.password != null && body.password !== '') {
    checkPasswordStrength(body.password);
    values.password_hash = await hashPassword(body.password);
    values.must_change_password = row.id === ctx.user.id ? 0 : 1;
  }
  const losesOwner = (values.role && values.role !== 'owner') || values.active === 0;
  if (losesOwner && await isLastActiveOwner(ctx.env, row)) throw conflict('There must always be one active owner.', 'last_owner');

  const changed = Object.keys(values).filter((k) => k !== 'must_change_password' && JSON.stringify(row[k]) !== JSON.stringify(values[k]));
  if (!changed.length) return { user: publicUserRow(row) };
  await updateRow(ctx.env, 'users', pick(values, [...changed, ...(values.must_change_password != null ? ['must_change_password'] : [])]), 'id = ?', [row.id]);
  // A reset password, a changed role or a deactivation ends the person's other sessions: whoever holds an
  // old token (a lost phone, say) has to sign in again with the new password.
  if (values.active === 0 || changed.includes('password_hash') || changed.includes('role')) {
    await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ? AND token <> ?', [row.id, ctx.user.session]);
  }

  let summary;
  if (changed.includes('password_hash')) summary = `Reset the password of ${row.email}`;
  else if (changed.includes('active')) summary = `${values.active ? 'Reactivated' : 'Deactivated'} ${describe(row)}`;
  else summary = `Changed ${fieldLabels(changed)} of ${describe(row)}`;
  const safe = (r) => { const { password_hash, ...rest } = r; return rest; };
  await audit(ctx, {
    entity: 'user', entity_id: row.id, action: 'update', summary,
    before: safe(pick(row, changed)), after: safe(pick(values, changed)),
  });
  return { user: publicUserRow(await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [row.id])) };
}

/** DELETE /api/admin/users/:id */
export async function remove(ctx) {
  requireManager(ctx.user, 'remove users');
  const row = await loadUser(ctx);
  checkRoleReach(ctx.user, row.role, 'remove');
  if (row.id === ctx.user.id) throw bad('You cannot remove your own account.', 'cannot_delete_self');
  if (await isLastActiveOwner(ctx.env, row)) throw conflict('There must always be one active owner.', 'last_owner');
  await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ?', [row.id]);
  await run(ctx.env, 'DELETE FROM users WHERE id = ?', [row.id]);
  // The full row (hash included) is kept so Restore can bring the account back; the history API redacts it.
  await audit(ctx, { entity: 'user', entity_id: row.id, action: 'delete', summary: `Removed ${describe(row)}`, before: row });
  return { ok: true };
}
