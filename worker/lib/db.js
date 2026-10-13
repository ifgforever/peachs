// Rome's Joy admin Worker: thin D1 helpers.
// Table and column names only ever come from code constants, never from a request; values are always bound.

const bindable = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export const stmt = (env, sql, binds = []) => env.DB.prepare(sql).bind(...binds.map(bindable));
export const first = (env, sql, binds) => stmt(env, sql, binds).first();
export const all = async (env, sql, binds) => (await stmt(env, sql, binds).all()).results;
export const run = (env, sql, binds) => stmt(env, sql, binds).run();
export const batch = (env, statements) => (statements.length ? env.DB.batch(statements) : Promise.resolve([]));

/** INSERT INTO table (...) VALUES (...) → the new row id. */
export async function insertRow(env, table, values) {
  const { meta } = await insertStmt(env, table, values).run();
  return meta.last_row_id;
}

export function insertStmt(env, table, values) {
  const cols = Object.keys(values);
  return stmt(env, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => values[c]));
}

export function updateStmt(env, table, values, whereSql, whereBinds = []) {
  const cols = Object.keys(values);
  return stmt(env, `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${whereSql}`,
    [...cols.map((c) => values[c]), ...whereBinds]);
}

/** UPDATE ... → number of rows changed. */
export async function updateRow(env, table, values, whereSql, whereBinds = []) {
  if (!Object.keys(values).length) return 0;
  const { meta } = await updateStmt(env, table, values, whereSql, whereBinds).run();
  return meta.changes;
}

export function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) → ISO "YYYY-MM-DDTHH:MM:SSZ" so browsers parse it correctly. */
export const isoTime = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
  ? `${s.replace(' ', 'T')}Z` : s);

const TIME_COLUMNS = ['created_at', 'updated_at', 'last_login_at', 'emailed_at', 'expires_at'];
/** Copies a row with its timestamp columns in ISO form. */
export function withIsoTimes(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of TIME_COLUMNS) if (col in out) out[col] = isoTime(out[col]);
  return out;
}

/** Keeps only the listed keys (used before storing a row's "before" state). */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** The current UTC time in SQLite's own "YYYY-MM-DD HH:MM:SS" form, for updated_at columns. */
export const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
