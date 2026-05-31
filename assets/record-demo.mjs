/**
 * Demo recorder — renders HTML/CSS scenes, screencaps each with Playwright, and
 * stitches them into a looping GIF with ffmpeg (palettegen/paletteuse for crisp
 * text). Same deterministic approach as the chatbotlite demo — NOT a screen
 * recording, so it's reproducible and the text stays sharp.
 *
 *   node assets/record-demo.mjs
 *   → assets/frames/*.png + assets/instacart-ca-mcp-demo.gif
 *
 * Uses Playwright from a sibling repo if this one only has playwright-core.
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Prefer full `playwright` (bundles a browser); fall back to chatbotlite's copy.
let chromium;
for (const p of ["playwright", "/home/nicole/MyGithub/chatbotlite/node_modules/playwright/index.js", "playwright-core"]) {
  try { ({ chromium } = require(p)); if (chromium) break; } catch {}
}
if (!chromium) throw new Error("no playwright available");

const OUT = path.join(__dirname, "frames");
const GIF = path.join(__dirname, "instacart-ca-mcp-demo.gif");
const HTML = "file://" + path.join(__dirname, "demo-frames.html");
const W = 1280, H = 800;

// scene id → how long (seconds) it should hold in the GIF
const SCENES = [
  { id: "drop", hold: 3.0 },
  { id: "ask", hold: 2.2 },
  { id: "result", hold: 4.5 },
  { id: "how", hold: 4.0 },
];

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.goto(HTML, { waitUntil: "networkidle" });

  for (const s of SCENES) {
    await page.evaluate((id) => { document.body.dataset.scene = id; }, s.id);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, s.id + ".png") });
    console.log("captured", s.id);
  }
  await browser.close();

  // Build an ffmpeg concat list with per-scene durations.
  const list = SCENES.map((s) => `file '${path.join(OUT, s.id + ".png")}'\nduration ${s.hold}`).join("\n")
    + `\nfile '${path.join(OUT, SCENES[SCENES.length - 1].id + ".png")}'\n`;
  const listPath = path.join(OUT, "list.txt");
  require("node:fs").writeFileSync(listPath, list);

  const palette = path.join(OUT, "palette.png");
  const vf = "scale=860:-1:flags=lanczos";
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -vf "${vf},palettegen=stats_mode=full" "${palette}"`, { stdio: "ignore" });
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -i "${palette}" -lavfi "${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" -loop 0 "${GIF}"`, { stdio: "ignore" });

  const kb = Math.round(require("node:fs").statSync(GIF).size / 1024);
  console.log("wrote", GIF, kb + "KB");
}

main();
