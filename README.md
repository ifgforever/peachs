# Rome's Joy Companies: website concepts, TV loops, playlist and merch

Everything made for Chef Cliff Rome's group, built as a pitch. `index.html` is the landing page that packages it all:

- **TV loops**: the three in-store videos for Peach's (see `signage/README.md`). All three play right on the page. The entrance video's full-quality file for the TV is shared directly, and a smaller copy is on the site.
- **Parkway Ballroom playlist** (`playlist/`): 38 songs by musicians who played the ballroom, each with dated evidence.
- **Merch** (`merch/`): ten Peach's designs, a six-piece starter line and four tee concepts, rendered from the Peach's Merch Line and Peach's Shirt Concepts canvases.
- **Screen network idea** (`screen-network/`): the "free TV for your business" flyer, pitched as a way to market Rome's Joy with other neighborhood businesses.
- **Websites**: a concept site for each company. Click a card to open it, or use the "Current site" link to compare with the live website.

Live preview: https://peachs.tvinstallchicago.workers.dev/ (Cloudflare redeploys it whenever changes are merged into the main branch).

| Folder | Company | Live site today |
|---|---|---|
| `romesjoy/` | Rome's Joy Companies (parent) | https://romesjoy.com/ |
| `peachs.html` | Peach's on 47th | https://peachson47th.com/ |
| `catering/` | Rome's Joy Catering | https://romesjoy.com/catering/ |
| `parkway-social/` | Parkway Social | https://parkwaysocialchicago.com/ |
| `mise-en-place/` | Mise En Place | https://miseenplacechicago.org/ |
| `blanc/` | Blanc Art Gallery | https://blancchicago.com/ |
| `rjc-sausage/` | R.J.C. Sausage Company | none (first website) |

Each folder has its own `README.md` (what's better, what the client still needs to supply) and `content-inventory.md` (every fact used, with its source and the items to confirm). Every page is set to `noindex` so the concepts never compete with the real sites in Google.

---

## Peach's on 47th

A redesign concept for [peachson47th.com](https://peachson47th.com/), built as a pitch for the owner. The hero is a scroll-driven 3D animation: pancakes hang suspended in mid-air, then drop one by one into a stack, followed by butter and syrup.

Everything on the page (menu, prices, hours, press, catering) comes from the live site and its printed menus. See [`docs/content-inventory.md`](docs/content-inventory.md) for the full list and the items the owner still needs to confirm.

## What's better than the current site

| Current site | This concept |
|---|---|
| Menu is a PDF link | Full menu on the page with section tabs and gluten-free / vegetarian / dairy-free filters |
| Small, low-resolution logo | Art-deco wordmark and line-art portrait recovered from the printed menus |
| No story on the homepage | "President Obama's Favorites", signature plates, press, catering, and coffee sections |
| Hours and address only on the Contact page | Live "Open now / Closed" badge (Chicago time), hours, map link, and transit note on the home page |
| Generic theme | Custom design in the brand's peach and orange palette with a 3D hero animation |
| Little search markup | Restaurant structured data (address, hours, menu) so Google can show rich results |

## Preview it on your computer

Any static web server works. From this folder:

```bash
npx http-server -p 8080
```

Then open http://localhost:8080 for the preview page. Opening `peachs.html` by double-clicking does **not** work: browsers block the JavaScript modules on `file://` pages.

## Get a shareable link for the client meeting

This is already set up on Cloudflare: https://peachs.tvinstallchicago.workers.dev/ shows the main branch. The options below are alternatives.

**Option A: GitHub Pages (free, about 2 minutes)**
1. Merge the pull request into `main`.
2. On GitHub, go to the repo's **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", choose **`main`** and **`/ (root)`**, then click **Save**.
4. After a minute or two the link appears at the top of that page, normally `https://ifgforever.github.io/peachs/`.

**Option B: Netlify Drop (no account needed for a temporary link)**
1. Download this repo as a ZIP (green **Code** button → **Download ZIP**) and unzip it.
2. Go to https://app.netlify.com/drop and drag the unzipped folder onto the page.
3. You get a link right away. Create a free account to keep it.

The concept preview has `noindex` set so it never competes with the real site in Google.

## Before going live (needs the client)

- [ ] WordPress / hosting login (or DNS access) to replace the current site
- [ ] Vector logo files (the marks here were recovered from the printed menus)
- [ ] Confirm hours (live site says Wed–Sun 8 am–2 pm; an older listing says 7–3 daily)
- [ ] Confirm the online coffee price (menu says $14 per ½ lb in the restaurant; the shop lists $22.95)
- [ ] More photography, especially the dining room, the team, and the 7-Up pancakes
- [ ] Decide whether to keep the WooCommerce coffee shop or move it to Toast or Square
- [ ] Remove the `noindex` tag and the "concept preview" footer line at launch

## Project layout

```
index.html               preview page linking every concept
peachs.html              the Peach's concept (one page)
preview/                 screenshot thumbnails for the preview page, and og.jpg (the link-preview image)
assets/css/styles.css    styles
assets/js/main.js        nav, menu tabs and filters, open-now badge, hero scroll wiring
assets/js/menu-data.js   menu content (edit prices here)
assets/js/hero.js        the 3D pancake-stack hero (Three.js r169 from a CDN)
assets/img/              food photos and brand marks
menus/                   original menu PDF and images
docs/                    content inventory and source notes
signage/                 videos for the restaurant's TVs: the Peach's loop, the Rome's Joy family loop, and the entrance screen (see signage/README.md)
playlist/                the Parkway Ballroom playlist page
merch/                   Peach's merch page and the rendered designs (img/)
screen-network/          the free-TV flyer (PDF) and its preview image
worker/index.js          answers byte-range requests for the .mp4 files so they play in Safari (Cloudflare's static
                         assets always send the whole file); runs only for video paths, see wrangler.jsonc
```

No build step and no frameworks; the only server code is the small video Worker. To change a price, edit `assets/js/menu-data.js`.
