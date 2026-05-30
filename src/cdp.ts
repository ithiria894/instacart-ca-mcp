/**
 * CDP connection layer.
 *
 * Connects to a Chrome instance that already has the user logged in to
 * instacart.ca, finds (or opens) an instacart.ca tab, and runs JavaScript in
 * that page's context. Because the code runs *inside* the logged-in page, the
 * httpOnly session cookies are sent automatically with every fetch — same
 * trick our Reddit MCP uses: hit the site's own internal API as the page does.
 *
 * Chrome must be started with remote debugging enabled, e.g.:
 *   google-chrome --remote-debugging-port=9222 --user-data-dir=~/.instacart-ca-mcp/chrome
 * then log in to instacart.ca once in that window.
 */
import CDP from "chrome-remote-interface";

const DEBUG_PORT = Number(process.env.INSTACART_CDP_PORT || 9222);
const DEBUG_HOST = process.env.INSTACART_CDP_HOST || "127.0.0.1";

export interface EvalResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function log(...args: unknown[]) {
  // MCP uses stdout for protocol; all logs go to stderr.
  console.error("[instacart-ca-mcp]", ...args);
}

/** Find an instacart.ca tab among open targets; returns its targetId or null. */
async function findInstacartTarget(): Promise<string | null> {
  const targets = await CDP.List({ host: DEBUG_HOST, port: DEBUG_PORT });
  log(`Found ${targets.length} CDP targets`);
  const page = targets.find(
    (t) => t.type === "page" && t.url.includes("instacart.ca")
  );
  if (page) {
    log(`Using existing instacart.ca tab: ${page.url}`);
    return page.id;
  }
  return null;
}

/**
 * Run an async JS function string in the instacart.ca page context and return
 * its JSON-serialised result. Opens an instacart.ca tab if none exists.
 */
export async function evalInInstacartPage<T = unknown>(
  fnBody: string
): Promise<EvalResult<T>> {
  let client: CDP.Client | undefined;
  try {
    let targetId = await findInstacartTarget();

    if (!targetId) {
      // No instacart tab open — create one and navigate.
      log("No instacart.ca tab found; opening one");
      const target = await CDP.New({
        host: DEBUG_HOST,
        port: DEBUG_PORT,
        url: "https://www.instacart.ca/store",
      });
      targetId = target.id;
      client = await CDP({ host: DEBUG_HOST, port: DEBUG_PORT, target: targetId });
      await client.Page.enable();
      await client.Page.loadEventFired();
      // give the SPA a moment to settle
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      client = await CDP({ host: DEBUG_HOST, port: DEBUG_PORT, target: targetId });
    }

    await client.Runtime.enable();

    const expression = `(async () => { ${fnBody} })()`;
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (exceptionDetails) {
      return {
        ok: false,
        error:
          exceptionDetails.exception?.description ||
          exceptionDetails.text ||
          "Unknown evaluation error",
      };
    }

    return { ok: true, value: result.value as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/** Verify Chrome is reachable + an instacart.ca session looks logged in. */
export async function checkConnection(): Promise<EvalResult<{ loggedIn: boolean; url: string }>> {
  const res = await evalInInstacartPage<{ loggedIn: boolean; url: string }>(`
    const r = await fetch("/graphql?operationName=CurrentUserFields&variables=%7B%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%22d7d1050d8a8efb9a24d2fd0d9c39f58d852ab84ea709370bcbedbca790112952%22%7D%7D", { credentials: "include", headers: { accept: "application/json" } });
    const j = await r.json().catch(() => ({}));
    const s = JSON.stringify(j);
    return { loggedIn: r.status === 200 && !s.includes("null") === false ? true : (r.status === 200), url: location.href };
  `);
  return res;
}
