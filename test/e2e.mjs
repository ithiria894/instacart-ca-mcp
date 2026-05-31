// E2E: drive the real business logic against the self-owned headless profile.
import { checkConnection } from "../dist/cdp.js";
import { comparePrices } from "../dist/instacart.js";

const conn = await checkConnection();
console.log("checkConnection:", JSON.stringify(conn.value || conn));

const r = await comparePrices("ground beef");
for (const res of r.results) {
  const tm = res.topMatch;
  console.log(
    res.store,
    "→",
    tm ? tm.name + " " + tm.price : "NO MATCH",
    "(" + res.allMatches.length + " matches)" + (res.error ? " err=" + res.error : "")
  );
}
process.exit(0);
