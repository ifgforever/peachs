// Rome's Joy admin Worker: request field validation.
// A spec maps column → rule; readFields() returns clean values ready to bind, or throws a 400.
import { bad } from './http.js';
import { parseDate, timeToMinutes } from './time.js';

export const isDate = (s) => parseDate(s) !== null;
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const isUrl = (s) => typeof s === 'string' && /^(https?:\/\/|mailto:|tel:|\/)[^\s]*$/i.test(s);
export const isSlug = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

const label = (rule, key) => rule.label || key.replace(/_/g, ' ');

function coerce(value, rule, key) {
  const name = label(rule, key);
  const isEmpty = value == null || (typeof value === 'string' && value.trim() === '');
  if (isEmpty && rule.type !== 'bool' && rule.type !== 'list') {
    if (rule.required) throw bad(`${name} is required.`, 'missing_field');
    return null;
  }
  switch (rule.type) {
    case 'text': {
      if (typeof value !== 'string') throw bad(`${name} must be text.`, 'invalid_field');
      const text = value.trim();
      if (text.length > (rule.max || 5000)) throw bad(`${name} is too long (max ${rule.max || 5000} characters).`, 'invalid_field');
      if (rule.oneOf && !rule.oneOf.includes(text)) throw bad(`${name} must be one of: ${rule.oneOf.join(', ')}.`, 'invalid_field');
      return text;
    }
    case 'bool':
      if (isEmpty) return rule.required ? 0 : (rule.default ?? 0);
      if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) ? 1 : 0;
      return value ? 1 : 0;
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n)) throw bad(`${name} must be a whole number.`, 'invalid_field');
      if (rule.min != null && n < rule.min) throw bad(`${name} must be at least ${rule.min}.`, 'invalid_field');
      if (rule.max != null && n > rule.max) throw bad(`${name} must be at most ${rule.max}.`, 'invalid_field');
      return n;
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw bad(`${name} must be a number.`, 'invalid_field');
      if (rule.min != null && n < rule.min) throw bad(`${name} must be at least ${rule.min}.`, 'invalid_field');
      return n;
    }
    case 'date':
      if (!isDate(value)) throw bad(`${name} must be a date like 2026-11-26.`, 'invalid_field');
      return value;
    case 'time':
      if (!isTime(value)) throw bad(`${name} must be a time like 17:30.`, 'invalid_field');
      return value;
    case 'url':
      if (!isUrl(String(value).trim())) throw bad(`${name} must start with http:// or https://.`, 'invalid_field');
      return String(value).trim();
    case 'email':
      if (!isEmail(String(value).trim().toLowerCase())) throw bad(`${name} must be an email address.`, 'invalid_field');
      return String(value).trim().toLowerCase();
    case 'emails': {
      // A comma-separated list (or an array) of inboxes, stored comma-separated.
      const list = (Array.isArray(value) ? value : String(value).split(/[,;\n]/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      for (const e of list) if (!isEmail(e)) throw bad(`"${e}" is not an email address.`, 'invalid_field');
      return list.length ? list.join(', ') : null;
    }
    case 'list': {
      // An array of short strings (tags, allergens, business slugs), stored as JSON text.
      if (isEmpty) return '[]';
      const arr = Array.isArray(value) ? value : String(value).split(',');
      const clean = arr.map((s) => String(s).trim()).filter(Boolean);
      if (clean.length > (rule.max || 50)) throw bad(`${name} has too many entries.`, 'invalid_field');
      for (const s of clean) if (s.length > 80) throw bad(`${name} entries must be short.`, 'invalid_field');
      return JSON.stringify(clean);
    }
    case 'prices': {
      // [{ label, value }] → JSON text, or null.
      if (!Array.isArray(value)) throw bad(`${name} must be a list of { label, value }.`, 'invalid_field');
      const clean = value.map((p) => {
        const l = String(p?.label ?? '').trim();
        const v = Number(p?.value);
        if (!l || !Number.isFinite(v)) throw bad(`${name} entries need a label and a number.`, 'invalid_field');
        return { label: l.slice(0, 80), value: v };
      });
      return clean.length ? JSON.stringify(clean) : null;
    }
    case 'json':
      return JSON.stringify(value);
    default:
      throw new Error(`Unknown rule type ${rule.type}`);
  }
}

/**
 * Picks the spec's keys out of a body. In "create" mode missing keys get their default (or a 400 when
 * required); in "patch" mode only the keys that were sent come back.
 */
export function readFields(body, spec, mode = 'create') {
  if (!body || typeof body !== 'object') throw bad('Missing request body.');
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(body, key);
    if (!present) {
      if (mode === 'create') {
        if (rule.default !== undefined) out[key] = rule.default;
        else if (rule.required) throw bad(`${label(rule, key)} is required.`, 'missing_field');
        else if (rule.type === 'bool') out[key] = 0;
        else if (rule.type === 'list') out[key] = '[]';
      }
      continue;
    }
    out[key] = coerce(body[key], rule, key);
  }
  if (mode === 'patch' && !Object.keys(out).length) throw bad('Nothing to change.', 'nothing_to_change');
  return out;
}

/** "HH:MM" or a minute count → minutes after midnight, for hours rows. */
export function minutesField(value, name) {
  if (value == null || value === '') return null;
  const n = typeof value === 'string' && value.includes(':') ? timeToMinutes(value) : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1440) throw bad(`${name} must be between 0 and 1440 minutes (or HH:MM).`, 'invalid_field');
  return n;
}

/** Validates one { weekday?, closed, open_min, close_min } row. */
export function readHoursRow(row, what = 'Hours') {
  const closed = row.closed === true || row.closed === 1 || row.closed === '1' || row.closed === 'true';
  if (closed) return { closed: 1, open_min: null, close_min: null };
  const open_min = minutesField(row.open_min ?? row.open, `${what} opening time`);
  const close_min = minutesField(row.close_min ?? row.close, `${what} closing time`);
  if (open_min == null || close_min == null) throw bad(`${what} need an opening and closing time, or mark the day closed.`, 'invalid_field');
  if (!(open_min < close_min)) throw bad(`${what}: the closing time must be after the opening time.`, 'invalid_field');
  return { closed: 0, open_min, close_min };
}
