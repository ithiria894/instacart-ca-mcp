#!/usr/bin/env node
/**
 * Instacart Canada MCP server.
 *
 * Exposes product search + cross-store price comparison over instacart.ca's
 * internal GraphQL API, using a self-owned logged-in Chromium profile.
 *
 * Tools:
 *   - instacart_check    : verify the browser session is logged in
 *   - instacart_search   : search one store
 *   - instacart_compare  : compare a query across all configured stores
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { checkConnection, shutdown } from "./cdp.js";
import { searchStore, comparePrices, STORES } from "./instacart.js";
const server = new Server({ name: "instacart-ca-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
const STORE_NAMES = Object.keys(STORES).join(", ");
const TOOLS = [
    {
        name: "instacart_check",
        description: "Verify the Instacart.ca browser session is logged in. Returns loggedIn boolean and current URL.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "instacart_search",
        description: "Search a single Instacart.ca store for a product query. Returns a name+price list.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Product search text, e.g. 'ground beef'" },
                store: { type: "string", description: "Store name: " + STORE_NAMES },
                maxResults: { type: "number", description: "Max products to return (default 8)" },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        name: "instacart_compare",
        description: "Compare the price of a product across all configured Instacart.ca stores (" +
            STORE_NAMES +
            "). Returns the top match plus all matches per store.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Product search text, e.g. 'ground beef'" },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {});
    try {
        if (name === "instacart_check") {
            const r = await checkConnection();
            return { content: [{ type: "text", text: JSON.stringify(r.value ?? r, null, 2) }] };
        }
        if (name === "instacart_search") {
            const query = String(args.query ?? "");
            const store = args.store ? String(args.store) : Object.keys(STORES)[0];
            const maxResults = typeof args.maxResults === "number" ? args.maxResults : 8;
            const shopId = STORES[store] ?? STORES[Object.keys(STORES)[0]];
            const r = await searchStore(shopId, query, maxResults);
            return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
        }
        if (name === "instacart_compare") {
            const query = String(args.query ?? "");
            const r = await comparePrices(query);
            return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
        }
        throw new Error("Unknown tool: " + name);
    }
    catch (err) {
        return {
            content: [
                { type: "text", text: "Error: " + (err instanceof Error ? err.message : String(err)) },
            ],
            isError: true,
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[instacart-ca-mcp] server ready");
}
process.on("SIGINT", async () => {
    await shutdown();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
});
main().catch((e) => {
    console.error("[instacart-ca-mcp] error:", e);
    process.exit(1);
});
