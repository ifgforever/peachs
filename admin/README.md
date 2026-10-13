# The back office (admin panel)

This folder is the staff "back office" for every Rome's Joy website. Staff sign in at
`/admin/`, pick a business, and change hours, contact details, the notice bar, events,
menus and announcements. The websites and the in-store TV screens read the same data,
so one change shows up everywhere within about a minute. Website forms (contact,
quote, event, apply, wholesale) land in the admin's Inquiries page and are emailed to
the business once email is connected.

How it fits together:

- `admin/` (this folder) is the screen staff use. Plain HTML, CSS and JavaScript.
- `worker/` is the Cloudflare Worker: the API behind `/api/*` and the database
  (`worker/schema.sql`), plus the starting content (`worker/seed.sql`).
- The same Worker also serves every site in this repo as static files, so one
  deployment gives you the sites, the admin and the API on one address.
- `docs/admin-api.md` is the technical contract between the pieces.

## Local development (try it on your computer)

You need Node 22 or newer. No install step is required; `npx` fetches wrangler.

```sh
cd peachs
cp .dev.vars.example .dev.vars        # then edit ADMIN_BOOTSTRAP_TOKEN in .dev.vars, e.g. local-dev-token
npx wrangler@4 d1 execute romesjoy-admin --local --persist-to ../romesjoy-local-data --file worker/schema.sql
npx wrangler@4 d1 execute romesjoy-admin --local --persist-to ../romesjoy-local-data --file worker/seed.sql
npx wrangler@4 dev --local --port 8787 --persist-to ../romesjoy-local-data
```

(The same three commands are `npm run db:schema:local`, `npm run db:seed:local` and
`npm run dev` once you have run `npm install` once.)

Then open:

- http://localhost:8787/admin/ – the back office (first visit: "Create the first account")
- http://localhost:8787/peachs – the Peach's site, now reading live data
- http://localhost:8787/signage/live?business=peachs – the TV screen
- http://localhost:8787/api/public/peachs – the raw data a site reads

Why `--persist-to ../romesjoy-local-data`: the Worker serves the whole repo folder as
static files, and wrangler watches that folder for changes. Its own runtime files
(the local database) would otherwise live inside the folder and trigger an endless
"Reloading local server…" loop. Keeping the local database one level up, next to the
repo, avoids that. Delete that folder to start from a clean database.

Checks you can run while the dev server is up:

```sh
node worker/smoke-test.mjs http://localhost:8787   # 31 API checks, creates smoke-owner@example.com on an empty database
node admin/ui-test.mjs                             # drives the admin in a headless browser against a fake API
node signage/tv-test.mjs                           # same for the TV page
```

## Production setup, step by step

Everything runs in one Cloudflare account. Right now that is Lance's account; the
D1 database `romesjoy-admin` already exists there and its id is in `wrangler.jsonc`.

### 1. Log in to Cloudflare from your computer

```sh
npx wrangler@4 login
```

### 2. Create the database tables and load the starting content

```sh
npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/schema.sql
npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/seed.sql
```

`schema.sql` only creates tables that do not exist yet, and `seed.sql` is safe to
run again: it puts the original content back (hours, menus, events) but never
deletes inquiries, staff accounts, history or a notice staff typed. Only run the
seed again on purpose.

### 3. Set the secrets

```sh
npx wrangler@4 secret put ADMIN_BOOTSTRAP_TOKEN   # needed once, to create the first owner; paste the output of: openssl rand -base64 32
npx wrangler@4 secret put RESEND_API_KEY          # optional, for emailing inquiries (see "Connecting email")
npx wrangler@4 secret put EMAIL_FROM              # optional, e.g. Rome's Joy Websites <no-reply@romesjoy.com>
```

Also set `PUBLIC_BASE_URL` in `wrangler.jsonc` (the `vars` block) to the public
address of the Worker, for example `https://peachs.<your-subdomain>.workers.dev` or
your custom domain. It is only used to put a link to the admin into inquiry emails.

### 4. Deploy

```sh
npx wrangler@4 deploy
```

The command prints the address. Alternatively connect the GitHub repository to
Cloudflare (Workers & Pages → Create → Workers → Import a repository, "Workers
Builds"): every push to the main branch then deploys automatically with the same
`wrangler.jsonc`. Secrets are set once in the dashboard (Worker → Settings →
Variables and Secrets) instead of with `secret put`.

### 5. First login and staff accounts

1. Open `https://<the address>/admin/`. Because there are no accounts yet it shows
   "Create the first account".
2. Enter the `ADMIN_BOOTSTRAP_TOKEN`, a name, an email and a password. This account
   is the owner.
3. Go to Users → Add user for everyone else. Roles:
   - Owner: everything, including other owners.
   - Admin: every business, and can add or remove editors and admins.
   - Editor: only the businesses ticked for them (for example just Blanc).
   New people get a temporary password you tell them; they must choose their own
   the first time they sign in.

The setup token stops working as soon as the first account exists (and wrong guesses
are limited to a handful per hour before that). You can still remove it afterwards with
`npx wrangler@4 secret delete ADMIN_BOOTSTRAP_TOKEN`; it is only needed again if every
account is ever deleted.

### Connecting email (Resend)

Before email is connected, forms still work: every submission is saved and shows in
Inquiries with "Not emailed: email sending is not set up on the server yet". The
Inquiries page shows a yellow banner saying so.

To get the emails:

1. Create an account at https://resend.com (the free tier is enough).
2. Domains → Add domain → the domain you will send from (e.g. `romesjoy.com`), and
   add the DNS records Resend lists. Wait until it shows "Verified".
3. API Keys → Create → copy the key.
4. `npx wrangler@4 secret put RESEND_API_KEY` (paste the key) and
   `npx wrangler@4 secret put EMAIL_FROM` with an address on the verified domain,
   e.g. `Rome's Joy Websites <no-reply@romesjoy.com>`.
5. In the admin, check Contact & links → "Inquiry emails" for each business: that
   comma-separated list is who receives the form emails.

Open any earlier inquiry and press "Resend email" to confirm it works.

### Photo uploads (R2)

Staff upload photos (events, announcements, artworks) from their phone. The photos
live in the R2 bucket `romesjoy-media`, which already exists in Lance's account and is
bound as `MEDIA` in `wrangler.jsonc`, so there is nothing to set up there. Files are
served from `/api/media/…` on the Worker's address.

In a new Cloudflare account, create the bucket once before deploying:
`npx wrangler@4 r2 bucket create romesjoy-media`. (Without the `r2_buckets` line in
`wrangler.jsonc` the forms fall back to a photo *link* field.)

### Upgrading the live site (artwork catalog, October 2026)

The live site was deployed before the artwork catalog existed. Its database needs the
two new tables once; then deploy the new code. On Lance's Mac, in the `peachs` folder:

```sh
git pull
npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/migrations/2026-10-13-artworks.sql
npx wrangler@4 deploy
```

The migration only adds the `artworks` and `artwork_images` tables and switches the
catalog on for Blanc (`features:blanc`, plus a starting `signage:blanc` TV setting if
there is none); it does not touch hours, menus, events,
inquiries or accounts, and it is safe to run again. The R2 bucket `romesjoy-media`
already exists, so photo uploads work as soon as the deploy finishes. If the code is
deployed before the migration runs, nothing breaks: the sites and admin work as before,
and the Artworks screen and the website's catalog appear once the migration has run.

### Pointing the GitHub Pages copies at the Worker

The sites can also be hosted as plain files (GitHub Pages or any web host). They
then need to know where the API is. In each site's HTML there is

```html
<meta name="live-api" content="">
```

Put the Worker's address in `content` (no trailing slash), e.g.
`content="https://peachs.<your-subdomain>.workers.dev"`, in `peachs.html`,
`romesjoy/index.html`, `catering/index.html`, `parkway-social/index.html`,
`mise-en-place/index.html`, `blanc/index.html`, `rjc-sausage/index.html`, and in
`admin/index.html` (`<meta name="api-base" content="https://…/api">`). The TV page
takes it in the address instead: `signage/live.html?business=peachs&api=https://…`.
The Worker already allows any website origin to read the public data and submit forms.

### Moving everything to an account Chef Rome owns

Nothing is tied to Lance's account except the database id and the deployment.

1. In the new account: `npx wrangler@4 login`, then
   `npx wrangler@4 d1 create romesjoy-admin`. It prints a new `database_id`.
   Also create the photo bucket: `npx wrangler@4 r2 bucket create romesjoy-media`
   (photos already uploaded stay in the old account's bucket; copy them over or
   upload them again).
2. Put that id in `wrangler.jsonc` (`d1_databases[0].database_id`).
3. Repeat steps 2–4 above in the new account (schema, seed, secrets, deploy).
   The first login creates a fresh owner account; staff accounts, inquiries and
   history do not move with the code. To carry them over, export first:
   `npx wrangler@4 d1 export romesjoy-admin --remote --output backup.sql` in the old
   account and `npx wrangler@4 d1 execute romesjoy-admin --remote --file backup.sql`
   in the new one (instead of schema + seed).
4. Point the domain at the new Worker, update `live-api` metas if the address changed,
   and delete the old Worker.

## Daily use (for staff)

Sign in at `/admin/`. The top bar has a business switcher; everything on the left
(or in the bottom bar on a phone) is about that business. Every save shows "Saved.
Websites update within a minute."

- **Overview**: what visitors see right now (open or closed, today's hours, new
  inquiries, next event, the notice) with shortcuts to change each.
- **Hours**: the weekly hours. Switch a day to Closed or type open and close times;
  "Copy to all open days" fills the week from one day. Special days below are
  one-offs (holidays, a late opening) that replace the weekly hours for that date
  only; they disappear by themselves afterwards.
- **Contact & links**: name, address, phone, public email, the *inquiry emails*
  that receive form submissions, and the website/Instagram/Facebook/map/ordering/
  booking links.
- **Notice**: a one-line banner at the top of the website and on the TV ("Closed
  Thanksgiving Day"). Optional "show until" date; "Clear notice" removes it.
- **Events**: exhibitions, classes and happenings. Past events move to "Past" by
  themselves. "Published" off keeps a draft hidden. "Featured" puts it first.
- **Menu**: sections and items. Each change saves on its own. "Available" off
  hides an item without deleting it (sold out today). Up/Down reorders.
  Dietary tags (GF, V, DF) and allergens show on the site.
- **Artworks** (Blanc): the gallery's catalog. See "Artworks (Blanc)" below.
- **Announcements**: news and promos with start and end dates, for one business or
  the whole family ("Whole family" tab, owners and admins only). "Show on TV"
  puts it in the screen rotation.
- **Inquiries**: form submissions, newest first. Open one to see every field; Mark
  handled, Spam, or Resend email.
- **History**: every change with who made it and when. "Restore" puts the earlier
  version back (and is itself recorded).
- **Users**: owners and admins add staff and set what they may edit.
- **Account**: change your password, sign out.

The in-store screen reads the same data: see `signage/README.md` for setting up
the TV and what each setting does.

### Artworks (Blanc)

The Artworks screen appears for Blanc only (on a phone it is in the bottom bar). Each
piece has a title, artist, year, medium, size, a description, up to 12 photos, the
exhibition it hangs in, a price and a status.

**Adding a piece from a phone**

1. Artworks → **Add artwork**. Type the title and artist (the rest can wait).
2. Under "Show, price and status", pick the exhibition (or "Not in a show"), type the
   price (e.g. `1800`) and choose **Show price**, **Price on request** or **Don't show**.
3. Tap **Add photos** and take or choose photos. The first photo you add saves the piece,
   so photos always have a home (that is why the title comes first). If the wifi drops,
   the photos that did not make it get a **Try again** button. Big phone photos are shrunk before they upload, so it is
   quick on the gallery wifi. On an iPhone, if a photo is refused, set Settings → Camera
   → Formats → **Most Compatible**, or choose a JPEG.
4. For each photo, describe what it shows ("Oil painting of two sisters on a porch").
   People who use screen readers hear this instead of seeing the photo. **Make main**
   picks the photo the website shows first; the arrows change the order.
5. Tap **Save changes**. The website updates within a minute.

**Marking a piece sold**: tap **Mark sold** on its card in the list. The website then
shows a red dot and "Sold" and never the price. Tapped by mistake? Use **Undo** in the
message, or **Mark available**. "Reserved" and "Not for sale" are in the Status menu on
the piece's page.

**Featuring**: tick **Featured** on the piece's page to put it first on the website (it
gets a star in the list). Between exhibitions (none on view or coming up), the gallery
TV plays the featured pieces. Untick **Published** to keep a piece as a draft only staff can see.
Pieces in an exhibition that is still a draft (Events → Published off) stay off the
website too, prices included, until the exhibition is published; their cards say
"Hidden: its exhibition is a draft". So a show can be prepared before it is announced.

**What visitors see**: on the Blanc website, an "Artworks" section (and menu link)
groups the pieces under their exhibition: on view now, coming up, past shows, then "From
the collection". Each exhibition with pieces gets a "See the artworks" link. Tapping a piece opens it
large with all its photos, and **Ask about this piece** sends a message that lands in
Inquiries as an "Artwork inquiry" naming the piece (and by email once email is set up).

**The gallery TV**: `https://peachs.tvinstallchicago.workers.dev/signage/live.html?business=blanc`
shows the exhibition's title card and then each piece with a photo (never prices). See
`signage/README.md` for the settings.

**Deleted something by mistake?** History → **Restore** on "Deleted artwork …" brings the
piece back with all its photos. Deleting an exhibition keeps its pieces ("Not in a show");
restoring the exhibition from History puts them back in it.

## Troubleshooting

- **"Create the first account" says "That setup token is not right, or an account already exists"**: the
  `ADMIN_BOOTSTRAP_TOKEN` secret is missing or different (or someone already created
  the first account: use Sign in). Set it again with
  `npx wrangler@4 secret put ADMIN_BOOTSTRAP_TOKEN` and deploy.
- **"The database is not set up yet"**: run the schema command from step 2.
- **The website shows the old hours**: pages cache the data for up to a minute and
  keep the last copy if the API cannot be reached. Reload after a minute; if it is
  still old, open `/api/public/<slug>` on the Worker's address and check what it
  returns. On a GitHub Pages copy, check the `live-api` meta tag.
- **Forms say "Thanks" but no email arrives**: open the inquiry in the admin; the
  grey line under it says why (email not set up, no inquiry address for that
  business, or Resend's error). "Form emails are not set up yet" means the two
  email secrets are missing.
- **Too many sign-in attempts**: after 10 wrong passwords in 15 minutes the address
  is blocked for 15 minutes. Wait, then try again.
- **A staff member forgot their password**: an owner or admin opens Users → Edit →
  types a new temporary password. They will be asked to change it at sign-in.
- **Something was changed by mistake**: History → Restore on that entry.
- **Local dev keeps printing "Reloading local server…"**: start it with
  `--persist-to ../romesjoy-local-data` (or `npm run dev`), see above.
- **Local dev says the table is missing or empty**: the schema and seed commands
  must use the same `--persist-to` folder as `dev`.
