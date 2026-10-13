-- Adds the Assistant (change sets with previews), the photo library and the TV screens panel.
-- Safe to run more than once; touches no existing rows.
--   npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/migrations/2026-10-14-assistant.sql

-- A draft of changes the Assistant (or the Claude app) wants to make. Nothing in it is live until a person publishes it.
CREATE TABLE IF NOT EXISTS change_sets (
  id              TEXT PRIMARY KEY,                  -- 22-char random URL-safe id; also the preview token
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('assistant', 'mcp')),
  conversation_id TEXT,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded', 'expired', 'failed', 'undone')),
  ops_json        TEXT NOT NULL,
  summary_json    TEXT,
  checks_json     TEXT,
  businesses_json TEXT NOT NULL DEFAULT '[]',        -- slugs the ops touch (for previews and permission checks)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  published_at    TEXT,
  result_json     TEXT                               -- per-op outcome and the audit_log ids it wrote
);
CREATE INDEX IF NOT EXISTS idx_change_sets_user ON change_sets (user_id, created_at);

-- Assistant chats. Messages are stored exactly as sent/received and never edited (append-only).
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_slug   TEXT,                              -- business selected when the chat started
  title           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_conversations_user ON assistant_conversations (user_id, updated_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json    TEXT NOT NULL,                     -- the full content array, byte-for-byte as the API returned / as we sent
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation ON assistant_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS assistant_usage (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER,
  conversation_id       TEXT,
  model                 TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_usage_created ON assistant_usage (created_at);

-- Photo library: albums per business, photos stored in R2 (MEDIA).
CREATE TABLE IF NOT EXISTS media_albums (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_slug, name)
);

CREATE TABLE IF NOT EXISTS media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  album_id        INTEGER REFERENCES media_albums(id) ON DELETE SET NULL,
  url             TEXT NOT NULL,                     -- full-size (≤ 2000 px)
  thumb_url       TEXT,                              -- ≤ 640 px
  r2_key          TEXT,                              -- uploads/<slug>/... for the full-size file
  thumb_r2_key    TEXT,
  note            TEXT,                              -- what staff typed: "brunch special", "new piece, Hamilton"
  alt             TEXT,
  width           INTEGER,
  height          INTEGER,
  bytes           INTEGER,
  taken_at        TEXT,                              -- when the photo was taken, if the browser could read it
  uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_business ON media (business_slug, album_id, created_at);

-- TV screens: one row per physical TV/player.
CREATE TABLE IF NOT EXISTS screens (
  id              TEXT PRIMARY KEY,                  -- short random id used in the player URL (?screen=<id>)
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  name            TEXT NOT NULL,                     -- "Peach's: counter"
  notes           TEXT,
  last_seen_at    TEXT,                              -- last heartbeat (UTC)
  last_seen_ip    TEXT,
  last_user_agent TEXT,
  last_scene      TEXT,                              -- scene the player reported showing
  last_version    TEXT,                              -- data version the player has loaded
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_screens_business ON screens (business_slug);

-- Starter albums (staff can rename or delete them).
INSERT OR IGNORE INTO media_albums (business_slug, name, sort_order) VALUES
  ('peachs', 'Food', 1), ('peachs', 'Dining room', 2), ('peachs', 'Team', 3), ('peachs', 'Events', 4),
  ('catering', 'Food', 1), ('catering', 'Events', 2),
  ('blanc', 'Artworks', 1), ('blanc', 'Openings', 2), ('blanc', 'Installs', 3),
  ('parkway-social', 'The space', 1), ('parkway-social', 'Events', 2),
  ('mise-en-place', 'Classes', 1), ('mise-en-place', 'Graduations', 2),
  ('rjc-sausage', 'Products', 1),
  ('romesjoy', 'Chef Rome', 1), ('romesjoy', 'Press', 2);
