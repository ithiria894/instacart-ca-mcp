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
// shopId per retailer for Nicole's Vancouver zone (V6B6H4, zone 755).
// These are zone-specific; a different delivery address may map to different ids.
export const STORES = {
    Walmart: "9057",
    Superstore: "3702",
    // "T&T": "????",  // TODO: capture T&T shopId from its storefront page
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
      zoneId: ${JSON.stringify(ZONE.zoneId)}, first: ${first}
    };
    const ext = { persistedQuery: { version: 1, sha256Hash: hash } };
    const url = "/graphql?operationName=SearchResultsPlacements&variables=" +
      encodeURIComponent(JSON.stringify(variables)) +
      "&extensions=" + encodeURIComponent(JSON.stringify(ext));
    const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (r.status !== 200) return { ok: false, error: "HTTP " + r.status, products: [] };
    // Use raw text (not r.json()) — proven-working parse path.
    const s = await r.text();
    if (s.indexOf('"errors"') !== -1 && s.indexOf('"data"') === -1) {
      return { ok: false, error: s.slice(0, 200), products: [] };
    }
    // Pair each product name with the nearest following price string.
    const UI = /^(bodymedium|small_currency|dollar|cents|body|caption|title|subtitle|heading|label)/i;
    const re = /"name":"([^"]{4,80})"/g;
    let m; const out = []; const seen = new Set();
    while ((m = re.exec(s)) !== null) {
      const name = m[1];
      if (UI.test(name)) continue;
      const after = s.substring(m.index, m.index + 900);
      const pm = after.match(/"(?:priceString|fullPriceString)":"(\\$[\\d.]+)"/);
      if (!pm) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, price: pm[1] });
    }
    return { ok: true, products: out.slice(0, ${first}) };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    return res.value;
}
/** Compare the cheapest match for a query across all configured stores. */
export async function comparePrices(query) {
    const results = [];
    for (const [store, shopId] of Object.entries(STORES)) {
        const r = await searchStore(shopId, query, 6);
        results.push({
            store,
            topMatch: r.products[0] || null,
            allMatches: r.products,
            error: r.error,
        });
    }
    return { query, results };
}
