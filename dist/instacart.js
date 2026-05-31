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
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, price: pm[1] });
      if (out.length >= 40) break;
    }
    return { ok: true, products: out };
  `;
    const res = await evalInInstacartPage(fnBody);
    if (!res.ok)
        return { ok: false, products: [], error: res.error };
    // Instacart pads results with "you might also like" recommendations that
    // ignore the query (e.g. Nutella under "chicken thigh"). Keep only products
    // whose name actually matches a meaningful query word, then trim to `first`.
    const matches = (res.value.products || []).filter((p) => isRelevant(query, p.name));
    const products = (matches.length ? matches : res.value.products).slice(0, first);
    return { ok: true, products };
}
const STOPWORDS = new Set([
    "the", "and", "with", "for", "pack", "value", "large", "small", "fresh",
    "organic", "boneless", "skinless", "each",
]);
/**
 * A product is relevant if its name contains at least one meaningful word from
 * the query. Words are lowercased, stopwords dropped, and a trailing "s" is
 * stripped so "eggs" matches "egg". If the query has no meaningful words
 * (e.g. all stopwords), everything is considered relevant.
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
    return tokens.some((t) => lname.includes(t));
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
