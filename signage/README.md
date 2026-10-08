# In-store screen loop

`peachs-instore-loop.mp4` is a 1920×1080 video for the TVs in the restaurant. It has no sound and is built to loop without a visible jump. The same file plays on every screen, whether there are 2 or 3.

## What's in it (about 1½ minutes)

1. **Pancake stack**: the 3D pancakes from the website, with hours and address.
2. **"In his words"**: President Obama's Instagram caption about Cliff and Peach's (@barackobama, May 23, 2025), quoted word for word.
3. **Chef Cliff Rome**: his background, Rome's Joy Companies, and his role at Tafari's Kitchen and the Obama Presidential Center (from obama.org).
4. **President Obama's Favorites**: the two dishes from the menu, plus the WGN-TV headline.
5. **Signature plates**: pancakes, banana rum French toast, hangover wings, avocado toast.
6. **Coffee**: Best Damn Drip, $14.
7. **Catering**: half-pan prices, phone number and email.
8. **Closing**: logo, hours, address, @peachson47th.

Prices come from the menu on the website. Update `loop.html` and re-render if they change.

## Putting it on a BrightSign player

1. On a computer, install **BrightAuthor:connected** (free from brightsign.biz).
2. Create a new presentation:
   - Resolution: 1920×1080, 30p.
   - Layout: one full-screen zone.
3. Add `peachs-instore-loop.mp4` to that zone. With a single file in the zone, it repeats on its own.
4. Choose **Publish → Local Storage** and save to the player's microSD card.
5. Put the card in the player and power it on. Repeat for each screen's player, or copy the same card contents to each.

## Changing it

1. Edit `loop.html`. To preview a single frame, open it with `?scene=obama&t=8`.
2. From the repo root, run `python3 -m http.server 8765`, then `node signage/render.mjs`.
3. Each scene is saved to `signage/build/`. The scenes are then joined into `peachs-instore-loop.mp4`.
4. To re-render only some scenes, name them: `node signage/render.mjs cliff outro`.

The Obama Instagram video can be added as its own scene once someone has the file and permission to play it. The video belongs to Obama's account, so ask his team, through Cliff, before showing it in the restaurant. The quote slide only quotes his public caption and credits it to him, but it's still worth mentioning to Cliff.
