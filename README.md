# instacart-ca-mcp

MCP server for **Instacart Canada** (`instacart.ca`). Search products and compare prices across stores (Walmart, Superstore, …) straight from your AI assistant, using the site's internal GraphQL API and your own logged-in session.

> ⚠️ Unofficial. This drives Instacart's *internal* web GraphQL API the same way the website does. It can break any time Instacart changes their frontend. For personal use; respect their ToS.

## Why this exists

Instacart's official Developer Platform API is **catalog + cart only** — it can't read live per-store prices for arbitrary products, and it can't see *your* zone's pricing. The website, though, shows real prices for every store you can deliver from. This MCP reuses that same internal API by running queries **inside a logged-in `instacart.ca` page**, so:

- prices are the real ones for **your** delivery zone
- no API key, no approval process
- works for every retailer Instacart lists in your area

## Architecture

```
┌─────────────┐   stdio    ┌──────────────────┐  page.evaluate  ┌──────────────────────┐
│ Claude/LLM  │ ─────────► │ instacart-ca-mcp │ ──────────────► │ own headless Chromium│
│  (MCP host) │  JSON-RPC  │   (this server)  │   GraphQL call  │ (persistent profile) │
└─────────────┘            └──────────────────┘                 └──────────────────────┘
```

The server **owns its own Chromium** (Playwright `launchPersistentContext`) with a persistent
user-data-dir at `~/.instacart-ca-mcp/profile`. You log in there once; the session is stored in
the profile and survives restarts. Every query runs *inside* that logged-in page via
`page.evaluate`, so the site's httpOnly session cookies are sent automatically — we hit
`instacart.ca`'s own persisted-GraphQL endpoint exactly like the website does.

Why not attach to your existing Chrome over CDP? Modern Chrome locks down the DevTools HTTP
discovery endpoint (`/json`, `/json/version` → 404) and restricts the browser-level WebSocket by
origin, so a standalone server can't reliably attach. Owning the browser sidesteps all of that and
makes the server self-contained and publishable.

## Tools

| Tool | What it does |
|------|--------------|
| `instacart_check` | Verify the browser session is logged in (`loggedIn`, current URL). |
| `instacart_search` | Search one store. Args: `query`, `store` (Walmart \| Superstore), `maxResults`. |
| `instacart_compare` | Compare a query across all configured stores. Returns top match + all matches per store. |

## Prerequisites

- Node 18+
- An Instacart.ca account

## Setup

```bash
npm install
npx playwright install chromium   # one-time: download the Chromium Playwright drives
npm run build
```

### Log in (one time)

Two ways to seed the profile with your session:

**A. Interactive login (needs a display)**

```bash
INSTACART_HEADLESS=false npm run login
```

A visible Chromium window opens. Log in to `instacart.ca`. The script detects login, saves the
profile, and exits. After that the server runs headless and stays logged in.

**B. Import cookies (headless machines)**

In any logged-in `instacart.ca` tab: DevTools → Network → click a `graphql?…` request → copy the
whole `cookie:` request header value, then:

```bash
INSTACART_COOKIES='device_uuid=…; __Host-instacart_sid=…; …' npm run import-cookies
# or: npm run import-cookies /path/to/cookies.txt
```

The `__Host-instacart_sid` cookie is the one that actually carries the session.

### Register with your MCP host

`~/.mcp.json`:

```json
{
  "mcpServers": {
    "instacart": {
      "command": "node",
      "args": ["/abs/path/to/instacart-ca-mcp/dist/index.js"],
      "env": { "INSTACART_HEADLESS": "true" }
    }
  }
}
```

(Claude Code also needs the server name in `enabledMcpjsonServers` in `~/.claude/settings.json`.)

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `INSTACART_HEADLESS` | `true` | `false` opens a visible window (for login). |
| `INSTACART_PROFILE_DIR` | `~/.instacart-ca-mcp/profile` | Where the logged-in profile lives. |
| `INSTACART_POSTAL` | `V6B6H4` | Delivery postal code (zone-specific pricing). |
| `INSTACART_ZONE` | `755` | Instacart zone id matching the postal code. |

Store `shopId`s and the persisted-query hash are zone-specific and captured in `src/instacart.ts`.
If results dry up after an Instacart frontend deploy, re-capture the `SearchResultsPlacements`
hash from a live page (Network tab) and update `HASHES` there.

## Tests

```bash
node test/e2e.mjs     # drives the business logic against the headless profile
node test/stdio.mjs   # full MCP JSON-RPC handshake + instacart_compare
```

## License

MIT
