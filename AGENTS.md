# AI Agent 開發與維護規範 (`AGENTS.md`)

本文件為 `GoogleSearchSidebarUserscripts` 專案的最高指導原則。所有參與本專案開發、重構、除錯與維護的 AI Agent，在修改任何檔案前皆必須嚴格遵守以下技術架構、效能約束與 **Greasy Fork 官方上架規範**。

---

## 1. 專案定位與核心架構

- **目標產物**：`GoogleSearchSidebar.user.js`（相容於 ScriptCat 腳本貓、Tampermonkey、Violentmonkey 的極簡 Userscript）。
- **核心體驗**：將 Google 搜尋結果頁（SERP）頂部需點擊「工具（Tools）」才展開的下拉選單（語言、時間範圍、結果模式、清除篩選、進階搜尋），直接**垂直攤開並內嵌於搜尋結果左側空白處**，復刻早期 Google 搜尋一目了然的直向側邊欄體驗。

### 雙引擎資料擷取架構（DOM 提取 + `URLSearchParams` 保底）
1. **主引擎（DOM 提取 + Proxy Click 代理點擊）**：
   - 自動探測頂部「工具」按鈕（`#hdtb-tls`、`[aria-controls="hdtbMenus"]`，或導覽列內文字為 `工具`／`Tools` 之按鈕）與其關聯選單容器（`#hdtbMenus`、`g-popup`、`g-menu`、`[role="menu"]`）。
   - **背景靜默展開**：若 `#hdtbMenus` 尚未掛載子選單節點，在抑制頂部選單閃爍的前提下於背景觸發一次工具按鈕，誘導 Google 載入原生選單節點，提取後立即將頂部工具列復原收合。
   - **連結與代理點擊分流**：
     - 具原生 `<a href="...">` 之選項：直接採用其 `href` 建立側邊欄連結（完整支援滑鼠中鍵開新分頁與右鍵選單）。
     - 無 `href` 之互動節點（如「自訂日期範圍...」`#cdr_opt` 或具 `jsaction` 之 `[role="menuitemradio"]`／`[role="button"]`）：透過 **Proxy Click（代理點擊）** 轉發點擊事件至原生隱藏節點，100% 保留 Google 原生日期選擇對話框與互動行為。
2. **保底引擎（`URLSearchParams` 逐群組動態補齊）**：
   - 當 Google 進行 A/B 測試、延遲載入逾時，或特定篩選群組在未手動點擊前無法從 DOM 提取時，必須**逐群組**退回使用 `URLSearchParams` 動態生成原生篩選連結，確保側邊欄永遠完整可用：
     - **語言群組**：不限語言（移除 `lr` 與 `cr`）、繁體中文網頁（`lr=lang_zh-TW`）、台灣的網頁（`cr=countryTW`）。
     - **時間群組**：不限時間（移除 `tbs` 內之 `qdr:*`／`cdr:*`）、過去 1 小時（`tbs=qdr:h`）、過去 24 小時（`tbs=qdr:d`）、過去 1 週（`tbs=qdr:w`）、過去 1 個月（`tbs=qdr:m`）、過去 1 年（`tbs=qdr:y`）。
     - **結果群組**：所有結果（移除 `tbs` 內之 `li:1`）、完全符合（`tbs=li:1`）。
     - **複合條件保留**：修改 `tbs` 參數時，必須以逗號拆解並保留其他維度的既有條件（例如在已啟用 `li:1` 時切換 `qdr:d`，應合併為 `tbs=li:1,qdr:d`，不可互相覆蓋），同時移除分頁參數 `start` 以回到第一頁。
     - **底部動作項**：當存在生效篩選條件時顯示「清除篩選」；底部常駐提供「進階搜尋（`/advanced_search`）」。

---

## 2. UI / UX、排版與效能硬性約束

1. **分頁顯示範圍**：
   - 僅在「全部（預設一般網頁搜尋，無 `tbm` 且無特殊 `udm`）」與「網頁（`udm=14`）」分頁顯示。
   - 嚴格排除圖片（`udm=2` / `tbm=isch`）、影片（`udm=7` / `tbm=vid`）、新聞（`udm=12` / `tbm=nws`）、購物（`udm=28` / `tbm=shop`）、地圖、書籍等特殊分頁。
2. **零侵入絕對定位（嚴禁更動 Google 原生排版）**：
   - 側邊欄使用 `position: absolute` 隨頁面自然捲動，寬度固定為 `140px`，左側定位於 `left: 20px`，頂部與第一筆搜尋結果容器（`#rso`、`#search` 或 `#center_col`）頂部對齊。
   - **嚴禁修改** `#rcnt`、`#center_col`、`#appbar`、`#rhs` 等 Google 原生容器的寬度、位置或邊距（Margin / Padding）。
   - 當視窗寬度 `< 1250px` **或** 主搜尋結果欄左側實際留白空間不足（`< 168px`）時，必須自動隱藏側邊欄，絕不壓縮或遮擋主內容。
3. **極簡外觀與深淺色主題自適應**：
   - 不顯示群組標題，群組間僅以 `1px solid` 淺色水平細線分隔，所有子項目直接展開。
   - 目前生效（Active）之篩選條件，於文字左側標示 `✓`，並套用粗體與醒目強調色（淺色模式 `#dd4b39`、深色模式 `#f28b82`）。
   - 自動讀取 Google 頁面背景色明度（Luminance）與系統 `prefers-color-scheme`，以 CSS 變數動態切換文字、懸停背景與分隔線顏色，嚴禁寫死白底黑字。
4. **`MutationObserver` 防抖與節流規範**：
   - 監聽頁面動態載入時，必須排除側邊欄自身節點（`#gs-tools-sidebar`）造成的變更，並搭配 Debounce（防抖）與 `requestAnimationFrame` 節流機制，嚴禁在觀察器回呼內無條件同步改寫受監聽節點，避免頁面卡頓或無窮迴圈。

---

## 3. Greasy Fork 官方上架規範（強制落實）

所有對 `GoogleSearchSidebar.user.js` 的修改，皆必須 100% 符合以下 Greasy Fork 平台規範：

### 3.1 Metadata Block 必備鍵值與禁令
- `@name` 與 `@name:zh-TW`：必填，提供精準的英文與台灣繁體中文名稱。
- `@description` 與 `@description:zh-TW`：必填，清楚說明腳本功能，嚴禁塞入無關關鍵字。
- `@namespace`：**必須固定為 `https://greasyfork.org/users/1237813-abc0922001`**，嚴禁隨意變更。
- `@version`：採用標準 Mozilla 語意化版本格式（如 `1.0.0`）。**⚠️ 鐵律：每次修改 `GoogleSearchSidebar.user.js` 程式碼時，必須同步遞增 `@version` 版本號！**
- `@author`：固定為 `abc0922001`。
- `@license`：固定為 `MIT`（SPDX 標準識別碼）。
- `@match`：僅精準匹配 `https://www.google.com/search*` 與 `https://www.google.com.tw/search*`，嚴禁加入無關網域或過度寬鬆的萬用字元。
- `@compatible`：標註 `chrome`、`edge`、`firefox`。
- `@run-at`：`document-end`。
- `@grant`：`none`。
- **🚫 嚴禁填寫更新網址**：**切勿**加入 `@updateURL`、`@downloadURL` 或 `@installURL`（Greasy Fork 上架時會自動處理平台專屬更新連結）。

### 3.2 程式碼與外部資源禁令（Code & External Scripts Rules）
- **嚴禁混淆與壓縮（No Minification / Obfuscation）**：程式碼必須保持完整可讀性、標準縮排與語意化識別字命名，並附帶完整 JSDoc 與台灣繁體中文註解。
- **零外部執行碼（Zero External Executable Code）**：嚴禁使用 `@require`，亦禁止透過動態 `<script>`、`fetch` / `XMLHttpRequest` + `eval` / `Function` 載入任何外部 JavaScript。所有功能必須 100% 內建於單一腳本中。
- **無作者私利功能（No Antifeatures）**：嚴禁植入任何追蹤器、遙測、廣告或自訂更新檢查邏輯（更新完全交由腳本管理器處理）。
- **換行符號標準**：專案內所有檔案（`.js`、`.md`）一律強制使用 Unix 標準 **`LF` (`\n`)**，嚴禁出現 `CRLF` (`\r\n`)。

---

## 4. 語言與版本控制約束

1. **道地台灣繁體中文（zh-TW）**：所有程式碼註解、JSDoc、文件（`README.md`、`AGENTS.md`）與 Git Commit 訊息，一律使用台灣繁體中文慣用術語（例如：腳本、元件、預設、開放原始碼、瀏覽器擴充功能、網址參數、對話框、快取、非同步），嚴禁出現中國大陸慣用詞彙（如：脚本、组件、默认、开源、插件、链接参数、弹窗、缓存、异步）。
2. **禁止自動推送**：AI Agent 除非獲得開發者於對話中明確下達指令，否則**嚴禁自動執行 `git push`**。
