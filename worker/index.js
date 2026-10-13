// Rome's Joy admin: the Cloudflare Worker behind every site and the in-store screens.
// It only handles /api/* (see wrangler.jsonc); everything else is served from the static files.
// The contract is docs/admin-api.md; the database is worker/schema.sql.
import { createRouter } from './lib/router.js';
import { ApiError, clientIp, json } from './lib/http.js';
import { chicagoNow } from './lib/time.js';
import * as auth from './lib/auth.js';
import * as pub from './lib/public.js';
import * as forms from './lib/forms.js';
import * as businesses from './lib/admin-businesses.js';
import * as events from './lib/admin-events.js';
import * as menu from './lib/admin-menu.js';
import * as announcements from './lib/admin-announcements.js';
import * as inquiries from './lib/admin-inquiries.js';
import * as history from './lib/admin-history.js';
import * as users from './lib/admin-users.js';
import * as settings from './lib/admin-settings.js';

const { admin } = auth;
const router = createRouter();

/* ---------- Public: no login, any origin, cached for a minute ---------- */
router.get('/api/public/businesses', pub.businesses);
router.get('/api/public/signage/:slug', pub.signage);
router.get('/api/public/:slug', pub.bundle);
router.post('/api/forms/:slug/:type', forms.submit);
router.get('/api/media/*', settings.serve);

/* ---------- Auth ---------- */
router.get('/api/auth/status', auth.status);
router.post('/api/auth/bootstrap', auth.bootstrap);
router.post('/api/auth/login', auth.login);
router.post('/api/auth/logout', auth.logout);
router.get('/api/auth/me', auth.me);
router.post('/api/auth/change-password', auth.changePassword);

/* ---------- Admin: businesses and hours ---------- */
router.get('/api/admin/businesses', admin(businesses.list));
router.get('/api/admin/businesses/:slug', admin(businesses.get));
router.patch('/api/admin/businesses/:slug', admin(businesses.patch));
router.put('/api/admin/businesses/:slug/hours', admin(businesses.putHours));
router.get('/api/admin/businesses/:slug/hours/exceptions', admin(businesses.listExceptions));
router.post('/api/admin/businesses/:slug/hours/exceptions', admin(businesses.createException));
router.delete('/api/admin/hours/exceptions/:id', admin(businesses.deleteException));

/* ---------- Admin: events ---------- */
router.get('/api/admin/businesses/:slug/events', admin(events.list));
router.post('/api/admin/businesses/:slug/events', admin(events.create));
router.patch('/api/admin/events/:id', admin(events.patch));
router.delete('/api/admin/events/:id', admin(events.remove));

/* ---------- Admin: menu ---------- */
router.get('/api/admin/businesses/:slug/menu', admin(menu.list));
router.post('/api/admin/businesses/:slug/menu/sections', admin(menu.createSection));
router.post('/api/admin/businesses/:slug/menu/reorder', admin(menu.reorder));
router.patch('/api/admin/menu/sections/:id', admin(menu.patchSection));
router.delete('/api/admin/menu/sections/:id', admin(menu.deleteSection));
router.post('/api/admin/menu/sections/:id/items', admin(menu.createItem));
router.patch('/api/admin/menu/items/:id', admin(menu.patchItem));
router.delete('/api/admin/menu/items/:id', admin(menu.deleteItem));

/* ---------- Admin: announcements ---------- */
router.get('/api/admin/businesses/:slug/announcements', admin(announcements.listBusiness));
router.post('/api/admin/businesses/:slug/announcements', admin(announcements.createBusiness));
router.get('/api/admin/announcements', admin(announcements.listFamily));
router.post('/api/admin/announcements', admin(announcements.createFamily));
router.patch('/api/admin/announcements/:id', admin(announcements.patch));
router.delete('/api/admin/announcements/:id', admin(announcements.remove));

/* ---------- Admin: inquiries ---------- */
router.get('/api/admin/businesses/:slug/inquiries', admin(inquiries.list));
router.get('/api/admin/inquiries/:id', admin(inquiries.get));
router.patch('/api/admin/inquiries/:id', admin(inquiries.patch));
router.post('/api/admin/inquiries/:id/resend', admin(inquiries.resend));

/* ---------- Admin: history ---------- */
router.get('/api/admin/businesses/:slug/history', admin(history.listBusiness));
router.get('/api/admin/history', admin(history.listAll));
router.get('/api/admin/history/:id', admin(history.get));
router.post('/api/admin/history/:id/restore', admin(history.restore));

/* ---------- Admin: users, settings, media ---------- */
router.get('/api/admin/users', admin(users.list));
router.post('/api/admin/users', admin(users.create));
router.patch('/api/admin/users/:id', admin(users.patch));
router.delete('/api/admin/users/:id', admin(users.remove));
router.get('/api/admin/settings/:key', admin(settings.get));
router.put('/api/admin/settings/:key', admin(settings.put));
router.post('/api/admin/media', admin(settings.upload));

/* -------------------------------------------------------------------------
   CORS: public and form routes allow any origin; admin routes echo the caller's origin.
   Only bearer tokens are used (no cookies), so credentials are never allowed.
   ------------------------------------------------------------------------- */
const OPEN_PREFIXES = ['/api/public/', '/api/forms/', '/api/media/'];

function corsHeaders(request, pathname) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  const origin = request.headers.get('Origin');
  if (OPEN_PREFIXES.some((p) => pathname.startsWith(p))) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

/** Turns anything thrown by a handler into { error, code } JSON. */
function errorResponse(err) {
  if (err instanceof ApiError) return json({ error: err.message, code: err.code }, err.status);
  const message = String(err?.message || err);
  if (/UNIQUE constraint/i.test(message)) return json({ error: 'That already exists.', code: 'conflict' }, 409);
  if (/FOREIGN KEY constraint/i.test(message)) return json({ error: 'That refers to something that no longer exists.', code: 'conflict' }, 409);
  if (/no such table/i.test(message)) return json({ error: 'The database is not set up yet. Run worker/schema.sql.', code: 'database_missing' }, 500);
  console.error('Unhandled error:', err);
  return json({ error: 'Something went wrong on our side.', code: 'internal' }, 500);
}

async function handle(request, env, executionCtx, url) {
  const match = router.match(request.method === 'HEAD' ? 'GET' : request.method, url.pathname);
  if (!match) throw new ApiError(404, 'not_found', 'No such API route.');
  if (match.methodMismatch) throw new ApiError(405, 'method_not_allowed', `${request.method} is not allowed here.`);
  const ctx = {
    request, env, url, params: match.params, ip: clientIp(request), now: chicagoNow(), user: null,
    waitUntil: (promise) => executionCtx?.waitUntil?.(promise),
  };
  const result = await match.handler(ctx);
  return result instanceof Response ? result : json(result);
}

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    const cors = corsHeaders(request, url.pathname);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let response;
    try {
      response = await handle(request, env, executionCtx, url);
    } catch (err) {
      response = errorResponse(err);
    }
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store');
    out.headers.set('X-Content-Type-Options', 'nosniff');
    return out;
  },
};
