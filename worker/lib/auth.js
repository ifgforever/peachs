// Rome's Joy admin Worker: passwords, sessions, permissions and the /api/auth/* routes.
import { ApiError, bad, forbidden, notFound, readBody, tooMany, unauthorized } from './http.js';
import { all, first, insertRow, isoTime, parseJson, run, updateRow } from './db.js';
import { isEmail } from './validate.js';
import { audit } from './audit.js';

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;
const MAX_LOGIN_TRIES = 10;        // failures from one IP in 15 minutes
const MAX_EMAIL_TRIES = 50;        // failures for one email in 15 minutes, from anywhere
const MAX_BOOTSTRAP_TRIES = { ip: 5, all: 20 }; // wrong setup tokens per hour: per IP, and in total
const BOOTSTRAP_MARK = '#bootstrap'; // login_attempts.email for bootstrap failures (never a real address)
export const ROLES = ['owner', 'admin', 'editor'];

/* -------------------------------------------------------------------------
   Passwords: PBKDF2-SHA256, 100,000 iterations, 16-byte salt → "base64(salt):base64(hash)"
   ------------------------------------------------------------------------- */
const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${toBase64(salt)}:${toBase64(await derive(password, salt))}`;
}

export async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = String(stored || '').split(':');
  if (!saltB64 || !hashB64) return false;
  const expected = fromBase64(hashB64);
  const actual = new Uint8Array(await derive(password, fromBase64(saltB64)));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]; // constant time
  return diff === 0;
}

/** SHA-256 of a string as lower-case hex. */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings without leaking where they differ (both are hashed first, so lengths match). */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw bad(`Passwords need at least ${MIN_PASSWORD} characters.`, 'weak_password');
  }
  if (password.length > 200) throw bad('That password is too long.', 'weak_password');
}

/* -------------------------------------------------------------------------
   Sessions (bearer tokens, 30 days). The client keeps the raw token; the table only holds its SHA-256,
   so a copy of the database cannot be used to sign in.
   ------------------------------------------------------------------------- */
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sessionKey = (token) => sha256Hex(token);

export async function createSession(env, userId) {
  const token = newToken();
  await run(env, `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`, [await sessionKey(token), userId]);
  return token;
}

/** Housekeeping that piggybacks on logins: expired sessions and stale login attempts go away. */
async function prune(env) {
  await run(env, "DELETE FROM sessions WHERE expires_at <= datetime('now')");
  await run(env, "DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')");
}

export const allSlugs = async (env) => (await all(env, 'SELECT slug FROM businesses ORDER BY sort_order, slug')).map((r) => r.slug);

/** The public shape of a user: { id, email, name, role, businesses, must_change_password }. */
export function shapeUser(row, slugs) {
  const stored = parseJson(row.businesses_json, []);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    businesses: row.role === 'editor' ? stored : slugs,
    must_change_password: Boolean(row.must_change_password),
  };
}

/** Loads the user for the bearer token (ignoring expired sessions) or throws 401. */
export async function authenticate(ctx) {
  const header = ctx.request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  const key = await sessionKey(token);
  const row = await first(ctx.env, `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`, [key]);
  if (!row) throw unauthorized('Your session has expired. Please log in again.');
  ctx.user = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    businesses: parseJson(row.businesses_json, []),
    must_change_password: Boolean(row.must_change_password),
    session: key, // the sessions.token value of this request, for "every session but this one"
  };
  return ctx.user;
}

/** Wraps an admin handler so it runs only for a logged-in user. */
export const admin = (handler) => async (ctx) => { await authenticate(ctx); return handler(ctx); };

/* -------------------------------------------------------------------------
   Permissions
   ------------------------------------------------------------------------- */
export const isManager = (user) => user.role === 'owner' || user.role === 'admin';
export const canEdit = (user, slug) => isManager(user) || user.businesses.includes(slug);

export function requireManager(user, what = 'do that') {
  if (!isManager(user)) throw forbidden(`Only owners and admins can ${what}.`);
}

export function assertCanEdit(user, slug) {
  if (!canEdit(user, slug)) throw forbidden('You can only edit the businesses assigned to you.');
}

/** Loads a business the current user may edit (404 unknown, 403 not theirs). */
export async function requireBusiness(ctx, slug) {
  const business = await first(ctx.env, 'SELECT * FROM businesses WHERE slug = ?', [slug]);
  if (!business) throw notFound('No such business.', 'unknown_business');
  assertCanEdit(ctx.user, slug);
  return business;
}

/* -------------------------------------------------------------------------
   Routes
   ------------------------------------------------------------------------- */
export const emailConfigured = (env) => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);

export async function status(ctx) {
  const { n } = await first(ctx.env, 'SELECT COUNT(*) AS n FROM users');
  return { has_users: n > 0, email_configured: emailConfigured(ctx.env), media_configured: Boolean(ctx.env.MEDIA) };
}

export async function bootstrap(ctx) {
  const body = await readBody(ctx.request);
  const expected = ctx.env.ADMIN_BOOTSTRAP_TOKEN;
  const { n } = await first(ctx.env, 'SELECT COUNT(*) AS n FROM users');
  if (n > 0 || !expected) throw forbidden('Bootstrap is not available.', 'bootstrap_disabled');
  // The token can only be guessed while no account exists, so wrong guesses are counted and capped hard.
  const tries = await first(ctx.env, `SELECT COUNT(*) AS all_tries, SUM(ip = ?) AS ip_tries FROM login_attempts
    WHERE email = ? AND created_at > datetime('now', '-1 hour')`, [ctx.ip, BOOTSTRAP_MARK]);
  if ((tries.ip_tries || 0) >= MAX_BOOTSTRAP_TRIES.ip || tries.all_tries >= MAX_BOOTSTRAP_TRIES.all) {
    throw tooMany('Too many setup attempts. Please wait an hour and try again.');
  }
  if (typeof body.token !== 'string' || !(await sameSecret(body.token, expected))) {
    await run(ctx.env, 'INSERT INTO login_attempts (email, ip) VALUES (?, ?)', [BOOTSTRAP_MARK, ctx.ip]);
    throw forbidden('Bootstrap is not available.', 'bootstrap_disabled');
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw bad('Please enter a valid email address.', 'invalid_field');
  checkPasswordStrength(body.password);
  const name = String(body.name || '').trim().slice(0, 120) || null;
  const id = await insertRow(ctx.env, 'users', {
    email, name, password_hash: await hashPassword(body.password), role: 'owner', businesses_json: '[]',
  });
  await run(ctx.env, "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [id]);
  const row = await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [id]);
  ctx.user = { id, email, name, role: 'owner', businesses: [] };
  await audit(ctx, { entity: 'user', entity_id: id, action: 'create', summary: `Created the first owner account, ${email}`, after: publicUserRow(row) });
  const token = await createSession(ctx.env, id);
  return { token, user: shapeUser(row, await allSlugs(ctx.env)) };
}

export async function login(ctx) {
  const body = await readBody(ctx.request);
  const email = String(body.email || '').trim().toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw bad('Email and password are required.', 'missing_field');
  // Brute force is stopped per IP. The per-email cap is much looser so that someone who knows a staff
  // address cannot lock that person out from elsewhere; a successful login clears the email's failures.
  const tries = await first(ctx.env, `SELECT SUM(ip = ?) AS by_ip, SUM(email = ?) AS by_email FROM login_attempts
    WHERE created_at > datetime('now', '-15 minutes') AND (email = ? OR ip = ?)`, [ctx.ip, email, email, ctx.ip]);
  if ((tries.by_ip || 0) >= MAX_LOGIN_TRIES || (tries.by_email || 0) >= MAX_EMAIL_TRIES) {
    throw tooMany('Too many login attempts. Please wait 15 minutes and try again.');
  }
  const row = await first(ctx.env, 'SELECT * FROM users WHERE email = ?', [email]);
  const ok = row && row.active && await verifyPassword(password, row.password_hash);
  if (!ok) {
    await run(ctx.env, 'INSERT INTO login_attempts (email, ip) VALUES (?, ?)', [email, ctx.ip]);
    throw new ApiError(401, 'invalid_credentials', 'That email and password do not match.');
  }
  await run(ctx.env, 'DELETE FROM login_attempts WHERE email = ?', [email]);
  await prune(ctx.env);
  await run(ctx.env, "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [row.id]);
  const token = await createSession(ctx.env, row.id);
  return { token, user: shapeUser(row, await allSlugs(ctx.env)) };
}

export async function logout(ctx) {
  await authenticate(ctx);
  await run(ctx.env, 'DELETE FROM sessions WHERE token = ?', [ctx.user.session]);
  return { ok: true };
}

export async function me(ctx) {
  await authenticate(ctx);
  const row = await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  return { user: shapeUser(row, await allSlugs(ctx.env)) };
}

export async function changePassword(ctx) {
  await authenticate(ctx);
  const body = await readBody(ctx.request);
  const row = await first(ctx.env, 'SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  if (!(await verifyPassword(String(body.current_password ?? ''), row.password_hash))) {
    throw bad('Your current password is not right.', 'wrong_password');
  }
  checkPasswordStrength(body.new_password);
  await updateRow(ctx.env, 'users', { password_hash: await hashPassword(body.new_password), must_change_password: 0 }, 'id = ?', [row.id]);
  // Other devices have to log in again with the new password.
  await run(ctx.env, 'DELETE FROM sessions WHERE user_id = ? AND token <> ?', [row.id, ctx.user.session]);
  await audit(ctx, {
    entity: 'user', entity_id: row.id, action: 'update', summary: `${row.email} changed their password`,
    before: { must_change_password: Boolean(row.must_change_password) }, after: { must_change_password: false },
  });
  return { ok: true };
}

/** A users row without its password hash, for audit entries and the users page. */
export function publicUserRow(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return { ...rest, businesses: parseJson(row.businesses_json, []), active: Boolean(row.active),
    must_change_password: Boolean(row.must_change_password), created_at: isoTime(row.created_at), last_login_at: isoTime(row.last_login_at) };
}
