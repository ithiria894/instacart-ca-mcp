#!/usr/bin/env node
/**
 * instacart-ca-mcp — MCP server for Instacart Canada.
 *
 * Tools:
 *   instacart_check      — verify Chrome connection + login
 *   instacart_search     — search products in one store
 *   instacart_compare    — compare a product's price across all configured stores
 *
 * Architecture: the server talks to a Chrome instance you have already logged
 * in to instacart.ca with (via the Chrome DevTools Protocol on port 9222) and
 * runs the site's own internal GraphQL queries inside that page. No scraping of
 * the DOM, no official API key, no re-login — same pattern as our Reddit MCP.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { checkConnection } from "./cdp.js";
import { searchStore, comparePrices, STORES } from "./instacart.js";

const server = new Server(
  { name: "instacart-ca", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "instacart_check",
      description:
        "Verify the MCP can reach your logged-in Chrome and that the instacart.ca session is active. Run this first if other tools return empty.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "instacart_search",
      description:
        "Search products in ONE Instacart Canada store. Returns product names and prices.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product search query, e.g. 'ground beef'" },
          store: {
            type: "string",
            description: `Store name. One of: ${Object.keys(STORES).join(", ")}`,
          },
          maxResults: { type: "number", description: "Max products (default 8)" },
        },
        required: ["query"],
      },
    },
    {
      name: "instacart_compare",
      description:
        "Compare a product's price across ALL configured Instacart Canada stores. Returns the cheapest top match per store.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product to compare, e.g. 'ground beef'" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "instacart_check") {
      const r = await checkConnection();
      return json(r);
    }

    if (name === "instacart_search") {
      const query = String(a.query ?? "");
      const storeName = String(a.store ?? "Walmart");
      const max = Number(a.maxResults ?? 8);
      const shopId = STORES[storeName];
      if (!shopId) {
        return json({ error: `Unknown store '${storeName}'. Available: ${Object.keys(STORES).join(", ")}` });
      }
      const r = await searchStore(shopId, query, max);
      return json({ store: storeName, ...r });
    }

    if (name === "instacart_compare") {
      const query = String(a.query ?? "");
      const r = await comparePrices(query);
      return json(r);
    }

    return json({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function json(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[instacart-ca-mcp] server running (CDP port " + (process.env.INSTACART_CDP_PORT || 9222) + ")");
}

main().catch((e) => {
  console.error("[instacart-ca-mcp] fatal:", e);
  process.exit(1);
});
