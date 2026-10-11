# R.J.C. Sausage Co.: website concept

A brand-new site for R.J.C. Sausage Company, the Halal Zabiha chicken sausage and patty maker in Bronzeville, Chicago, and part of Rome's Joy Companies. The company has no website today, so this is a first site, not a redesign.

There are no product photos yet, so the art direction comes from the real logo: black-and-white butcher-awning stripes, the oval "R.J.C." cartouche, a slab display face (Rye), and paprika, mustard and halal-green accents. The sausage links and patty are drawn in inline SVG. The only photos are the logo and Chef Rome's portrait, both from romesjoy.com.

All facts come from the client contact and romesjoy.com. See [`content-inventory.md`](content-inventory.md) for sources and the items marked CONFIRM.

## What this site gives them

- A place to send buyers: one page that explains the product, the halal certification and who it's for.
- A clear wholesale path: a food-service inquiry form (restaurant, grocer, school, caterer, distributor) plus a click-to-call phone number on every screen size.
- Halal Zabiha front and center: in the hero, the badges, a dedicated section, and the buyer pitch.
- A ready-made "Where to buy" section, with clearly labeled placeholders until retailers are confirmed.
- A brand system built from their own logo that works without product photography, and is ready for photos later.
- Organization and Product structured data (no made-up prices or offers), fast load (about 140 KB plus fonts), mobile nav, WCAG AA contrast, and reduced-motion support.
- A link back to the Rome's Joy family site.

## Needs from the client

- [ ] Confirm every product claim (all natural, clean ingredients, gluten-free non-pork casing, USDA inspected, lower fat); see the inventory
- [ ] Halal Zabiha certifying body name and certificate number (shown as text only; no certifier logo is used)
- [ ] Product names, flavor lineup and pack sizes (flavor cards are placeholders)
- [ ] Retail and restaurant locations for "Where to buy" (placeholders now); confirm whether Peach's on 47th serves it
- [ ] The inbox for wholesale inquiries (the form currently addresses `ordering@romesjoy.com`, the Rome's Joy ordering address) or a form service such as Formspree
- [ ] Product photography (raw links, cooked links, patties, packaging) and a vector logo
- [ ] Spec sheet or nutrition panel to offer as a download (no nutrition numbers are on the page)
- [ ] A domain name; then make the og:image and JSON-LD logo URLs absolute
- [ ] Remove the `noindex` tag and the "Concept preview" footer line at launch

## Preview

From the repo root: `python3 -m http.server 8080`, then open http://localhost:8080/rjc-sausage/.

## Layout

```
index.html        the whole site (one page)
css/styles.css    styles (tokens and contrast notes at the top)
js/main.js        mobile nav, wholesale inquiry email composer, footer year
img/              logo, favicon, Chef Rome portrait (from romesjoy.com)
```
