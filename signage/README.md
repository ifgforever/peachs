# In-store screens

There are two ways to feed the TVs in the restaurant:

- **Option A: fixed video.** `peachs-instore-loop.mp4`, a 1920×1080 loop rendered from `loop.html`. Nothing changes until someone re-renders it.
- **Option B: live screen.** `live.html`, a web page that reads hours, menu, announcements and events from the admin panel and updates itself every 5 minutes. Change something in the admin and the screens follow.

Both are 1920×1080 with no sound, and the same thing plays on every screen whether there are 2 or 3.

---

## Option A: fixed video

`peachs-instore-loop.mp4` is a 1920×1080 video for the TVs in the restaurant. It has no sound and is built to loop without a visible jump.

### What's in it (about 1½ minutes)

1. **Pancake stack**: the 3D pancakes from the website, with hours and address.
2. **"In his words"**: President Obama's Instagram caption about Cliff and Peach's (@barackobama, May 23, 2025), quoted word for word.
3. **Chef Cliff Rome**: his background, Rome's Joy Companies, and his role at Tafari's Kitchen and the Obama Presidential Center (from obama.org).
4. **President Obama's Favorites**: the two dishes from the menu, plus the WGN-TV headline.
5. **Signature plates**: pancakes, banana rum French toast, hangover wings, avocado toast.
6. **Coffee**: Best Damn Drip, $14.
7. **Catering**: half-pan prices, phone number and email.
8. **Closing**: logo, hours, address, @peachson47th.

Prices come from the menu on the website. Update `loop.html` and re-render if they change.

### Putting it on a BrightSign player

1. On a computer, install **BrightAuthor:connected** (free from brightsign.biz).
2. Create a new presentation:
   - Resolution: 1920×1080, 30p.
   - Layout: one full-screen zone.
3. Add `peachs-instore-loop.mp4` to that zone. With a single file in the zone, it repeats on its own.
4. Choose **Publish → Local Storage** and save to the player's microSD card.
5. Put the card in the player and power it on. Repeat for each screen's player, or copy the same card contents to each.

### Changing it

1. Edit `loop.html`. To preview a single frame, open it with `?scene=obama&t=8`.
2. From the repo root, run `python3 -m http.server 8765`, then `node signage/render.mjs`.
3. Each scene is saved to `signage/build/`. The scenes are then joined into `peachs-instore-loop.mp4`.
4. To re-render only some scenes, name them: `node signage/render.mjs cliff outro`.

The Obama Instagram video can be added as its own scene once someone has the file and permission to play it. The video belongs to Obama's account, so ask his team, through Cliff, before showing it in the restaurant. The quote slide only quotes his public caption and credits it to him, but it's still worth mentioning to Cliff.

---

## Option B: live screen

`live.html` (with `live.css` and `live.js`) is a web page built for TVs. Once the sites are deployed on Cloudflare, it lives at:

```
https://<your site host>/signage/live.html
```

It asks the admin's API (`/api/public/signage/peachs`) for the current data when it starts and every 5 minutes after that, then rotates through these scenes, about 10 seconds each, with a soft cross-fade:

1. **Welcome**: logo, "Open now · until 2 pm" (or when it opens next), today's hours, the week's hours, address, phone, Instagram.
2. **Notice**: only while a notice is set on the business (for example a holiday closing).
3. **Announcements**: one scene per announcement marked "Show on TV", including family-wide ones from Rome's Joy.
4. **Chef's picks**: menu items marked "featured", 3–4 per scene, with price and description.
5. **Menu board**: one scene per menu section, big type in two columns. Long sections split over two scenes.
6. **Catering**: a few items from the catering menu with "Ask about catering", phone and email.
7. **Coming up**: current and upcoming events, plus what is on view at Blanc Gallery.
8. **Closing**: logo, hours summary, address, website, Instagram.

Scenes with nothing to show are skipped. A small clock and "updated 3 min ago" sit in the bottom corner.

### What happens when the internet drops

The page keeps the last good copy of the data in the player's browser storage. If the API is slow (more than 6 seconds) or unreachable, the screen keeps rotating through that copy and shows a small "offline" chip in the corner; it tries again every 5 minutes (every minute if it has never loaded anything). If there is no saved copy at all, it shows a calm brand screen with the logo, name and address instead of an error. It never goes blank. The open/closed status is worked out from the saved hours and the player's clock, so it stays right even while offline.

Two things the player does need: a correct clock (BrightSign players set theirs from the internet; a stick or TV from its own settings) and, for the brand fonts, internet access at least once in a while. Without internet the page still works with the player's standard fonts.

### Setting up a BrightSign player (BrightAuthor:connected)

The page is light: plain HTML, CSS fades, no video, no WebGL. It runs on the LS series (LS424/LS425) as well as HD and XD players. BrightSign OS 8.5 or newer is recommended.

**B1. Point the player at the hosted page (recommended, needs internet on the player)**

1. On a computer, install **BrightAuthor:connected** and sign in. Set the player up on the network (Ethernet or Wi-Fi) with the BrightSign setup steps, and give it a name like "Peach's TV 1".
2. Create a new presentation: 1920×1080, 30p, one full-screen zone.
3. In the media library choose **Add HTML5 site** (sometimes shown as "HTML5" or "Web page"). Pick the **URL** type and paste:
   ```
   https://<your site host>/signage/live.html?business=peachs
   ```
   Leave "Enable mouse events" and "Display cursor" off. If there is a "Hardware acceleration" option, leave it on.
4. Drag that HTML5 item into the zone. With one item in the zone, the page simply stays up; the rotation is inside the page.
5. In the presentation's player settings, make sure nothing turns the screen off: no "screen blanking", no idle timeout, and no power schedule unless you want one. Do the same on the TV itself (sleep timer and screen saver off; most TVs have a "store" or "retail" mode that keeps the screen on).
6. **Publish** the presentation to the player over the network, or to its microSD card. A BrightSign player starts its published presentation by itself every time it powers on, so there is nothing else to enable for auto-start. If BrightAuthor shows an "Autorun" or "Automatically start presentation" checkbox, keep it ticked.
7. Turn the TV on. The brand screen appears first, then the live scenes a moment later.

Repeat for each player, or publish the same presentation to all of them (BrightAuthor lets you pick several players at once).

**B2. Keep the page on the microSD card (works without hosting, still needs internet for the data)**

Use this if you would rather not depend on the site host, or your player cannot open remote URLs.

1. Copy these from the repo onto the card, keeping the folder names:
   - `signage/live.html`, `signage/live.css`, `signage/live.js`
   - `assets/img/brand/` (the logo files)
2. In BrightAuthor:connected, add an HTML5 site of the **local files** type and choose `signage/live.html`.
3. Tell the page where the data is by adding the API address to the file name in the site dialog:
   ```
   signage/live.html?api=https://<your site host>
   ```
   `<your site host>` is the Cloudflare host that serves the sites and the admin. If your BrightAuthor version does not accept a `?` after a local file name, use B1 instead.
4. Continue from step 4 of B1.

### Changing what the screen shows

Everything comes from the admin panel; no files need editing.

| To change | Where in the admin |
|---|---|
| Hours, today's status, holiday closings | the business page → Hours and Holiday hours |
| The notice scene | the business page → Notice (and "until" date). Clear it to remove the scene |
| Announcements | Announcements → tick **Show on TV**. Family-wide announcements show on every business's screens |
| Chef's picks | Menu → mark an item **Featured**. Unmark it to take it off the screen |
| Menu board | Menu → sections and items. Mark an item unavailable to hide it everywhere |
| Catering scene | the catering business's menu and contact details |
| Events, "At Blanc Gallery" | Events for the business, and Blanc's events |
| Seconds per scene and which scenes play | Settings → `signage:peachs` |

The `signage:peachs` setting is a small JSON object. Only `seconds_per_scene` is needed; the rest default to on:

```json
{
  "seconds_per_scene": 10,
  "show_announcements": true,
  "show_featured": true,
  "show_menu_board": true,
  "show_catering": true,
  "show_events": true,
  "show_blanc": true
}
```

`seconds_per_scene` is clamped to 4–60; 8–12 reads well. Menu board scenes with many items stay up a little longer on their own. Changes reach the screens within 5 minutes.

The same page works for any business: `live.html?business=blanc` reads Blanc's data (the brand screen then shows the name in type instead of the Peach's logo).

### Cheaper fallback: a streaming stick or a smart TV

Any device with a web browser that can run full screen will show the same page.

1. **Fire TV Stick** (any current model): install a kiosk browser from the Amazon app store, for example **Fully Kiosk Browser** or **Wallpanel**. Set its start URL to `https://<your site host>/signage/live.html?business=peachs`, turn on full screen / kiosk mode, "start on boot" and "keep screen on", and turn off the stick's screen saver (Settings → Display & Sounds → Screen saver → Start time: Never). Plug the stick into a USB port that stays powered or a wall adapter.
2. **Smart TV with a browser** (Samsung, LG, Android TV, Google TV): open the browser, enter the same URL, choose full screen. This works but most TV browsers do not come back by themselves after a power cut, so someone has to reopen it; a stick or a BrightSign player is the better long-term choice.
3. Either way, set the TV to never sleep.

### Previewing on a computer

- Hosted: open `https://<your site host>/signage/live.html` in any browser. It scales to fit the window, so a laptop screen is fine for a look.
- Without the Worker: `node signage/tv-test.mjs --keep` starts a local server with sample data and prints a URL to open.
- Keys: **d** shows a debug overlay (API address, last fetch, errors), **n** skips to the next scene, **r** refetches now.
- Add `&at=2026-11-26T09:00` to the address to freeze the clock at a date and time and see what the screen says then (for example a holiday).

### Checking it automatically

`node signage/tv-test.mjs` serves the repo with a fake API built from `docs/fixtures/public-peachs.json`, opens the page at 1920×1080 in Chromium, screenshots every scene, checks for console errors, then cuts the API off and confirms the page still shows the saved data (and the brand screen when there is nothing saved). Screenshots land in a temp folder, or wherever `--out <dir>` points.
