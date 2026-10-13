-- Adds the artwork catalog to a database created before 2026-10-13. Safe to run more than once.
--   npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/migrations/2026-10-13-artworks.sql
-- Does not touch existing hours, menus, events, inquiries or accounts.

CREATE TABLE IF NOT EXISTS artworks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  artist          TEXT,
  year            TEXT,
  medium          TEXT,
  dimensions      TEXT,
  description     TEXT,
  price           REAL,
  price_display   TEXT NOT NULL DEFAULT 'on_request' CHECK (price_display IN ('show', 'on_request', 'hidden')),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'not_for_sale')),
  featured        INTEGER NOT NULL DEFAULT 0,
  published       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artworks_business ON artworks (business_slug, event_id, sort_order);

CREATE TABLE IF NOT EXISTS artwork_images (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id      INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  thumb_url       TEXT,
  alt             TEXT,
  width           INTEGER,
  height          INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artwork_images_artwork ON artwork_images (artwork_id, sort_order);

-- Turn the Artworks screen on for Blanc (other businesses can be switched on the same way).
INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('features:blanc', '{"artworks": true}', datetime('now'));
INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('signage:blanc', '{"seconds_per_scene": 12}', datetime('now'));
