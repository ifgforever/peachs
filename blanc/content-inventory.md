# Blanc Gallery: content inventory

Crawled 2026-10-11. The live site blocks the default curl user agent through Mod_Security, so all pages were fetched with a browser user agent. Items marked **CONFIRM** need the client.

## Sources crawled

- https://blancchicago.com/ (home page, current exhibition)
- https://blancchicago.com/about-us/
- https://blancchicago.com/exhibits/ (exhibition index), plus the individual `/portfolio/…` pages for each show from 2024 to 2026
- https://blancchicago.com/artists/ and a sample of the artist pages
- https://blancchicago.com/gallery-images/
- https://blancchicago.com/contact-us/
- https://blancchicago.com/calendar/ (empty)
- WordPress REST API page and post lists (`/wp-json/wp/v2/pages`, `/posts`) and the sitemap
- https://linktr.ee/blancgallerychicago (Instagram link-in-bio)
- Eventbrite: https://www.eventbrite.com/e/opening-reception-what-shall-i-do-with-my-dead-tickets-2001272755685
- https://www.instagram.com/blancgallerychicago/ (logged-out fetch returned only an app shell with no bio or posts, so it is linked and not quoted)

## Identity

| Fact | Value | Source |
|---|---|---|
| Name | Blanc | Chicago, “Blanc Art Gallery”, “Blanc Gallery” | home, about |
| Tagline | A Culture of Conversation | home, Linktree |
| Founders | Cliff Rome and Eileen Rhodes (photo caption: “Cliff Rome and Eileen Rhodes”) | /about-us/ |
| Parent | Rome’s Joy Companies (Cliff Rome, proprietor of the Parkway Ballroom) | /about-us/, brief |
| Mission | “to engage African Americans and all Chicagoans through the arts and to ignite a dialogue on issues of spiritual, political and social significance” | /about-us/ |
| Programs | “Speak Easy” (openings, artist talks, panel discussions); “Do Well/Do Good” (each cycle, two local non-profits) | /about-us/ |
| Private rental | “Blanc is not currently available for Private Rental” | /about-us/ |
| Logo | `wp-content/uploads/2025/03/small-blanc-logo.jpg` (75×75: square outline + “blanc”) | header. **CONFIRM** vector logo |

## Visit

| Fact | Value | Source |
|---|---|---|
| Address | 4445 South King Drive, Chicago, IL 60653 | /contact-us/; Eventbrite (4445 S. Dr. Martin Luther King Jr. Dr.); exhibition posters (4445 S. MLK Dr). Note that the Rome’s Joy office is 4455 S. King Dr. |
| Geo | 41.8136548, -87.6159522 | Eventbrite venue |
| Phone | 773.373.4320 | /contact-us/ |
| Hours | Sat and Sun 11 am–3 pm; Mon–Fri closed; also by appointment. “These hours are fixed unless otherwise noted on our instagram.” | /contact-us/ |
| Admission | Free (the opening reception is free on Eventbrite). **CONFIRM** that general admission is always free | Eventbrite |
| Parking | “Free” | Eventbrite “good to know”. **CONFIRM** this applies on regular days |
| Email | None published. The contact form (Contact Form 7) posts to the site. **CONFIRM** a public email | /contact-us/ |
| Instagram | https://www.instagram.com/blancgallerychicago/ | header, Linktree |
| Newsletter | https://lp.constantcontactpages.com/su/2FJ0bpq/blancsignup | Linktree |

## Upcoming exhibition (hero)

**What Shall I Do With My Dead?** by Raja’Nee Hamilton and Jalen Hamilton.
- Opening reception: Saturday, October 24, 2026, 5–8 pm. Free, RSVP on Eventbrite (sales open as of 2026-09-16). Under-18s must attend with a guardian.
- Described as a “six-week exhibition”. **CONFIRM** the closing date. The JS status label assumes 6 weeks.
- The copy is quoted and lightly trimmed from the Eventbrite description. The poster image (`img/whatshall.webp`) is the organizer’s Eventbrite cover image.
- Jalen Hamilton: first solo show *To Whom This Ground Belongs* (Blanc, 2022), co-facilitator of Deeply Curious Residency (III) (source: https://blancchicago.com/jalen-hamilton/).

## Exhibitions (dates as found)

| Exhibition | Dates | Artists / curator | Source |
|---|---|---|---|
| This Could Be//The Permanent Rebellion | Aug 7 – Sep 12, 2026 (opening Aug 7, 6–9 pm) | Curated by Imani Harmon. Marc A. V. Bates, Isabel Padilla Bonelli, Sevyn De La Cruz, Messejah Washington, Danielle Levi, Tafari Melisizwe, Nia Wilson, Adilah Muhammed, Annikah Idiova, Cheyenne Tobias-Bamson, Shelby/Shelbs, Dionne Clemon | home page and poster |
| From Memory to Movement: Emmett at 85 | Jun 5 – Jul 26, 2026 (opening Jun 5, 6–9 pm) | Curated by Raymond A. Thomas, in partnership with the Emmett Till and Mamie Till-Mobley Institute. Paul Branton, Roger Carter, Gerald Griffin, Candace Hunter, Tonika Lewis Johnson, Bryant Lamont, John Caleb Pendleton, Max Sansing, Norman Teague, Raymond A. Thomas, Bernard Williams, Kevin (WAK) Williams | portfolio page and poster |
| I Used to Live in Chicago | Apr 10 – May 24, 2026 (from the page URL) | Curated by Anefertiti Bowman. Norman Teague, Max Sansing, Steve Bravo, Sura Dupart, Tyrue “Slang” Jones, Patric McCoy | portfolio page |
| Loud & Clear | 2026 (posted Feb 24). **CONFIRM** dates | Jordan “Soup” Campbell | portfolio page |
| code: KING ALFRED | 2025 (posted Oct 29). **CONFIRM** dates | Andres L. Hernandez | portfolio page |
| Raised In It! | Aug 10 – Sep 20 (2025, from the poster) | Dorian Sylvain | portfolio page and poster |
| Water Lines | 2025. **CONFIRM** dates | Natasha Moustache | portfolio page |
| litany | 2025. **CONFIRM** dates | SSCAC in partnership with Blanc. Curated by jada-amina. Candace Hunter, Rhonda Wheatley, Erika Allen, Cydney Lewis, Sonja Henderson | portfolio page |
| In Retrospect | 2025 (video only, no text) | (not used) | portfolio page |
| The (Mis)Education of Chicago | 2024 (posted Oct 30) | Austin Pope | portfolio page |
| Frontline Prophet: James Baldwin | May 24 – Jun 30, 2024 | Sabrina Nelson. Curated by Ashara Ekundayo and Omo Misha | portfolio page |
| Lawrence Agyei: DRILL | Apr 5 – May 11, 2024 | Curated by Rikki Byrd. Part of Art Design Chicago (Terra Foundation) | portfolio page |
| GuestBook | Opened Feb 16, 2024 | Curated by Cliff Rome | portfolio page |
| Archive, 2019–2023 | Years taken from the post dates on /exhibits/ (approximate) | See the list in index.html | /exhibits/ |

## Artists

The list on the page combines most names on /artists/ (excluding the “Thick Description | Contributing Artist” project entry) with the artists of the 2024–2026 shows above. Left out to keep the list focused (all still on the live site): Alberto Vogelfrey, Antonio Calleja, Camille Morgan, Carlo LoCascio, Cati Munar, Clara Gracia, Juncal Aguirre, Marcelo Eli, Marco G. Ferrari, Michal Rejner, Olivier Souff, Raub Welch, Reisha, Susana Valdes, Terry Rashbrook. **CONFIRM** which artists the gallery wants listed.

## Press and links (from Linktree)

- Chicago Reader, “Embodied growth” (Outmoded Shapes): https://chicagoreader.com/arts-culture/embodied-growth-blanc-gallery-outmoded-shapes/
- Dazed, “Inside Chicago’s booming art scene”: https://www.dazeddigital.com/art-photography/article/56002/1/inside-chicagos-booming-art-scene-city-artists-brandon-breux
- Newcity Art, review of Brandon Breaux’s BIG WORDS: https://art.newcity.com/2022/04/25/constructing-identity-a-review-of-brandon-breaux-at-blanc-gallery/
- Chicago Reader, “The Big World of Brandon Breaux”: https://chicagoreader.com/arts-culture/the-big-world-of-brandon-breaux/
- South Side Weekly, Black Monuments: https://southsideweekly.com/black-monuments-going-from-city-to-city-the-monumental-tour-is-an-act-of-cultural-equity/
- CBS Chicago, South Shore Drill Team exhibit (from the DRILL page): https://www.cbsnews.com/chicago/news/chicago-gallery-south-shore-drill-team-exhibit/

The automated link check got 403, 406, or 429 bot-blocking responses from Chicago Reader, Newcity, CBS, and Constant Contact. These are anti-bot responses, not dead links; check them once in a browser.

## Images used (all from the client’s own pages, converted to WebP)

The posters and thumbnails come from /exhibits/ and the portfolio pages. The founders photo comes from /about-us/ (credit on the image: sandra steinbrecher). The gallery interiors come from /gallery-images/ (2024/04 IMG_4888–4890). Installation views are from the Water Lines, litany, and GuestBook pages. The upcoming-show poster comes from Eventbrite. No Instagram CDN images are used. With the client’s help, more photos and exhibition history can be pulled from Instagram (@blancgallerychicago).

## Neutral or placeholder copy written for the concept

- Section intros (“Every exhibition is the start of a conversation…”, “Stay in the conversation”). These are editorial, not factual claims.
- The private-events card points to the sister venue, Parkway Social (`../parkway-social/`, live site https://parkwaysocialchicago.com/). **CONFIRM** the wording.
- “Non-profit partners: call 773.373.4320.” **CONFIRM** the preferred contact.
