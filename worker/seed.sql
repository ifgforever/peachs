-- Rome's Joy admin: seed data.
-- Loads the real, current content of all seven businesses (as of 2026-10-13) into the
-- schema in worker/schema.sql. Apply after the schema:
--   npx wrangler d1 execute romesjoy-admin --local  --file worker/seed.sql   (local dev)
--   npx wrangler d1 execute romesjoy-admin --remote --file worker/seed.sql   (production, once)
--
-- Safe to re-run: every row has a fixed id or key. Leaf rows use INSERT OR REPLACE.
-- Parent rows (businesses, menu_sections) are upserted with ON CONFLICT ... DO UPDATE
-- instead, because REPLACE deletes the old row first and ON DELETE CASCADE would take
-- inquiries, events, announcements and staff-added menu items with it. Re-running puts
-- the seeded rows back to these values and leaves everything staff added in the admin
-- alone (including a business's notice, which this file never touches).
--
-- Sources, all in this repo:
--   Peach's        docs/content-inventory.md, assets/js/menu-data.js (menu updated 2/26, kids 3/26)
--   Catering       catering/index.html + catering/content-inventory.md (menu PDF rev. 12.25)
--   Blanc          blanc/index.html + blanc/content-inventory.md
--   Parkway Social parkway-social/index.html + content-inventory.md
--   Mise En Place  mise-en-place/index.html + content-inventory.md
--   R.J.C. Sausage rjc-sausage/index.html + content-inventory.md
--   Rome's Joy     romesjoy/index.html + content-inventory.md
--
-- Ids: Peach's menu sections 101-109 and items 1001-1067; catering sections 201-207 and
-- items 2001-2069; Blanc events 1-9; announcements 1-2. New rows added in the admin get
-- ids above these (AUTOINCREMENT keeps counting from the highest seeded id).
--
-- CONFIRM with the client before launch (nothing below is invented; these are gaps):
--   * Hours are not published for Rome's Joy Companies, Rome's Joy Catering, Mise En Place
--     or R.J.C. Sausage. Each is seeded as closed every day so no site shows wrong hours;
--     staff should enter the real office hours in the admin.
--   * Inboxes: ordering@romesjoy.com receives forms for Rome's Joy, Peach's, Catering and
--     R.J.C. Sausage; parkwaysocial@romesjoy.com for Parkway Social. Blanc and Mise En
--     Place publish no email, so their inquiry_emails is NULL and their forms will be
--     saved but not emailed until an inbox is entered.
--   * Catering allergen labels copied from the PDF look like copy-paste errors
--     (catering/content-inventory.md): Charred Tomato Cream Rigatoni lists shellfish; the
--     couscous salad and Greek salad bases were already cleaned up on the page (fish and
--     shellfish moved to the salmon and shrimp versions). Seeded as the page shows them.
--   * The dietary key the sites render is GF / V / DF only. Catering's vegan dishes (Cold
--     Garlic Chili Soba Noodle Salad, Spring Mix Salad, Curried Potatoes, Green Beans,
--     Vegan Muffins) are tagged V + DF, which is what vegan implies in that key.
--   * Catering equipment add-ons ($5.50/person disposables, $30 chafing racks) are not menu
--     items on the page and are not seeded.
--   * Blanc: the closing date of "What Shall I Do With My Dead?" is taken as six weeks
--     after the October 24, 2026 opening (December 5). Shows the gallery lists with a year
--     only (Loud & Clear 2026, code: KING ALFRED 2025, Water Lines 2025, litany 2025, The
--     (Mis)Education of Chicago 2024) and the 2019-2023 archive are not seeded because
--     events need a real start date. GuestBook's closing date is not published.
--   * Instagram @rjc.events is seeded as Rome's Joy Catering's account (client-supplied,
--     not linked from the live site). Rome's Joy Companies itself has no known accounts.
--   * Peach's "President Obama's Favorites" is a starred block on the printed menu; both
--     of its items are seeded as featured, as is Peach Cobbler.

-- ---------------------------------------------------------------------------
-- Businesses (sort_order is the order the hub and TV family list use)
-- ---------------------------------------------------------------------------

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'romesjoy', 'Rome''s Joy Companies', 'Rome''s Joy',
  'Chef Cliff Rome''s family of Bronzeville businesses',
  'Rome''s Joy Companies, founded by Chef Cliff Rome in 2000, is the family behind Peach''s, '
  || 'Rome''s Joy Catering, Parkway Social, Mise En Place, Blanc Art Gallery and R.J.C. Sausage'
  || ' Company, based at 4455 S. King Drive in Bronzeville.',
  '4455 S. King Drive', 'Chicago', 'IL', '60653', '773.373.4320',
  'ordering@romesjoy.com', 'ordering@romesjoy.com',
  'https://romesjoy.com/',
  NULL, NULL,
  'https://www.google.com/maps/search/?api=1&query=4455+S+King+Drive+Chicago+IL+60653',
  NULL,
  NULL,
  NULL, 1
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'peachs', 'Peach''s on 47th', 'Peach''s',
  'Southern breakfast and brunch in Bronzeville',
  'Southern breakfast and brunch at 4652 S. King Drive in Chicago''s Bronzeville.',
  '4652 S. King Drive', 'Chicago', 'IL', '60653', '773.966.5801',
  'ordering@romesjoy.com', 'ordering@romesjoy.com',
  'https://peachson47th.com/',
  'https://www.instagram.com/peachson47th/', 'https://www.facebook.com/Peachson47th/',
  'https://www.google.com/maps/search/?api=1&query=Peach%27s+4652+S+King+Dr+Chicago+IL+60653',
  'https://order.toasttab.com/online/peachs-restaurant-king-dr',
  NULL,
  NULL, 2
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'catering', 'Rome''s Joy Catering', 'Catering',
  'Full-service catering and event planning from Bronzeville',
  'Full-service catering and event planning from Chef Cliff Rome''s team in Bronzeville, '
  || 'Chicago: box lunches, hot lunch, brunch, dinner entrées and signature full pans.',
  '4455 S. King Drive', 'Chicago', 'IL', '60653', '773.373.4320',
  'ordering@romesjoy.com', 'ordering@romesjoy.com',
  'https://romesjoy.com/catering/',
  'https://www.instagram.com/rjc.events/', NULL,
  'https://www.google.com/maps/search/?api=1&query=4455+S+King+Drive+Chicago+IL+60653',
  NULL,
  NULL,
  NULL, 3
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'parkway-social', 'Parkway Social', 'Parkway Social',
  'Coworking lounge, social club and event space in the historic Parkway Ballroom',
  'Parkway Social is a member coworking lounge, social club and event space inside the '
  || 'historic Parkway Ballroom at 4455 S. King Drive in Bronzeville.',
  '4455 S. King Drive', 'Chicago', 'IL', '60653', '773.373.4320',
  'parkwaysocial@romesjoy.com', 'parkwaysocial@romesjoy.com',
  'https://parkwaysocialchicago.com/',
  'https://www.instagram.com/parkway.social/', NULL,
  'https://www.google.com/maps/search/?api=1&query=Parkway+Social+4455+S+King+Drive+Chicago+IL+60653',
  NULL,
  'https://parkwaysocial.coworksapp.com/tour-request/374',
  NULL, 4
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'mise-en-place', 'Mise En Place Chicago', 'Mise En Place',
  'Investing in our future before they step up to the plate',
  'Mise En Place Chicago (formerly Before The Plate) is a three-tier culinary and '
  || 'hospitality training program for Chicagoans ages 16 to 36, led by Chef Clifford Rome at '
  || 'the Parkway Ballroom.',
  '4455 S. King Drive', 'Chicago', 'IL', '60653', '773.373.4320',
  NULL, NULL,
  'https://miseenplacechicago.org/',
  NULL, 'https://www.facebook.com/miseenplacechi/',
  'https://www.google.com/maps/search/?api=1&query=4455+S+King+Drive+Chicago+IL+60653',
  NULL,
  NULL,
  NULL, 5
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'blanc', 'Blanc Gallery', 'Blanc',
  'A Culture of Conversation',
  'Blanc is a contemporary art gallery at 4445 S. King Drive in Chicago''s Bronzeville, '
  || 'founded by Cliff Rome and Eileen Rhodes to engage African Americans and all Chicagoans '
  || 'through the arts.',
  '4445 S. King Drive', 'Chicago', 'IL', '60653', '773.373.4320',
  NULL, NULL,
  'https://blancchicago.com/',
  'https://www.instagram.com/blancgallerychicago/', NULL,
  'https://www.google.com/maps/search/?api=1&query=Blanc+Gallery+4445+S+King+Dr+Chicago+IL+60653',
  NULL,
  'https://www.eventbrite.com/e/opening-reception-what-shall-i-do-with-my-dead-tickets-2001272755685',
  'and by appointment', 6
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

INSERT INTO businesses
  (slug, name, short_name, tagline, description, address1, city, state, zip, phone, public_email,
   inquiry_emails, website_url, instagram_url, facebook_url, map_url, order_url, book_url,
   hours_note, sort_order)
VALUES (
  'rjc-sausage', 'R.J.C. Sausage Company', 'R.J.C. Sausage',
  'Halal Zabiha certified chicken sausage and patties made in Bronzeville',
  'R.J.C. Sausage Company makes all-natural, Halal Zabiha certified chicken sausage and '
  || 'patties in Chicago''s Bronzeville neighborhood for restaurants, grocers, schools and '
  || 'caterers.',
  '4455 S. King Drive', 'Chicago', 'IL', '60653', '773-373-4320',
  NULL, 'ordering@romesjoy.com',
  NULL,
  NULL, NULL,
  'https://www.google.com/maps/search/?api=1&query=4455+S+King+Drive+Chicago+IL+60653',
  NULL,
  NULL,
  NULL, 7
)
ON CONFLICT (slug) DO UPDATE SET
  name = excluded.name, short_name = excluded.short_name, tagline = excluded.tagline,
  description = excluded.description, address1 = excluded.address1, city = excluded.city,
  state = excluded.state, zip = excluded.zip, phone = excluded.phone,
  public_email = excluded.public_email, inquiry_emails = excluded.inquiry_emails,
  website_url = excluded.website_url, instagram_url = excluded.instagram_url,
  facebook_url = excluded.facebook_url, map_url = excluded.map_url, order_url = excluded.order_url,
  book_url = excluded.book_url, hours_note = excluded.hours_note, sort_order = excluded.sort_order,
  updated_at = datetime('now');

-- ---------------------------------------------------------------------------
-- Weekly hours: 7 rows per business, weekday 0 = Sunday, minutes after midnight
-- ---------------------------------------------------------------------------

-- Rome's Joy Companies. CONFIRM: hours not published; closed until staff enter them.
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('romesjoy', 1, 1, NULL, NULL),          -- Monday
  ('romesjoy', 2, 1, NULL, NULL),          -- Tuesday
  ('romesjoy', 3, 1, NULL, NULL),          -- Wednesday
  ('romesjoy', 4, 1, NULL, NULL),          -- Thursday
  ('romesjoy', 5, 1, NULL, NULL),          -- Friday
  ('romesjoy', 6, 1, NULL, NULL),          -- Saturday
  ('romesjoy', 0, 1, NULL, NULL);          -- Sunday

-- Peach's on 47th: Wednesday - Sunday, 8 am - 2 pm (peachson47th.com)
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('peachs', 1, 1, NULL, NULL),            -- Monday
  ('peachs', 2, 1, NULL, NULL),            -- Tuesday
  ('peachs', 3, 0, 480, 840),              -- Wednesday
  ('peachs', 4, 0, 480, 840),              -- Thursday
  ('peachs', 5, 0, 480, 840),              -- Friday
  ('peachs', 6, 0, 480, 840),              -- Saturday
  ('peachs', 0, 0, 480, 840);              -- Sunday

-- Rome's Joy Catering. CONFIRM: hours not published; closed until staff enter them.
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('catering', 1, 1, NULL, NULL),          -- Monday
  ('catering', 2, 1, NULL, NULL),          -- Tuesday
  ('catering', 3, 1, NULL, NULL),          -- Wednesday
  ('catering', 4, 1, NULL, NULL),          -- Thursday
  ('catering', 5, 1, NULL, NULL),          -- Friday
  ('catering', 6, 1, NULL, NULL),          -- Saturday
  ('catering', 0, 1, NULL, NULL);          -- Sunday

-- Parkway Social: Monday - Friday, 8:30 am - 5 pm (site footer)
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('parkway-social', 1, 0, 510, 1020),     -- Monday
  ('parkway-social', 2, 0, 510, 1020),     -- Tuesday
  ('parkway-social', 3, 0, 510, 1020),     -- Wednesday
  ('parkway-social', 4, 0, 510, 1020),     -- Thursday
  ('parkway-social', 5, 0, 510, 1020),     -- Friday
  ('parkway-social', 6, 1, NULL, NULL),    -- Saturday
  ('parkway-social', 0, 1, NULL, NULL);    -- Sunday

-- Mise En Place Chicago. CONFIRM: hours not published; closed until staff enter them.
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('mise-en-place', 1, 1, NULL, NULL),     -- Monday
  ('mise-en-place', 2, 1, NULL, NULL),     -- Tuesday
  ('mise-en-place', 3, 1, NULL, NULL),     -- Wednesday
  ('mise-en-place', 4, 1, NULL, NULL),     -- Thursday
  ('mise-en-place', 5, 1, NULL, NULL),     -- Friday
  ('mise-en-place', 6, 1, NULL, NULL),     -- Saturday
  ('mise-en-place', 0, 1, NULL, NULL);     -- Sunday

-- Blanc Gallery: Saturday & Sunday, 11 am - 3 pm, and by appointment (hours_note)
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('blanc', 1, 1, NULL, NULL),             -- Monday
  ('blanc', 2, 1, NULL, NULL),             -- Tuesday
  ('blanc', 3, 1, NULL, NULL),             -- Wednesday
  ('blanc', 4, 1, NULL, NULL),             -- Thursday
  ('blanc', 5, 1, NULL, NULL),             -- Friday
  ('blanc', 6, 0, 660, 900),               -- Saturday
  ('blanc', 0, 0, 660, 900);               -- Sunday

-- R.J.C. Sausage Company. CONFIRM: hours not published; closed until staff enter them.
INSERT OR REPLACE INTO hours (business_slug, weekday, closed, open_min, close_min) VALUES
  ('rjc-sausage', 1, 1, NULL, NULL),       -- Monday
  ('rjc-sausage', 2, 1, NULL, NULL),       -- Tuesday
  ('rjc-sausage', 3, 1, NULL, NULL),       -- Wednesday
  ('rjc-sausage', 4, 1, NULL, NULL),       -- Thursday
  ('rjc-sausage', 5, 1, NULL, NULL),       -- Friday
  ('rjc-sausage', 6, 1, NULL, NULL),       -- Saturday
  ('rjc-sausage', 0, 1, NULL, NULL);       -- Sunday

-- ---------------------------------------------------------------------------
-- Peach's on 47th menu (assets/js/menu-data.js; restaurant menu updated 2/26, kids 3/26)
-- ---------------------------------------------------------------------------

-- Peach's Plates
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (101, 'peachs', 'Peach''s Plates', 'Peach''s Plates', NULL, 1, 1)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1001, 101, 'Fried Catfish, Greens & Grits', NULL, 23, NULL,
   'Cornmeal & flour fried catfish with grits & collard greens',
   '[]', '[]', 0, 1, 1),
  (1002, 101, 'Bayou Breakfast Bowl', NULL, 24, NULL,
   'Shrimp, alligator sausage, potatoes, green peppers, onion, mushrooms, tomatoes, '
   || 'scallions, & cheddar cheese with your choice of egg on top and a side of chicken gravy',
   '[]', '[]', 0, 1, 2),
  (1003, 101, 'Breakfast Bowl', NULL, 17, NULL,
   'Potatoes, green peppers, onions, mushrooms, tomatoes, cheddar cheese & a scallion '
   || 'garnish with your choice of egg',
   '["GF","V"]', '[]', 0, 1, 3),
  (1004, 101, 'Hangover Plate', NULL, 20, NULL,
   'Fried chicken thighs tossed in our signature sweet & spicy hangover sauce, served with '
   || '(2) eggs any style & a cup of grits. Upgrade to all wings for $1',
   '[]', '[]', 0, 1, 4),
  (1005, 101, 'Biscuit & Gravy', NULL, 12, NULL,
   'Homemade biscuit smothered with chicken sausage, green peppers & chicken gravy',
   '[]', '[]', 0, 1, 5),
  (1006, 101, 'Peach''s Special', NULL, 20, NULL,
   '(2) eggs any style with a choice of meat (pork/turkey bacon or pork sausage links), '
   || 'house potatoes or grits & pancakes or toast. Upgrade meat options available',
   '[]', '[]', 0, 1, 6),
  (1007, 101, 'Yardbird & Sweet Toast', NULL, 18, NULL,
   'Fried chicken thighs with cinnamon french toast & sweet honey butter',
   '[]', '[]', 0, 1, 7),
  (1008, 101, '“The Big Bird”', NULL, 19, NULL,
   'Chicken sausage patties, duck bacon, gouda cheese, one egg any style on a Peach''s '
   || 'homemade biscuit with a side of peach bourbon compote. Served with a choice of grits or '
   || 'house potatoes',
   '[]', '[]', 0, 1, 8),
  (1009, 101, 'Southern Benedict', NULL, 18, NULL,
   'Chicken gravy, chicken sausage patties, (2) poached eggs served on top of our freshly '
   || 'made biscuits',
   '[]', '[]', 0, 1, 9),
  (1010, 101, '“This Cluck’n Biscuit”', NULL, 10, NULL,
   'Chicken sausage patties served on a Peach''s homemade biscuit with a side of peach '
   || 'bourbon compote. Add 1 egg for $3.50',
   '[]', '[]', 0, 1, 10),
  (1011, 101, 'Avocado Toast', NULL, 11, NULL,
   'Avocado, cherry tomatoes, micro greens, feta, & balsamic glaze on toast. Add 1 egg for '
   || '$3.50',
   '["V"]', '[]', 0, 1, 11),
  (1012, 101, 'DLT Sandwich', NULL, 15, NULL,
   'Duck bacon, spinach, & tomatoes with creole sauce on sourdough toast. Add 1 egg for '
   || '$3.50 and choice of cheese for $2',
   '[]', '[]', 0, 1, 12),
  (1013, 101, 'Hangover Chicken Wings & Fries', NULL, 17, NULL,
   '(4) Fried chicken wings tossed in our signature sweet & spicy hangover sauce with french'
   || ' fries',
   '[]', '[]', 0, 1, 13),
  (1014, 101, 'Duck Bowl', NULL, 19, NULL,
   'One egg any style with potatoes, green peppers, onion, spinach, cheddar cheese, & duck '
   || 'bacon',
   '["GF"]', '[]', 0, 1, 14);

-- President Obama's Favorites
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (102, 'peachs', 'President Obama''s Favorites', 'Obama''s Favorites', NULL, 1, 2)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1015, 102, 'Peach''s Shrimp & Grits', NULL, 24, NULL,
   'Shrimp with garlic cream sauce, pork bacon, mushrooms, tomatoes, scallions on top of '
   || 'cheese or plain grits. Served with garlic Texas toast',
   '[]', '[]', 1, 1, 1),
  (1016, 102, 'Salmon Croquettes & Grits', NULL, 23, NULL,
   'Wild caught, fresh baked salmon croquettes served on top of cheese or plain grits',
   '["DF","GF"]', '[]', 1, 1, 2);

-- Pancakes & French Toast
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (103, 'peachs', 'Pancakes & French Toast', 'Pancakes & French Toast',
  'Ask your server about our seasonal specials.', 1, 3)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1017, 103, '7-Up Pancakes', 'Short stack', 12, NULL,
   'Served with lemon cream cheese frosting',
   '[]', '[]', 0, 1, 1),
  (1018, 103, 'Peach Bourbon French Toast', '6 wedges', 14, NULL, NULL, '[]', '[]', 0, 1, 2),
  (1019, 103, 'Banana Rum French Toast', '6 wedges', 14, NULL, NULL, '[]', '[]', 0, 1, 3),
  (1020, 103, 'Pancakes', NULL, NULL, '[{"label":"Side","value":6},{"label":"Short","value":9},{"label":"Full","value":12}]',
   NULL,
   '[]', '[]', 0, 1, 4),
  (1021, 103, 'Gluten-Free Pancakes', NULL, NULL, '[{"label":"Short","value":12},{"label":"Full","value":15}]',
   NULL,
   '[]', '[]', 0, 1, 5),
  (1022, 103, 'French Toast', NULL, NULL, '[{"label":"Side","value":6},{"label":"Full","value":12}]',
   NULL,
   '[]', '[]', 0, 1, 6),
  (1023, 103, 'Toppings', NULL, 3, NULL, 'Banana rum, blueberry lemon, & peach compote', '[]', '[]', 0, 1, 7),
  (1024, 103, 'Add Brown Sugar Crumbles', NULL, 2, NULL, NULL, '["GF"]', '[]', 0, 1, 8);

-- Omelettes
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (104, 'peachs', 'Omelettes', 'Omelettes',
  'Served with a choice of fruit cup, grits, or house potatoes.', 1, 4)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1025, 104, 'The Soul Queen Salmon Omelette', NULL, 20, NULL,
   'Salmon, green peppers, gouda cheese, & capers on the side',
   '["GF"]', '[]', 0, 1, 1),
  (1026, 104, 'Healthy Start Omelette', NULL, 19, NULL,
   '(2) egg whites with spinach, tomatoes, mushrooms, onions, green peppers, feta cheese',
   '["GF","V"]', '[]', 0, 1, 2),
  (1027, 104, 'DIY Omelette', NULL, 18, NULL,
   'Choose (1) protein, (1) cheese, & (1) veggie. Add chicken sausage (+3); salmon or shrimp'
   || ' (+5). Additional veggies (+1)',
   '["GF"]', '[]', 0, 1, 3);

-- Meat & Seafood
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (105, 'peachs', 'Meat & Seafood', 'Meat & Seafood', NULL, 1, 5)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1028, 105, 'Applewood Smoked Pork Bacon', '(3)', 5, NULL, NULL, '[]', '[]', 0, 1, 1),
  (1029, 105, 'Turkey Bacon', '(3)', 4, NULL, NULL, '[]', '[]', 0, 1, 2),
  (1030, 105, 'Pork Sausage Links', '(3)', 4, NULL, NULL, '[]', '[]', 0, 1, 3),
  (1031, 105, 'Chicken Sausage Patties', '(2)', 5, NULL, NULL, '[]', '[]', 0, 1, 4),
  (1032, 105, 'Side Salmon Croquette', '(1)', 8, NULL, NULL, '[]', '[]', 0, 1, 5),
  (1033, 105, 'Side Catfish Fillet', '(1)', 8, NULL, NULL, '[]', '[]', 0, 1, 6),
  (1034, 105, 'Shrimp & Sauce', '(3)', 7, NULL, NULL, '[]', '[]', 0, 1, 7),
  (1035, 105, 'Fried Chicken Wings', '(4)', 8, NULL, NULL, '[]', '[]', 0, 1, 8),
  (1036, 105, 'Fried Chicken Thighs', '(2)', 9, NULL, NULL, '[]', '[]', 0, 1, 9),
  (1037, 105, 'Duck Bacon', '(3)', 7, NULL, NULL, '[]', '[]', 0, 1, 10);

-- Peach's on the Side
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (106, 'peachs', 'Peach''s on the Side', 'On the Side', NULL, 1, 6)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1038, 106, 'One Egg, Any Style', NULL, 3.5, NULL, NULL, '[]', '[]', 0, 1, 1),
  (1039, 106, 'Plain Grits', NULL, 3, NULL, NULL, '["GF","V"]', '[]', 0, 1, 2),
  (1040, 106, 'Cheese Grits', NULL, 4, NULL, NULL, '["GF","V"]', '[]', 0, 1, 3),
  (1041, 106, 'Chicken Gravy', NULL, 4, NULL, NULL, '[]', '[]', 0, 1, 4),
  (1042, 106, 'Greens', NULL, 4, NULL, NULL, '["GF"]', '[]', 0, 1, 5),
  (1043, 106, 'Fresh Fruit Cup', NULL, 8, NULL, NULL, '[]', '[]', 0, 1, 6),
  (1044, 106, 'House Potatoes', NULL, 3, NULL, NULL, '["GF","V"]', '[]', 0, 1, 7),
  (1045, 106, 'Biscuit', NULL, 4, NULL, NULL, '[]', '[]', 0, 1, 8),
  (1046, 106, 'Oatmeal & Peach Bourbon Compote', NULL, 4, NULL, NULL, '[]', '[]', 0, 1, 9),
  (1047, 106, 'Fries', NULL, 7, NULL, NULL, '["GF"]', '[]', 0, 1, 10),
  (1048, 106, 'Toast', NULL, 5, NULL, 'Sourdough, wheat, white, raisin, Texas toast', '[]', '[]', 0, 1, 11),
  (1049, 106, 'Fruit Topping', NULL, 2, NULL, 'Strawberries, blueberries or bananas', '["GF"]', '[]', 0, 1, 12);

-- The Sweet Spot @ Peach's
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (107, 'peachs', 'The Sweet Spot @ Peach''s', 'Sweet Spot', 'Subject to availability.', 1, 7)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1050, 107, 'Peach Cobbler', NULL, 9, NULL, NULL, '[]', '[]', 1, 1, 1),
  (1051, 107, 'Happy Biscuit', NULL, 5, NULL, 'House-made biscuit served with peach compote', '[]', '[]', 0, 1, 2);

-- Beverages
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (108, 'peachs', 'Beverages', 'Beverages', NULL, 1, 8)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1052, 108, 'Freshly Brewed Coffee', NULL, 3.5, NULL, 'Peach or Buffalo Soldier, unflavored', '[]', '[]', 0, 1, 1),
  (1053, 108, 'Hot Tea', NULL, 3, NULL, NULL, '[]', '[]', 0, 1, 2),
  (1054, 108, 'Peach Palmer', NULL, 6, NULL, NULL, '[]', '[]', 0, 1, 3),
  (1055, 108, 'Strawberry Lemonade', NULL, 6, NULL, NULL, '[]', '[]', 0, 1, 4),
  (1056, 108, 'Hot Chocolate', NULL, 5, NULL, NULL, '[]', '[]', 0, 1, 5),
  (1057, 108, 'Whole Milk', NULL, 2, NULL, NULL, '[]', '[]', 0, 1, 6),
  (1058, 108, 'Apple Juice', NULL, 4, NULL, NULL, '[]', '[]', 0, 1, 7),
  (1059, 108, 'Orange Juice', NULL, 3.5, NULL, NULL, '[]', '[]', 0, 1, 8),
  (1060, 108, 'Pellegrino', NULL, 4, NULL, NULL, '[]', '[]', 0, 1, 9),
  (1061, 108, 'Ice Mountain Water', NULL, 3, NULL, NULL, '[]', '[]', 0, 1, 10),
  (1062, 108, 'Soda', NULL, 3, NULL, NULL, '[]', '[]', 0, 1, 11),
  (1063, 108, 'Peach''s Coffee at Home', '1/2 lb', 14, NULL,
   'Whole bean or ground. Roasts: Peach, Coconut, Jamaican Rum, Buffalo Soldier. Subject to '
   || 'availability',
   '[]', '[]', 0, 1, 12);

-- Kids Menu
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (109, 'peachs', 'Kids Menu', 'Kids', 'For kids 12 and under.', 1, 9)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (1064, 109, 'Chicken Littles', NULL, 10.5, NULL,
   '(3-4) crispy chicken tenders with golden fries',
   '[]', '[]', 0, 1, 1),
  (1065, 109, 'Strawberry Shortcakes', NULL, 10, NULL,
   '(2) fluffy pancakes topped with freshly sliced strawberries, fluffy whipped cream, and '
   || 'sprinkles of powdered sugar, with your choice of bacon or sausage links (2)',
   '[]', '[]', 0, 1, 2),
  (1066, 109, 'French Toast Special', NULL, 8.5, NULL,
   '(2) pieces of french toast, (2) strips of bacon, and one egg',
   '[]', '[]', 0, 1, 3),
  (1067, 109, 'Mickey Mouse Pancake', NULL, 8.5, NULL,
   'A smiling, fluffy Mickey Mouse pancake with your choice of bacon or sausage links (2)',
   '[]', '[]', 0, 1, 4);

-- ---------------------------------------------------------------------------
-- Rome's Joy Catering menu (catering/index.html, from the PDF rev. 12.25)
-- Per-person sections need a minimum of 10 orders per selection; full pans feed up to 20.
-- ---------------------------------------------------------------------------

-- Salads
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (201, 'catering', 'Salads', 'Salads', 'Per person · minimum 10 orders per selection', 1, 1)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2001, 201, 'Thai Herbed Couscous & Shaved Carrot Salad', 'Per person', 12, NULL,
   'Toasted pearl couscous, garlic vinaigrette, shaved carrots, cilantro, mint, basil, red '
   || 'chili pepper, green onion',
   '["V"]', '["Wheat","Soy"]', 0, 1, 1),
  (2002, 201, 'Grilled Chicken Thai Herbed Couscous Salad', 'Per person', 15, NULL,
   'The couscous and shaved carrot salad with grilled chicken',
   '[]', '["Wheat","Soy"]', 0, 1, 2),
  (2003, 201, 'Garlic Soy Glaze Salmon Couscous Salad', 'Per person', 17, NULL,
   'The couscous and shaved carrot salad with garlic soy glazed salmon',
   '[]', '["Wheat","Soy","Fish"]', 0, 1, 3),
  (2004, 201, 'Mediterranean Greek Salad', 'Per person', 18, NULL,
   'Lemon-dressed romaine, scallions, parsley, cucumber, marinated cherry tomatoes, red '
   || 'onion, kalamata olives, feta, crispy chickpeas',
   '["GF","V"]', '["Dairy","Legumes"]', 0, 1, 4),
  (2005, 201, 'Harissa Garlic Grilled Shrimp Greek Salad', 'Per person', 23, NULL,
   'The Mediterranean Greek salad topped with harissa garlic grilled shrimp',
   '[]', '["Dairy","Legumes","Shellfish"]', 0, 1, 5),
  (2006, 201, 'Crispy Chickpea Fritters Greek Salad', 'Per person', 20.5, NULL,
   'The Mediterranean Greek salad topped with crispy chickpea fritters',
   '[]', '["Dairy","Legumes"]', 0, 1, 6),
  (2007, 201, 'Grilled Lemon Oregano Chicken Greek Salad', 'Per person', 23, NULL,
   'The Mediterranean Greek salad topped with lemon oregano chicken',
   '[]', '["Dairy","Legumes"]', 0, 1, 7),
  (2008, 201, 'Spicy Southwest Chicken Salad', 'Per person', 15, NULL,
   'Romaine, grilled chicken, fire-roasted tomatoes, black beans, roasted corn, cilantro, '
   || 'garlic confit, chipotle dressing, tortilla crisps',
   '[]', '["Dairy"]', 0, 1, 8),
  (2009, 201, 'Cold Garlic Chili Soba Noodle Salad', 'Per person', 12, NULL,
   'With a cabbage matchstick slaw of cucumbers, carrots, red bell pepper and red cabbage',
   '["V","DF"]', '["Gluten"]', 0, 1, 9),
  (2010, 201, 'Chilled Italian Pasta Salad', 'Per person', 12, NULL,
   'Garlic confit pasta, cherry tomatoes, bell pepper, pepperoncini, kalamata olives, '
   || 'parmesan, mozzarella, spinach, shallots, pepperoncini dressing',
   '[]', '["Dairy","Gluten"]', 0, 1, 10),
  (2011, 201, 'Chilled Quinoa Salad', 'Per person', 13, NULL,
   'Roasted spiced sweet potatoes, marinated tomato, roasted chickpeas, red onion, pumpkin '
   || 'seed, feta, mint, roasted red pepper dressing',
   '[]', '["Dairy"]', 0, 1, 11),
  (2012, 201, 'Chilled Pistachio Pesto Pasta Salad', 'Per person', 14, NULL,
   'Green beans, garlic confit pasta, pesto, spinach, lemon zest, olive oil, mozzarella',
   '[]', '["Tree nuts","Dairy","Gluten"]', 0, 1, 12);

-- Hot lunch & pasta
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (202, 'catering', 'Hot lunch & pasta', 'Hot lunch & pasta',
  'Per person · minimum 10 orders per selection', 1, 2)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2013, 202, 'Build Your Own Southern Croquette Bowl', 'Per person', 25, NULL,
   'Creamy grits or house potatoes, fried salmon croquettes, fried catfish nuggets, greens, '
   || 'roasted tomato remoulade',
   '[]', '["Fish","Dairy","Gluten","Eggs"]', 0, 1, 1),
  (2014, 202, 'Salmon Croquettes & Roasted Red Pepper Creole Sauce', 'Per person', 18, NULL,
   NULL,
   '[]', '[]', 0, 1, 2),
  (2015, 202, 'Crispy Brown Butter Fried Catfish', 'Per person', 15, NULL,
   'With lemon caper cream sauce',
   '[]', '[]', 0, 1, 3),
  (2016, 202, 'Smothered Herb Roasted Chicken Thighs', 'Per person', 14, NULL, NULL, '[]', '[]', 0, 1, 4),
  (2017, 202, 'Slow Braised Southern Greens with Smoked Turkey', 'Per person', 11, NULL, NULL, '[]', '[]', 0, 1, 5),
  (2018, 202, 'Slow Simmered Black Eyed Peas', 'Per person', 10, NULL,
   'With scallion chili butter',
   '[]', '[]', 0, 1, 6),
  (2019, 202, 'Herb Parmesan Crispy House Potatoes', 'Per person', 10, NULL,
   'With smoked paprika aioli',
   '[]', '[]', 0, 1, 7),
  (2020, 202, 'Buttery Cornbread', 'Per person', 8, NULL, 'Served with whipped honey butter', '[]', '[]', 0, 1, 8),
  (2021, 202, 'Garlic Butter Shrimp Spaghetti Aglio e Olio', 'Per person', 20, NULL,
   'Lemon chili gremolata, garlic oil, Calabrian chili, parsley, lemon',
   '[]', '[]', 0, 1, 9),
  (2022, 202, 'Charred Tomato Cream Rigatoni', 'Per person', 18, NULL,
   'Tomato cream, whipped mascarpone, basil, crispy shallots, creamy burrata',
   '[]', '["Shellfish","Dairy","Gluten"]', 0, 1, 10),
  (2023, 202, 'Four Cheese Garlic Shell Pasta', 'Per person', 16, NULL,
   'Sharp white cheddar, fontina, parmesan and asiago, with crispy herbs',
   '[]', '["Dairy","Gluten"]', 0, 1, 11);

-- Box lunches
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (203, 'catering', 'Box lunches', 'Box lunches',
  'Per person · each box comes with a bag of chips and a cookie', 1, 3)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2024, 203, 'Southern Club Turkey BLT', 'Per person', 18, NULL,
   'Smoked turkey breast, brown sugar turkey bacon, butter lettuce, tomato, remoulade mayo',
   '[]', '["Wheat","Dairy","Eggs"]', 0, 1, 1),
  (2025, 203, 'Southern Salmon Croquette Salad', 'Per person', 18, NULL,
   'Salmon croquette on mixed greens, cherry tomatoes, cucumber, red onion, feta, lemon '
   || 'vinaigrette on the side',
   '[]', '["Dairy","Fish"]', 0, 1, 2),
  (2026, 203, 'Black Eye Peas & Roasted Veggie Grain Bowl', 'Per person', 12, NULL,
   'Chilled farro bowl, roasted sweet potato, matchstick veggies, spinach, spicy cashew '
   || 'dressing',
   '[]', '["Dairy","Tree nuts"]', 0, 1, 3),
  (2027, 203, 'Hot Honey Chicken Sandwich', 'Per person', 15, NULL,
   'Blackened chicken breast, red cabbage slaw, hot honey vinaigrette',
   '[]', '["Dairy","Gluten"]', 0, 1, 4),
  (2028, 203, 'Blackened Catfish Caesar Salad', 'Per person', 20, NULL,
   'Baby romaine, cornbread crumble, parmesan, black pepper Caesar dressing',
   '[]', '["Dairy"]', 0, 1, 5);

-- Dinner entrées
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (204, 'catering', 'Dinner entrées', 'Dinner entrées',
  'Per person · minimum 10 orders per selection', 1, 4)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2029, 204, 'Creole Blackened Salmon with Citrus Beurre Blanc', 'Per person', 23, NULL,
   'Creamy mashed potatoes, grilled baby broccolini',
   '[]', '["Dairy","Fish"]', 0, 1, 1),
  (2030, 204, 'Coconut Curry Braised Short Ribs', 'Per person', 25, NULL,
   'Ginger jasmine rice, sautéed garlic bok choy or Southern greens',
   '[]', '["Soy","Dairy"]', 0, 1, 2),
  (2031, 204, 'Mushroom Marsala Cream Chicken', 'Per person', 15, NULL,
   'With parmesan and rosemary roasted potatoes',
   '[]', '["Dairy","Mushrooms"]', 0, 1, 3),
  (2032, 204, 'Citrus Herb Roasted Chicken Quarters', 'Per person', 15, NULL,
   'Calabrian chili butter, chicken jus vinaigrette, tarragon yogurt',
   '[]', '["Dairy"]', 0, 1, 4),
  (2033, 204, 'Roasted Cauliflower Steaks', 'Per person', 15, NULL,
   'Romesco and chimichurri, creamy white bean purée, charred baby broccolini',
   '["V"]', '["Dairy"]', 0, 1, 5),
  (2034, 204, 'Creamy Wild Mushroom Risotto', 'Per person', 17, NULL,
   'Topped with crispy leeks and parmesan',
   '["V"]', '["Dairy"]', 0, 1, 6),
  (2035, 204, 'Thai Green Curry Braised Chickpeas', 'Per person', 15, NULL,
   'Coconut jasmine rice, Thai basil, mint, red chili pepper, cilantro, lime',
   '["V"]', '["Chickpeas"]', 0, 1, 7),
  (2036, 204, 'Harissa Roasted Sweet Potato & Crispy Brussels Sprout Salad', 'Per person', 13, NULL,
   'With lemon tahini sauce',
   '["V"]', '["Dairy"]', 0, 1, 8);

-- Brunch
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (205, 'catering', 'Brunch', 'Brunch', 'Per person · minimum 10 orders per selection', 1, 5)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2037, 205, 'Fried Chicken and Waffles', 'Per person', 18, NULL,
   'With bourbon peach glaze',
   '[]', '["Dairy"]', 0, 1, 1),
  (2038, 205, 'Overnight Custard French Toast', 'Per person', 12, NULL,
   'With brown sugar crumble',
   '[]', '["Dairy"]', 0, 1, 2),
  (2039, 205, 'Chicken Sausage Biscuit', 'Per person', 14, NULL,
   'With maple brown butter',
   '[]', '["Dairy"]', 0, 1, 3),
  (2040, 205, 'Salmon Croquettes & Roasted Red Pepper Creole Sauce', 'Per person', 18, NULL,
   NULL,
   '[]', '["Dairy","Fish"]', 0, 1, 4),
  (2041, 205, 'Croissant Sandwiches', 'Per person', 15, NULL,
   'Turkey, pesto aioli, spicy tomato confit, arugula',
   '[]', '[]', 0, 1, 5),
  (2042, 205, 'Seasonal Sliced Fresh Fruit', 'Per person', 10, NULL, NULL, '[]', '[]', 0, 1, 6),
  (2043, 205, 'Applewood Smoked Bacon', '2 pieces per person', 7, NULL, NULL, '[]', '[]', 0, 1, 7),
  (2044, 205, 'Turkey Bacon', '2 pieces per person', 8, NULL, NULL, '[]', '[]', 0, 1, 8),
  (2045, 205, 'Chicken Sausage', '2 pieces per person', 8, NULL, NULL, '[]', '[]', 0, 1, 9),
  (2046, 205, 'Duck Bacon', '2 pieces per person', 10, NULL, NULL, '[]', '[]', 0, 1, 10);

-- Signature full pans
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (206, 'catering', 'Signature full pans', 'Signature full pans',
  'Each full pan feeds up to 20 people', 1, 6)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2047, 206, 'Caesar Salad', 'Full pan', 85, NULL,
   'Romaine, sliced red onions, croutons, parmesan, Caesar dressing',
   '["V"]', '["Dairy","Gluten"]', 0, 1, 1),
  (2048, 206, 'Spring Mix Salad', 'Full pan', 85, NULL,
   'Spring mix, shaved almonds, dried fruit, raspberry vinaigrette',
   '["GF","V","DF"]', '["Nuts"]', 0, 1, 2),
  (2049, 206, 'Bowtie Pasta', 'Full pan', 185, NULL,
   'Mushrooms, cherry tomatoes, zucchini, peppers, garlic cream sauce, olive oil',
   '["V"]', '["Gluten","Dairy"]', 0, 1, 3),
  (2050, 206, 'Bowtie Pasta with Chicken', 'Full pan', 238, NULL,
   'The bowtie pasta with chicken',
   '[]', '["Gluten","Dairy"]', 0, 1, 4),
  (2051, 206, 'Bowtie Pasta with Shrimp', 'Full pan', 274, NULL,
   'The bowtie pasta with shrimp',
   '[]', '["Gluten","Dairy"]', 0, 1, 5),
  (2052, 206, 'Char-grilled Moroccan Chicken', 'Full pan', 220, NULL,
   'With shaved jalapeño and chopped cilantro',
   '[]', '[]', 0, 1, 6),
  (2053, 206, 'Fried Catfish', 'Full pan', 124, NULL, NULL, '[]', '["Fish"]', 0, 1, 7),
  (2054, 206, 'Southern Greens with Smoked Turkey', 'Full pan', 84, NULL, NULL, '[]', '[]', 0, 1, 8),
  (2055, 206, 'Oven-roasted Curried Potatoes', 'Full pan', 95, NULL, NULL, '["GF","V","DF"]', '[]', 0, 1, 9),
  (2056, 206, 'Sautéed Green Beans', 'Full pan', 112, NULL,
   'With roasted peppers, garlic and red onion',
   '["GF","V","DF"]', '[]', 0, 1, 10),
  (2057, 206, 'Homemade Biscuits', '20 pieces', 130, NULL, NULL, '["V"]', '[]', 0, 1, 11);

-- Desserts & drinks
INSERT INTO menu_sections (id, business_slug, title, short_title, description, published, sort_order)
VALUES (207, 'catering', 'Desserts & drinks', 'Desserts & drinks', 'Priced as listed', 1, 7)
ON CONFLICT (id) DO UPDATE SET business_slug = excluded.business_slug, title = excluded.title,
  short_title = excluded.short_title, description = excluded.description,
  published = excluded.published, sort_order = excluded.sort_order;
INSERT OR REPLACE INTO menu_items
  (id, section_id, name, portion, price, prices_json, description, tags_json, allergens_json,
   featured, available, sort_order)
VALUES
  (2058, 207, 'Chocolate Chip Cookie', 'Each', 4.3, NULL, NULL, '[]', '["Gluten","Dairy"]', 0, 1, 1),
  (2059, 207, 'Gluten-Free Chocolate Chip Cookie', 'Each', 4.5, NULL, NULL, '[]', '[]', 0, 1, 2),
  (2060, 207, 'Mini Brownies', '48 pre-cut, 1×1 inch', 75, NULL, NULL, '[]', '["Gluten","Dairy"]', 0, 1, 3),
  (2061, 207, 'Mini Carrot Cake', 'Sheet pan, up to 30 pieces', 112.5, NULL,
   NULL,
   '[]', '["Gluten","Dairy"]', 0, 1, 4),
  (2062, 207, 'Assorted Muffins', 'One dozen', 27, NULL,
   'Blueberry, banana nut, chocolate chip',
   '[]', '["Gluten","Dairy","Nuts"]', 0, 1, 5),
  (2063, 207, 'Assorted Vegan Muffins', 'One dozen', 27, NULL,
   'Blueberry, banana nut, chocolate chip',
   '["V","DF"]', '["Nuts"]', 0, 1, 6),
  (2064, 207, 'Assorted Mini Danishes', 'One dozen', 32, NULL,
   'Cheese, apple, raspberry, lemon',
   '[]', '["Gluten","Dairy"]', 0, 1, 7),
  (2065, 207, 'Coffee or Decaf', '96 oz, serves up to 12', 35, NULL, NULL, '[]', '[]', 0, 1, 8),
  (2066, 207, 'Assorted Hot Teas', '12 tea bags and one hot water dispenser', 25, NULL, NULL, '[]', '[]', 0, 1, 9),
  (2067, 207, 'Strawberry Lemonade', 'Individual 16 oz bottle', 4.75, NULL, NULL, '[]', '[]', 0, 1, 10),
  (2068, 207, 'Peach Palmer', 'Individual 16 oz bottle', 4.75, NULL, NULL, '[]', '[]', 0, 1, 11),
  (2069, 207, 'Bottled Water', '40 count', 32, NULL, NULL, '[]', '[]', 0, 1, 12);

-- ---------------------------------------------------------------------------
-- Events: Blanc Gallery exhibitions and the current opening reception
-- (blanc/index.html + blanc/content-inventory.md). Status is computed from the dates.
-- ---------------------------------------------------------------------------

-- Current / next show. End date = six weeks after opening (CONFIRM).
INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  1, 'blanc', 'exhibition', 'What Shall I Do With My Dead?',
  'Raja''Nee Hamilton and Jalen Hamilton',
  'A six-week exhibition bringing together family photographs, historical documents, and '
  || 'handmade artworks to explore intergenerational memory through a Black feminist '
  || 'storytelling lens.',
  '2026-10-24', '2026-12-05', NULL, NULL, NULL,
  'https://www.eventbrite.com/e/opening-reception-what-shall-i-do-with-my-dead-tickets-2001272755685',
  'RSVP for the opening', '/blanc/img/whatshall.webp', 1, 1, 1
);

-- The opening reception, Saturday October 24, 2026, 5-8 pm.
INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  2, 'blanc', 'event', 'Opening reception: What Shall I Do With My Dead?',
  'Raja''Nee Hamilton and Jalen Hamilton',
  'Free and open to all. Guests under 18 must attend with a guardian.',
  '2026-10-24', NULL, '17:00', '20:00', 'Blanc Gallery, 4445 S. King Drive',
  'https://www.eventbrite.com/e/opening-reception-what-shall-i-do-with-my-dead-tickets-2001272755685',
  'RSVP on Eventbrite', '/blanc/img/whatshall.webp', 1, 1, 2
);

-- Most recent past show.
INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  3, 'blanc', 'exhibition', 'This Could Be//The Permanent Rebellion',
  'Curated by Imani Harmon',
  'Inspired by Black Rage, an interdisciplinary course at the School of the Art Institute '
  || 'of Chicago, this exhibition explores past, present and possibility in Black contemporary'
  || ' art''s reflections of Black political consciousness and subjectivity. Printmaking, '
  || 'fiber, painting, sculpture, photography and performance art by Marc A. V. Bates, Isabel '
  || 'Padilla Bonelli, Sevyn De La Cruz, Messejah Washington, Danielle Levi, Tafari Melisizwe,'
  || ' Nia Wilson, Adilah Muhammed, Annikah Idiova, Cheyenne Tobias-Bamson, Shelby/Shelbs and '
  || 'Dionne Clemon.',
  '2026-08-07', '2026-09-12', NULL, NULL, NULL,
  NULL,
  NULL, '/blanc/img/permanent-rebellion.webp', 0, 1, 3
);

INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  4, 'blanc', 'exhibition', 'From Memory to Movement: Emmett at 85',
  'Curated by Raymond A. Thomas, with the Emmett Till and Mamie Till-Mobley Institute',
  'Paul Branton, Roger Carter, Gerald Griffin, Candace Hunter, Tonika Lewis Johnson, Bryant'
  || ' Lamont, John Caleb Pendleton, Max Sansing, Norman Teague, Raymond A. Thomas, Bernard '
  || 'Williams and Kevin (WAK) Williams.',
  '2026-06-05', '2026-07-26', NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/from-memory-to-movement-emmett-at-85/',
  'Exhibition page', '/blanc/img/emmett-at-85.webp', 0, 1, 4
);

INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  5, 'blanc', 'exhibition', 'I Used to Live in Chicago',
  'Curated by Anefertiti Bowman',
  'Norman Teague, Max Sansing, Steve Bravo, Sura Dupart, Tyrue “Slang” Jones and Patric '
  || 'McCoy.',
  '2026-04-10', '2026-05-24', NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/i-used-to-live-in-chicago-apr-10-may-24-2026/',
  'Exhibition page', '/blanc/img/i-used-to-live-in-chicago.webp', 0, 1, 5
);

INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  6, 'blanc', 'exhibition', 'Raised In It!',
  'Dorian Sylvain',
  'Dorian Sylvain''s first solo exhibition in two decades.',
  '2025-08-10', '2025-09-20', NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/raised-in-it/',
  'Exhibition page', '/blanc/img/raised-in-it.webp', 0, 1, 6
);

INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  7, 'blanc', 'exhibition', 'Frontline Prophet: James Baldwin',
  'Sabrina Nelson',
  'Curated by Ashara Ekundayo and Omo Misha.',
  '2024-05-24', '2024-06-30', NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/frontline-prophet-james-baldwin/',
  'Exhibition page', '/blanc/img/frontline-prophet.webp', 0, 1, 7
);

INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  8, 'blanc', 'exhibition', 'Lawrence Agyei: DRILL',
  'Curated by Rikki Byrd',
  'Part of Art Design Chicago.',
  '2024-04-05', '2024-05-11', NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/lawrence-agyei-drill/',
  'Exhibition page', '/blanc/img/drill.webp', 0, 1, 8
);

-- Opened February 16, 2024; closing date not published (CONFIRM).
INSERT OR REPLACE INTO events
  (id, business_slug, kind, title, subtitle, description, start_date, end_date, start_time, end_time,
   location, link_url, link_label, image_url, featured, published, sort_order)
VALUES (
  9, 'blanc', 'exhibition', 'GuestBook',
  'Curated by Blanc co-founder Cliff Rome',
  NULL,
  '2024-02-16', NULL, NULL, NULL, NULL,
  'https://blancchicago.com/portfolio/guestbook/',
  'Exhibition page', '/blanc/img/guestbook.webp', 0, 1, 9
);

-- ---------------------------------------------------------------------------
-- Announcements. business_slug NULL = the whole family (hub site and TV screens).
-- ---------------------------------------------------------------------------

-- Headline on romesjoy.com and its News page (ABC7 coverage aired 2026-02-10).
INSERT OR REPLACE INTO announcements
  (id, business_slug, title, body, link_url, link_label, image_url, starts_at, ends_at, show_on_tv, published)
VALUES (
  1, NULL, 'Chef Rome and team will lead food services at the Obama Presidential Center',
  'Rome''s Joy Companies, in partnership with Bon Appétit, will be leading the food services'
  || ' at the Obama Presidential Center.',
  'https://romesjoy.com/news/', 'Read the news', NULL, '2026-02-10', NULL, 1, 1
);

-- Blanc: the next opening, shown from the day Eventbrite RSVPs opened until the reception.
INSERT OR REPLACE INTO announcements
  (id, business_slug, title, body, link_url, link_label, image_url, starts_at, ends_at, show_on_tv, published)
VALUES (
  2, 'blanc', 'Opening October 24: What Shall I Do With My Dead?',
  'Raja''Nee and Jalen Hamilton''s six-week exhibition opens with a free reception on '
  || 'Saturday, October 24, 2026, 5–8 pm.',
  'https://www.eventbrite.com/e/opening-reception-what-shall-i-do-with-my-dead-tickets-2001272755685',
  'RSVP on Eventbrite', '/blanc/img/whatshall.webp', '2026-09-16', '2026-10-24', 1, 1
);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- In-store TV loop at Peach's: how long each scene stays on screen.
INSERT OR REPLACE INTO settings (key, value_json, updated_at)
VALUES ('signage:peachs', '{"seconds_per_scene": 10}', datetime('now'));

-- Artwork catalog: switched on for Blanc. No artworks are seeded (the gallery adds its own).
INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('features:blanc', '{"artworks": true}', datetime('now'));
INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES ('signage:blanc', '{"seconds_per_scene": 12}', datetime('now'));
