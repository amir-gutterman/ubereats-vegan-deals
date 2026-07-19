# Uber Eats vegan deal finder

Personal tool: given a public Uber Eats menu URL, sets the delivery address,
scans the menu for vegan/plant-based items, and prints a Markdown table of
items discounted more than 10%.

## Local setup

```
npm install
npx playwright install --with-deps chromium
UBER_EATS_URL="https://www.ubereats.com/..." npm run scrape
```

## GitHub Actions

Push this folder to a repo, then:

1. Go to the repo's **Actions** tab.
2. Select **Uber Eats Vegan Deal Finder** in the left sidebar.
3. Click **Run workflow**, paste the menu URL into `UBER_EATS_URL`, run it.
4. Open the run's logs to see the Markdown table.

No repository secrets are required — the address and menu page are both
public, unauthenticated browsing, so nothing sensitive needs to be stored.

## Important: the selectors will probably need tuning

Uber Eats renders its menu with hashed, auto-generated CSS class names that
change over time and aren't documented anywhere. I wrote `scrape.js` with
reasonable best-effort selectors (`data-testid` attributes where Uber Eats
has historically used them, with text/pattern-based fallbacks), but I have
no way to verify them against the live site from here — so **the first run
will likely need a fix-up pass**. If a run comes back with "No qualifying
deals found" but you know deals exist:

1. Run locally in headed mode to see what's happening:
   ```
   node -e "process.env.PWDEBUG='1'; require('./scrape.js')"
   ```
   or add `headless: false` temporarily in `scrape.js`'s `chromium.launch(...)` call.
2. Open the target menu URL in a normal browser, right-click a menu item →
   **Inspect**, and note:
   - What attribute or class wraps a single item card
   - Where the discount badge / strikethrough price lives
3. Update the `SELECTORS` object and the `extractRawItems` page-context
   function at the top of `scrape.js` to match.

The discount math itself (percent-off parsing, two-price parsing, the
`2-for-1 ⇒ 50%` approximation, the >10% filter, the vegan keyword filter) is
selector-independent and shouldn't need changes — only the DOM hooks that
find items/prices/headings will need adjusting to match Uber Eats' current
markup.

## Notes on scope

- Delivery fee is assumed €0 (Uber One) and isn't factored into the math.
- "Vegan" match is keyword-based: item text or its section heading must
  contain "vegan" or "plant-based". Items without an explicit label won't be
  caught even if they happen to be vegan.
- This automates a normal, logged-out browser session — no anti-bot evasion
  is implemented. If Uber Eats blocks or challenges the automated browser,
  that's a signal from their side, not something this script tries to work
  around.
