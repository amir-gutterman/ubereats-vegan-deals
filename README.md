# Uber Eats vegan deal finder

Fully autonomous personal tool. No inputs at runtime: it sets a fixed
delivery address, opens Uber Eats' "Vegan" category, scans up to 12
restaurant results, and writes any vegan item discounted more than 10% to
[`deals.md`](deals.md) in this repo — a dashboard you can check anytime.

## Known limitation: Uber Eats blocks a real fraction of runs

GitHub-hosted runners get served Uber Eats' Cloudflare bot-check
("Performing security verification... Cloudflare") on some runs — confirmed
directly via a debug snapshot, not a guess (`debug-snapshots-3` artifact,
2026-07-19: title `Just a moment...`, page explicitly attributed to
Cloudflare). This is Cloudflare doing what it's designed to do against
automated traffic from datacenter IPs running headless browsers, and that
applies to any cloud host, not just GitHub's — a different VPS or CI
provider wouldn't reliably fix it, only delay hitting the same wall.

**This script does not implement or plan to implement anything to defeat
that check** — no stealth/fingerprint-spoofing, no proxy rotation, no
CAPTCHA-solving. A blocked run is treated as expected, acceptable behavior:

- `isBotChallengePage()` detects both forms Uber Eats uses (redirect to
  `def.uber.com`, and the same-origin Cloudflare "Just a moment..." page)
  and reports it plainly in the logs.
- `deals.md` gets a clearly-labeled **"This run was blocked by Uber
  Eats"** section instead of silently showing an empty deals table — so a
  blocked run is never confused with "checked and genuinely found nothing."

Practically: expect `deals.md` to sometimes say "blocked" instead of
showing deals. That's the honest result of running this from cloud
infrastructure, not a bug to chase.

## How it runs

- **Schedule**: `.github/workflows/scraper.yml` runs it automatically twice
  a day (`0 13,20 * * *` UTC).
- **Manual override**: the workflow also has a no-input `workflow_dispatch`
  trigger, so you can hit **Run workflow** in the Actions tab (including
  from the GitHub mobile app) any time without waiting for the schedule.
- **Output**: each run overwrites `deals.md` and, if it changed, the
  workflow commits and pushes it back to the repo using the built-in
  `GITHUB_TOKEN` (job has `permissions: contents: write` for this).
- **Debug snapshots**: every run also saves a screenshot + full HTML +
  URL/title of the page at four funnel points (landing page, after setting
  the address, after opening the Vegan category, plus failure snapshots).
  Uploaded as a workflow artifact named `debug-snapshots-<run number>`,
  downloadable from the run's page in the **Actions** tab (bottom of the
  page, under "Artifacts") — not committed to the repo, auto-deleted after
  14 days. Set `DEBUG_SNAPSHOTS=0` to turn this off.

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

## Another thing that isn't a selector bug

**Uber Eats' "Vegan" search doesn't filter — it just re-ranks.** Clicking
the Vegan category returns the same full local result set (verified
directly: same "311 results" count, grocery stores like Carrefour and
Costco still on top), with vegan-named places starting further down.
`collectRestaurantLinks()` in `scrape.js` compensates by filtering result
cards to ones whose own text mentions "vegan" before taking the top
`MAX_RESTAURANTS`; if none do, it logs a warning and falls back to the
unfiltered top N rather than silently returning nothing.

## If selectors genuinely need tuning

The selectors in `SELECTORS` and in `extractRawItems` /
`collectRestaurantLinks` were verified against the live site on 2026-07-19,
but Uber Eats' hashed, auto-generated class names can still drift over
time. If `deals.md` comes back empty (and doesn't say "blocked"):

1. Check the debug snapshot artifact from that run first — it's usually
   faster than reproducing locally.
2. If still unclear, run locally with `headless: false` temporarily in
   `scrape.js`'s `chromium.launch(...)` call to watch what happens.
3. Open `https://www.ubereats.com/es-en` in a normal browser and, at
   whichever step is failing, right-click → **Inspect** to find the
   current attribute or text pattern, then update `SELECTORS`.

The discount math (percent-off parsing, two-price parsing, the
`2-for-1 / 2 por 1 ⇒ 50%` approximation, the >10% filter, the vegan keyword
filter) is selector-independent and shouldn't need changes.

## Notes on scope

- Delivery fee is assumed €0 (Uber One) and isn't factored into the math.
- "Vegan" item match is keyword-based: item text or its section heading
  must contain "vegan"/"vegano"/"vegana" or "plant-based". Items without an
  explicit label won't be caught even if they happen to be vegan.
- Each run loads the results feed plus up to `MAX_RESTAURANTS` (12) menu
  pages, twice a day, unattended, indefinitely — a real, ongoing automated
  footprint against Uber Eats, part of which is now confirmed to get
  blocked outright by their Cloudflare protection. This is accepted as-is
  (see above) rather than worked around.
- Because the repo is public, `deals.md` — restaurant names, item names,
  and prices — is visible to anyone. Nothing sensitive is written, but
  worth knowing.
