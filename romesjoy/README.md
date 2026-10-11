# Rome's Joy Companies: hub concept

A redesign concept for [romesjoy.com](https://romesjoy.com/), the parent site for Chef Cliff Rome's family of businesses. It is one page that links out to the sibling concepts in this repo (Peach's, Catering, Parkway Social, Mise En Place, Blanc) and to each company's live site.

All copy comes from romesjoy.com (Home, About, Our Companies, Catering, News, Contact), plus Chef Rome's bio on chicagogourmet.org and social links the client supplied. See [`content-inventory.md`](content-inventory.md) for sources and the items marked **CONFIRM**.

## What's better than the current site

| Current site | This concept |
|---|---|
| Six "We Are" slides with no words on the photos; the homepage says almost nothing | A clear hero that names every company, plus a single primary action ("Explore our companies") and a secondary one ("Partner with us") |
| Obama Presidential Center news is one line and a "Learn more" link | A full news band: the Bon Appétit / BAMJoy headline, the latest ABC7 story featured, and all 7 press links with dates |
| Company logos with no descriptions; addresses only on a separate page | One card per company with a photo, logo, one-line description, address, phone, a link to its new concept and a link to its live site |
| R.J.C. Sausage Company is a logo with nowhere to go | Links to the new R.J.C. Sausage concept (`../rjc-sausage/`) and says its live website is coming soon |
| Several nav and footer links point at a Bluehost staging URL (`gvy.upa.mybluehost.me/website_1acdf3a7/...`) | Every link is relative or points at the real domain |
| Leadership bios are walls of text on a separate page | Chef Rome's story, the mission statement, team cards, community partners, hiring partners and certifications (IBEP, MBE, ACDBE) are all on the home page |
| The contact form needs JavaScript from WPForms; there's no map link | Address, a tap-to-call number, email and a Google Maps link, plus a form that opens the visitor's email app (no backend) |
| No structured data | Organization JSON-LD with founder, team and all sub-companies (Restaurant, ArtGallery, EducationalOrganization and others) |
| Not mobile-tuned | Mobile-first layout, a working menu button, WCAG AA contrast, reduced-motion support, about 720 KB total |

## Preview

From the repo root: `npx http-server -p 8080`, then open http://localhost:8080/romesjoy/.

## Needs from the client

- [ ] WordPress / Bluehost login to replace the site, and to fix the staging links the live site uses today
- [ ] Which inbox should receive website inquiries (the concept uses ordering@romesjoy.com from the Contact page)
- [ ] Vector logo files for RJC and each company (the concept uses the 150 px logos from the site)
- [ ] Higher-resolution photos: the company and team images on the site are 300 px
- [ ] Confirm the hero photo is Chef Rome and that we may caption it that way
- [ ] Confirm @rjc.events is the Rome's Joy Catering Instagram account; are there social accounts for the parent company, Parkway Social or Mise En Place?
- [ ] R.J.C. Sausage Company: a phone or email, and a product line or retail stockists if any
- [ ] Office hours for 4455 S King Drive, if visitors should come in
- [ ] Illinois Restaurant Association role: romesjoy.com says "advisory board member", chicagogourmet.org says "Board of Directors"
- [ ] Mise En Place: whether it runs under Rome and a Day Productions (the 501(c)(3)) so it can be described as a nonprofit
- [ ] A form backend (Formspree, WPForms or similar) at launch, replacing the mailto form
- [ ] Remove the `noindex` tag, the "Concept preview" footer line and the "All concepts" bar at launch

## Files

```
index.html          the page
css/styles.css      styles (palette and contrast ratios noted at the top)
js/main.js          menu button, hero word rotator, mailto form, scroll reveals
img/                site images converted to WebP
content-inventory.md  every fact used, with its source
```
