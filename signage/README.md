# In-store screens

Three TVs, three videos. Each is 1920×1080 and loops on its own BrightSign player.

| Screen | File | Sound | Length |
|---|---|---|---|
| **Entrance**, the first thing guests see | `peachs-entrance-loop.mp4` (built on request, **not in this repo**; see below) | Yes, during the Obama Foundation videos | Depends on the videos |
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
7. **Parkway Social**: the historic Parkway Ballroom (Ellington, Basie, Armstrong), $150 membership, $25 day pass, and "Members save 15% on Peach's meals over $30".
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

Cliff has permission to show these videos in the restaurant. That doesn't cover publishing them, and this repo is public, so the clips and the finished entrance video are kept out of git (see `.gitignore`).

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
- Widescreen clips play full screen. A clip of any other shape (a vertical phone video, say) plays in a Peach's-colored frame with its title beside it.
- Every clip's sound is leveled to the same loudness, so one video isn't much louder than the next.
- To cut a clip's start or end (for example, a YouTube end screen), add `"start": 2` and/or `"end": 95` (seconds) to that clip in `entrance.json`.
- To add another video (a news segment, a new Instagram post), put the file in `source/` and add a block like the existing clips to `entrance.json`.

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
