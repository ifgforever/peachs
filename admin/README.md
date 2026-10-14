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

To try the Assistant without a real Anthropic key, run the stand-in for Claude's API
(`node worker/assistant-mock.mjs --port 8932`) and start wrangler with an env file that has
`ANTHROPIC_API_KEY=test` and `ANTHROPIC_BASE_URL=http://127.0.0.1:8932` as well as the setup
token (`npx wrangler@4 dev … --env-file <that file>`). The mock answers with a short text
unless a test scripts its replies (see the top of `worker/assistant-mock.mjs`).

Checks you can run while the dev server is up:

```sh
node worker/smoke-test.mjs http://localhost:8787   # the API checks; creates smoke-owner@example.com on an empty database
node admin/ui-test.mjs                             # drives the admin in a headless browser against a fake API (Assistant, Photos and TV screens included)
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

### Upgrading the live site (Assistant, photo library, TV screens, October 2026)

This release adds the Assistant, the Photos page, the TV screens page and the Claude app
connector. On Lance's Mac, in the `peachs` folder, run these four commands in this order:

```sh
git pull
npm install
npx wrangler@4 d1 execute romesjoy-admin --remote --file worker/migrations/2026-10-14-assistant.sql
npx wrangler@4 deploy
```

- `npm install` fetches the three new packages the Assistant and the connector need
  (wrangler bundles them into the Worker when it deploys).
- The migration only adds new tables (drafts, chats, AI usage, photo library, albums,
  TV screens) and the starter albums; it changes no existing rows and is safe to run again.
  Run it before the deploy: until it has run, the Assistant, Photos and TV screens pages
  only say "The server had a problem" (the websites and everything else keep working).
- `ANTHROPIC_API_KEY` is already set as a secret on the Worker, so the Assistant works as
  soon as the deploy finishes. The `OAUTH_KV` namespace the connector uses also already
  exists. Nothing else to set up.

Then add the connector in the Claude app (once per person who wants it; full steps in
"The Claude app connector" below): Settings → Connectors → **Add custom connector** →
`https://peachs.tvinstallchicago.workers.dev/mcp` → sign in with the back office email and
password → **Allow**.

To check it worked: open https://peachs.tvinstallchicago.workers.dev/admin/, tap
**Assistant** and ask "What are Peach's hours this week?"; the Overview shows
"AI usage this month" for owners and admins.

#### The Assistant: switching it on

The key is already set on the live Worker. These steps are for a new Cloudflare account, or
to replace the key:

1. Sign in at https://console.anthropic.com with the account that pays for it.
2. Settings → Limits: set a monthly spend limit (for example $50). The Assistant stops
   when it is reached and the back office keeps working by hand.
3. Settings → API keys → Create key. Copy it.
4. `npx wrangler@4 secret put ANTHROPIC_API_KEY` and paste the key. No deploy is needed
   for a secret change.

Each person can send 60 Assistant messages a day. To change that for everyone (here to 100):

```sh
npx wrangler@4 d1 execute romesjoy-admin --remote --command "INSERT INTO settings (key, value_json) VALUES ('assistant:limits', '{\"daily_turns\": 100}') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
```

Owners and admins see the month's estimated cost on the Overview ("AI usage this month").
It is an estimate from the token counts; the Anthropic Console has the real bill. The
automatic check after each Publish does not count toward the 60 messages.

Big drafts and the Workers plan: publishing runs every change through the database, and
on the free Workers plan one request may make at most 50 database queries. That is enough
for about 8 changes in one draft; a bigger draft can stop part-way. If that happens,
History has the changes that were made, and each can be undone there. On Workers Paid
(1,000 queries) drafts of up to 40 changes publish fine. On the free plan, ask for big changes in a few smaller
drafts (or lower `MAX_OPS` in `worker/lib/changesets.js`).

#### The Claude app connector: adding it in Claude

Anyone with a back office login can manage the sites from the Claude app (it uses their
Claude plan, not the API key above), with exactly the rights of their login.

1. In the Claude app (or claude.ai): Settings → Connectors → **Add custom connector**.
2. Name: `Rome's Joy`. URL: `https://peachs.tvinstallchicago.workers.dev/mcp` (the
   Account page in the back office shows this address with a Copy button).
3. Claude opens the back office sign-in: sign in with your email and password, then
   tap **Allow** on "Allow Claude to manage … as …".
4. In a chat, turn the connector on and ask, e.g. "Close Peach's early this Friday at noon".
   Claude drafts the change and shows the preview links. **Claude cannot publish**: when
   you want it live, it gives you a link to the draft in the back office. Open it (signed
   in), check the changes and tap **Publish** there, then tell Claude it is done and it
   checks the live website for you. (This way nothing written in a website inquiry or a
   photo note can talk Claude into publishing.)

To disconnect: back office → Account → "Claude app" → **Disconnect**. Changing your
password also ends the connection; connect again from Claude to carry on. Switching
someone off (or removing them) in Users disconnects their Claude app too, for good.

Only Claude's own sign-in pages (claude.ai and claude.com) can receive a sign-in. To allow
another address, add its host to `OAUTH_REDIRECT_HOSTS` in `wrangler.jsonc` and deploy.

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
- **Photos**: the business's photo library, in albums. See "Photos" below.
- **TV screens**: every TV, whether it is on, what the screens show. See "TV screens" below.
- **Inquiries**: form submissions, newest first. Open one to see every field; Mark
  handled, Spam, or Resend email.
- **History**: every change with who made it and when. "Restore" puts the earlier
  version back (and is itself recorded).
- **Users**: owners and admins add staff and set what they may edit.
- **Account**: change your password, sign out, and connect the Claude app.
- **Assistant** (top bar, on every page): ask for changes in plain English. See below.

The in-store screen reads the same data: see `signage/README.md` for setting up
the TV and what each setting does.

On a phone, the back office can sit on the home screen like an app: in Safari tap
Share → **Add to Home Screen**; in Chrome tap ⋮ → **Add to Home screen**. It opens as
"Back Office" without the browser bars (it still needs the internet).

### The Assistant

Tap **Assistant** in the top bar (the sparkle button on a phone). It opens beside the
page on a computer and full screen on a phone. Tell it what you want in your own words,
the way you would tell a manager:

- "Close Peach's early this Friday at noon."
- "Put up a notice: closed Thanksgiving Day."
- "Add the peach cobbler to the dessert menu at $9."
- "Use the photo I took this morning for the Saturday brunch event."

You can also tap the **microphone** and speak (where the phone or browser supports it),
or tap the **camera** to send a photo of a menu board, a flyer or an artwork label so it
can read prices, dates and titles from it.

How it works:

1. It reads what is there now and **asks about anything missing** (which day, am or pm,
   the price, whether it should show on the TV). It never makes up prices, dates,
   allergens or names.
2. It **drafts** the change. A card shows **before → after** for each business, its
   **checks** (green: fine; amber: worth a look, e.g. a price that tripled or an allergen
   removed; red: must be fixed first, e.g. a notice that ends in the past), and
   **Preview** buttons that open the website and the TV screen as they *will* look, with
   a "Preview — not live yet" banner. **Copy preview link** or **Share** sends the preview
   to someone else to check (it works for 48 hours).
3. **Nothing is live until you tap Publish.** Publish is greyed out while a red check is
   showing: tell the Assistant what to change and it updates the same draft.
4. After **Publish**, the card checks the live website ("Checked: it is all live.") and
   the Assistant says what changed. The websites update within a minute and the TV
   screens within a minute or two. **Undo** puts everything back (within 30 days); each
   change is also in History, marked "Assistant:".
5. **Discard** throws a draft away; drafts nobody publishes expire after 48 hours.

**Chats** lists your last 30 chats; **New chat** starts fresh (do that for a new topic,
or when it says the chat has got long). It can only change the businesses your login can
change, and says who to ask for the rest. If it says "The Assistant is not switched on
yet", see "Upgrading the live site (Assistant…)" above; if it says you have used today's
messages, it resets at midnight and you can still edit by hand.

If the phone locks or the signal drops while it is replying, it keeps working: the chat
says so, waits, and shows the reply when it is done (Send stays off until then).

### Photos

The **Photos** page is the business's photo library. Take a photo now, use it later.

- **Take or choose photos**: on a phone this offers the camera or the photo library. Pick
  the **album** first (it starts on the album you are looking at) and, if you like, a short
  **note** ("brunch special", "new piece, Hamilton"): the Assistant finds photos by their
  note. Big photos are shrunk before they upload. If the wifi drops, **Try again** resends
  the ones that failed.
- **Albums** are the buttons above the photos (each with its count). **New album** adds
  one; when an album is selected, **Rename album** and **Delete album** appear (deleting an
  album keeps its photos, under "No album").
- **Move**: tick the box on one or more photos, choose an album (or another business you can
  edit) under "Move to", and tap **Move**.
- **Edit** opens a photo: change its note, its description (what it shows, for people who
  use screen readers; it is used when the photo goes on the website) and its album, and see
  **where it is used**.
- **Delete** removes a photo for good. A photo that is on the website (an event, an
  announcement, an artwork or the notice) cannot be deleted: it says where it is used, with
  a link, so you can take it off there first.
- **Search** looks through notes, descriptions and album names.

Every photo field (events, announcements, artworks) has **Choose from library** next to the
upload button: pick a photo from the albums and its link goes into the form. Save the form
to keep it.

### TV screens

The **TV screens** page lists every TV that plays this business's screen.

1. **Add screen** and give it a name you will recognise ("Counter", "Dining room").
2. Open its **Player link** on that TV (Copy, then paste it into the TV's browser or
   signage player, full screen). See `signage/README.md` for the TV set-up.
3. From then on the TV reports in every minute: the page shows **Online** (seen in the last
   10 minutes), **Offline**, or **Not connected yet**, with "last seen 2 min ago". The page
   checks again every 30 seconds; **Check again** checks now.

Each screen has a small **live preview** of what it shows (**Open preview** opens it big).
**What the screens show** switches scenes on or off (welcome, notice, announcements,
featured dishes, menu board, catering, events, artworks) and sets the seconds per scene;
tap **Save screen settings**. **Refresh all screens now** makes every TV of this business
load the latest data within about a minute (use it after a change that must show at once).
**Rename** and **Remove** are on each screen; a removed TV keeps playing but no longer
reports in.

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
