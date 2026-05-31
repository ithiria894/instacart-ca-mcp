// Live demo: compare a handful of everyday items across stores, reusing one
// browser session (one launch, sequential queries — low rate-limit risk).
import { comparePrices } from "../dist/instacart.js";
import { shutdown } from "../dist/cdp.js";

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["ground beef", "eggs", "milk", "chicken thigh", "tofu"];

for (const q of QUERIES) {
  const r = await comparePrices(q);
  console.log("\n■ " + q);
  for (const res of r.results) {
    if (!res.allMatches.length) {
      console.log("   " + res.store.padEnd(11) + " (no match" + (res.error ? " — " + res.error : "") + ")");
      continue;
    }
    // show the cheapest 2 matches per store
    const top = res.allMatches.slice(0, 2).map((p) => p.name + " " + p.price).join("  |  ");
    console.log("   " + res.store.padEnd(11) + " " + top);
  }
}
await shutdown();
process.exit(0);
