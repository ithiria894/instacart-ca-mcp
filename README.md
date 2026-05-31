# instacart-ca-mcp

An MCP server for **Instacart Canada** (`instacart.ca`). Ask your AI assistant to search products, browse categories, and compare prices across every store in your delivery zone — no clicking through the website, no API key.

*(中文版喺下面 / Cantonese version below.)*

> ⚠️ **Unofficial.** This drives Instacart's *internal* web GraphQL API the same way the website does, from inside your own logged-in browser session. It can break any time Instacart changes their frontend. Built for personal use. Respect Instacart's Terms of Service.

---

## What it does

Instacart's official Developer Platform API is catalog + cart only. It can't read live per-store prices for arbitrary products, and it can't see *your* zone's pricing. The website can, though, so this server reuses the website's own API by running queries inside a logged-in `instacart.ca` page. That means:

- real prices for **your** delivery zone
- every retailer Instacart lists in your area (54 in the Vancouver zone)
- no API key, no approval process
- a "No markups" flag so you know which prices are the real shelf price vs an Instacart markup

Example, in your AI chat:

> **You:** compare ground beef across Walmart, Save-On, Costco and T&T

> **Assistant:** *(calls `instacart_compare`)*
> | Store | Cheapest | |
> |---|---|---|
> | Walmart | Regular Ground Beef **$6.27** | ↑ markup |
> | Save-On-Foods | Fresh Ground Beef $8.50 | ✓ no-markup (real shelf price) |
> | Superstore | Medium Ground Beef $9.50 | ↑ markup |
> | Costco | Lean Ground Beef $38.47 (bulk) | ↑ markup |

## Tools

| Tool | What it does |
|------|--------------|
| `instacart_check` | Verify your browser session is logged in. |
| `instacart_stores` | List every retailer in your zone (live), with shopId, slug, name, type. |
| `instacart_categories` | List a store's category slugs (`meat-and-seafood`, `produce`, `frozen`, …). |
| `instacart_browse` | Browse a category at a store. **Clean** results, no cross-category noise. |
| `instacart_search` | Fuzzy search one store. Fast, but can include off-category items. |
| `instacart_compare` | Compare a product across stores, cheapest first. Add `category` for noise-free comparison; each result is tagged `noMarkup`. |
| `instacart_deals` | On-sale items at a store, with struck-through original prices. |

**Clean vs fuzzy:** plain search is fuzzy, so a store that doesn't carry an item gets padded with "you might also like" junk (dog food, makeup). `instacart_browse` and `instacart_compare`'s `category` mode use Instacart's own category collections instead, which are clean.

## Quick start

```bash
git clone https://github.com/ithiria894/instacart-ca-mcp
cd instacart-ca-mcp
npm install
npx playwright install chromium   # one-time: download the Chromium it drives
npm run build
```

### Log in (one time)

The server owns its own Chromium profile, so you log in once and it stays logged in.

**Option A — interactive login (needs a display):**

```bash
INSTACART_HEADLESS=false npm run login
```

A Chromium window opens. Log in to instacart.ca. The script detects login, saves the profile, and exits. After that the server runs headless and stays logged in.

**Option B — import cookies (headless / server machines):**

In any logged-in instacart.ca tab: DevTools → Network → click any `graphql?…` request → copy the whole `cookie:` request header, then:

```bash
INSTACART_COOKIES='device_uuid=…; __Host-instacart_sid=…; …' npm run import-cookies
# or save the cookie string to a file:
npm run import-cookies /path/to/cookies.txt
```

The `__Host-instacart_sid` cookie is the one that carries the session.

### Register with your MCP host

**Claude Code** — add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "instacart": {
      "command": "node",
      "args": ["/absolute/path/to/instacart-ca-mcp/dist/index.js"],
      "env": { "INSTACART_HEADLESS": "true" }
    }
  }
}
```

Claude Code also needs the server name in `enabledMcpjsonServers` in `~/.claude/settings.json`. Restart Claude Code, then just ask it to compare prices.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `INSTACART_HEADLESS` | `true` | `false` opens a visible window (for first-time login). |
| `INSTACART_PROFILE_DIR` | `~/.instacart-ca-mcp/profile` | Where the logged-in profile lives. |
| `INSTACART_POSTAL` | `V6B6H4` | Delivery postal code (zone-specific pricing). |
| `INSTACART_ZONE` | `755` | Instacart zone id matching the postal code. |

Store shopIds and the persisted-query hashes are captured for the Vancouver zone in `src/instacart.ts`. For another city, update `INSTACART_POSTAL` / `INSTACART_ZONE`; `instacart_stores` reads the live retailer list for your zone. See [`API.md`](./API.md) for the full reverse-engineered API reference.

## How it works

```
┌─────────────┐   stdio    ┌──────────────────┐  page.evaluate  ┌──────────────────────┐
│  AI / LLM   │ ─────────► │ instacart-ca-mcp │ ──────────────► │ own headless Chromium│
│ (MCP host)  │  JSON-RPC  │   (this server)  │   GraphQL call  │ (persistent profile) │
└─────────────┘            └──────────────────┘                 └──────────────────────┘
```

The server owns its own Chromium (Playwright `launchPersistentContext`) with a persistent profile at `~/.instacart-ca-mcp/profile`. You log in once; the session survives restarts. Every query runs *inside* that logged-in page via `page.evaluate`, so the site's httpOnly cookies are sent automatically, and we hit instacart.ca's own persisted-GraphQL endpoint exactly like the website.

Why not attach to your existing Chrome over CDP? Modern Chrome locks down the DevTools HTTP discovery endpoint (`/json`, `/json/version` return 404) and restricts the browser-level WebSocket by origin, so a standalone server can't reliably attach. Owning the browser sidesteps all of that and makes the server self-contained.

## Limitations

- The login session expires after a few weeks to a few months. When `instacart_check` reports `loggedIn: false`, re-run `npm run login` or `npm run import-cookies`.
- Persisted-query hashes change when Instacart ships a new frontend bundle. If a call returns `PersistedQueryNotSupported`, re-capture the hash from the Network tab and update `HASHES` in `src/instacart.ts`.
- The constants are captured for the Vancouver zone. Other zones work for the live store list and search; some hand-picked shopIds may differ.

## Tests

```bash
node test/features.mjs   # full feature walk-through against the headless profile
node test/stdio.mjs      # MCP JSON-RPC handshake + a real tool call
```

## License

MIT

---
---

# instacart-ca-mcp（廣東話版）

一個畀 **Instacart Canada**（`instacart.ca`）用嘅 MCP server。叫你個 AI 助手幫你搜尋產品、瀏覽分類、跨店比價 —— 唔使自己撳網站，唔使 API key。

> ⚠️ **非官方。** 呢個係用你自己已登入嘅 browser session，行 instacart.ca 個**內部** GraphQL API（同個網站自己用嘅一模一樣）。Instacart 改 frontend 隨時會壞。自用為主，請遵守 Instacart 嘅服務條款。

---

## 做到啲乜

Instacart 官方 Developer API 淨係得 catalog + cart，**讀唔到任意產品嘅實時店價**，亦睇唔到你自己 zone 嘅定價。但個網站做得到，所以呢個 server 喺一個已登入嘅 instacart.ca page 入面跑 query，重用返網站自己個 API。即係：

- 真實價，針對**你**個送貨 zone
- 你區內 Instacart 上面所有店（溫哥華 zone 有 54 間）
- 唔使 API key、唔使審批
- 有「No markups（冇加價）」標記，畀你知邊間嘅價先係真實店價，邊間係 Instacart 加咗價

喺你個 AI 對話度嘅例子：

> **你：** 幫我比較 Walmart、Save-On、Costco、T&T 嘅免治牛肉

> **助手：**（呼叫 `instacart_compare`）
> | 店 | 最平 | |
> |---|---|---|
> | Walmart | Regular Ground Beef **$6.27** | ↑ 有加價 |
> | Save-On-Foods | Fresh Ground Beef $8.50 | ✓ 冇加價（真店價）|
> | Superstore | Medium Ground Beef $9.50 | ↑ 有加價 |
> | Costco | Lean Ground Beef $38.47（大包）| ↑ 有加價 |

## 工具

| 工具 | 做乜 |
|------|------|
| `instacart_check` | 確認 browser session 仲登入住。 |
| `instacart_stores` | 即時列出你 zone 入面所有店（shopId、slug、名、類型）。 |
| `instacart_categories` | 列出某間店嘅分類 slug（`meat-and-seafood`、`produce`、`frozen`…）。 |
| `instacart_browse` | 瀏覽某店某分類。**乾淨**結果，冇跨類雜訊。 |
| `instacart_search` | 喺單一店模糊搜尋。快，但可能撈到唔同類嘅嘢。 |
| `instacart_compare` | 跨店比價，由平到貴。加 `category` 就行乾淨模式；每個結果有 `noMarkup` 標記。 |
| `instacart_deals` | 某店嘅特價貨，連劃線原價。 |

**乾淨 vs 模糊：** 普通 search 係模糊嘅，所以一間冇賣嗰樣嘢嘅店會塞「你可能想要」垃圾（狗糧、化妝品）。`instacart_browse` 同 `instacart_compare` 嘅 `category` 模式改用 Instacart 自己嘅分類 collection，所以乾淨。

## 快速開始

```bash
git clone https://github.com/ithiria894/instacart-ca-mcp
cd instacart-ca-mcp
npm install
npx playwright install chromium   # 一次過：download 佢要用嘅 Chromium
npm run build
```

### 登入（一次過）

呢個 server 擁有自己一個 Chromium profile，所以你登入一次就會長期記住。

**方法 A — 互動登入（要有畫面）：**

```bash
INSTACART_HEADLESS=false npm run login
```

會開一個 Chromium 視窗。登入 instacart.ca。個 script 偵測到登入就會儲存 profile 然後收工。之後 server 就 headless 運行兼長期保持登入。

**方法 B — Import cookie（headless / server 機）：**

喺任何已登入嘅 instacart.ca tab：DevTools → Network → 撳任何一個 `graphql?…` request → copy 成個 `cookie:` request header，然後：

```bash
INSTACART_COOKIES='device_uuid=…; __Host-instacart_sid=…; …' npm run import-cookies
# 或者將 cookie string 存落 file：
npm run import-cookies /path/to/cookies.txt
```

`__Host-instacart_sid` 嗰條 cookie 先係帶住個 session 嗰條。

### 喺你個 MCP host 註冊

**Claude Code** —— 加入 `~/.mcp.json`：

```json
{
  "mcpServers": {
    "instacart": {
      "command": "node",
      "args": ["/absolute/path/to/instacart-ca-mcp/dist/index.js"],
      "env": { "INSTACART_HEADLESS": "true" }
    }
  }
}
```

Claude Code 仲要喺 `~/.claude/settings.json` 個 `enabledMcpjsonServers` 入面加埋個 server 名。Restart Claude Code，跟住直接叫佢比價就得。

## 設定

| 環境變數 | 預設 | 用途 |
|---------|------|------|
| `INSTACART_HEADLESS` | `true` | `false` 會開一個可見視窗（畀第一次登入用）。 |
| `INSTACART_PROFILE_DIR` | `~/.instacart-ca-mcp/profile` | 登入 profile 存喺邊。 |
| `INSTACART_POSTAL` | `V6B6H4` | 送貨郵遞區號（定價係 zone-specific）。 |
| `INSTACART_ZONE` | `755` | 對應郵遞區號嘅 Instacart zone id。 |

店嘅 shopId 同 persisted-query hash 喺 `src/instacart.ts` 入面（捕捉自溫哥華 zone）。換城市就改 `INSTACART_POSTAL` / `INSTACART_ZONE`；`instacart_stores` 會即時讀你 zone 嘅店列表。完整 reverse-engineered API 參考睇 [`API.md`](./API.md)。

## 原理

```
┌─────────────┐   stdio    ┌──────────────────┐  page.evaluate  ┌──────────────────────┐
│  AI / LLM   │ ─────────► │ instacart-ca-mcp │ ──────────────► │ 自己嘅 headless     │
│ (MCP host)  │  JSON-RPC  │  （呢個 server） │   GraphQL call  │ Chromium（持久 profile）│
└─────────────┘            └──────────────────┘                 └──────────────────────┘
```

Server 擁有自己一個 Chromium（Playwright `launchPersistentContext`），profile 放喺 `~/.instacart-ca-mcp/profile`。登入一次，restart 都記住。每個 query 都喺嗰個已登入 page 入面用 `page.evaluate` 跑，所以個網站嘅 httpOnly cookie 自動送出，我哋就好似個網站咁打 instacart.ca 自己嘅 persisted-GraphQL endpoint。

點解唔連你現有嘅 Chrome（用 CDP）？因為 modern Chrome 鎖死咗 DevTools 個 HTTP discovery endpoint（`/json`、`/json/version` 返 404），又用 origin 限制咗 browser-level WebSocket，所以一個 standalone server 連唔到。自己擁有個 browser 就避開晒呢啲問題，亦令個 server 自給自足。

## 限制

- 登入 session 過幾星期到幾個月會過期。當 `instacart_check` 報 `loggedIn: false`，重跑 `npm run login` 或 `npm run import-cookies` 就得。
- Instacart 出新 frontend bundle 嗰陣，persisted-query hash 會變。如果有 call 返 `PersistedQueryNotSupported`，喺 Network tab 重新捕捉個 hash，更新 `src/instacart.ts` 入面嘅 `HASHES`。
- 啲常數係捕捉自溫哥華 zone。其他 zone：即時店列表同 search 都 work，但個別手揀嘅 shopId 可能唔同。

## 測試

```bash
node test/features.mjs   # 喺 headless profile 上行完整功能
node test/stdio.mjs      # MCP JSON-RPC handshake + 真實 tool call
```

## 授權

MIT
