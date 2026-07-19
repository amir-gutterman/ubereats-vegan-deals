'use strict';

/**
 * Fully autonomous Uber Eats vegan-discount finder.
 *
 * No inputs at runtime: sets a fixed delivery address, opens the "Vegan"
 * category, scans the top N restaurant results, and writes the results to
 * OUTPUT_FILE (deals.md). Intended to run unattended on a schedule (see
 * .github/workflows/scraper.yml).
 *
 * Two things worth knowing before treating an empty run as a selector bug:
 *
 * 1. Uber Eats' "Vegan" search/category link does not actually filter to
 *    vegan restaurants — it re-ranks the full local result set, so
 *    collectRestaurantLinks() filters candidates by whether "vegan" appears
 *    in the result card's own text before taking the top MAX_RESTAURANTS.
 * 2. Uber Eats runs its own bot/fraud challenge (redirects to
 *    def.uber.com/en/challenge) and it can trigger on direct, automated
 *    navigation to a page. This script detects that redirect and reports it
 *    plainly (see isBotChallengePage) rather than treating it as "0 items
 *    found." No attempt is made to solve or route around that challenge —
 *    if it's showing up often, that's Uber Eats blocking this automation,
 *    which is a stop sign, not a bug to fix.
 *
 * Beyond that, Uber Eats' DOM uses hashed/obfuscated CSS class names that
 * change without notice, so selectors can still drift over time even though
 * they were verified against the live site as of 2026-07-19. See README.md
 * for how to re-verify and update them.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.ubereats.com/es-en';
const DELIVERY_ADDRESS = 'Calle del Molino de Viento 18, Madrid';
const MAX_RESTAURANTS = 12;
const MIN_DISCOUNT_PERCENT = 10; // strictly greater than this survives the filter
const VEGAN_KEYWORDS = ['vegan', 'vegano', 'vegana', 'plant-based', 'plant based'];
const OUTPUT_FILE = path.join(__dirname, 'deals.md');
const PER_RESTAURANT_DELAY_MS = 1500; // be gentle — this loops over multiple pages per run

// Verified 2026-07-19 by manually inspecting the live site. Still not
// stable long-term — Uber Eats' markup changes without notice — but these
// reflect what's actually there today, not guesses.
const SELECTORS = {
  addressInputCandidates: [
    'input[aria-label*="delivery address" i]',
    'input[placeholder*="delivery address" i]',
  ],
  addressSuggestionCandidates: [
    '[role="listbox"] [role="option"]',
  ],
  // There's no separate "confirm" step: clicking a suggestion navigates
  // straight to the results feed.
  restaurantLinkSelector: 'a[href*="/store/"]',
  // A heading we can wait on to know a store page has hydrated.
  storeHeaderCandidates: [
    'h1',
  ],
};

function log(...args) {
  console.error('[scrape]', ...args);
}

/**
 * Uber Eats redirects to its own bot/fraud challenge page (def.uber.com)
 * when it decides a session looks automated. Detecting this explicitly lets
 * the rest of the script report "we got blocked" instead of misreporting it
 * as "the selectors found nothing."
 */
function isBotChallengePage(page) {
  try {
    const host = new URL(page.url()).hostname;
    return host !== 'www.ubereats.com' && host !== 'ubereats.com';
  } catch {
    return false;
  }
}

async function waitForFirstVisible(page, selectors, timeout) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function setDeliveryAddress(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  if (isBotChallengePage(page)) {
    throw new Error(`Uber Eats served a bot-check page instead of the landing page (redirected to ${page.url()}).`);
  }

  const addressInput = await waitForFirstVisible(page, SELECTORS.addressInputCandidates, 15000);
  if (!addressInput) {
    log('WARNING: could not find an address input after waiting 15s. ' +
      'Skipping address step — if the session already has a saved address this may be fine, ' +
      'otherwise inspect the page and update SELECTORS.addressInputCandidates.');
    return;
  }

  await addressInput.click();
  await addressInput.fill(DELIVERY_ADDRESS);

  const suggestion = await waitForFirstVisible(page, SELECTORS.addressSuggestionCandidates, 8000);
  if (!suggestion) {
    log('WARNING: no address suggestion dropdown appeared within 8s. Pressing Enter as a fallback.');
    await addressInput.press('Enter');
  } else {
    await suggestion.click();
  }

  // Selecting a suggestion navigates straight to the results feed — there's
  // no separate confirm step to click.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
}

/**
 * Uber Eats' "Vegan" category link does not filter results — it re-ranks
 * the same full local result set, with an unrelated mix (grocery stores
 * etc.) still at the top. This clicks it anyway (it's still the closest
 * thing to a discovery entry point) and lets collectRestaurantLinks() do
 * the actual vegan filtering by result-card text.
 */
async function openVeganCategory(page) {
  const veganLink = page.locator('a', { hasText: /^Vegan$/ }).first();
  try {
    await veganLink.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    log('WARNING: could not find a "Vegan" category link on the feed page within 10s. ' +
      'Continuing with whatever is on the current page.');
    return;
  }
  await veganLink.click();
  await page.waitForTimeout(2500); // let the results page hydrate
}

async function collectRestaurantLinks(page, max) {
  if (isBotChallengePage(page)) {
    throw new Error(`Uber Eats served a bot-check page instead of results (redirected to ${page.url()}).`);
  }

  const candidates = await page.evaluate((sel) => {
    const seen = new Set();
    const out = [];
    for (const a of Array.from(document.querySelectorAll(sel))) {
      if (!a.href || seen.has(a.href)) continue;
      seen.add(a.href);
      let card = a;
      for (let i = 0; i < 3 && card.parentElement; i++) card = card.parentElement;
      out.push({ href: a.href, cardText: card.textContent.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }, SELECTORS.restaurantLinkSelector);

  if (!candidates.length) {
    log('WARNING: found no restaurant links on the results page. ' +
      'Update SELECTORS.restaurantLinkSelector.');
    return [];
  }

  const veganNamed = candidates.filter((c) =>
    VEGAN_KEYWORDS.some((kw) => c.cardText.toLowerCase().includes(kw)));

  if (!veganNamed.length) {
    log(`WARNING: none of the ${candidates.length} result cards mention "vegan" by name. ` +
      `Falling back to the first ${max} results as-is (the per-item vegan filter later still applies, ` +
      'but most of these pages will likely yield zero vegan items).');
    return candidates.slice(0, max).map((c) => c.href);
  }

  return veganNamed.slice(0, max).map((c) => c.href);
}

async function waitForMenuHydration(page) {
  for (const selector of SELECTORS.storeHeaderCandidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 15000 });
      return;
    } catch {
      // try next candidate
    }
  }
  log('WARNING: never saw a store header render. Continuing anyway; extraction may return nothing.');
}

/**
 * Runs inside the page context. Heuristically pairs each menu item with the
 * nearest preceding heading (its category/section title) and pulls out any
 * price-like or discount-badge text it can find nearby.
 */
async function extractRawItems(page) {
  return page.evaluate(() => {
    function nearestHeadingText(node) {
      let el = node;
      while (el) {
        let sib = el.previousElementSibling;
        while (sib) {
          if (/^H[1-4]$/.test(sib.tagName)) return sib.textContent.trim();
          const heading = sib.querySelector && sib.querySelector('h1,h2,h3,h4');
          if (heading) return heading.textContent.trim();
          sib = sib.previousElementSibling;
        }
        el = el.parentElement;
      }
      return null;
    }

    const priceRegex = /€\s?\d+[.,]\d{2}|\d+[.,]\d{2}\s?€/g;
    const percentOffRegex = /(\d{1,3})\s?%\s*off/i;
    const twoForOneRegex = /\b2\s*[-x]?\s*for\s*1\b|buy\s*1\s*get\s*1|2\s*por\s*1/i;

    const candidateSelectors = [
      '[data-testid="store-item"]',
      '[data-testid*="menu-item" i]',
      'li[data-test*="item" i]',
    ];

    let nodes = [];
    for (const sel of candidateSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length) {
        nodes = found;
        break;
      }
    }

    if (!nodes.length) {
      const all = Array.from(document.querySelectorAll('body *'));
      nodes = all.filter((el) => {
        if (el.children.length > 6) return false;
        const text = el.textContent || '';
        return priceRegex.test(text) && text.length < 400;
      });
    }

    const restaurantNameEl = document.querySelector('h1');
    const restaurantName = restaurantNameEl ? restaurantNameEl.textContent.trim() : 'Unknown restaurant';

    return nodes.map((node) => {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      const prices = text.match(priceRegex) || [];
      const percentMatch = text.match(percentOffRegex);
      const twoForOneMatch = twoForOneRegex.test(text);
      return {
        restaurantName,
        sectionTitle: nearestHeadingText(node) || 'Unknown section',
        rawText: text,
        prices,
        explicitPercentOff: percentMatch ? Number(percentMatch[1]) : null,
        twoForOne: twoForOneMatch,
      };
    });
  });
}

function parsePrice(str) {
  const cleaned = str.replace(/[€\s]/g, '').replace(',', '.');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function isVegan(item) {
  const haystack = `${item.sectionTitle} ${item.rawText}`.toLowerCase();
  return VEGAN_KEYWORDS.some((kw) => haystack.includes(kw));
}

/**
 * Returns { discountPercent, originalPrice, salePrice, note } or null if no
 * usable discount signal was found.
 */
function computeDiscount(item) {
  if (item.explicitPercentOff !== null) {
    return {
      discountPercent: item.explicitPercentOff,
      originalPrice: null,
      salePrice: null,
      note: 'from "% off" badge',
    };
  }

  if (item.prices.length >= 2) {
    const values = item.prices.map(parsePrice).filter((v) => v !== null);
    if (values.length >= 2) {
      const originalPrice = Math.max(...values);
      const salePrice = Math.min(...values);
      if (originalPrice > 0 && salePrice < originalPrice) {
        const discountPercent = ((originalPrice - salePrice) / originalPrice) * 100;
        return { discountPercent, originalPrice, salePrice, note: 'from two price tags' };
      }
    }
  }

  if (item.twoForOne) {
    // Approximation: buying 2 and paying for 1 is a 50% discount on the pair.
    return { discountPercent: 50, originalPrice: null, salePrice: null, note: 'assumed from "2-for-1 / 2 por 1" wording' };
  }

  return null;
}

function itemName(item) {
  let name = item.rawText;
  for (const p of item.prices) name = name.replace(p, '');
  name = name.replace(/(\d{1,3})\s?%\s*off/i, '');
  return name.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function scanRestaurant(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  if (isBotChallengePage(page)) {
    throw new Error(`Uber Eats served a bot-check page instead of the menu (redirected to ${page.url()}).`);
  }

  await waitForMenuHydration(page);
  await page.waitForTimeout(2000); // menu items hydrate after the header

  const rawItems = await extractRawItems(page);
  const veganItems = rawItems.filter(isVegan);

  const deals = [];
  for (const item of veganItems) {
    const discount = computeDiscount(item);
    if (discount && discount.discountPercent > MIN_DISCOUNT_PERCENT) {
      deals.push({ item, discount, sourceUrl: url });
    }
  }
  return { candidateCount: rawItems.length, veganCount: veganItems.length, deals };
}

function buildMarkdown(allDeals, meta) {
  const lines = [];
  lines.push('# Vegan Uber Eats deals');
  lines.push('');
  lines.push(`Last updated: ${meta.timestamp}`);
  lines.push('');
  lines.push(`Delivery address: ${DELIVERY_ADDRESS} (delivery fee assumed €0 — Uber One)`);
  lines.push(`Restaurants scanned: ${meta.restaurantsScanned} · Threshold: > ${MIN_DISCOUNT_PERCENT}% off`);
  lines.push('');

  if (!allDeals.length) {
    lines.push('No qualifying deals found this run. If this looks wrong, the DOM selectors ' +
      'likely need adjusting — see README.md for how to inspect and update them.');
    return lines.join('\n') + '\n';
  }

  lines.push('| Restaurant | Vegan Item | Original Price | Sale Price | Discount |');
  lines.push('|---|---|---|---|---|');
  for (const d of allDeals) {
    const orig = d.discount.originalPrice !== null ? `€${d.discount.originalPrice.toFixed(2)}` : 'n/a';
    const sale = d.discount.salePrice !== null ? `€${d.discount.salePrice.toFixed(2)}` : 'n/a';
    lines.push(`| ${d.item.restaurantName} | ${itemName(d.item)} | ${orig} | ${sale} | ${d.discount.discountPercent.toFixed(0)}% (${d.discount.note}) |`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const allDeals = [];
  let restaurantsScanned = 0;

  try {
    log('Setting delivery address...');
    await setDeliveryAddress(page);

    log('Opening the Vegan category...');
    await openVeganCategory(page);

    const restaurantUrls = await collectRestaurantLinks(page, MAX_RESTAURANTS);
    log(`Found ${restaurantUrls.length} restaurant(s) to scan.`);

    for (const url of restaurantUrls) {
      log(`Scanning: ${url}`);
      try {
        const result = await scanRestaurant(page, url);
        restaurantsScanned += 1;
        log(`  ${result.candidateCount} candidate items, ${result.veganCount} vegan-tagged, ${result.deals.length} deal(s) > ${MIN_DISCOUNT_PERCENT}%.`);
        allDeals.push(...result.deals);
      } catch (err) {
        log(`  WARNING: failed to scan ${url}: ${err.message}`);
      }
      await page.waitForTimeout(PER_RESTAURANT_DELAY_MS);
    }

    allDeals.sort((a, b) => b.discount.discountPercent - a.discount.discountPercent);

    const markdown = buildMarkdown(allDeals, {
      timestamp: new Date().toISOString(),
      restaurantsScanned,
    });

    fs.writeFileSync(OUTPUT_FILE, markdown, 'utf8');
    log(`Wrote ${allDeals.length} deal(s) to ${OUTPUT_FILE}.`);
    console.log(markdown);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
