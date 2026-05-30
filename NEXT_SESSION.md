# instacart-ca-mcp — 下次 session 接手

## ✅ 已證明 work（核心價值）
喺 logged-in instacart.ca page 入面跑內部 GraphQL `SearchResultsPlacements`，
攞到真實跨店價錢。實測（2026-05-30）：
- Walmart (shopId 9057): Lean Ground Beef $9.37 / Regular $6.27 / Extra Lean $11.07
- Superstore (shopId 3702): 有結果

## 🔑 已抽到嘅 constant（src/instacart.ts 已記低）
- SearchResultsPlacements hash: 84255489b672b9f4b28ef070ea4ee50f4a363ab2dfe48b5715df94cb19566c65
- shopId: Walmart 9057, Superstore 3702 (T&T 待抽)
- zone: postalCode V6B6H4, zoneId 755 (Vancouver downtown)
- GraphQL variables shape: 見 src/instacart.ts searchStore()

## 🔴 卡住嘅位：standalone node connect Chrome
`chrome-remote-interface` 連唔到呢部機嘅 Chrome：
- Chrome `/json` HTTP discovery endpoint 返 404（新版 Chrome security default）
- browser-level ws (DevToolsActivePort) connect 都 throw bare "Error"
- 即係 dist/index.js 跑唔到（CDP layer fail）

## 💡 下次嘅 3 條出路（揀一）
1. **改用 playwright 而唔係 chrome-remote-interface** ⭐推薦
   - playwright 已裝（~/.mcp.json playwright server 用緊）
   - `chromium.connectOverCDP('http://127.0.0.1:9222')` — playwright 識 handle endpoint
   - 或 launchPersistentContext 自己開 browser（一次 login 存 profile）
   - 改寫 src/cdp.ts 用 playwright，其餘 instacart.ts/index.ts 唔使郁
2. **專開一個 Chrome 保持 /json enabled**
   - 舊版 flag 或 --remote-allow-origins=* 可能 re-enable /json
   - 然後 chrome-remote-interface 就 work
3. **唔做 standalone MCP，直接喺 Claude session 用 chrome-devtools MCP 跑 GraphQL**
   - 即係唔需要 build server，每次 Nicole 問比價，agent 用 chrome-devtools
     evaluate_script 跑（已驗證 work）
   - 最簡單但唔係 reusable MCP

## 架構決定（要 Nicole 揀）
Nicole 想要 reusable MCP（開 repo）→ 行路線 1（playwright connectOverCDP）。
