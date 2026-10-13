# Rome's Joy Assistant: design

Staff manage every site in plain English. The assistant asks for missing details, drafts the change, double-checks it, shows a before → after summary and a live website preview, and changes nothing until a person taps **Publish**. Two front doors share one engine:

1. **Assistant panel in the admin** (`/admin/`, "Assistant" button): runs Claude through Anthropic's API, billed to Lance's Anthropic account (`ANTHROPIC_API_KEY` secret on the Worker), with a monthly spending limit set in the Anthropic Console.
2. **Claude app connector** (MCP server at `/mcp` on the same Worker): Lance or Cliff add it once in Claude (Settings → Connectors → Add custom connector) and manage the sites from the Claude app. No per-use API cost; it uses their Claude plan.

Both front doors use the **same tool layer**, the **same permissions** (the signed-in person's role and businesses), and the **same draft → preview → publish** flow. Nothing either path does can exceed what that person could do by hand in the admin.

## 1. The change-set model (the heart of "preview before committing")

Every write the AI wants to make becomes a **change set**: a draft list of operations that has not touched the live data.

```sql
CREATE TABLE IF NOT EXISTS change_sets (
  id              TEXT PRIMARY KEY,                  -- random, URL-safe (also the preview token)
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('assistant', 'mcp')),
  conversation_id TEXT,                              -- assistant conversation that made it
  title           TEXT NOT NULL,                     -- one line, e.g. "Close early Friday + add Juneteenth brunch"
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded', 'expired', 'failed')),
  ops_json        TEXT NOT NULL,                     -- [{ op, business_slug, entity, entity_id?, args }]
  summary_json    TEXT,                              -- [{ business_slug, line, before, after }] for the preview screen
  checks_json     TEXT,                              -- [{ level: 'ok'|'warn'|'block', message }] from the double-check
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,                     -- drafts expire after 48 hours
  published_at    TEXT,
  result_json     TEXT                               -- per-op outcome + audit ids after publish
);
CREATE INDEX IF NOT EXISTS idx_change_sets_user ON change_sets (user_id, created_at);
```

- **Ops** reuse the existing admin handlers' validation: each op names an admin action that already exists (e.g. `hours.put`, `hours_exception.create`, `business.patch` (contact, notice), `event.create|patch|delete`, `menu_item.create|patch|delete`, `menu_section.create|patch`, `announcement.create|patch|delete`, `artwork.create|patch|delete`, `artwork_image.patch`). `ops_json` stores the exact arguments the handler will receive.
- **Validate on draft, again on publish.** When a draft is created every op is dry-run validated (same validators as the admin) and permission-checked; blocking errors go back to the AI to fix before the person ever sees a preview. On publish the ops run again inside one D1 batch where possible; any failure marks the change set `failed`, nothing partial is left (ops that cannot batch are applied in order and rolled back with the audit `before` states on failure).
- **Double-check** (`checks_json`), computed server-side, never by the model alone: hours that close before they open or overlap midnight, a special day in the past, an event ending before it starts or entirely in the past, a notice whose "until" date already passed, a price of $0 or a 10× jump from the old price, a menu item with an allergen tag removed, a sold artwork that would show a price, an inquiry email that does not look like an address, changes to a business the person cannot edit (block), more than 25 ops (warn: "this is a big change").
- **Publish** writes the normal `audit_log` rows with `summary` prefixed "Assistant: " (or "Claude app: ") and `user_id` = the approving person, so History and Restore work exactly as for manual edits. One extra History entry per change set ("Published 'Close early Friday + add Juneteenth brunch' (4 changes)") with **Undo all**.

## 2. Preview

- `GET /api/public/:slug?preview=<change_set_id>` returns the public bundle **as it would look after publishing**: the Worker loads the draft ops, applies them to an in-memory copy of the rows it reads for the bundle, and builds the bundle with the same code. Only `draft` change sets that have not expired preview; the response has `Cache-Control: no-store` and a `"preview": { "id", "title", "expires_at" }` field.
- `assets/js/live.js` passes `?preview=` from the page URL through to the bundle request and shows a fixed banner "Preview — not live yet · <title>" with a "Back to admin" link. The TV page (`signage/live.html`) does the same.
- The preview screen in the admin shows, per business: the plain-English summary lines with before → after, the double-check results (green / amber / red), and one **"Preview the website"** button per affected site (opens `/<site>?preview=<id>` in a new tab), plus **Copy preview link** and **Text/email it** (uses the device share sheet via `navigator.share` when available).
- Preview links are unguessable (128-bit random id) and expire with the draft (48 h). They show only what the public site would show (no inquiries, no unpublished items).

## 3. The tool layer (shared by both front doors)

`worker/lib/assistant-tools.js` defines each tool once: a name, a plain description, a JSON Schema (`strict: true`, `additionalProperties: false`), and a handler `(ctx, input) → result`. Tools come in three kinds:

| Kind | Examples | What the handler does |
|---|---|---|
| **Read** | `list_businesses`, `get_business` (contact, notice, hours, special days), `list_events`, `get_menu`, `list_announcements`, `list_inquiries` (summaries only, no visitor contact details unless asked and permitted), `list_artworks`, `get_history` | Reads with the person's permissions. Returns compact JSON. |
| **Draft** | `propose_changes` with `{ title, ops: [...] }` | Validates + permission-checks every op, computes the before/after summary and the double-check, stores/updates the person's open draft change set, returns `{ change_set_id, summary, checks, preview_urls }` or the validation errors for the AI to fix. Calling it again **replaces** the open draft (the conversation converges on one draft). |
| **Commit** | none for the AI | The AI never publishes. Publishing is a button in the admin (`POST /api/admin/change-sets/:id/publish`) or, in the Claude app, the `publish_change_set` tool **which only succeeds after the person typed an explicit confirmation**: it requires `confirm_phrase` equal to `PUBLISH <first 6 chars of the id>`, which the AI must ask the person to type. |
| **Verify** | `verify_change_set` | After publish, re-reads the live public bundle(s) and reports whether each summary line is now true. The assistant calls it automatically and tells the person. |

Images: the admin assistant accepts photo attachments (menu boards, flyers, artwork labels). They are sent to Claude as image content blocks (resized in the browser to ≤ 1600 px JPEG first) so it can read prices, dates and titles. Photos the person wants **on the website** are uploaded through the existing media pipeline and referenced by URL in the ops.

## 4. Admin assistant (Anthropic API)

- **SDK:** `@anthropic-ai/sdk` (the official TypeScript/JavaScript SDK), bundled into the Worker by wrangler. `package.json` gains it as a dependency; `npm install` before `wrangler deploy` (Workers Builds runs it automatically).
- **Model:** `claude-opus-5-5`, adaptive thinking (default on this model), `output_config.effort: "medium"` set explicitly, server-side refusal fallbacks enabled (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`), `tool_choice: auto` (forced tool choice is not supported on this model), every custom tool `strict: true`. Check `stop_reason` before reading content; handle `refusal` with a plain message.
- **Loop:** server-side manual tool loop in `POST /api/admin/assistant/messages` (streams Server-Sent Events to the admin: text deltas, "Looking at Peach's hours…" tool progress lines, and a final `draft` event when a change set exists). Max 12 tool rounds per turn; the person sees a gentle error if exceeded.
- **History is append-only.** Conversations are stored in `assistant_conversations` / `assistant_messages` (each message's full `content` array exactly as returned, thinking blocks included, never edited, never re-ordered, never trimmed in place). Long conversations use server-side compaction, not manual trimming. This is required for preserved thinking on this model.
- **Prompt caching:** system prompt + tool list are frozen and come first with `cache_control`; per-request facts (today's date in Chicago, the person's name and businesses) go in the first user turn of each conversation, not the system prompt.
- **System prompt (behaviour the promise depends on):** act as a careful assistant for restaurant/gallery staff; plain short sentences; always find out what is missing before drafting (dates, times, which business, prices, links, whether it should show on the TV); restate ambiguous requests and confirm; never invent prices, dates, allergens, names or certifications; always draft through `propose_changes`, show the summary, point at the preview links, and wait; never claim something is live until `verify_change_set` says so; refuse changes outside the person's businesses and say who can do it; keep allergen and halal labels exactly as staff state them.
- **Limits and cost control:** per-user daily cap on assistant turns (setting `assistant:limits`, default 60/day), max image size, `max_tokens` 16000 per call, and the usage of every call recorded in `assistant_usage` (input/output/cache tokens, cost estimate) shown to owners on an "AI usage" card so Lance can bill Cliff. Without `ANTHROPIC_API_KEY` the Assistant button explains that it is not switched on yet.

## 5. Claude app connector (MCP)

- **Endpoint:** `https://<worker>/mcp`, MCP Streamable HTTP, exposing the same read tools, `propose_changes`, `publish_change_set` (with the typed confirmation phrase) and `verify_change_set`.
- **Sign-in:** OAuth 2.1 with PKCE and Dynamic Client Registration (what Claude's custom connectors use), implemented with Cloudflare's OAuth provider library for Workers; the authorization page is the admin's own sign-in (same email + password, same lockouts), then an "Allow Claude to manage <businesses> as <name>?" consent screen. Tokens map to the existing `users` row, so permissions are identical. Owners can see and revoke connected apps on the Account screen.
- **Previews in the Claude app:** `propose_changes` returns the preview links; Claude shows them and the summary, and only publishes after the person types the confirmation phrase.

## 6. What Lance does once

1. Create an API key at console.anthropic.com (Settings → API keys), set a monthly spend limit (Settings → Limits).
2. `npx wrangler@4 secret put ANTHROPIC_API_KEY` and run the new migration (`worker/migrations/2026-10-14-assistant.sql`).
3. In the Claude app: Settings → Connectors → Add custom connector → `https://peachs.tvinstallchicago.workers.dev/mcp` → sign in with the admin login.
