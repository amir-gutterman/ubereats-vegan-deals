# Uber Eats vegan deal finder

Fully autonomous personal tool. No inputs at runtime: it sets a fixed
delivery address, opens Uber Eats' "Vegan" category, scans up to 12
restaurant results, and writes any vegan item discounted more than 10% to
[`deals.md`](deals.md) in this repo — a dashboard you can check anytime.

## Runs on a self-hosted runner (your PC), not GitHub's cloud

GitHub's shared cloud runners got served Uber Eats' Cloudflare bot-check
("Performing security verification... Cloudflare") on every single run
tried from there — confirmed directly via debug snapshot, not a guess.
Cloudflare does this to automated traffic from datacenter IPs running
headless browsers; that applies to any cloud host, not just GitHub's, so
switching CI providers wouldn't have fixed it.

Since there was no always-on secondary device available, this now runs as
a **self-hosted GitHub Actions runner installed as a Windows service on
your own PC** (`runs-on: [self-hosted, Windows, X64]` in
`.github/workflows/scraper.yml`). Traffic originates from your normal
residential IP with no other change to the automation itself — still no
stealth/fingerprint-spoofing/proxy-rotation/CAPTCHA-solving, that standing
decision hasn't changed. This should see the Cloudflare check far less
often, but the detection and honest-labeling described below stay in place
as a safety net regardless, since it can still happen.

**What this means practically:**
- Your PC needs to be on and connected to the internet for a scheduled or
  manually-triggered run to actually execute. The runner service starts
  automatically on boot, so you don't need to log in or open anything —
  just have the machine powered on.
- If the PC is off when the twice-daily schedule fires, that run just sits
  queued on GitHub's side until the runner comes back online, rather than
  failing outright.
- The runner service is visible in Windows Services as
  `actions.runner.amir-gutterman-ubereats-vegan-deals.amir-pc`, and in the
  repo's **Settings → Actions → Runners** on GitHub.
- Because this is a public repo, the self-hosted runner only executes code
  from triggers you control (`schedule`, `workflow_dispatch`) — there's no
  `pull_request` trigger, which is the usual risk with public-repo
  self-hosted runners. Worth keeping in mind before adding one.

**Bot-check detection, unchanged:**
- `isBotChallengePage()` detects both forms Uber Eats uses (redirect to
  `def.uber.com`, and the same-origin Cloudflare "Just a moment..." page)
  and reports it plainly in the logs.
- `deals.md` gets a clearly-labeled **"This run was blocked by Uber
  Eats"** section instead of silently showing an empty deals table — so a
  blocked run is never confused with "checked and genuinely found nothing."

## How it runs

- **Schedule**: `.github/workflows/scraper.yml` runs it automatically twice
  a day (`0 13,20 * * *` UTC), on the self-hosted runner.
- **Manual override**: the workflow also has a no-input `workflow_dispatch`
  trigger, so you can hit **Run workflow** in the Actions tab (including
  from the GitHub mobile app) any time without waiting for the schedule —
  it'll queue and run as soon as the runner picks it up.
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
npx playwright install chromium
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
