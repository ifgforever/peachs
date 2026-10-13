-- Rome's Joy admin: D1 (SQLite) schema.
-- One database feeds every site and the in-store screens. Apply with:
--   npx wrangler d1 execute romesjoy-admin --local  --file worker/schema.sql   (local dev)
--   npx wrangler d1 execute romesjoy-admin --remote --file worker/schema.sql   (production)
-- Weekdays use JavaScript's numbering: 0 = Sunday ... 6 = Saturday.
-- Times of day are minutes after midnight (8:00 am = 480). Dates are YYYY-MM-DD in America/Chicago.

CREATE TABLE IF NOT EXISTS businesses (
  slug            TEXT PRIMARY KEY,                  -- romesjoy, peachs, catering, parkway-social, mise-en-place, blanc, rjc-sausage
  name            TEXT NOT NULL,
  short_name      TEXT,
  tagline         TEXT,
  description     TEXT,
  address1        TEXT,
  address2        TEXT,
  city            TEXT NOT NULL DEFAULT 'Chicago',
  state           TEXT NOT NULL DEFAULT 'IL',
  zip             TEXT,
  phone           TEXT,                              -- as shown to visitors, e.g. 773.966.5801
  public_email    TEXT,                              -- shown on the site
  inquiry_emails  TEXT,                              -- comma-separated inboxes that receive form submissions
  website_url     TEXT,
  instagram_url   TEXT,
  facebook_url    TEXT,
  map_url         TEXT,
  order_url       TEXT,                              -- e.g. Toast online ordering
  book_url        TEXT,                              -- e.g. tour booking / RSVP platform
  timezone        TEXT NOT NULL DEFAULT 'America/Chicago',
  hours_note      TEXT,                              -- e.g. "and by appointment"
  notice          TEXT,                              -- short site-wide notice shown as a banner; NULL = none
  notice_until    TEXT,                              -- YYYY-MM-DD; notice hides itself after this date
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hours (
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  closed          INTEGER NOT NULL DEFAULT 0,
  open_min        INTEGER,
  close_min       INTEGER,
  PRIMARY KEY (business_slug, weekday)
);

-- Holiday or one-off changes. A row wins over the weekly hours for that date.
CREATE TABLE IF NOT EXISTS hours_exceptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  closed          INTEGER NOT NULL DEFAULT 1,
  open_min        INTEGER,
  close_min       INTEGER,
  label           TEXT,                              -- e.g. "Thanksgiving"
  UNIQUE (business_slug, date)
);

-- Exhibitions, receptions, classes, programs. Status (current / upcoming / past) is computed from the dates.
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'exhibition', 'program')),
  title           TEXT NOT NULL,
  subtitle        TEXT,                              -- e.g. artist names
  description     TEXT,
  start_date      TEXT NOT NULL,                     -- YYYY-MM-DD
  end_date        TEXT,                              -- YYYY-MM-DD; NULL = single day
  start_time      TEXT,                              -- HH:MM 24h, optional
  end_time        TEXT,
  location        TEXT,
  link_url        TEXT,
  link_label      TEXT,                              -- e.g. "RSVP on Eventbrite"
  image_url       TEXT,
  featured        INTEGER NOT NULL DEFAULT 0,
  published       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_business_dates ON events (business_slug, start_date, end_date);

CREATE TABLE IF NOT EXISTS menu_sections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  short_title     TEXT,
  description     TEXT,
  published       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_sections_business ON menu_sections (business_slug, sort_order);

CREATE TABLE IF NOT EXISTS menu_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id      INTEGER NOT NULL REFERENCES menu_sections(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  portion         TEXT,                              -- e.g. "half pan", "serves 10"
  price           REAL,                              -- single price; NULL when prices_json is used
  prices_json     TEXT,                              -- JSON array [{"label":"Small","value":6}, ...]
  description     TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',        -- JSON array of "GF" | "V" | "DF"
  allergens_json  TEXT NOT NULL DEFAULT '[]',        -- JSON array of strings, e.g. ["Dairy","Shellfish"]
  featured        INTEGER NOT NULL DEFAULT 0,        -- "star" items
  available       INTEGER NOT NULL DEFAULT 1,        -- 0 hides it from sites and screens without deleting it
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_items_section ON menu_items (section_id, sort_order);

-- News and promos. business_slug NULL = shows for the whole family (hub site, TV screens).
CREATE TABLE IF NOT EXISTS announcements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT REFERENCES businesses(slug) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT,
  link_url        TEXT,
  link_label      TEXT,
  image_url       TEXT,
  starts_at       TEXT NOT NULL DEFAULT (date('now')), -- YYYY-MM-DD
  ends_at         TEXT,                              -- YYYY-MM-DD; NULL = until unpublished
  show_on_tv      INTEGER NOT NULL DEFAULT 1,
  published       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_business ON announcements (business_slug, starts_at);

-- Every website form submission is saved here first, then emailed.
CREATE TABLE IF NOT EXISTS inquiries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  form_type       TEXT NOT NULL DEFAULT 'contact',   -- contact, quote, event, wholesale, apply, ...
  name            TEXT,
  email           TEXT,
  phone           TEXT,
  message         TEXT,
  fields_json     TEXT NOT NULL DEFAULT '{}',        -- any extra fields the form sent
  source_url      TEXT,
  ip              TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled', 'spam')),
  emailed_at      TEXT,
  email_error     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inquiries_business ON inquiries (business_slug, created_at);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,              -- stored lower-case
  name            TEXT,
  password_hash   TEXT NOT NULL,                     -- "salt:hash", PBKDF2-SHA256, base64
  role            TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'admin', 'editor')),
  businesses_json TEXT NOT NULL DEFAULT '[]',        -- slugs an editor may change; ignored for owner/admin
  active          INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token           TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT,
  ip              TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (created_at);

-- Who changed what. Powers the History page and "Restore".
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER,
  user_email      TEXT,
  business_slug   TEXT,
  entity          TEXT NOT NULL,                     -- business, hours, hours_exception, event, menu_section, menu_item, announcement, inquiry, user, settings
  entity_id       TEXT,
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  summary         TEXT,                              -- one line for the History page, e.g. "Changed Saturday hours"
  before_json     TEXT,
  after_json      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_business ON audit_log (business_slug, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,                  -- e.g. "signage:peachs"
  value_json      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------------
-- Artwork catalog (Blanc). Added 2026-10-13; existing databases get these tables
-- from worker/migrations/2026-10-13-artworks.sql (safe to run more than once).
-- -------------------------------------------------------------------------

-- One piece of art. Linked to the exhibition (an events row) it hangs in, if any.
CREATE TABLE IF NOT EXISTS artworks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug   TEXT NOT NULL REFERENCES businesses(slug) ON DELETE CASCADE,
  event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  artist          TEXT,
  year            TEXT,                              -- free text: "2024", "c. 1968", "2019–2023"
  medium          TEXT,                              -- e.g. "Oil on canvas"
  dimensions      TEXT,                              -- e.g. "36 × 48 in."
  description     TEXT,
  price           REAL,                              -- USD; NULL = no price set
  price_display   TEXT NOT NULL DEFAULT 'on_request' CHECK (price_display IN ('show', 'on_request', 'hidden')),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'not_for_sale')),
  featured        INTEGER NOT NULL DEFAULT 0,
  published       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artworks_business ON artworks (business_slug, event_id, sort_order);

-- Photos of a piece, first = main photo. url is the full-size image (≤ 2000 px), thumb_url a ≤ 640 px copy.
CREATE TABLE IF NOT EXISTS artwork_images (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id      INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  thumb_url       TEXT,
  alt             TEXT,                              -- what the photo shows, for screen readers
  width           INTEGER,
  height          INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artwork_images_artwork ON artwork_images (artwork_id, sort_order);
