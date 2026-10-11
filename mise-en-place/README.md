# Mise En Place Chicago: website concept

A redesign concept for [miseenplacechicago.org](https://miseenplacechicago.org/), the hospitality training program of Rome in a Day Production Chicago (a 501(c)(3)) and part of the Rome's Joy family. One page, no build step. Everything on it comes from the live site, the program brochure PDF, romesjoy.com, and published press. See [`content-inventory.md`](content-inventory.md) for sources and the items to confirm.

Preview from the repo root with `npx http-server` (or `python3 -m http.server`) and open `/mise-en-place/`.

## What's better than the current site

| Current site | This concept |
|---|---|
| Home page is a logo image and one "Sign Up" button | A story in order: mission, how the program works, who it's for, graduates, team, partners, then how to apply or give |
| The three-tier program is only described inside a 5-page image PDF (no searchable text) | Tier One / Two / Three shown on the page with brochure photos, skills, and the student kit |
| "Sponsors" is one flat logo image | Logo strip plus a readable list of partners, and where Chef Rome's network places people |
| Donate page is a lone PayPal GIF button | Donate card with the same PayPal hosted button, what a gift pays for, the 501(c)(3) note, and partner options |
| Media page has unlabeled videos and a dead Chicago Tribune link | Press cards (including the 2025 Obama Presidential Center story), labeled video links |
| Theme demo leftovers (stock concert images, "Sample Page") | Only the program's own photos, resized to WebP (about 0.6 MB total) |
| No structured data | EducationalOrganization + NGO + Course JSON-LD with DonateAction |
| Desktop-first theme | Mobile-first layout, working menu, AA contrast, reduced-motion support |

## Needs from the client

- [ ] **Next session dates**, length, schedule, cost (or "free"), and eligibility beyond ages 16 to 36
- [ ] **An application form.** The live "Sign up" button goes to the general contact form. A real intake form (Google Form, Jotform, or a form on the new site) would help
- [ ] **Outcomes:** number of graduates, placement rate, employers. The concept shows no statistics because none are published
- [ ] **An email address** for the program (none is published; only the phone number)
- [ ] Confirm the team as shown: Chef Clifford Rome (founder), Eileen Rhodes (co-founder), Chef Trillis Rollins (instructor). Headshots welcome
- [ ] Confirm the sponsor list is current (the logo image dates from 2022) and send vector logos
- [ ] Permission to show the photos of students and graduates; names for captions if wanted
- [ ] Current Chicago Tribune article URL (the old link returns 404), and rights for the Chef Rome photo used in the press section
- [ ] Should the brochure (2022) and the "Clean Habits" custodial program be mentioned?
- [ ] At launch: remove the `noindex` tag and the "Concept preview" footer line

## Files

```
index.html     the whole site (one page)
css/styles.css styles (palette and contrast notes at the top)
js/main.js     mobile menu, header state, scroll reveals
img/           program photos, brochure crops, logo (WebP)
```
