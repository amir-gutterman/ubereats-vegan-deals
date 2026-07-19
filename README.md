# Uber Eats vegan deal finder

Fully autonomous personal tool. No inputs at runtime: it sets a fixed
delivery address, searches Uber Eats for "Vegan", scans the top ~12
restaurant results, and writes any vegan item discounted more than 10% to
[`deals.md`](deals.md) in this repo — a dashboard you can check anytime.

## How it runs

- **Schedule**: `.github/workflows/scraper.yml` runs it automatically twice
  a day (`0 13,20 * * *` UTC).
- **Manual override**: the workflow also has a no-input `workflow_dispatch`
  trigger, so you can hit **Run workflow** in the Actions tab any time
  without waiting for the schedule.
- **Output**: each run overwrites `deals.md` and, if it changed, the
  workflow commits and pushes it back to the repo using the built-in
  `GITHUB_TOKEN` (job has `permissions: contents: write` for this).

No repository secrets are required — address-setting and menu browsing are
both public, unauthenticated actions, and the commit-back uses the token
GitHub Actions already provides.

## Local setup

```
npm install
npx playwright install --with-deps chromium
npm run scrape
```

This writes `deals.md` in the project root and also prints it to stdout.

## Important: the selectors will probably need tuning

Uber Eats renders with hashed, auto-generated CSS class names that change
over time and aren't documented anywhere. `scrape.js` uses best-effort
selectors (`data-testid` attributes where Uber Eats has historically used
them, with text/pattern-based fallbacks) for four separate steps — address
entry, the search box, restaurant result links, and menu items — and I
can't verify any of them against the live site from here. **Budget for a
tuning pass after the first run(s).**

If `deals.md` comes back with "No qualifying deals found" or the restaurant
count looks wrong:

1. Run locally with `headless: false` temporarily in `scrape.js`'s
   `chromium.launch(...)` call to watch what happens.
2. Open `https://www.ubereats.com/es-en` in a normal browser and, at
   whichever step is failing (address modal, search box, results feed, or a
   menu page), right-click → **Inspect** to find the current attribute or
   text pattern.
3. Update the relevant entry in `SELECTORS` (or `extractRawItems` /
   `collectRestaurantLinks` for the page-context logic) in `scrape.js`.

The discount math (percent-off parsing, two-price parsing, the
`2-for-1 / 2 por 1 ⇒ 50%` approximation, the >10% filter, the vegan keyword
filter) is selector-independent and shouldn't need changes.

## Notes on scope

- Delivery fee is assumed €0 (Uber One) and isn't factored into the math.
- "Vegan" match is keyword-based: item text or its section heading must
  contain "vegan" or "plant-based". Items without an explicit label won't
  be caught even if they happen to be vegan.
- Each run loads the search feed plus up to `MAX_RESTAURANTS` (12) menu
  pages, twice a day, unattended, indefinitely. This is a meaningfully
  larger and more regular automated footprint against Uber Eats than the
  original one-off manual tool. No anti-bot evasion is implemented — if
  Uber Eats blocks or challenges the automated browser, that's a signal
  from their side, not something this script tries to work around. If runs
  start failing consistently, that's worth treating as a stop sign rather
  than a bug to route around.
- Because the repo is public, `deals.md` — restaurant names, item names,
  and prices — is visible to anyone. Nothing sensitive is written, but
  worth knowing.
