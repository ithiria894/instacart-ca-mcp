#!/usr/bin/env node
/**
 * Instacart Canada MCP server.
 *
 * Product search, clean category browsing, cross-store price comparison and
 * flyer deals over instacart.ca's internal GraphQL API, using a self-owned
 * logged-in Chromium profile. See README.md / API.md.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { checkConnection, shutdown } from "./cdp.js";
import { searchStore, comparePrices, browseCollection, getCategories, listStores, getDeals, resolveStore, pickCategorySlug, STORES, STORE_SLUGS, } from "./instacart.js";
const server = new Server({ name: "instacart-ca-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });
const STORE_NAMES = Object.keys(STORES).join(", ");
/** Resolve a store name (from STORES) or a raw shopId to a shopId. */
function toShopId(store) {
    return STORES[store] || store;
}
const TOOLS = [
    {
        name: "instacart_check",
        description: "Verify the Instacart.ca browser session is logged in.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "instacart_stores",
        description: "List every retailer available for delivery in the zone (live), with shopId, slug, name and type. Use this to discover stores beyond the built-in set.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "instacart_categories",
        description: "List a store's category collection slugs (e.g. meat-and-seafood, produce, frozen). Pass a store name (" +
            STORE_NAMES +
            ") or a retailer slug.",
        inputSchema: {
            type: "object",
            properties: {
                store: { type: "string", description: "Store name or retailer slug" },
            },
            required: ["store"],
            additionalProperties: false,
        },
    },
    {
        name: "instacart_browse",
        description: "Browse a category at a store — CLEAN, category-accurate results (no cross-category noise). Args: store, category (slug or common name like 'meat-and-seafood'), maxResults.",
        inputSchema: {
            type: "object",
            properties: {
                store: { type: "string", description: "Store name: " + STORE_NAMES },
                category: { type: "string", description: "Category slug or common name" },
                maxResults: { type: "number", description: "Max products (default 20)" },
            },
            required: ["store", "category"],
            additionalProperties: false,
        },
    },
    {
        name: "instacart_search",
        description: "Fuzzy search a single store. Faster but may include off-category items; for clean results use instacart_browse.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Product search text" },
                store: { type: "string", description: "Store name: " + STORE_NAMES },
                maxResults: { type: "number", description: "Max products (default 8)" },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        name: "instacart_compare",
        description: "Compare a product's price across stores, cheapest first. Default uses fuzzy search; pass `category` to browse that category collection at each store for clean, noise-free comparison. Optionally limit to a subset of stores.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Product to compare, e.g. 'ground beef'" },
                category: {
                    type: "string",
                    description: "Optional category (e.g. 'meat-and-seafood', 'produce') — enables clean category-mode comparison",
                },
                stores: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional subset of store names to compare (default: all)",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        name: "instacart_deals",
        description: "Top on-sale / flyer deals at a store. Args: store, maxResults.",
        inputSchema: {
            type: "object",
            properties: {
                store: { type: "string", description: "Store name: " + STORE_NAMES },
                maxResults: { type: "number", description: "Max deals (default 20)" },
            },
            required: ["store"],
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
            return text(JSON.stringify(r.value ?? r, null, 2));
        }
        if (name === "instacart_stores") {
            const stores = await listStores();
            return text(JSON.stringify({ count: stores.length, stores }, null, 2));
        }
        if (name === "instacart_categories") {
            const store = String(args.store ?? "");
            // accept a STORES name or a raw retailer slug
            const slug = STORE_SLUGS[store] || store;
            const slugs = await getCategories(slug);
            return text(JSON.stringify({ store, retailerSlug: slug, categories: slugs }, null, 2));
        }
        if (name === "instacart_browse") {
            const store = String(args.store ?? "");
            const category = String(args.category ?? "");
            const maxResults = typeof args.maxResults === "number" ? args.maxResults : 20;
            // Resolve slug + authoritative shopId from the store name (or raw slug).
            let { slug, shopId } = await resolveStore(store);
            if (!slug)
                slug = store; // allow a raw retailer slug
            if (!shopId)
                shopId = toShopId(store);
            const slugs = await getCategories(slug);
            const collSlug = pickCategorySlug(slugs, category) || category;
            const r = await browseCollection(shopId, collSlug, maxResults);
            return text(JSON.stringify({ store, category, collectionSlug: collSlug, ...r }, null, 2));
        }
        if (name === "instacart_search") {
            const query = String(args.query ?? "");
            const store = args.store ? String(args.store) : Object.keys(STORES)[0];
            const maxResults = typeof args.maxResults === "number" ? args.maxResults : 8;
            const r = await searchStore(toShopId(store), query, maxResults);
            return text(JSON.stringify({ store, ...r }, null, 2));
        }
        if (name === "instacart_compare") {
            const query = String(args.query ?? "");
            const category = args.category ? String(args.category) : undefined;
            const stores = Array.isArray(args.stores) ? args.stores : undefined;
            const r = await comparePrices(query, { category, stores });
            return text(JSON.stringify(r, null, 2));
        }
        if (name === "instacart_deals") {
            const store = String(args.store ?? "");
            const maxResults = typeof args.maxResults === "number" ? args.maxResults : 20;
            const r = await getDeals(toShopId(store), maxResults);
            return text(JSON.stringify({ store, ...r }, null, 2));
        }
        throw new Error("Unknown tool: " + name);
    }
    catch (err) {
        return {
            content: [{ type: "text", text: "Error: " + (err instanceof Error ? err.message : String(err)) }],
            isError: true,
        };
    }
});
function text(t) {
    return { content: [{ type: "text", text: t }] };
}
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[instacart-ca-mcp] server ready");
}
process.on("SIGINT", async () => { await shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
main().catch((e) => {
    console.error("[instacart-ca-mcp] error:", e);
    process.exit(1);
});
