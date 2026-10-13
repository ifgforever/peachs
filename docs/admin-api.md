# Rome's Joy admin: API contract

One Cloudflare Worker (`worker/index.js`) with a D1 database (`worker/schema.sql`) is the single source of truth for every site and the in-store screens. The same Worker serves the static sites as assets; it only handles paths under `/api/`.

- Public routes need no login, allow any origin (`Access-Control-Allow-Origin: *`), and are cacheable (`Cache-Control: public, max-age=60`).
- Admin routes need `Authorization: Bearer <session token>`. Tokens come from `POST /api/auth/login` and last 30 days.
- Every response is JSON. Errors look like `{ "error": "message", "code": "short_code" }` with a sensible HTTP status (400 bad input, 401 not logged in, 403 not allowed, 404 missing, 409 conflict, 429 too many tries, 501 not configured).
- Dates are `YYYY-MM-DD`, times of day are `HH:MM` (24-hour), weekdays are `0`–`6` with `0 = Sunday`, and "now" is always America/Chicago.
- Every admin write records a row in `audit_log` with `before_json` and `after_json`.

## Bindings and secrets

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 | the database |
| `ASSETS` | static assets | the sites (the Worker only runs for `/api/*`, see `wrangler.jsonc`) |
| `MEDIA` | R2 (optional) | photo uploads; without it, `POST /api/admin/media` returns 501 and the admin shows a URL field |
| `ADMIN_BOOTSTRAP_TOKEN` | secret | one-time token to create the first owner account |
| `RESEND_API_KEY`, `EMAIL_FROM` | secrets (optional) | outgoing email via Resend; without them inquiries are saved but not emailed |
| `PUBLIC_BASE_URL` | var (optional) | used in emails to link back to the admin |

Local dev reads secrets from `.dev.vars` (never committed); see `.dev.vars.example`.

## Public

### `GET /api/public/businesses`
`{ "businesses": [ { slug, name, short_name, tagline, phone, phone_href, address: {...}, hours_summary, open_now }, ... ] }` ordered by `sort_order`.

### `GET /api/public/:slug`
The bundle a site renders from:

```json
{
  "generated_at": "2026-10-13T15:00:00Z",
  "today": { "date": "2026-10-13", "weekday": 2 },
  "business": {
    "slug": "peachs", "name": "Peach's on 47th", "short_name": "Peach's", "tagline": "...", "description": "...",
    "address": { "line1": "4652 S. King Drive", "line2": null, "city": "Chicago", "state": "IL", "zip": "60653",
                 "formatted": "4652 S. King Drive, Chicago, IL 60653" },
    "phone": "773.966.5801", "phone_href": "tel:+17739665801",
    "public_email": "...", "website_url": "...", "instagram_url": "...", "facebook_url": "...",
    "map_url": "...", "order_url": "...", "book_url": "...", "hours_note": null,
    "notice": { "text": "Closed Thanksgiving Day", "until": "2026-11-27" }
  },
  "hours": [
    { "weekday": 1, "label": "Monday", "short": "Mon", "closed": true,  "open_min": null, "close_min": null, "open": null, "close": null, "text": "Closed" },
    { "weekday": 3, "label": "Wednesday", "short": "Wed", "closed": false, "open_min": 480, "close_min": 840, "open": "8 am", "close": "2 pm", "text": "8 am – 2 pm" }
  ],
  "hours_summary": "Wed – Sun · 8 am – 2 pm",
  "exceptions": [ { "date": "2026-11-26", "closed": true, "open": null, "close": null, "label": "Thanksgiving" } ],
  "open_now": { "open": true, "text": "Open now · until 2 pm", "checked_at": "2026-10-13T15:00:00Z" },
  "announcements": [ { "id": 1, "title": "...", "body": "...", "link_url": "...", "link_label": "...", "image_url": null, "starts_at": "...", "ends_at": null } ],
  "events": {
    "current":  [ { "id": 7, "kind": "exhibition", "title": "...", "subtitle": "...", "description": "...",
                    "start_date": "2026-10-24", "end_date": "2026-12-05", "start_time": null, "end_time": null,
                    "date_text": "Oct 24 – Dec 5, 2026", "time_text": null, "location": "...",
                    "link_url": "...", "link_label": "...", "image_url": null, "featured": true, "status": "current" } ],
    "upcoming": [], "past": []
  },
  "menu": {
    "sections": [ { "id": 1, "title": "Peach's Plates", "short_title": "Plates", "description": null,
                    "items": [ { "id": 10, "name": "...", "portion": null, "price": 23, "prices": null, "description": "...",
                                 "tags": ["GF","V"], "allergens": [], "featured": false } ] } ]
  },
  "dietary": { "GF": "Gluten free", "V": "Vegetarian", "DF": "Dairy free" }
}
```

Rules:
- `hours` is ordered Monday → Sunday (weekdays 1,2,3,4,5,6,0). `text` is ready to print.
- `hours_summary` groups consecutive days with identical hours ("Mon – Fri · 8:30 am – 5 pm", "Sat & Sun · 11 am – 3 pm").
- `exceptions` lists only today and the next 60 days.
- `open_now` applies today's exception first, then the weekly hours. `text` is one of: `Open now · until 2 pm`, `Closed · opens today 8 am`, `Closed · opens Wed 8 am`, `Closed today`.
- `announcements`: `published = 1`, `starts_at <= today`, and (`ends_at IS NULL` or `ends_at >= today`), newest first. Business-specific ones plus family-wide ones (`business_slug IS NULL`).
- `events`: `published = 1` only. `status` = `past` when the last day (`end_date` or `start_date`) is before today; `upcoming` when `start_date` is after today; otherwise `current`. `past` holds the 20 most recent. `upcoming` and `current` are sorted by `start_date` ascending, `past` descending. `date_text` examples: `Oct 24, 2026`, `Oct 24 – Dec 5, 2026`, `Dec 28, 2026 – Jan 4, 2027`. `time_text` examples: `5–8 pm`, `11 am – 3 pm`, `7 pm`.
- `menu`: published sections with `available = 1` items only, in `sort_order`. `prices` is the parsed `prices_json` or `null`.
- `notice` is `null` when there is no notice or `notice_until` has passed.

### `GET /api/public/signage/:slug`
The same bundle plus `"signage": { ...settings["signage:<slug>"] or {} }` and `"family": [ { slug, name, tagline, hours_summary } ]` for every business.

### `POST /api/forms/:slug/:type`
Accepts JSON or `application/x-www-form-urlencoded` (so a plain HTML `<form>` works). Fields: `name`, `email`, `phone`, `message`, any others (stored in `fields_json`), and the honeypot `website` (must be empty). `:type` is a short word like `contact`, `quote`, `event`, `wholesale`, `apply`.

- Saves an `inquiries` row, then emails every address in the business's `inquiry_emails` (if email is configured) and records `emailed_at` or `email_error`.
- Returns `{ "ok": true, "id": 123, "emailed": true }`. If the request had `_redirect` (a same-site path) and was form-encoded, respond `303` to it instead.
- Rejects: honeypot filled (returns `{ok:true}` silently), missing `message` and `email` both, any field over 5,000 characters, more than 20 fields, unknown business, or more than 10 submissions from one IP in 10 minutes (429).

## Auth

- `GET /api/auth/status` → `{ "has_users": true, "email_configured": false, "media_configured": false }` (no login needed). The admin shows the bootstrap screen when `has_users` is false.
- `POST /api/auth/bootstrap` `{ token, email, password, name }` → creates the first `owner` and returns `{ token, user }`. Only works while there are zero users and `token` equals `ADMIN_BOOTSTRAP_TOKEN`; otherwise 403.
- `POST /api/auth/login` `{ email, password }` → `{ token, user }`. After 10 failed tries for an email or IP in 15 minutes, 429.
- `POST /api/auth/logout` → `{ ok: true }`.
- `GET /api/auth/me` → `{ user }`. `user` = `{ id, email, name, role, businesses: [slugs], must_change_password }`.
- `POST /api/auth/change-password` `{ current_password, new_password }` (min 8 characters) → `{ ok: true }`.

Passwords: PBKDF2-SHA256, 100,000 iterations, random 16-byte salt, stored as `base64(salt):base64(hash)`.

## Permissions

| Role | Can edit | Users page |
|---|---|---|
| `owner` | every business | everything, including other owners |
| `admin` | every business | create/edit editors and admins, not owners |
| `editor` | only slugs in `businesses_json` | no |

Family-wide announcements (`business_slug = null`) need `owner` or `admin`. A request for a business the user may not edit returns 403.

## Admin: businesses and hours

- `GET /api/admin/businesses` → `{ businesses: [ ...rows the user may edit, with hours_summary and counts: { new_inquiries, upcoming_events } ] }`
- `GET /api/admin/businesses/:slug` → `{ business, hours: [7 rows, Monday first], exceptions: [all future] }`
- `PATCH /api/admin/businesses/:slug` with any subset of the editable columns (`name`, `short_name`, `tagline`, `description`, `address1`, `address2`, `city`, `state`, `zip`, `phone`, `public_email`, `inquiry_emails`, `website_url`, `instagram_url`, `facebook_url`, `map_url`, `order_url`, `book_url`, `hours_note`, `notice`, `notice_until`) → `{ business }`. `slug` and `sort_order` are not editable here.
- `PUT /api/admin/businesses/:slug/hours` body `{ hours: [ { weekday, closed, open_min, close_min } × 7 ] }` → `{ hours }`. Validates 0 ≤ open_min < close_min ≤ 1440 unless closed.
- `GET /api/admin/businesses/:slug/hours/exceptions`, `POST` `{ date, closed, open_min, close_min, label }` → `{ exception }`, `DELETE /api/admin/hours/exceptions/:id`.

## Admin: events

- `GET /api/admin/businesses/:slug/events?status=all|current|upcoming|past` → `{ events: [ ...with computed status ] }` (includes unpublished).
- `POST /api/admin/businesses/:slug/events` body = editable columns (`kind`, `title`, `subtitle`, `description`, `start_date`, `end_date`, `start_time`, `end_time`, `location`, `link_url`, `link_label`, `image_url`, `featured`, `published`, `sort_order`) → `{ event }`. `title` and `start_date` required; `end_date` must not be before `start_date`.
- `PATCH /api/admin/events/:id`, `DELETE /api/admin/events/:id`.

## Admin: menu

- `GET /api/admin/businesses/:slug/menu` → `{ sections: [ { ...section, items: [ ...items with parsed tags, allergens, prices ] } ] }` (includes unpublished and unavailable).
- `POST /api/admin/businesses/:slug/menu/sections` `{ title, short_title, description, published }` → `{ section }`
- `PATCH /api/admin/menu/sections/:id`, `DELETE /api/admin/menu/sections/:id` (deletes its items).
- `POST /api/admin/menu/sections/:id/items` `{ name, portion, price, prices, description, tags, allergens, featured, available }` → `{ item }`. `tags` and `allergens` are arrays; `price` a number or null; `prices` an array of `{label, value}` or null.
- `PATCH /api/admin/menu/items/:id`, `DELETE /api/admin/menu/items/:id`.
- `POST /api/admin/businesses/:slug/menu/reorder` `{ sections: [ids in order], items: { "<sectionId>": [item ids in order] } }` → `{ ok: true }`. Either key may be omitted.

## Admin: announcements

- `GET /api/admin/businesses/:slug/announcements` → business-specific rows. `GET /api/admin/announcements?scope=family` → family-wide rows (owner/admin).
- `POST /api/admin/businesses/:slug/announcements` and `POST /api/admin/announcements` (family-wide) with `{ title, body, link_url, link_label, image_url, starts_at, ends_at, show_on_tv, published }`.
- `PATCH /api/admin/announcements/:id`, `DELETE /api/admin/announcements/:id`.

## Admin: inquiries

- `GET /api/admin/businesses/:slug/inquiries?status=new|handled|spam|all&limit=50&before=<id>` → `{ inquiries: [ ...with parsed fields ] }` newest first.
- `PATCH /api/admin/inquiries/:id` `{ status }` → `{ inquiry }`.
- `POST /api/admin/inquiries/:id/resend` → tries the email again → `{ emailed: true|false, error }`.

## Admin: history

- `GET /api/admin/businesses/:slug/history?limit=50&before=<id>` → `{ entries: [ { id, user_email, entity, entity_id, action, summary, created_at, can_restore } ] }`. Owners/admins can also call `GET /api/admin/history` for everything.
- `GET /api/admin/history/:id` → the entry with `before_json` and `after_json` parsed.
- `POST /api/admin/history/:id/restore` → puts the `before` state back for `update` and `delete` entries (recreating a deleted row with its original id when possible) and removes the row for `create` entries. Writes its own `restore` entry. Returns `{ ok: true }`.

## Admin: users (owner/admin)

- `GET /api/admin/users` → `{ users: [ { id, email, name, role, businesses, active, last_login_at } ] }`
- `POST /api/admin/users` `{ email, name, role, businesses, password }` → `{ user }` (new users get `must_change_password = 1`).
- `PATCH /api/admin/users/:id` `{ name, role, businesses, active, password }` (an admin cannot change an owner; nobody can deactivate the last active owner).
- `DELETE /api/admin/users/:id`.

## Admin: settings and media

- `GET /api/admin/settings/:key` → `{ value }` (`{}` when unset); `PUT /api/admin/settings/:key` `{ value }` (owner/admin, or an editor for `signage:<slug>` of a business they may edit).
- `POST /api/admin/media` multipart `file` (jpeg, png, webp, gif, ≤ 8 MB) → `{ url }` stored in R2 under `uploads/<slug>/<timestamp>-<name>` and served at `GET /api/media/<key>` (public, long cache). 501 when `MEDIA` is not bound.

## Email

`sendEmail({ to: [..], subject, text, html })` tries, in order: Resend (`RESEND_API_KEY` + `EMAIL_FROM`), then returns `{ sent: false, reason: 'not_configured' }`. Inquiry emails include every field, the business name, the time in Chicago, and a link to the admin inbox when `PUBLIC_BASE_URL` is set.
