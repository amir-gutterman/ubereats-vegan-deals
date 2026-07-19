'use strict';

/**
 * Personal Uber Eats vegan-discount finder.
 *
 * Uber Eats' DOM uses hashed/obfuscated CSS class names that change without
 * notice, so the selectors below are best-effort starting points, not
 * verified-stable hooks. If a run comes back empty, open the target menu in
 * a normal browser, use devtools to find the current attributes/text
 * patterns, and update SELECTORS below. See README.md for a walkthrough.
 */

const { chromium } = require('playwright');

const TARGET_URL = process.env.UBER_EATS_URL;
const DELIVERY_ADDRESS = 'Calle del Molino de Viento 18, Madrid';
const MIN_DISCOUNT_PERCENT = 10; // strictly greater than this survives the filter
const VEGAN_KEYWORDS = ['vegan', 'plant-based', 'plant based'];

const SELECTORS = {
  // Homepage address entry point. Try a few common patterns; first match wins.
  addressInputCandidates: [
    'input[aria-label*="delivery address" i]',
    'input[placeholder*="delivery address" i]',
    'input[aria-label*="address" i]',
  ],
  addressSuggestionCandidates: [
    '[role="listbox"] [role="option"]',
    'li[role="option"]',
    'ul li button',
  ],
  addressConfirmButtonCandidates: [
    'button:has-text("Done")',
    'button:has-text("Confirm")',
    'button:has-text("Continue")',
  ],
  // A heading we can wait on to know the store page has hydrated.
  storeHeaderCandidates: [
    'h1',
  ],
};

function log(...args) {
  console.error('[scrape]', ...args);
}

async function setDeliveryAddress(page) {
  await page.goto('https://www.ubereats.com/', { waitUntil: 'domcontentloaded' });

  let addressInput = null;
  for (const selector of SELECTORS.addressInputCandidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      addressInput = locator;
      break;
    }
  }

  if (!addressInput) {
    log('WARNING: could not find an address input on the homepage. ' +
      'Skipping address step — if the session already has a saved address this may be fine, ' +
      'otherwise inspect the page and update SELECTORS.addressInputCandidates.');
    return;
  }

  await addressInput.click();
  await addressInput.fill(DELIVERY_ADDRESS);
  await page.waitForTimeout(1500); // let the autocomplete suggestions load

  let suggestion = null;
  for (const selector of SELECTORS.addressSuggestionCandidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      suggestion = locator;
      break;
    }
  }

  if (!suggestion) {
    log('WARNING: no address suggestion dropdown found. Pressing Enter as a fallback.');
    await addressInput.press('Enter');
  } else {
    await suggestion.click();
  }

  for (const selector of SELECTORS.addressConfirmButtonCandidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click().catch(() => {});
      break;
    }
  }

  await page.waitForTimeout(1000);
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
    const twoForOneRegex = /\b2\s*[-x]?\s*for\s*1\b|buy\s*1\s*get\s*1/i;

    // Candidate item containers: prefer explicit test hooks, fall back to
    // any element whose own text (not descendants') looks like a price and
    // whose ancestor block also contains a name-like text node.
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
      // Fallback heuristic: any element whose text matches a price pattern,
      // deduplicated to the smallest common ancestor "card".
      const all = Array.from(document.querySelectorAll('body *'));
      nodes = all.filter((el) => {
        if (el.children.length > 6) return false; // skip big containers
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
    // Flagged explicitly since it's an assumption, not a parsed number.
    return { discountPercent: 50, originalPrice: null, salePrice: null, note: 'assumed from "2-for-1" wording' };
  }

  return null;
}

function itemName(item) {
  // Best-effort: strip price substrings and known badge phrases out of the
  // raw text to leave something name-like. Not exact — verify against
  // console.error debug output if names look wrong.
  let name = item.rawText;
  for (const p of item.prices) name = name.replace(p, '');
  name = name.replace(/(\d{1,3})\s?%\s*off/i, '');
  return name.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function toMarkdownTable(deals) {
  const header = '| Restaurant | Item | Original Price | Sale Price | Discount |\n' +
    '|---|---|---|---|---|';
  const rows = deals.map((d) => {
    const orig = d.discount.originalPrice !== null ? `€${d.discount.originalPrice.toFixed(2)}` : 'n/a';
    const sale = d.discount.salePrice !== null ? `€${d.discount.salePrice.toFixed(2)}` : 'n/a';
    return `| ${d.item.restaurantName} | ${itemName(d.item)} | ${orig} | ${sale} | ${d.discount.discountPercent.toFixed(0)}% (${d.discount.note}) |`;
  });
  return [header, ...rows].join('\n');
}

async function main() {
  if (!TARGET_URL) {
    console.error('ERROR: set UBER_EATS_URL to the menu page you want to scan.');
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await setDeliveryAddress(page);

    log(`Navigating to target menu: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await waitForMenuHydration(page);
    // Menus are client-rendered after the header appears; give it a beat.
    await page.waitForTimeout(2000);

    const rawItems = await extractRawItems(page);
    log(`Extracted ${rawItems.length} candidate item nodes.`);

    const veganItems = rawItems.filter(isVegan);
    log(`${veganItems.length} of those matched vegan/plant-based signals.`);

    const deals = [];
    for (const item of veganItems) {
      const discount = computeDiscount(item);
      if (discount && discount.discountPercent > MIN_DISCOUNT_PERCENT) {
        deals.push({ item, discount });
      }
    }

    deals.sort((a, b) => b.discount.discountPercent - a.discount.discountPercent);

    console.log(`\n# Vegan deals > ${MIN_DISCOUNT_PERCENT}% off`);
    console.log(`Delivery address: ${DELIVERY_ADDRESS} (delivery fee assumed €0 — Uber One)\n`);

    if (!deals.length) {
      console.log('No qualifying deals found. If this looks wrong, the DOM selectors likely ' +
        'need adjusting — see README.md for how to inspect and update them.');
    } else {
      console.log(toMarkdownTable(deals));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
