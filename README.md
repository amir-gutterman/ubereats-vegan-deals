# Uber Eats vegan deal finder

Fully autonomous personal tool. No inputs at runtime: it sets a fixed
delivery address, opens Uber Eats' "Vegan" category, scans up to 12
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

## Two things that aren't ordinary selector bugs

**Uber Eats' "Vegan" search doesn't filter — it just re-ranks.** Clicking
the Vegan category returns the same full local result set (verified
directly: same "311 results" count, grocery stores like Carrefour and
Costco still on top), with vegan-named places starting further down.
`collectRestaurantLinks()` in `scrape.js` compensates by filtering result
cards to ones whose own text mentions "vegan" before taking the top
`MAX_RESTAURANTS`; if none do, it logs a warning and falls back to the
unfiltered top N rather than silently returning nothing.

**Uber Eats runs its own bot/fraud challenge**, and it can trigger on
direct automated navigation — this was observed firsthand while verifying
this script (navigating straight to a restaurant URL got redirected to
`def.uber.com/en/challenge`, Uber's own anti-fraud check, during ordinary
manual browsing, not even from a datacenter IP). `isBotChallengePage()`
detects the redirect and reports it plainly (`"Uber Eats served a bot-check
page..."`) instead of it showing up as a confusing zero-items result. This
script does not attempt to solve or route around that challenge. If it
shows up often in the logs, that means Uber Eats is blocking this
automation — treat that as a stop sign, not something to fix by adding
evasion.

## If selectors genuinely need tuning

The selectors in `SELECTORS` and in `extractRawItems` /
`collectRestaurantLinks` were verified against the live site on 2026-07-19,
but Uber Eats' hashed, auto-generated class names can still drift over
time. If `deals.md` comes back empty and the log doesn't show a bot-check
warning:

1. Run locally with `headless: false` temporarily in `scrape.js`'s
   `chromium.launch(...)` call to watch what happens.
2. Open `https://www.ubereats.com/es-en` in a normal browser and, at
   whichever step is failing (address input, the Vegan category link,
   restaurant links, or menu items), right-click → **Inspect** to find the
   current attribute or text pattern.
3. Update the relevant entry.

The discount math (percent-off parsing, two-price parsing, the
`2-for-1 / 2 por 1 ⇒ 50%` approximation, the >10% filter, the vegan keyword
filter) is selector-independent and shouldn't need changes.

## Notes on scope

- Delivery fee is assumed €0 (Uber One) and isn't factored into the math.
- "Vegan" item match is keyword-based: item text or its section heading
  must contain "vegan"/"vegano"/"vegana" or "plant-based". Items without an
  explicit label won't be caught even if they happen to be vegan.
- Each run loads the results feed plus up to `MAX_RESTAURANTS` (12) menu
  pages, twice a day, unattended, indefinitely — a meaningfully larger and
  more regular automated footprint against Uber Eats than the original
  one-off manual tool, and (per above) one that has already been observed
  triggering Uber's own bot-challenge once. No anti-bot evasion is
  implemented or planned; if runs start failing/challenged consistently,
  that's worth reconsidering the schedule or scope rather than working
  around it.
- Because the repo is public, `deals.md` — restaurant names, item names,
  and prices — is visible to anyone. Nothing sensitive is written, but
  worth knowing.
