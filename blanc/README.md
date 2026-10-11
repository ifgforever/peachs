# Blanc Gallery: website concept

A redesign concept for [blancchicago.com](https://blancchicago.com/), the contemporary art gallery at 4445 S. King Drive in Bronzeville and part of Rome’s Joy Companies. It is one quiet, gallery-white page where the artwork supplies the color. The upcoming exhibition comes first, then the visit details.

Every fact on the page comes from the live site, the gallery’s Linktree, or its Eventbrite listing. See [`content-inventory.md`](content-inventory.md) for sources and the items to confirm with the client.

## What's better than the current site

| Current site | This concept |
|---|---|
| Home page still features *The Permanent Rebellion*, which closed September 12, 2026 | Leads with the next show, *What Shall I Do With My Dead?* (opens October 24), with a free RSVP button that goes straight to Eventbrite |
| Hours and address only on the Contact page | Hours, address, and phone right under the hero. A live “Open now / Opens today” badge uses Chicago time |
| The Exhibits page is a grid of thumbnails with no dates or artist names | Each exhibition shows its dates, artists and curators. The latest show is featured in full, and older shows sit in an archive list from 2019 to 2023 |
| The mission, Speak Easy, and Do Well/Do Good are buried on About | Story, founders, and programs each have their own section, and the page says plainly that private rental is not offered, pointing event inquiries to Parkway Social |
| Press, newsletter sign-up, and the Eventbrite link exist only on Linktree | Press, newsletter, and RSVP are all on the site |
| Leftover theme demo posts (for example “Miami Street Style”) are still public in WordPress | Clean, static, fast page with no demo content |
| No structured data | `ArtGallery` with hours, address, and geo, plus `ExhibitionEvent` entries (free offer for the opening) |
| A 75 px logo and generic theme | A larger rendering of the square + “blanc” mark, Instrument Serif and Inter type, AA contrast, mobile menu, and reduced-motion support |

## Needs from the client

- [ ] Closing date for *What Shall I Do With My Dead?* (Eventbrite says “six-week exhibition”, which would be about December 5, 2026)
- [ ] Better installation photography and high-resolution poster files, especially for the hero and the archive
- [ ] A public email address for the gallery. The live contact form has no visible address, so the concept uses phone, Instagram, and the newsletter instead
- [ ] Confirm whether free parking (listed on Eventbrite) applies on regular gallery days
- [ ] Confirm the private-events message: Blanc says it is “not currently available for Private Rental”, so inquiries are routed to Parkway Social
- [ ] Current Do Well / Do Good non-profit partners, if they should be named
- [ ] Instagram access, to pull more exhibition photos (we do not hotlink Instagram images)
- [ ] WordPress or hosting login, and clean-up of the theme demo posts
- [ ] At launch, remove the `noindex` tag and the “Website concept preview” footer line

## Files

```
index.html        the whole site (one page)
css/styles.css    styles (palette and contrast notes at the top)
js/main.js        mobile nav, open-now badge, exhibition status label, scroll reveals
img/              the gallery's own images, converted to WebP (about 0.8 MB)
```
