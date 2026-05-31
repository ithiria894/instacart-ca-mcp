/**
 * Browser layer (Playwright, self-owned persistent profile).
 *
 * Instead of attaching to an external Chrome (whose /json DevTools endpoint is
 * locked down on this machine), the MCP launches and owns its own Chromium with
 * a persistent user-data-dir. You log in to instacart.ca there ONCE; the
 * session is stored in the profile and survives restarts.
 *
 * All work runs *inside* the logged-in instacart.ca page via page.evaluate, so
 * httpOnly session cookies are sent automatically — we hit the site's own
 * internal GraphQL API the same way the page does (the Reddit-MCP pattern).
 *
 * First-time login:
 *   INSTACART_HEADLESS=false  → a visible window opens; log in to instacart.ca.
 * After that, leave INSTACART_HEADLESS unset (headless) — the profile keeps you
 * logged in.
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import os from "os";
import path from "path";
import fs from "fs";

const PROFILE_DIR =
  process.env.INSTACART_PROFILE_DIR ||
  path.join(os.homedir(), ".instacart-ca-mcp", "profile");

const HEADLESS = process.env.INSTACART_HEADLESS !== "false";
const STORE_URL = "https://www.instacart.ca/store";

export interface EvalResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function log(...args: unknown[]) {
  console.error("[instacart-ca-mcp]", ...args);
}

// Singleton persistent context reused across calls within one server process.
let ctx: BrowserContext | null = null;
let page: Page | null = null;

async function getPage(): Promise<Page> {
  if (ctx && page && !page.isClosed()) return page;

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`Launching Chromium (headless=${HEADLESS}) profile=${PROFILE_DIR}`);
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    locale: "en-CA",
    timezoneId: "America/Vancouver",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  page = ctx.pages()[0] || (await ctx.newPage());
  if (!page.url().includes("instacart.ca")) {
    await page.goto(STORE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
  }
  return page;
}

/** Run an async JS function body in the instacart.ca page; return its result. */
export async function evalInInstacartPage<T = unknown>(
  fnBody: string
): Promise<EvalResult<T>> {
  try {
    const p = await getPage();
    if (!p.url().includes("instacart.ca")) {
      await p.goto(STORE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await p.waitForTimeout(3000);
    }
    const expression = `(async () => { ${fnBody} })()`;
    const value = (await p.evaluate(expression)) as T;
    if (value === undefined) return { ok: false, error: "Eval returned undefined" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Navigate to an instacart.ca path, let the SPA render, and pull
 * `/collections/<slug>` links from the DOM. A raw fetch of a storefront returns
 * no links (client-rendered), so getCategories uses this. Serialized through the
 * singleton page — don't call concurrently with page evals.
 */
export async function collectionSlugsForPath(path: string): Promise<string[]> {
  try {
    const p = await getPage();
    await p.goto("https://www.instacart.ca" + path, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    // Heavy storefronts render the category nav lazily — wait for the first
    // collections link to actually appear (fallback to a fixed wait).
    await p
      .waitForSelector('a[href*="/collections/"]', { timeout: 12000 })
      .catch(() => {});
    await p.waitForTimeout(1200);
    const slugs = (await p.evaluate(() => {
      const out: string[] = [];
      const seen: Record<string, number> = {};
      for (const a of Array.from(document.querySelectorAll('a[href*="/collections/"]'))) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/collections\/([a-z0-9][a-z0-9-]{1,44})/);
        if (m && !seen[m[1]]) { seen[m[1]] = 1; out.push(m[1]); }
      }
      return out;
    })) as string[];
    return slugs;
  } catch {
    return [];
  }
}

/** Verify the owned browser session is logged in to instacart.ca. */
export async function checkConnection(): Promise<
  EvalResult<{ loggedIn: boolean; url: string }>
> {
  return evalInInstacartPage<{ loggedIn: boolean; url: string }>(`
    const r = await fetch("/graphql?operationName=CurrentUserFields&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22d7d1050d8a8efb9a24d2fd0d9c39f58d852ab84ea709370bcbedbca790112952%22%7D%7D", { credentials: "include", headers: { accept: "application/json" } });
    const t = await r.text();
    return { loggedIn: r.status === 200 && t.includes('"id"'), url: location.href };
  `);
}

/** Close the owned browser (called on server shutdown). */
export async function shutdown(): Promise<void> {
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
  page = null;
}
