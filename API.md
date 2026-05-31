# instacart.ca internal GraphQL — captured API reference

All operations are persisted queries hit at:

```
GET https://www.instacart.ca/graphql?operationName=<OP>&variables=<urlenc JSON>&extensions=<urlenc {persistedQuery:{version:1,sha256Hash:<HASH>}}>
headers: accept: application/json, x-client-identifier: web   (the x-client-identifier is REQUIRED for search/collection ops — 401 without it)
```

Run from inside a logged-in `instacart.ca` page so httpOnly cookies are sent.
Zone-specific constants used below: Vancouver `postalCode=V6B6H4`, `zoneId=755`,
`addressId=19137103560427752`, coordinates `49.2840545,-123.113445`.
Hashes change when Instacart ships a new frontend bundle — re-capture from the
Network tab if a call starts returning `PersistedQueryNotSupported`.

---

## 1. Auth / session

### CurrentUserFields — login check
- hash: `d7d1050d8a8efb9a24d2fd0d9c39f58d852ab84ea709370bcbedbca790112952`
- variables: `{}`
- returns: `{data:{currentUser:{id, guest:false, ...}}}` — `guest:false` + an `id` ⇒ logged in.

---

## 2. Search (fuzzy, NOISY)

### SearchResultsPlacements
- hash: `84255489b672b9f4b28ef070ea4ee50f4a363ab2dfe48b5715df94cb19566c65`
- variables:
  ```json
  {"action":null,"query":"ground beef","pageViewId":"<uuid>","elevatedProductId":null,
   "searchSource":"search","filters":[],"disableReformulation":false,"disableLlm":false,
   "forceInspiration":false,"orderBy":"bestMatch","clusterId":null,"includeDebugInfo":false,
   "clusteringStrategy":null,"contentManagementSearchParams":{"itemGridColumnCount":1},
   "shopId":"9057","postalCode":"V6B6H4","zoneId":"755","first":20}
  ```
- Item node shape (the parser anchors on this):
  `"id":"items_<shopId>-<productId>","itemLoadId":"<uuid>","name":"<NAME>","size":...`
  then ~5–6 KB later `"priceString":"$X"` (and `"fullPriceString"` when on sale).
- **Caveat:** when a store doesn't carry the item, the response is padded with
  cross-category "you might also like" recommendations (dog food, makeup, jerky).
  There is **no department/category field per item** to filter on — the only
  refinements offered (see `filterDirectory` in the response) are:
  `order_by:price_asc|price_desc`, `sales:on_sale`, `brand_id:<n>`,
  `managed_attribute_refinement:<n>`. So search cannot be cleanly category-filtered.
  **Use Collections (below) instead when you want clean category results.**

---

## 3. Collections (category browse, CLEAN) ⭐

This is the reliable way to get category-accurate products — no noise.

### CollectionProductsWithFeaturedProducts — products in a category
- hash: `f3193dacfeec83828016dc1b3c8af8e61c4470d3f466da2d5797b3f2c530369c`
- variables:
  ```json
  {"shopId":"5780","slug":"meat-and-seafood","filters":[],"pageViewId":"<uuid>",
   "itemsDisplayType":"collections_all_items_grid","first":20,"pageSource":"collections",
   "postalCode":"V6B6H4","zoneId":"755"}
  ```
- Same item node shape as search. Verified clean: Costco `meat-and-seafood` → only
  meat; `produce` → only produce. Walmart `meat-and-seafood` → only meat.

### Per-store category slugs — each store has its OWN slug set

Category slugs are NOT served by a clean standalone API. Get them by scraping the
storefront once and caching:
`GET /store/<retailerSlug>/storefront` → regex `href="/collections/<slug>"`.

Walmart (33 categories): `produce, meat-and-seafood, household, dairy, baked-goods,
frozen, personal-care, canned-goods, snacks-and-candy, beverages, pets,
condiments-sauces, health-care, home-garden, breakfast-foods, dry-goods-pasta,
baking-essentials, baby, oils-vinegars-spices, electronics, party-gifts,
sports-outdoors, floral, dynamic(Sales), ...` — note Walmart uses `dairy` /
`baked-goods`, NOT `dairy-eggs` / `bread-bakery`. Slugs differ per store, so build
a category→per-store-slug map (discover-and-cache).

Cross-store-common slugs that DID work everywhere tested (Walmart, Superstore,
Save-On, T&T, Costco): `meat-and-seafood, produce, frozen, beverages, snacks`.
(`dairy-eggs`, `bakery`, `pantry` were EMPTY on most — use each store's own slug.)

### ShopCollectionScoped — per-retailer identity (NOT the slug list)
- hash: `f20693c3c551f0e0fbdcac9b2ca7aa6db50f9224a39967ba5ac767bb2b598f85`
- variables: `{"retailerSlug":"costco-canada","postalCode":"V6B6H4","coordinates":{...},"addressId":"...","allowCanonicalFallback":true}`
- Small response; just retailer identity. Not useful for category slugs.

---

## 4. Flyer / deals (on-sale)

### FlyerPlacements
- hash: `4c28e4b9b50b18a5a02824804d49e7a8acccf5473c3c0e7d8978c0fc2e3b80b3`
- variables: `{"shopId":"9057","zoneId":"755","postalCode":"V6B6H4","first":4}`

### FlyerTopSavingsMasonryItems
- hash: `119c16c75110c139d0d4704b93dcfd2f20686d216dfad02d499447fd6b6ba26e`
- variables: `{"shopId":"9057","source":"flyers_destination"}`

### ContentManagementDataQueriesFlyerPersonalizedItems — buy-it-again-and-on-sale
- hash: `f9348eadd66417e60350e840fb464bca6b110997123c767a0e76b2883757293e`
- variables: `{"shopId":"9057","source":"flyers_destination","filter":"buy_it_again_and_on_sale","pageViewId":"<uuid>","first":5,"postalCode":"V6B6H4","zoneId":"755"}`

(Item nodes carry `priceString` + `fullPriceString` so the discount = full − current.)

---

## 5. Fetch specific items by id

### Items
- hash: `b2411f6acba21b2a6a277ca5616fdc5d1265ba647808895c05fe7ce1fd2fdcec`
- variables: `{"ids":["items_5780-21115490", ...],"shopId":"5780","zoneId":"755","postalCode":"V6B6H4"}`

---

## 6. Store directory / retailer list ⭐

### ShopCollectionUnscoped — the full list of stores in the zone
- hash: `e4274fe3bbcb2464e3bca7be8368fdb702ca6b13b76d0042647d7470f44a8be7`
- variables: `{"postalCode":"V6B6H4","coordinates":{"latitude":49.2840545,"longitude":-123.113445},"addressId":"19137103560427752"}`
- **This returns every retailer available in the zone** — each `shops[]` entry has
  `id` (shopId), `retailer.id` (retailerId), `retailer.slug`, `retailer.name`,
  `retailer.retailerType`. 54 retailers in the Vancouver zone, including ones not yet
  in STORES: Loblaws, Safeway, Thrifty Foods, FreshCo, Your Independent Grocer,
  Fresh St. Market, Meridian Farm Market, City Market, Urban Fare, Bulk Barn,
  M&M Food Market, plus non-grocery (Staples, Michaels, Sephora, Home Depot, LUSH,
  Kiehl's, PetSmart, Pet Valu, Dollarama, …).
- This is the authoritative way to (re)build the STORES map for any zone — read
  `shops[].id` (shopId) + `retailer.slug`/`name` rather than hand-capturing.

- `priceParity` directory `/store/directory?filter=priceParity` flags stores re:
  price parity. In this zone it surfaced **Costco** (Costco DOES mark up; most others
  like Walmart are at in-store/no-markup prices).
- A retailer can have several shopIds (chain branches); STORES in src/instacart.ts
  keeps one representative per chain for the Vancouver zone.

### Price parity / markup note
Walmart via Instacart ≈ in-store prices (no markup). Costco via Instacart is marked
up. So when comparing, treat no-markup stores' prices as the real shelf price.
