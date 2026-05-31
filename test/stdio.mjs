// Real MCP stdio smoke test: spawn the server, do the JSON-RPC handshake,
// list tools, then call instacart_compare and print the result.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, INSTACART_HEADLESS: "true" },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const HARD = setTimeout(() => { console.log("HARD_TIMEOUT"); child.kill(); process.exit(1); }, 80000);

const init = await rpc(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
console.log("initialize:", init.result?.serverInfo?.name);

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await rpc(2, "tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

const cmp = await rpc(3, "tools/call", { name: "instacart_compare", arguments: { query: "ground beef" } });
const txt = cmp.result?.content?.[0]?.text || JSON.stringify(cmp);
const parsed = JSON.parse(txt);
for (const res of parsed.results) {
  console.log("  " + res.store + " → " + (res.topMatch ? res.topMatch.name + " " + res.topMatch.price : "NO MATCH") + " (" + res.allMatches.length + ")");
}

clearTimeout(HARD);
child.kill("SIGINT");
process.exit(0);
