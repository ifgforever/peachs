# Assistant, photo library and TV screens: build contract

This is the contract the builders follow. The design and the "why" are in `docs/assistant-design.md`; the existing API is `docs/admin-api.md`. Tables are in `worker/migrations/2026-10-14-assistant.sql` (also appended to `worker/schema.sql`; starter albums in `worker/seed.sql`).

Conventions are the existing ones: JSON errors `{ error, code }` via `ApiError` from `worker/lib/http.js`; handlers receive `ctx` (`{ request, env, url, params, ip, now, user, waitUntil }`); permissions via `canEdit(user, slug)` / `isManager(user)` from `worker/lib/auth.js`; every write audited through `worker/lib/audit.js`; plain-English summaries; dates `YYYY-MM-DD`, America/Chicago. Each new module exports `register(router, admin)` and is already wired in `worker/index.js` (do not reorder the existing routes).

## 1. Change sets (`worker/lib/changesets.js`)

### Ops
An op is `{ op, business_slug, args }`. `args` is exactly the JSON body the existing admin handler takes (plus the id the route takes as `id` where the route has one). Every op maps to one existing handler; publishing calls that handler with a synthesized `ctx` (same user, `params` filled in, a `request` whose `.json()` returns `args`), so validation, permissions and audit are identical to a manual edit.

| `op` | Existing handler | Route it mirrors |
|---|---|---|
| `business.patch` | `businesses.patch` | `PATCH /api/admin/businesses/:slug` (contact, links, notice, notice_until) |
| `hours.put` | `businesses.putHours` | `PUT /api/admin/businesses/:slug/hours` |
| `hours_exception.create` / `.delete` | `businesses.createException` / `deleteException` | special days |
| `event.create` / `.patch` / `.delete` | `events.*` | events and exhibitions |
| `menu_section.create` / `.patch` / `.delete` | `menu.*` | |
| `menu_item.create` / `.patch` / `.delete` | `menu.*` | |
| `announcement.create` / `.patch` / `.delete` | `announcements.*` | `business_slug: null` = family-wide (owner/admin only) |
| `artwork.create` / `.patch` / `.delete` | `artworks.*` | |
| `artwork_image.add` / `.patch` / `.delete` | `artworks.addImage` / `patchImage` / `removeImage` | images reference library photos by URL |
| `screen_settings.put` | `settings.put` with key `signage:<slug>` | TV scene settings |

`ops_json` may reference an object created earlier in the same change set with `"$ref": "<index>"` (e.g. add an image to the artwork created by op 0): `{"op":"artwork_image.add","business_slug":"blanc","args":{"id":{"$ref":0},"url":"…"}}`. On publish, `$ref` resolves to the id the earlier op returned.

### Exported functions (used by `assistant.js`, `assistant-tools.js` and `mcp.js`)
```js
proposeChangeSet(ctx, { title, ops, source, conversation_id, replace_id }) // → { change_set } or throws ApiError with details
getChangeSet(ctx, id)            // → change set (owner of it, or owner/admin)
publishChangeSet(ctx, id)        // → { change_set, results }
discardChangeSet(ctx, id)        // → { change_set }
undoChangeSet(ctx, id)           // → { change_set } (restores every audit entry it wrote, newest first)
verifyChangeSet(ctx, id)         // → { ok, lines: [{ business_slug, line, ok, detail }] } read from the live public bundle
previewBundle(env, slug, id)     // → public bundle with the draft applied, or null when the id is not a live draft
```
`change_set` (API shape) = `{ id, title, status, source, created_at, expires_at, published_at, businesses, ops, summary: [{ business_slug, business_name, line, before, after }], checks: [{ level: 'ok'|'warn'|'block', message, op_index }], preview_urls: [{ business_slug, label, url }] }`.

Rules:
- **Propose** validates every op (shape, field rules: reuse `worker/lib/validate.js` and each module's validators; do not duplicate them where an export exists, add small exports where needed), checks `canEdit` for every `business_slug` (family-wide announcements need `isManager`), resolves `$ref`, computes `summary` (plain English, before → after from the current rows) and `checks`, stores the draft (`expires_at` = now + 48 h). With `replace_id` (a draft of the same user) it overwrites that draft instead of creating another. Blocking problems throw `400 invalid_change_set` with `details: [{ op_index, message }]` so the model can fix them. More than 40 ops → 400.
- **Checks** (server-side; at least): hours where close ≤ open or a closed day with times; a special day in the past; an event whose end is before its start or entirely in the past (warn) ; a notice whose `notice_until` already passed (block); a price ≤ 0 (block) or more than 3× or less than ⅓ of the current price (warn); a menu item that loses an allergen or a GF/V/DF tag (warn: "Allergen info removed from …"); an artwork marked sold with `price_display: 'show'` (warn: price will be hidden); an inquiry email that is not an email address (block); deleting something that has photos or is featured (warn); changing a business the user cannot edit (block); more than 15 ops (warn: "This is a big change; check the preview carefully."). If nothing to flag: one `ok` line "Checked: nothing unusual."
- **Publish**: only a `draft` that has not expired, by its creator or an owner/admin who can edit every business it touches. Re-runs propose's validation first (data may have changed); then runs the ops in order via the real handlers with `ctx.auditSource = 'Assistant' | 'Claude app'` (audit.js prefixes summaries with `"<source>: "` when set). Records each op's result and the audit ids it wrote in `result_json`. If an op throws, everything already applied is rolled back by restoring its audit entries newest-first (reuse the History restore logic from `admin-history.js`; export what you need), the change set becomes `failed` with the error, and the API returns 409 `publish_failed` with the message. After success writes one extra audit row `{ entity: 'change_set', entity_id: id, action: 'update', summary: 'Published "<title>" (<n> changes)' }`.
- **Undo** (`undoChangeSet`): restores the audit entries from `result_json` newest-first; status `undone`. Works within 30 days; later → 409.
- **Preview**: `GET /api/public/:slug?preview=<id>` and `GET /api/public/signage/:slug?preview=<id>`: when `id` is a non-expired draft that touches `slug`, the bundle is built from the current rows with the draft's ops applied in memory (no writes). Response adds `"preview": { "id", "title", "expires_at" }` and `Cache-Control: no-store`. Otherwise the param is ignored. Implement by giving `public.js` a row-overlay hook (e.g. build the bundle from a `rows` object, and let `previewBundle` patch that object before rendering) rather than a second copy of the bundle code.
- `preview_urls` are absolute when `PUBLIC_BASE_URL` is set, else same-site paths: `<site path>?preview=<id>` where site path is `/romesjoy/`, `/peachs.html`, `/catering/`, `/parkway-social/`, `/mise-en-place/`, `/blanc/`, `/rjc-sausage/`, plus `/signage/live.html?business=<slug>&preview=<id>` labelled "TV screen".

### Routes
- `GET /api/admin/change-sets?status=draft|published|all` → `{ change_sets }` (own; owner/admin see all).
- `GET /api/admin/change-sets/:id` → `{ change_set }`
- `POST /api/admin/change-sets/:id/publish` → `{ change_set, results }`
- `POST /api/admin/change-sets/:id/discard` → `{ change_set }`
- `POST /api/admin/change-sets/:id/undo` → `{ change_set }`
- `GET /api/admin/change-sets/:id/verify` → `{ ok, lines }`

### Sites and TV
`assets/js/live.js`: when the page URL has `?preview=<id>`, pass it to the bundle request, never cache that bundle, and show a fixed top banner "Preview — not live yet · <title>" with a "Back to the admin" link (`/admin/`). `signage/live.js` does the same for its bundle(s) and shows a small "PREVIEW" corner badge.

## 2. Tool layer (`worker/lib/assistant-tools.js`)
One definition per tool, shared by the admin Assistant and the Claude app connector:
```js
export const TOOLS = [{ name, description, input_schema, kind: 'read'|'draft'|'commit'|'verify', handler: async (ctx, input) => result }]
export function toolsFor(surface)  // 'assistant' → all but publish_change_set; 'mcp' → all
export async function runTool(ctx, name, input) // permission-checked; returns a JSON-serializable result or { error }
```
Schemas: JSON Schema with `additionalProperties: false` and `required` listing every property (optional fields as `["string","null"]` etc.), so they work with `strict: true`. Results are compact (no huge blobs; lists capped at 50 with a note).

Tools (minimum):
- `list_businesses` → the user's businesses (slug, name, open_now text, hours summary, notice).
- `get_business` `{ slug }` → contact/links, notice, weekly hours, upcoming special days.
- `list_events` `{ slug, status: current|upcoming|past|all }`, `get_menu` `{ slug }`, `list_announcements` `{ slug|null }`, `list_artworks` `{ slug, status|null, event_id|null }`, `list_inquiries` `{ slug, status }` (name, form type, first 200 chars of message, date; no phone/email unless `include_contact: true`), `get_history` `{ slug, limit }`.
- `list_photos` `{ slug, album|null, query|null, since|null }` → library photos (id, url, thumb_url, note, album, taken/created date) so the model can use "the photo I took this morning".
- `get_screens` `{ slug }` → screens with online/offline and last seen.
- `propose_changes` `{ title, ops, replace_change_set_id|null }` → `proposeChangeSet` result: `{ change_set_id, summary, checks, preview_urls }` or `{ error, details }` (validation problems are returned, not thrown, so the model can fix them).
- `get_change_set` `{ id }`, `discard_change_set` `{ id }`.
- `publish_change_set` `{ id, confirm_phrase }` (MCP only): succeeds only if `confirm_phrase === 'PUBLISH ' + id.slice(0, 6).toUpperCase()`; otherwise returns `{ error: 'Ask the person to type: PUBLISH XXXXXX' }`.
- `verify_change_set` `{ id }` → `verifyChangeSet`.

## 3. Admin Assistant engine (`worker/lib/assistant.js`)
- **SDK**: `@anthropic-ai/sdk` (add to `package.json` `dependencies`; wrangler bundles it). Read the `claude-api` skill (TypeScript README + tool-use docs) before writing the calls. Key: `env.ANTHROPIC_API_KEY` (already set as a secret in production). Without it every assistant route returns 501 `assistant_not_configured`.
- **Model and request**: `model: 'claude-opus-5-5'`, `max_tokens: 16000`, `output_config: { effort: 'medium' }` (explicit; thinking is adaptive by default on this model; do not send `thinking: {type:'disabled'}` or `budget_tokens`, both 400), `tool_choice: { type: 'auto' }` (forced tool choice 400s on this model), every tool `strict: true`, server-side refusal fallbacks (`client.beta.messages.stream({ ..., betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })`). Check `stop_reason` before reading content; on `refusal` reply in plain words that it can't help with that request. Streaming with `.stream()` and `finalMessage()`.
- **Caching**: frozen system prompt and tool list first with `cache_control: { type: 'ephemeral' }` on the last system block; per-conversation facts (today in Chicago, the person's name, role and businesses, the selected business) go in the first user message of the conversation, never in the system prompt.
- **History is append-only**: store every user message and every assistant response's full `content` array exactly as received (thinking blocks included) in `assistant_messages`; resend them unchanged and in order; never edit, trim, reorder or drop earlier messages. Tool results go back as one user message containing all `tool_result` blocks for that turn. When a conversation gets long (estimate > 150k input tokens) tell the person to start a new chat instead of trimming.
- **Loop**: `POST /api/admin/assistant/conversations` `{ business_slug|null }` → `{ conversation }`. `POST /api/admin/assistant/conversations/:id/messages` `{ text, images: [{ media_type, data_base64 }] (≤ 4, each ≤ 1.5 MB after the browser shrinks it) }` → **Server-Sent Events** (`Content-Type: text/event-stream`): `event: text` `{ delta }`; `event: tool` `{ name, label }` (label is friendly: "Looking at Peach's hours…", "Drafting the changes…"); `event: draft` `{ change_set }` whenever `propose_changes` succeeds; `event: done` `{ message_id, usage }`; `event: error` `{ error, code }`. Max 12 tool rounds per turn. `GET /api/admin/assistant/conversations` (own, newest first, 30), `GET /api/admin/assistant/conversations/:id` → `{ conversation, messages: [{ role, text, attachments_count, created_at, drafts: [change_set ids] }] }` (render-friendly: text blocks joined; tool calls summarized; no thinking content).
- **System prompt** (write it carefully; it is the product): you help restaurant, gallery and event staff keep their websites and in-store TVs right; short plain sentences; ask for missing details before drafting (which business, dates, times, prices, links, whether it should show on the TV, which photo); restate anything ambiguous and confirm; never invent prices, dates, allergens, names, certifications or quotes; read the current data with tools before proposing; every change goes through `propose_changes`; after proposing, show the summary in plain words, mention any warnings, point to the preview links, and say that nothing is live until they tap Publish; never say something is live unless `verify_change_set` (after publish) says so; refuse work outside the person's businesses and say who can do it; keep allergen, dietary and halal labels exactly as staff give them; for photos, prefer the library (`list_photos`) and ask which one if unsure.
- **Publishing from the admin** happens with the Publish button (change-set routes), not the model. After the person publishes, the admin calls `POST /api/admin/assistant/conversations/:id/published` `{ change_set_id }`, which appends a user message "(Published <title>.)" and runs one assistant turn so it calls `verify_change_set` and reports back (SSE like messages).
- **Limits and usage**: per-user daily cap from setting `assistant:limits` (`{ "daily_turns": 60 }` default); 429 `assistant_limit` with a friendly message. Record each API call's usage (input, output, cache read/write tokens, model, cost estimate using $4 / $20 per million input/output tokens, cache reads $0.20, cache writes 1.25 × input) in `assistant_usage`. `GET /api/admin/assistant/usage?days=30` (owner/admin) → totals per day and per user.
- **Testing**: no real API key is available while building. Write `worker/assistant-mock.mjs`: a tiny local HTTP server that imitates the Messages API streaming endpoint well enough for the SDK (scripted responses: a tool_use for `get_business`, then `propose_changes`, then text), and run wrangler dev with `ANTHROPIC_BASE_URL` pointing at it (`.dev.vars`). Real-key testing happens after deploy.

## 4. Claude app connector (`worker/lib/mcp.js`)
- MCP Streamable HTTP at `/mcp`, exposing `toolsFor('mcp')`, with OAuth 2.1 (PKCE, dynamic client registration, metadata at `/.well-known/oauth-authorization-server`) so it can be added in Claude as a custom connector. Use Cloudflare's OAuth provider library for Workers (`@cloudflare/workers-oauth-provider`, KV binding `OAUTH_KV` is configured) and the MCP server library the Cloudflare docs recommend for stateless Workers (check with the Cloudflare docs search tool; avoid Durable Objects unless required). Add every new path (`/mcp`, `/authorize`, `/token`, `/register`, `/.well-known/*`) to `run_worker_first` in `wrangler.jsonc` and route them in `worker/index.js` before the static-asset fallthrough, keeping all existing behaviour.
- `/authorize` renders a small sign-in page in the admin's look (email + password, same lockouts as `/api/auth/login`), then a consent screen "Allow Claude to manage <businesses> as <name>?". The grant stores the user id; every tool call loads that user fresh (deactivated users lose access immediately).
- Account screen data: `GET /api/admin/connected-apps` → grants for the user; `DELETE /api/admin/connected-apps/:id` revokes.

## 5. Photo library (`worker/lib/media-library.js`)
- `GET /api/admin/businesses/:slug/media?album_id=<id|none>&q=<text>&before=<id>&limit=60` → `{ photos: [{ id, url, thumb_url, note, alt, album_id, album_name, width, height, taken_at, created_at, uploaded_by_name, in_use: [{ kind, id, title }] }], albums: [{ id, name, count }] }`. Owners/admins: `GET /api/admin/media?q=` across all businesses.
- `POST /api/admin/businesses/:slug/media` `{ url, thumb_url, r2_key, thumb_r2_key, note, alt, album_id, width, height, bytes, taken_at }` → `{ photo }` (called by the admin right after the existing `POST /api/admin/media` upload; the upload response must include `key`). `PATCH /api/admin/media/:id` `{ note, alt, album_id, business_slug }` (moving to another business needs `canEdit` on both). `DELETE /api/admin/media/:id` → 409 `in_use` (with where) when the URL is used by an event, announcement, artwork image, or notice; otherwise deletes the row and both R2 objects.
- Albums: `GET/POST /api/admin/businesses/:slug/albums` `{ name }`, `PATCH /api/admin/albums/:id` `{ name, sort_order }`, `DELETE /api/admin/albums/:id` (photos fall back to "No album").
- In-use detection compares URLs (events.image_url, announcements.image_url, artwork_images.url/thumb_url).

## 6. TV screens (`worker/lib/screens.js` + `signage/live.js`)
- `GET /api/admin/businesses/:slug/screens` → `{ screens: [{ id, name, notes, status: 'online'|'offline'|'never', last_seen_at, last_scene, player_url }], settings }` (online = heartbeat within 10 minutes). `POST` `{ name, notes }`, `PATCH /api/admin/screens/:id`, `DELETE /api/admin/screens/:id`. `player_url` = `<base>/signage/live.html?business=<slug>&screen=<id>`.
- Scene settings live in the existing `signage:<slug>` setting: `{ seconds_per_scene, scenes: { welcome, notice, announcements, featured, menu, catering, events, artworks } (booleans, default true), refresh_version }`. `POST /api/admin/businesses/:slug/screens/refresh` bumps `refresh_version` (audited) so players reload within ~30 s.
- Public heartbeat: `POST /api/public/screens/:id/heartbeat` `{ scene, version }` (no login; rate-limited to 1/20 s per screen; updates last_seen_*; unknown id → 404) → `{ refresh_version, seconds_per_scene }`. `signage/live.js` sends it every 60 s when `?screen=` is present, honours `scenes` toggles, and when `refresh_version` changes reloads its data immediately.

## 7. Admin UI (`admin/`)
- **Assistant panel**: an "Assistant" button in the top bar on every screen (and a nav item), opening a right-side panel on desktop / full-screen sheet on phones. Chat list + new chat; message composer with text, **mic button** (Web Speech API `SpeechRecognition` when available, otherwise hidden) and **photo attach** (camera or library; shrunk in the browser to ≤ 1600 px JPEG before sending). Streams replies; shows tool progress lines; when a `draft` event arrives shows a **Draft card**: title, summary lines grouped by business (before → after), checks (green/amber/red), "Preview the website" buttons per site + "TV screen", "Copy preview link" / Share (navigator.share), **Publish** (disabled while any `block` check exists; confirm dialog "Publish these N changes?"), **Discard**. After publish: shows the verify result from the follow-up turn and an **Undo all** button. Explains plainly when the assistant is not switched on (501) or the daily limit is hit (429).
- **Photos screen**: albums as tabs/chips (+ New album, rename, delete), grid of thumbnails with notes, big **Take photo / Add photos** button (`input type=file accept="image/*" multiple`; the existing shrink pipeline; then `POST …/media`), choose album while uploading, multi-select move, edit note/alt, delete (shows where it's used when 409), search box. "Choose from library" button on every photo field (events, announcements, artworks) opening a picker sheet on that business's albums.
- **TV screens screen**: list of screens with status dot (online/offline/never) and "last seen 2 min ago", a live mini preview (scaled `iframe` of the player URL, `loading="lazy"`, only the visible ones), Add screen (name), copy player URL, scene toggles + seconds per scene, **Refresh all screens now**.
- **AI usage card** on Overview for owners/admins (this month's cost estimate and turns).
- **PWA**: `admin/manifest.webmanifest` (name "Rome's Joy Back Office", short_name "Back Office", start_url `/admin/`, display standalone, theme/background colors from the admin palette, icons from existing brand assets resized) and `<link rel="manifest">` + `apple-touch-icon`; no service worker needed.
- Keep `_headers` CSP working: if the iframe preview needs `frame-src 'self'` or `child-src`, add exactly that; media for mic needs no CSP change.
