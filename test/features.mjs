// Full feature E2E — exercises every capability in one browser session.
import { shutdown } from "../dist/cdp.js";
import {
  checkConnection,
} from "../dist/cdp.js";
import {
  listStores,
  getCategories,
  browseCollection,
  getDeals,
  comparePrices,
  slugForShopId,
  STORES,
} from "../dist/instacart.js";

function line(...a) { console.log(...a); }

const conn = await checkConnection();
line("login:", JSON.stringify(conn.value || conn));

line("\n== instacart_stores ==");
const stores = await listStores();
line(`zone retailers: ${stores.length}`);
line(stores.slice(0, 8).map((s) => `${s.shopId} ${s.slug} (${s.name})`).join("\n"));

line("\n== instacart_categories (Walmart) ==");
const wSlug = await slugForShopId(STORES["Walmart"]);
line("walmart slug:", wSlug);
const cats = await getCategories(wSlug || "walmart-canada");
line(`categories (${cats.length}):`, cats.slice(0, 16).join(", "));

line("\n== instacart_browse Walmart meat-and-seafood (CLEAN) ==");
const meat = await browseCollection(STORES["Walmart"], "meat-and-seafood", 8);
line(meat.products.map((p) => `  ${p.name} ${p.price}`).join("\n") || "  (none) " + (meat.error || ""));

line("\n== instacart_deals (Walmart) ==");
const deals = await getDeals(STORES["Walmart"], 6);
line(deals.products.map((p) => `  ${p.name} ${p.price}${p.fullPrice ? " (was " + p.fullPrice + ")" : ""}`).join("\n") || "  (none) " + (deals.error || ""));

line("\n== instacart_compare 'ground beef' (search mode, top 8) ==");
const cmp = await comparePrices("ground beef", { stores: ["Walmart", "Superstore", "Costco", "T&T", "Save-On-Foods", "Famous Foods", "Bosa Foods", "Whole Foods"] });
line("mode:", cmp.mode);
for (const r of cmp.results) line(`  ${r.store.padEnd(13)} ${r.topMatch ? r.topMatch.name + " " + r.topMatch.price : "(no match)"}`);

line("\n== instacart_compare 'ground beef' category=meat-and-seafood (CLEAN mode) ==");
const cmp2 = await comparePrices("ground beef", { category: "meat-and-seafood", stores: ["Walmart", "Superstore", "Costco", "T&T", "Save-On-Foods", "Whole Foods"] });
line("mode:", cmp2.mode);
for (const r of cmp2.results) line(`  ${r.store.padEnd(13)} ${r.topMatch ? r.topMatch.name + " " + r.topMatch.price : "(no match)" + (r.error ? " [" + r.error + "]" : "")}`);

await shutdown();
process.exit(0);
