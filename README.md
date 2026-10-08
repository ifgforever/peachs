# Peach's on 47th: website concept

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

Then open http://localhost:8080. Opening `index.html` by double-clicking does **not** work: browsers block the JavaScript modules on `file://` pages.

## Get a shareable link for the client meeting

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
index.html               the whole site (one page)
assets/css/styles.css    styles
assets/js/main.js        nav, menu tabs and filters, open-now badge, hero scroll wiring
assets/js/menu-data.js   menu content (edit prices here)
assets/js/hero.js        the 3D pancake-stack hero (Three.js r169 from a CDN)
assets/img/              food photos and brand marks
menus/                   original menu PDF and images
docs/                    content inventory and source notes
```

No build step and no frameworks. To change a price, edit `assets/js/menu-data.js`.
