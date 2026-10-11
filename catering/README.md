# Rome’s Joy Catering: website concept

A redesign concept for [romesjoy.com/catering](https://romesjoy.com/catering/), part of the Rome’s Joy Companies pitch. One page, no build step: `index.html`, `styles.css`, `main.js`, images in `img/`, and a local copy of the current catering menu PDF in `menu/`.

All copy, prices and names come from the live catering page, the parent site’s About / News / Our Companies pages, and the catering menu PDF (rev. 12.25). See [`content-inventory.md`](content-inventory.md) for sources and the items marked **CONFIRM**.

## What’s better than the current site

| Current page | This concept |
|---|---|
| Opens with a quote and a chef bio; no headline saying what the business does | Clear hero: who you are, what you cater, and a “Request a quote” button repeated in the sticky header |
| Menu is only a PDF link | Full menu on the page (69 items) in tabs: salads, hot lunch & pasta, box lunches, dinner, brunch, full pans, desserts & drinks, with prices, dietary tags and allergens |
| No guidance on how ordering works | Four-step “How it works” with the real rules (10-order minimum per selection, full pans feed 20, equipment add-ons) |
| Obama Presidential Center news lives on a different page | “In the news” strip right under the hero, linking Sun-Times, Block Club, Eater, FOX 32 and ABC7 |
| Four small photos with no captions or context | Photo collage in the hero and a captioned gallery, with an Instagram link (@rjc.events) for more event photos |
| Request form has a mislabeled field (“Event Event of”, a spam honeypot showing as a label) and free-text event type | Cleaner form: event type dropdown, phone, menu interests, date picker, inline validation, accessible labels |
| Theme defaults, little structured data | Custom black-and-gold design from the RJC logo, schema.org `FoodEstablishment` data, AA contrast, keyboard-friendly tabs and nav, reduced-motion support |

## Preview

From the repo root: `npx http-server -p 8080` then open http://localhost:8080/catering/.

## The quote form

There is no backend. Pressing **Send my request** opens the visitor’s email app with a pre-filled message to ordering@romesjoy.com (the page says so under the button). Before launch, point the form at a real handler (the existing WPForms install, Formspree, Toast Catering, etc.) so requests arrive even when the visitor has no mail app set up.

## Needs from the client

- [ ] Choose the form backend for quote requests (and who receives them)
- [ ] Confirm the event-type options in the dropdown and the “How it works” steps (follow-up time, lead time, deposit, delivery area and fee)
- [ ] Confirm allergen notes where the PDF looks copy-pasted (see CONFIRM items in the content inventory)
- [ ] Confirm @rjc.events is the official catering Instagram, and share high-resolution event photos (current images are 300×300)
- [ ] Notable clients or past events they are happy to name (none are listed on the live site, so none are shown)
- [ ] Confirm whether the Peach’s half-pan catering menu should be ordered through Rome’s Joy Catering or Peach’s (773.966.5801)
- [ ] Vector RJC logo
- [ ] Remove the `noindex` tag and the “Concept preview” footer line at launch
