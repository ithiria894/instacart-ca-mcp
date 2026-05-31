/**
 * One-time login helper.
 *
 * Opens a VISIBLE Chromium window using the MCP's own persistent profile and
 * navigates to instacart.ca. Log in there once (Google / email / phone). The
 * script polls the session and, once it sees you logged in, saves the profile
 * and exits. From then on the MCP server runs headless against this profile and
 * stays logged in.
 *
 * Run:  npm run login        (or: node dist/login.js)
 */
import { chromium, type BrowserContext } from "playwright-core";
import os from "os";
import path from "path";
import fs from "fs";

const PROFILE_DIR =
  process.env.INSTACART_PROFILE_DIR ||
  path.join(os.homedir(), ".instacart-ca-mcp", "profile");

const HASH_CURRENT_USER =
  "d7d1050d8a8efb9a24d2fd0d9c39f58d852ab84ea709370bcbedbca790112952";

async function isLoggedIn(ctx: BrowserContext): Promise<boolean> {
  const page = ctx.pages()[0];
  if (!page) return false;
  try {
    const url =
      "/graphql?operationName=CurrentUserFields&variables=%7B%7D&extensions=" +
      encodeURIComponent(
        JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH_CURRENT_USER } })
      );
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
      const t = await r.text();
      return { status: r.status, hasId: t.includes('"id"') };
    }, url);
    return res.status === 200 && res.hasId;
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[login] profile: ${PROFILE_DIR}`);
  console.log("[login] opening a visible Chromium window…");

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: "en-CA",
    timezoneId: "America/Vancouver",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.instacart.ca/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  console.log("[login] >>> Please log in to instacart.ca in the window. <<<");
  console.log("[login] Waiting for login (checks every 3s, up to 5 min)…");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(ctx)) {
      console.log("[login] ✅ Logged in! Session saved to the profile.");
      await page.waitForTimeout(1500);
      await ctx.close();
      process.exit(0);
    }
  }

  console.log("[login] ⏱️ Timed out waiting for login. Re-run `npm run login`.");
  await ctx.close();
  process.exit(1);
}

main().catch((e) => {
  console.error("[login] error:", e);
  process.exit(1);
});
