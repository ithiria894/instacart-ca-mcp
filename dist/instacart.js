/**
 * Instacart.ca business logic — built on top of the CDP page-eval layer.
 *
 * Everything goes through the site's internal persisted-GraphQL API, executed
 * from inside the logged-in instacart.ca page so cookies are sent automatically.
 * See API.md for the full reverse-engineered operation reference.
 *
 * Persisted-query hashes change when Instacart deploys a new frontend bundle.
 * If a call starts returning PersistedQueryNotSupported, re-capture the hash
 * from a live page (Network tab) and update HASHES below.
 */
import { evalInInstacartPage, collectionSlugsForPath } from "./cdp.js";
// --- Captured persisted-query hashes (instacart.ca, 2026-05-31) ------------
export const HASHES = {
    SearchResultsPlacements: "84255489b672b9f4b28ef070ea4ee50f4a363ab2dfe48b5715df94cb19566c65",
    CollectionProductsWithFeaturedProducts: "f3193dacfeec83828016dc1b3c8af8e61c4470d3f466da2d5797b3f2c530369c",
    ShopCollectionUnscoped: "e4274fe3bbcb2464e3bca7be8368fdb702ca6b13b76d0042647d7470f44a8be7",
    FlyerTopSavingsMasonryItems: "119c16c75110c139d0d4704b93dcfd2f20686d216dfad02d499447fd6b6ba26e",
    FlyerPersonalizedItems: "f9348eadd66417e60350e840fb464bca6b110997123c767a0e76b2883757293e",
};
// Representative shopId per retailer for the Vancouver zone (V6B6H4, zone 755),
// captured 2026-05-31. Zone-specific. This is a convenient hand-picked subset;
// listStores() fetches the full live list (54 retailers) dynamically.
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
// Retailer slug per STORES name (for storefront/collection URLs). Kept explicit
// because a chain can have several shopIds but one storefront slug, and the
// shopId→slug reverse lookup via the live list can pick the wrong branch.
export const STORE_SLUGS = {
    Walmart: "walmart-canada",
    Superstore: "real-canadian-superstore",
    "Save-On-Foods": "save-on-foods",
    Costco: "costco-canada",
    "Costco Business Centre": "costco-business-centre",
    "Wholesale Club": "real-canadian-wholesale-club",
    "T&T": "t-t",
    "Whole Foods": "whole-foods-ca",
    IGA: "georgia-main-iga",
    "Buy-Low Foods": "buy-low-foods",
    "Choices Markets": "choices-market",
    "Pricesmart Foods": "pricesmart-foods",
    "Nesters Market": "nesters",
    "Stong's Market": "stongs-market-canada",
    "London Drugs": "london-drugs",
    "Shoppers Drug Mart": "shoppers-drug-mart",
    Rexall: "rexall",
};
export const ZONE = {
    postalCode: process.env.INSTACART_POSTAL || "V6B6H4",
    zoneId: process.env.INSTACART_ZONE || "755",
};
// --- shared JS, injected into the page --------------------------------------
/**
 * JS source (run inside the page) that parses Instacart's item nodes out of a
 * raw GraphQL response string `s` into `out`. Shared by search / collection /
 * flyer since they all return the same item shape:
 *   "id":"items_<shop>-<pid>","itemLoadId":"<uuid>","name":"<NAME>" … "priceString":"$X"
 * priceString sits ~5–6 KB after the name, so we scan a 9 KB window. `LIMIT` is
 * substituted by the caller.
 */
function itemParserJs(limit) {
    return `
    const out = []; const seen = new Set();
    const re = /"id":"items_[\\d-]+","itemLoadId":"[^"]*","name":"([^"]{3,120})"/g;
    let __m;
    while ((__m = re.exec(s)) !== null) {
      const name = __m[1];
      const fwd = s.substring(__m.index, __m.index + 9000);
      const pm = fwd.match(/"priceString":"(\\$[\\d.]+)"/);
      if (!pm) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const prod = { name, price: pm[1] };
      const fpm = fwd.match(/"fullPriceString":"(\\$[\\d.]+)"/);
      if (fpm && fpm[1] && fpm[1] !== pm[1]) prod.fullPrice = fpm[1];
      out.push(prod);
      if (out.length >= ${limit}) break;
    }
  `;
}
/** Build a page fetch to a persisted-query op and return its raw text status. */
function gqlFetchJs(opName, hash, variablesExpr) {
    return `
    const ext = { persistedQuery: { version: 1, sha256Hash: ${JSON.stringify(hash)} } };
    const url = "/graphql?operationName=${opName}&variables=" +
      encodeURIComponent(JSON.stringify(${variablesExpr})) +
      "&extensions=" + encodeURIComponent(JSON.stringify(ext));
    const r = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json", "x-client-identifier": "web" },
    });
    const status = r.status;
    const s = await r.text();
  `;
}
// --- 1. Search (fuzzy) ------------------------------------------------------
/**
 * Search a single store via SearchResultsPlacements. Fuzzy — results may include
 * off-category recommendations, which isRelevant() then filters by keyword.
 */
export async function searchStore(shopId, query, first = 8) {
    const variablesExpr = `{
    action: null, query: ${JSON.stringify(query)}, pageViewId: "mcp-"+${JSON.stringify(shopId)}+"-"+Date.now(),
    elevatedProductId: null, searchSource: "search", filters: [],
    disableReformulation: false, disableLlm: false, forceInspiration: false,
    orderBy: "bestMatch", clusterId: null, includeDebugInfo: false,
    clusteringStrategy: null, contentManagementSearchParams: { itemGridColumnCount: 1 },
    shopId: ${JSON.stringify(shopId)}, postalCode: ${JSON.stringify(ZONE.postalCode)},
    zoneId: ${JSON.stringify(ZONE.zoneId)}, first: ${Math.max(first * 3, 20)}
  }`;
    const fnBody = `
    ${gqlFetchJs("SearchResultsPlacements", HASHES.SearchResultsPlacements, variablesExpr)}
    if (status !== 200) return { ok: false, error: "HTTP " + status, products: [] };
    if (s.indexOf('"errors"') !== -1 && s.indexOf('"data"') === -1) return { ok: false, error: s.slice(0, 200), products: [] };
    ${itemParserJs(40)}
    return { ok: true, products: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    if (!res.value.ok)
        return res.value;
    const products = (res.value.products || [])
        .filter((p) => isRelevant(query, p.name))
        .slice(0, first);
    return { ok: true, products };
}
// --- 2. Collections (clean category browse) ---------------------------------
/**
 * Browse a category collection at a store — CLEAN results (Instacart's own
 * taxonomy, no cross-category noise). `slug` is that store's collection slug
 * (e.g. "meat-and-seafood", "produce"); discover via getCategories().
 */
export async function browseCollection(shopId, slug, first = 20) {
    const variablesExpr = `{
    shopId: ${JSON.stringify(shopId)}, slug: ${JSON.stringify(slug)}, filters: [],
    pageViewId: "mcp-"+${JSON.stringify(shopId)}+"-"+Date.now(),
    itemsDisplayType: "collections_all_items_grid", first: ${Math.max(first, 20)},
    pageSource: "collections", postalCode: ${JSON.stringify(ZONE.postalCode)},
    zoneId: ${JSON.stringify(ZONE.zoneId)}
  }`;
    const fnBody = `
    ${gqlFetchJs("CollectionProductsWithFeaturedProducts", HASHES.CollectionProductsWithFeaturedProducts, variablesExpr)}
    if (status !== 200) return { ok: false, error: "HTTP " + status, products: [] };
    if (s.indexOf('"errors"') !== -1 && s.indexOf('"data"') === -1) return { ok: false, error: s.slice(0, 200), products: [] };
    ${itemParserJs(first)}
    return { ok: true, products: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    return res.value;
}
/**
 * Discover a store's category slugs by reading its storefront. Slugs differ per
 * store (Walmart uses "dairy"/"baked-goods", not "dairy-eggs"/"bread-bakery").
 * Cached per retailerSlug for the process lifetime.
 */
const categoryCache = new Map();
export async function getCategories(retailerSlug) {
    const cached = categoryCache.get(retailerSlug);
    if (cached)
        return cached;
    // The storefront is a SPA — a raw fetch has no collection links, so navigate
    // the page and read the rendered DOM.
    const slugs = await collectionSlugsForPath(`/store/${retailerSlug}/storefront`);
    categoryCache.set(retailerSlug, slugs);
    return slugs;
}
// --- 3. Store directory (full live list) ------------------------------------
let storesCache = null;
/** Fetch every retailer available in the zone via ShopCollectionUnscoped. */
export async function listStores() {
    if (storesCache)
        return storesCache;
    const variablesExpr = `{
    postalCode: ${JSON.stringify(ZONE.postalCode)},
    coordinates: { latitude: 49.2840545, longitude: -123.113445 },
    addressId: "19137103560427752"
  }`;
    const fnBody = `
    ${gqlFetchJs("ShopCollectionUnscoped", HASHES.ShopCollectionUnscoped, variablesExpr)}
    if (status !== 200) return { ok: false, error: "HTTP " + status, stores: [] };
    const out = []; const seen = {};
    const re = /"id":"(\\d+)","retailer":\\{"id":"\\d+"/g;
    let __m;
    while ((__m = re.exec(s)) !== null) {
      const shopId = __m[1];
      if (seen[shopId]) continue;
      const win = s.substring(__m.index, __m.index + 700);
      const slug = (win.match(/"slug":"([^"]+)"/) || [])[1];
      const name = (win.match(/"name":"([^"]+)"/) || [])[1];
      const type = (win.match(/"retailerType":"([^"]+)"/) || [])[1];
      if (slug && name) { seen[shopId] = 1; out.push({ shopId, slug, name, retailerType: type || null }); }
    }
    return { ok: true, stores: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok || !res.value?.ok)
        return [];
    // Decode & etc. that survived in raw-text parsing (e.g. "T&T").
    const stores = (res.value.stores || []).map((st) => ({
        ...st,
        name: decodeUnicode(st.name),
    }));
    storesCache = stores;
    return stores;
}
function decodeUnicode(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
/** Look up a store's retailerSlug from its shopId via the live list. */
export async function slugForShopId(shopId) {
    const stores = await listStores();
    return stores.find((s) => s.shopId === shopId)?.slug || null;
}
/** Authoritative shopId for a retailer slug, from the live zone list. */
export async function shopIdForSlug(slug) {
    const stores = await listStores();
    return stores.find((s) => s.slug === slug)?.shopId || null;
}
/**
 * Resolve a STORES name to its { slug, shopId }, preferring the live list (so
 * shopIds stay correct as zones change) and falling back to the curated maps.
 */
export async function resolveStore(name) {
    const slug = STORE_SLUGS[name] || null;
    let shopId = null;
    if (slug)
        shopId = await shopIdForSlug(slug);
    if (!shopId)
        shopId = STORES[name] || null;
    return { slug, shopId };
}
// --- 4. Flyer / deals -------------------------------------------------------
/** On-sale / top-savings items for a store (flyer). */
export async function getDeals(shopId, first = 20) {
    const variablesExpr = `{ shopId: ${JSON.stringify(shopId)}, source: "flyers_destination" }`;
    const fnBody = `
    ${gqlFetchJs("FlyerTopSavingsMasonryItems", HASHES.FlyerTopSavingsMasonryItems, variablesExpr)}
    if (status !== 200) return { ok: false, error: "HTTP " + status, products: [] };
    ${itemParserJs(first)}
    return { ok: true, products: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    return res.value;
}
// --- relevance + synonyms ---------------------------------------------------
const STOPWORDS = new Set([
    "the", "and", "with", "for", "pack", "value", "large", "small", "fresh",
    "organic", "boneless", "skinless", "each", "lean", "extra", "regular",
    "medium", "family", "premium", "natural", "free", "range", "grade",
]);
const NEGATIVE_HINTS = {
    beef: ["jerky", "snack", "stuffed", "bone", "hoof", "ear", "treat", "soup", "noodle", "burger", "meatball", "wrap", "teriyaki"],
    chicken: ["jerky", "snack", "stuffed", "bone", "treat", "soup", "noodle", "broth", "stock"],
    pork: ["jerky", "snack", "rind", "treat", "soup"],
    fish: ["food", "oil", "sauce", "cracker", "snack"],
};
/**
 * A product is relevant if its name contains at least one meaningful query word
 * and isn't only matching via a known wrong-category hint word (jerky/treat/…).
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
    const hits = matched.flatMap((t) => NEGATIVE_HINTS[t] || []);
    if (hits.length && hits.some((h) => lname.includes(h))) {
        if (!/\bground\b|\bsteak\b|\bfillet\b|\bbreast\b|\bthigh\b|\bdrumstick\b/.test(lname)) {
            return false;
        }
    }
    return true;
}
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
    return [query, ...variants.filter((v) => v.toLowerCase() !== q)];
}
/** Search a store, trying synonyms until results come back. */
export async function searchStoreSmart(shopId, query, first = 6) {
    let lastErr;
    for (const v of expandQuery(query)) {
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
// --- concurrency + compare --------------------------------------------------
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
const priceOf = (s) => s ? parseFloat(s.replace(/[^\d.]/g, "")) : Infinity;
/**
 * Compare a query's price across stores, cheapest first.
 *
 * Two modes:
 *  - default (search): fuzzy search + keyword relevance. Fast, some noise at
 *    stores that don't carry the item.
 *  - category mode (opts.category): for each store, find that store's collection
 *    slug for the category, browse it (CLEAN), then keep query-matching items.
 *    Slower (extra request to discover slugs) but no cross-category noise.
 *
 * opts.stores limits to a subset of STORES names; default is all of STORES.
 */
export async function comparePrices(query, opts = {}) {
    const concurrency = opts.concurrency ?? 4;
    const entries = Object.entries(STORES).filter(([store]) => !opts.stores || opts.stores.includes(store));
    const mode = opts.category ? "category" : "search";
    // Category mode discovers each store's collection slugs via a page navigation.
    // Navigations can't overlap with in-flight fetches on the shared page, so
    // pre-warm the category cache SEQUENTIALLY first; afterwards the per-store
    // browse calls are fetch-only and safe to run concurrently.
    if (opts.category) {
        for (const [store] of entries) {
            const slug = STORE_SLUGS[store];
            if (slug)
                await getCategories(slug);
        }
    }
    const results = await mapLimit(entries, concurrency, async ([store, fallbackShopId]) => {
        if (opts.category) {
            const r = await compareViaCategory(store, opts.category, query);
            return { store, topMatch: r.products[0] || null, allMatches: r.products, via: r.via, error: r.error };
        }
        const r = await searchStoreSmart(fallbackShopId, query, 6);
        return { store, topMatch: r.products[0] || null, allMatches: r.products, error: r.error };
    });
    results.sort((a, b) => {
        const av = a.allMatches.length ? priceOf(a.topMatch?.price) : Infinity;
        const bv = b.allMatches.length ? priceOf(b.topMatch?.price) : Infinity;
        return av - bv;
    });
    return { query, mode, results };
}
/**
 * Pick a store's collection slug matching the requested category, browse it, and
 * keep items matching the query. Returns cheapest-first.
 */
async function compareViaCategory(storeName, category, query) {
    const { slug: retailerSlug, shopId } = await resolveStore(storeName);
    if (!retailerSlug || !shopId)
        return { products: [], error: "cannot resolve " + storeName };
    const slugs = await getCategories(retailerSlug);
    const slug = pickCategorySlug(slugs, category);
    // Some storefronts don't expose their category nav reliably (headless render).
    // Fall back to fuzzy search so the store still gets a result rather than a
    // blank — clean category results where possible, search otherwise.
    if (!slug) {
        const sr = await searchStoreSmart(shopId, query, 6);
        return { products: sr.products, via: "search", error: sr.products.length ? undefined : "no '" + category + "' category and search empty" };
    }
    const r = await browseCollection(shopId, slug, 40);
    if (!r.ok)
        return { products: [], error: r.error };
    const matched = r.products
        .filter((p) => isRelevant(query, p.name))
        .sort((a, b) => priceOf(a.price) - priceOf(b.price));
    // If the collection had nothing matching, also fall back to search.
    if (!matched.length) {
        const sr = await searchStoreSmart(shopId, query, 6);
        if (sr.products.length)
            return { products: sr.products, via: "search" };
    }
    return { products: matched.slice(0, 6), via: "category" };
}
// Map a free-text category to one of a store's actual collection slugs. Tries
// the canonical name, common aliases, then a loose token-overlap match.
const CATEGORY_ALIASES = {
    "meat-and-seafood": ["meat-and-seafood", "meat-seafood", "meat", "seafood", "fresh-meat"],
    produce: ["produce", "fruits-vegetables", "fruits-and-vegetables", "fresh-produce"],
    "dairy-eggs": ["dairy-eggs", "dairy", "dairy-and-eggs", "eggs"],
    frozen: ["frozen", "frozen-foods"],
    bakery: ["bakery", "baked-goods", "bread-bakery", "bread"],
    beverages: ["beverages", "drinks"],
    snacks: ["snacks", "snacks-and-candy", "snacks-candy", "candy"],
    pantry: ["pantry", "canned-goods", "dry-goods-pasta", "condiments-sauces"],
};
export function pickCategorySlug(available, category) {
    const want = category.toLowerCase().trim();
    if (available.includes(want))
        return want;
    const aliases = CATEGORY_ALIASES[want] || [want];
    for (const a of aliases)
        if (available.includes(a))
            return a;
    // loose: any available slug that shares a meaningful token with an alias
    const wantTokens = new Set(aliases.flatMap((a) => a.split("-")).filter((t) => t.length >= 3));
    let best = null;
    let bestScore = 0;
    for (const slug of available) {
        const score = slug.split("-").filter((t) => wantTokens.has(t)).length;
        if (score > bestScore) {
            best = slug;
            bestScore = score;
        }
    }
    return best;
}
