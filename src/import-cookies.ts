/**
 * Import an instacart.ca session into the MCP's persistent profile WITHOUT a
 * manual login, by copying the Cookie header from an already-logged-in browser.
 *
 * How to get the cookie string:
 *   1. In a logged-in instacart.ca tab, open DevTools → Network.
 *   2. Click any `graphql?...` request → Headers → Request Headers → `cookie:`.
 *   3. Copy the whole value.
 *
 * Then run:
 *   INSTACART_COOKIES='device_uuid=...; __Host-instacart_sid=...; ...' \
 *     node dist/import-cookies.js
 * or put the cookie string in a file and:
 *   node dist/import-cookies.js /path/to/cookies.txt
 *
 * The cookies are written into the profile so the headless MCP server is
 * logged in. Sessions expire eventually; re-run this (or `npm run login`) when
 * instacart_status reports loggedIn:false.
 */
import { chromium } from "playwright-core";
import os from "os";
import path from "path";
import fs from "fs";

const PROFILE_DIR =
  process.env.INSTACART_PROFILE_DIR ||
  path.join(os.homedir(), ".instacart-ca-mcp", "profile");

function readCookieString(): string {
  const fileArg = process.argv[2];
  if (fileArg && fs.existsSync(fileArg)) return fs.readFileSync(fileArg, "utf8").trim();
  if (process.env.INSTACART_COOKIES) return process.env.INSTACART_COOKIES.trim();
  console.error(
    "No cookies provided. Set INSTACART_COOKIES env or pass a file path argument."
  );
  process.exit(1);
}

/** Parse a raw "k=v; k2=v2" Cookie header into Playwright cookie objects. */
function parseCookies(raw: string) {
  // The session cookie (__Host-instacart_sid) is a *session* cookie in the
  // browser — no Expires — so a persistent context would drop it on close and
  // the next headless launch would be a guest again. Force a far-future expiry
  // so Chromium writes every cookie to the profile's cookie store on disk.
  const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  // __Host- cookies must be Secure, path "/", and have NO domain attribute, so
  // they have to be added by URL. Everything else we pin to the .instacart.ca
  // domain so it survives across www / store subpaths.
  const cleaned = raw.replace(/^\s*cookie:\s*/i, "");
  type PWCookie = { name: string; value: string; expires: number; url: string };
  const cookies: PWCookie[] = [];
  for (const part of cleaned.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    // Playwright: a cookie is specified by EITHER url OR domain+path, never both.
    // Add everything by url — Playwright derives domain/path/secure from it, and
    // we only ever fetch from www.instacart.ca anyway.
    cookies.push({ name, value, expires: oneYear, url: "https://www.instacart.ca/" });
  }
  return cookies;
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const raw = readCookieString();
  const cookies = parseCookies(raw);
  console.log(`[import] parsed ${cookies.length} cookies`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: "en-CA",
    timezoneId: "America/Vancouver",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  await ctx.addCookies(cookies);

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.instacart.ca/store", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2500);

  const check = await page.evaluate(async () => {
    const url =
      "/graphql?operationName=CurrentUserFields&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22d7d1050d8a8efb9a24d2fd0d9c39f58d852ab84ea709370bcbedbca790112952%22%7D%7D";
    const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    const t = await r.text();
    return { status: r.status, guest: /"guest":true/.test(t), hasId: t.includes('"id"') };
  });

  await ctx.close();

  if (check.status === 200 && check.hasId && !check.guest) {
    console.log("[import] ✅ Session imported — MCP profile is now logged in.");
    process.exit(0);
  } else {
    console.log("[import] ⚠️ Cookies imported but session looks like a guest:", JSON.stringify(check));
    console.log("[import] The cookie string may be stale or missing __Host-instacart_sid.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("[import] error:", e);
  process.exit(1);
});
