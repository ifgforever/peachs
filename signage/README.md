# In-store screens

Three TVs, three videos. A fourth option, the **live screen**, is a web page that updates itself from the admin panel (hours, menu, notices, events, artworks); see "Live screen" at the end. Each is 1920×1080 and loops on its own BrightSign player.

| Screen | File | Sound | Length |
|---|---|---|---|
| **Entrance**, the first thing guests see | `peachs-entrance-loop.mp4` (full quality for the TV, **not in this repo**; see below) | Yes, during the Obama Foundation videos | Depends on the videos |
| **Screen 2** | `peachs-instore-loop.mp4` | No | 1:35 |
| **Screen 3** | `romesjoy-family-loop.mp4` | No | 2:41 |

Every scene fades through the same cream color, so any two of these files can also play back to back on one screen.

## Screen 3: the Rome's Joy family loop (`romesjoy-family-loop.mp4`)

Promotes Chef Cliff Rome, every company in the group, and his community work. Each company scene uses that company's own colors, fonts and logo, with a "Rome's Joy company" bar along the bottom.

1. **Open**: "One chef. One neighborhood. A whole community." Rome's Joy since 2000.
2. **Chef Cliff Rome**: Englewood native; Spago and Paris; Cannes American Pavilion 1998–2003; founded Rome's Joy in 2000; 30+ years; Washburne advisory board.
3. **Obama Presidential Center**: BAMJoy with Bon Appétit, plus the press clippings (Sun-Times, Block Club, Eater, Crain's, FOX 32, ABC7).
4. **Meet the family**: all six companies with their logos.
5. **Peach's**: "You're at Peach's on 47th. Find us on campus, too." (47th, University, Law).
6. **Rome's Joy Catering**: full-service catering, Chef Trillis Rollins, phone, email, @rjc.events.
7. **Parkway Social**: the historic Parkway Ballroom (Duke Ellington, Louis Jordan and Sun Ra all have dated appearances there), $150 membership, $25 day pass, and "Members save 15% on Peach's meals over $30".
8. **In his words**: Chef Rome's own GuestBook text about the Parkway Ballroom (Blanc, 2024).
9. **Blanc Gallery**: mission, Do Well / Do Good, hours, and the fall show *What Shall I Do With My Dead?*
10. **R.J.C. Sausage Co.**: Halal Zabiha chicken sausage and patties.
11. **Mise En Place**: job training for ages 16 to 36, the three tiers, how to donate.
12. **Building community**: Mise En Place, Clean Habits, Rome's Joy Institute, Do Well / Do Good.
13. **Partners**: community partners and where trainees land jobs (scrolling), plus MBE / IBEP / ACDBE certifications.
14. **Close**: social handles, "Partner with us · 773.373.4320", and a QR code to romesjoy.com.

Facts come from the content inventories in each company's folder (`../romesjoy/content-inventory.md` and the others).

**Please confirm before it goes on the wall:**
- [ ] The garden photo in scene 2 is Chef Rome (the same photo flagged in `romesjoy/`).
- [ ] @rjc.events is the catering Instagram account.
- [ ] R.J.C. Sausage: Halal Zabiha certified, all-natural, gluten-free non-pork casing, USDA inspected, and ordering@romesjoy.com for wholesale (these came from a LinkedIn profile).
- [ ] Mise En Place: every student gets a chef jacket, knife kit and ServSafe food handler certificate (the brochure sentence is garbled).
- [ ] Does Peach's use R.J.C. chicken sausage in The Big Bird or This Cluck'n Biscuit? If so, the sausage scene can say "Try it here."

**Dated line:** the Blanc scene shows "Free opening reception · Sat, Oct 24 · 5–8pm". That line drops out automatically when the loop is rendered after October 24, so re-render once after that date, and again when Blanc's next show is announced.

## Entrance screen: the Obama Foundation videos, with sound

`entrance.json` lists what plays, in order, then repeats:

1. The pancake stack with hours and address (from the Screen 2 loop), silent
2. A title card, then **"President Obama makes a surprise visit to South Side Chicago restaurant"** (Obama Foundation, https://youtu.be/2GJKUQ3Di48), with sound
3. President Obama's Favorites (from the Screen 2 loop), silent
4. A title card, then **"What's cooking at the Obama Presidential Center: Meet Chef Cliff Rome"** (Obama Foundation, https://youtu.be/yq40-pdvyPs), with sound

The full-quality entrance video is about 30 MB, over Cloudflare's 25 MB limit per file, so it stays out of git along with the source clips (see `.gitignore`) and goes to the TV directly. A smaller 720p copy, `peachs-entrance-loop-web.mp4`, is in the repo and plays on the landing page.

### Getting the video files

YouTube blocks downloads from the build server, so the files have to come from you:

- **Best:** ask Cliff's contact at the Obama Foundation for the original video files. They will be sharper than YouTube's copy.
- **Otherwise:** save them from YouTube at 1080p (or the highest quality offered).

Upload them to Google Drive or Dropbox, set sharing to "Anyone with the link", and send the links to Claude. The build server can download from both. The files go in `signage/source/` with these names:

| Video | File name |
|---|---|
| President Obama's surprise visit | `source/obama-visits-peachs.mp4` |
| Meet Chef Cliff Rome | `source/meet-chef-cliff-rome.mp4` |

### Building it

From the repo root, run `python3 -m http.server 8765`, then `node signage/entrance.mjs`.

- Any listed clip that isn't in `source/` is skipped, so it builds with whatever is there.
- It writes three files: `peachs-entrance-loop.mp4` (full quality, about 30 MB, for the BrightSign player), `peachs-entrance-loop-web.mp4` (720p, about 10 MB, for the landing page) and `peachs-entrance-loop-tv.mp4` (1080p, about 21 MB, for the `/tv/` page). Commit the web and TV copies; the full file is over Cloudflare's 25 MB limit.
- Widescreen clips play full screen. A clip of any other shape (a vertical phone video, say) plays in a Peach's-colored frame with its title beside it.
- Every clip's sound is leveled to the same loudness, so one video isn't much louder than the next.
- To cut a clip's start or end (for example, a YouTube end screen), add `"start": 2` and/or `"end": 95` (seconds) to that clip in `entrance.json`.
- To add another video (a news segment, a new Instagram post), put the file in `source/` and add a block like the existing clips to `entrance.json`.

## Showing a loop on a TV with a Fire TV Stick or an Android box

Open **peachs.tvinstallchicago.workers.dev/tv** in the TV's web browser and press OK. The entrance loop plays full screen, with sound, and repeats until you turn it off. The two other buttons play Screen 2 and Screen 3 (or open `/tv/?screen=2` or `/tv/?screen=3`). This needs Wi-Fi the whole time.

For a demo without Wi-Fi, save the video onto the device first, then play it in VLC with Repeat mode set to "Repeat single" (during playback press Up, choose Repeat mode, press OK once so the icon shows a 1). **peachs.tvinstallchicago.workers.dev/loop** downloads the 1080p entrance loop as a file; type it into the Downloader app on a Fire TV, or a browser on an Android box. The TV page's **Save this video to the device** link does the same. Fire TV sticks that run Vega OS (Settings > My Fire TV > About shows "OS" without "Fire") can't install Downloader or the regular VLC, so use the web page there.

## Putting a video on a BrightSign player

1. On a computer, install **BrightAuthor:connected** (free from brightsign.biz).
2. Create a new presentation:
   - Resolution: 1920×1080, 30p.
   - Layout: one full-screen zone.
3. Add the screen's MP4 to that zone. With a single file in the zone, it repeats on its own.
4. Choose **Publish → Local Storage** and save to the player's microSD card.
5. Put the card in the player and power it on.

Do this once per screen, each with its own file. For the entrance screen, the sound goes over the HDMI cable to the TV: make sure the TV isn't muted and set a comfortable volume. Screens 2 and 3 are silent.

## Changing a loop

1. Edit `loop.html` (Screen 2) or `family.html` (Screen 3). To preview one frame, open it with `?scene=<id>&t=<seconds>`, e.g. `family.html?scene=parkway&t=8`.
2. From the repo root, run `python3 -m http.server 8765`, then:
   - `node signage/render.mjs` for Screen 2
   - `node signage/render.mjs family` for Screen 3
3. Each scene is saved to `signage/build/<loop>/`, then they are joined into the MP4.
4. To re-render only some scenes, name them after the loop, e.g. `node signage/render.mjs family blanc outro`.

---

## Live screen (updates itself from the admin)

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

### Blanc gallery screen

```
https://peachs.tvinstallchicago.workers.dev/signage/live.html?business=blanc
```

Blanc's screen is the same page with a gallery slideshow added (any business with the artwork catalog switched on gets it):

1. **Welcome**: name, open/closed, today's and the week's hours.
2. **Title card**: "Now showing", the exhibition's title and dates (for example "Sep 19 – Nov 1, 2026").
3. **One scene per artwork** in the current exhibition: the main photo large on a dark gallery wall, with a slow, slight zoom (none on players or computers set to reduce motion), and a wall label: title, artist, year · medium, dimensions, and a small red dot with "Sold" for sold pieces. **Prices are never shown on the TV**, whatever the website shows.
4. Then the usual scenes: catering, Coming up, closing.

If no exhibition is on right now, the slideshow shows the next exhibition's pieces ("Coming soon"); if that has none either, the pieces marked Featured ("From the collection"). Up to 20 artworks play per round; with more, the next round shows the next 20, and so on.

How to control it, all in the admin (Blanc → Artworks):

| To | Do this |
|---|---|
| Put a piece on the screen | Tick **Published**, pick its **Exhibition**, and add at least one photo (the first photo is the one shown). Pieces without a photo are left out |
| Change the order | Featured pieces come first, then the order on the Artworks page |
| Show the red dot | Set **Status** to Sold |
| Take a piece off | Untick **Published** (it also leaves the website) |
| Change the title card | Edit the exhibition in Events (title, subtitle, dates) |
| Seconds per scene | the `signage:blanc` setting, `seconds_per_scene` (12 to start with; every scene, artworks included) |
| Turn the slideshow or the catering card off | `"show_artworks": false` or `"show_catering": false` in the same setting |

Changes reach the screen within 5 minutes. The screen loads each photo before its scene comes up; a photo that will not load is skipped (and tried again ten minutes later), so a broken link never shows as an empty wall. It also remembers which photos it has shown: without internet it plays the saved data and only those photos (the browser keeps the files), and if none of them load it simply skips the slideshow.

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

`node signage/tv-test.mjs` serves the repo with a fake API built from `docs/fixtures/public-peachs.json`, opens the page at 1920×1080 in Chromium, screenshots every scene, checks for console errors, then cuts the API off and confirms the page still shows the saved data (and the brand screen when there is nothing saved). It then does the same for Blanc's gallery screen with sample artworks (title card, then each piece; the sold dot; no prices; a broken photo skipped; offline from the saved copy, with and without the photos; more than 20 pieces rotating). Screenshots land in a temp folder, or wherever `--out <dir>` points.
