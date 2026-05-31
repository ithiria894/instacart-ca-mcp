/**
 * Instacart.ca business logic — built on top of the CDP page-eval layer.
 *
 * Everything goes through the site's internal persisted-GraphQL API, executed
 * from inside the logged-in instacart.ca page so cookies are sent automatically.
 *
 * Persisted-query hashes change when Instacart deploys a new frontend bundle.
 * If a call starts returning errors, re-capture the hash from a live page
 * (Network tab → the SearchResultsPlacements request) and update HASHES below.
 */
import { evalInInstacartPage } from "./cdp.js";
// --- Captured constants (2026-05-30, instacart.ca) -------------------------
export const HASHES = {
    SearchResultsPlacements: "84255489b672b9f4b28ef070ea4ee50f4a363ab2dfe48b5715df94cb19566c65",
};
// shopId per retailer for Nicole's Vancouver zone (V6B6H4, zone 755), captured
// live 2026-05-31 from the zone's available retailers. These are zone-specific;
// a different delivery address may map to different ids. Duplicate branches of
// the same chain are de-duped to one representative shopId.
export const STORES = {
    // mainstream grocery + warehouse
    Walmart: "9057",
    Superstore: "3702",
    "Save-On-Foods": "25116",
    Costco: "5780",
    "Costco Business Centre": "4309",
    "Wholesale Club": "464303",
    "T&T": "42632",
    "Whole Foods": "119201",
    IGA: "267197",
    "Marketplace IGA": "312093",
    "Buy-Low Foods": "111933",
    "Choices Markets": "56647",
    "Pricesmart Foods": "17773",
    "Nesters Market": "204339",
    "Stong's Market": "401403",
    "Donald's Market": "412045",
    "Lous Market": "755358",
    // specialty / ethnic / natural
    "Persia Foods": "16705205",
    "Bosa Foods": "367149",
    "Famous Foods": "367110",
    Fruiticana: "530231",
    "Galloway's": "472015",
    Spud: "479467",
    "Pomme Natural Market": "481838",
    "Aurora Natural": "551777",
    "The Health Food": "499703",
    "Eternity Natural Market": "538330",
    "Bestie Natural Market": "767798",
    "Cobs Bread": "357534",
    // pharmacy
    "London Drugs": "24392",
    "Shoppers Drug Mart": "42116",
    Rexall: "16656370",
    // pet
    "Pet Food N More": "761252",
};
export const ZONE = {
    postalCode: process.env.INSTACART_POSTAL || "V6B6H4",
    zoneId: process.env.INSTACART_ZONE || "755",
};
/**
 * Search a single store. Runs SearchResultsPlacements in the page and extracts
 * (name, price) pairs from the JSON. Parsing is intentionally tolerant — the
 * response is huge (~450KB) and we only need name+price.
 */
export async function searchStore(shopId, query, first = 8) {
    const fnBody = `
    const hash = ${JSON.stringify(HASHES.SearchResultsPlacements)};
    const variables = {
      action: null, query: ${JSON.stringify(query)}, pageViewId: "mcp-"+${JSON.stringify(shopId)}+"-"+Date.now(),
      elevatedProductId: null, searchSource: "search", filters: [],
      disableReformulation: false, disableLlm: false, forceInspiration: false,
      orderBy: "bestMatch", clusterId: null, includeDebugInfo: false,
      clusteringStrategy: null, contentManagementSearchParams: { itemGridColumnCount: 1 },
      shopId: ${JSON.stringify(shopId)}, postalCode: ${JSON.stringify(ZONE.postalCode)},
      zoneId: ${JSON.stringify(ZONE.zoneId)}, first: ${Math.max(first * 3, 20)}
    };
    const ext = { persistedQuery: { version: 1, sha256Hash: hash } };
    const url = "/graphql?operationName=SearchResultsPlacements&variables=" +
      encodeURIComponent(JSON.stringify(variables)) +
      "&extensions=" + encodeURIComponent(JSON.stringify(ext));
    // The search endpoint enforces the x-client-identifier header (the
    // CurrentUserFields probe does not); without it search returns HTTP 401.
    const r = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-client-identifier": "web",
      },
    });
    if (r.status !== 200) return { ok: false, error: "HTTP " + r.status, products: [] };
    // Use raw text (not r.json()) — the response is ~400KB; we only need name+price.
    const s = await r.text();
    if (s.indexOf('"errors"') !== -1 && s.indexOf('"data"') === -1) {
      return { ok: false, error: s.slice(0, 200), products: [] };
    }
    // Each product card has shape (verified live 2026-05-31):
    //   "id":"items_<shop>-<pid>","itemLoadId":"<uuid>","name":"<PRODUCT>","size":...
    //   ... (~5-6KB later) ... "priceString":"$X"
    // Anchor on the item node (id+itemLoadId+name adjacency, which uniquely marks
    // a real product, not a UI token), then look forward up to 9KB for the first
    // priceString within that card.
    const out = []; const seen = new Set();
    const re = /"id":"items_[\\d-]+","itemLoadId":"[^"]*","name":"([^"]{3,120})"/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const name = m[1];
      const fwd = s.substring(m.index, m.index + 9000);
      const pm = fwd.match(/"priceString":"(\\$[\\d.]+)"/);
      if (!pm) continue;
      // Instacart tags each item with its real department (e.g. "Meat &
      // Seafood", "Pets", "Health & Body Care"). Capture it for category filtering.
      const dm = fwd.match(/"departmentName":"([^"]{1,40})"/);
      const department = dm ? dm[1] : null;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, price: pm[1], department });
      if (out.length >= 40) break;
    }
    return { ok: true, products: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    // Instacart pads results with "you might also like" recommendations from
    // other categories (dog food / makeup / jerky under "ground beef"). Use the
    // server's own product taxonomy to keep only the query's dominant category.
    const products = dominantCategoryFilter(res.value.products || [], query).slice(0, first);
    return { ok: true, products };
}
/**
 * Keep only products in the query's dominant Instacart category.
 *
 * Each product carries a productCategoryId (e.g. 727 = ground beef). Real
 * matches cluster in one category; the padded recommendations scatter across
 * others or have none. We find the most common category among keyword-relevant
 * products and keep items in that category (plus any keyword-relevant item that
 * has no category id, so we never over-filter when the taxonomy is sparse).
 *
 * Falls back to plain keyword relevance when there's no clear category signal.
 */
export function dominantCategoryFilter(products, query) {
    const relevant = products.filter((p) => isRelevant(query, p.name));
    // Vote for the dominant category among keyword-relevant products only — that
    // keeps a stray off-category item (jerky tagged "snacks") from winning.
    const votes = new Map();
    for (const p of relevant) {
        if (p.category)
            votes.set(p.category, (votes.get(p.category) || 0) + 1);
    }
    if (votes.size === 0)
        return relevant; // no taxonomy signal → keyword only
    let top = "";
    let topN = 0;
    for (const [cat, n] of votes) {
        if (n > topN) {
            top = cat;
            topN = n;
        }
    }
    // If the dominant category only has a single member and there are several
    // categories, the signal is too weak to trust — fall back to keyword.
    if (topN < 2 && votes.size > 1)
        return relevant;
    return relevant.filter((p) => p.category === top || !p.category);
}
const STOPWORDS = new Set([
    "the", "and", "with", "for", "pack", "value", "large", "small", "fresh",
    "organic", "boneless", "skinless", "each", "lean", "extra", "regular",
    "medium", "family", "premium", "natural", "free", "range", "grade",
]);
// Words that, when they appear as the ONLY query match, usually mean a wrong
// category snuck in (jerky/snack/treat under a fresh-meat query, etc.). If a
// product matches the query only via these, treat it as irrelevant.
const NEGATIVE_HINTS = {
    beef: ["jerky", "snack", "stuffed", "bone", "hoof", "ear", "treat", "soup", "noodle", "burger", "meatball", "wrap", "teriyaki"],
    chicken: ["jerky", "snack", "stuffed", "bone", "treat", "soup", "noodle", "broth", "stock"],
    pork: ["jerky", "snack", "rind", "treat", "soup"],
    fish: ["food", "oil", "sauce", "cracker", "snack"],
};
/**
 * A product is relevant if its name contains at least one meaningful query word
 * AND (when the query names a fresh-food category) isn't only matching via a
 * known wrong-category hint word. Words are lowercased, stopwords dropped, and a
 * trailing "s" stripped so "eggs" matches "egg".
 */
export function isRelevant(query, name) {
    const tokens = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
        .map((t) => t.replace(/s$/, ""));
    if (!tokens.length)
        return true;
    const lname = name.toLowerCase();
    const matched = tokens.filter((t) => lname.includes(t));
    if (!matched.length)
        return false;
    // If every matched token has negative hints and the name hits one, reject.
    const hits = matched.flatMap((t) => NEGATIVE_HINTS[t] || []);
    if (hits.length && hits.some((h) => lname.includes(h))) {
        // …unless the name ALSO contains a clean "<category>" word like "ground beef"
        // / "beef steak" that isn't itself a hint. Allow if a non-hint food word
        // sits right next to the category (heuristic: "ground" present).
        if (!/\bground\b|\bsteak\b|\bfillet\b|\bbreast\b|\bthigh\b|\bdrumstick\b/.test(lname)) {
            return false;
        }
    }
    return true;
}
/**
 * Synonym/translation expansion. instacart.ca is English, but its search is
 * fuzzy, so a few extra phrasings catch products a single term misses (e.g.
 * "minced beef" / "ground beef", or a store that lists fresh meat under a
 * different wording). Returned list is the original query first, then variants.
 */
const SYNONYMS = {
    "ground beef": ["minced beef", "lean ground beef", "beef mince"],
    "ground pork": ["minced pork", "pork mince"],
    "ground chicken": ["minced chicken", "chicken mince"],
    "chicken thigh": ["chicken thighs", "boneless chicken thigh"],
    "chicken breast": ["chicken breasts", "boneless chicken breast"],
    eggs: ["egg", "large eggs", "dozen eggs"],
    milk: ["2% milk", "whole milk", "homogenized milk"],
    tofu: ["firm tofu", "soft tofu", "bean curd"],
    "green onion": ["green onions", "scallion", "spring onion"],
    "bok choy": ["baby bok choy", "shanghai bok choy"],
    "soy sauce": ["light soy sauce", "soya sauce"],
    shrimp: ["prawns", "shrimps"],
    salmon: ["salmon fillet", "atlantic salmon"],
};
export function expandQuery(query) {
    const q = query.trim().toLowerCase();
    const variants = SYNONYMS[q] || [];
    // de-dupe, keep original first
    return [query, ...variants.filter((v) => v.toLowerCase() !== q)];
}
/**
 * Search a store, trying the query plus synonyms until enough relevant products
 * come back. Stops as soon as a variant yields results, so common items cost a
 * single request; only sparse/oddly-worded stores fall through to variants.
 */
export async function searchStoreSmart(shopId, query, first = 6) {
    let lastErr;
    const variants = expandQuery(query);
    for (const v of variants) {
        const r = await searchStore(shopId, v, first);
        if (!r.ok) {
            lastErr = r.error;
            continue;
        }
        if (r.products.length)
            return { ok: true, products: r.products, triedAll: false };
    }
    return { ok: true, products: [], triedAll: true, error: lastErr };
}
/** Run an async fn over items with a bounded concurrency limit, preserving order. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await fn(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
/**
 * Compare a query across stores. By default it hits every configured store; pass
 * a subset of store names to limit it. Stores are queried with bounded
 * concurrency (default 4) — sequential over ~30 stores would be too slow, and
 * unbounded parallelism risks tripping Instacart's rate limiter.
 */
export async function comparePrices(query, storeNames, concurrency = 4) {
    const entries = Object.entries(STORES).filter(([store]) => !storeNames || storeNames.includes(store));
    const results = await mapLimit(entries, concurrency, async ([store, shopId]) => {
        const r = await searchStoreSmart(shopId, query, 6);
        return {
            store,
            topMatch: r.products[0] || null,
            allMatches: r.products,
            error: r.error,
        };
    });
    // Stores that carry the item first, sorted by cheapest top match; empties last.
    const priceOf = (s) => (s ? parseFloat(s.replace(/[^\d.]/g, "")) : Infinity);
    results.sort((a, b) => {
        const av = a.allMatches.length ? priceOf(a.topMatch?.price) : Infinity;
        const bv = b.allMatches.length ? priceOf(b.topMatch?.price) : Infinity;
        return av - bv;
    });
    return { query, results };
}
