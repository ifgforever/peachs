# Parkway Social: website concept

A redesign concept for [parkwaysocialchicago.com](https://parkwaysocialchicago.com/), the coworking lounge, social club and event space inside the historic Parkway Ballroom (4455 S. King Drive). One page, no build step, no frameworks. Part of the Rome's Joy Companies concept set; the footer links back to `../romesjoy/` and to the concept hub at `../`.

All copy, prices, room details and photos come from the live site. See [`content-inventory.md`](content-inventory.md) for sources and the items to confirm.

## What's better than the current site

| Current site | This concept |
|---|---|
| Five thin pages; the homepage is two paragraphs and one image | One page that tells the whole story: legacy, rooms, membership, events, gallery, visit |
| Price ($150/month, $25 day pass) buried at the bottom of the Membership page | Prices in the hero "at a glance" strip and in clear plan cards |
| No clear main action | "Book a tour" in the header, hero, membership and closing band; "Host an event" right behind it |
| Event booking is a bare name/email/message form on "Contact Us" | Dedicated events section with a room size/capacity table and an inquiry form (event type, date, guest count) |
| The Parkway Ballroom story (Ellington, Basie, Armstrong) hidden on About | Story section near the top: the strongest selling point leads |
| Room photos are 300px thumbnails, no gallery | Large room cards plus a 12-photo gallery with a keyboard-accessible lightbox |
| Member perks (Peach's, catering, event discounts) in a plain list | "Family perks" panel that ties Parkway Social to the other Rome's Joy companies |
| Right-click "Content is protected" script, no structured data | Accessible markup, AA contrast, LocalBusiness/EventVenue JSON-LD with hours, rooms, capacity and offers |
| Hours only in the footer | Live "Open now / Closed" badge (Chicago time) on the hero photo |

## Preview

From the repo root: `npx http-server -p 8080` and open http://localhost:8080/parkway-social/.

## Needs from the client

- [ ] Confirm which day-pass link is current: the nav uses `plan=10957`, the Membership page button uses `plan=7416` (this concept uses 10957)
- [ ] Event rental details: standing/seated capacity per room, whole-venue capacity, rental pricing, AV, catering rules, after-hours availability
- [ ] Choose a form backend for the event inquiry (the concept opens the visitor's email app addressed to parkwaysocial@romesjoy.com; Formspree, Netlify Forms or the existing WPForms would capture leads reliably)
- [ ] Photos of the Outdoor Courtyard (none on the live site), events in progress, and the Pillar phone booth
- [ ] Confirm the room in the round-table / woven-pendant photo (`img/meeting-table.webp`) and the bar photo (`img/bar.webp`) are Parkway Social
- [ ] Is breakfast/lunch included with membership or paid? (Live copy is ambiguous; the concept says "meals on site")
- [ ] Is the space open evenings or weekends for members or events? (Live site lists only Mon–Fri 8:30 am–5 pm, but the About page mentions courtyard cocktails, artist talks and game nights after hours)
- [ ] Vector logo file (the wordmark here is set in type to match)
- [ ] Testimonials or member quotes, if any (none used; none on the live site)
- [ ] Remove the `noindex` tag and the "Concept preview" footer line at launch

## Files

```
index.html        the page
css/styles.css    styles (palette and contrast notes at the top)
js/main.js        mobile nav, open-now badge, gallery lightbox, event inquiry, scroll reveals
img/              the client's photos, resized to WebP
```
