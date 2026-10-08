# Peach's on 47th — homepage redesign (demo)

A redesigned homepage for [peachson47th.com](https://peachson47th.com/), built to present to the client.
It's a plain static site (no build step), so it runs anywhere and doesn't need the client's WordPress login.

## The hero: a floating pancake stack
- Pancakes drift into view **floating in the air**, hang for a beat, then **drop onto the plate one at a time** with a soft landing squash.
- Then the whipped cream and blueberries land and the **blueberry sauce pours down the sides**. It matches their real Berry Pancakes.
- **Scrolling down lifts the stack back into the air**, and scrolling up re-stacks it.
- There's no video and no play button. Everything is drawn with code (SVG + JavaScript), so it starts by itself on iPhone.
- If a visitor's phone has **Reduce Motion** turned on, they see the finished stack standing still instead.

## Files
| File | What it is |
| --- | --- |
| `index.html` | Page content: hero, favorites, menus, Instagram, visit info, footer |
| `styles.css` | Look and layout (peach / cream / syrup colors, Fraunces + DM Sans fonts) |
| `script.js` | Pancake animation, "Open now" badge (Chicago time), scroll effects |
| `assets/menu/` | The six food photos, taken from the current site and compressed |

## Preview locally
```
python3 -m http.server 8000
```
Then open http://localhost:8000. You can also just double-click `index.html`.

## To confirm with the client
- The dish descriptions and the hero tagline are placeholder copy written from the photos. Get his wording.
- The menu links point to the current PDF/PNG files on peachson47th.com. They'll need updating when the menus change.
- The Shop, In the News and Contact links still go to the existing WordPress pages.
- Hours, address, phone and the Toast ordering link were copied from the live site in Oct 2026.
