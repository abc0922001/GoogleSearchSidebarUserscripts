// ==UserScript==
// @name         Google Search Tools Sidebar
// @name:zh-TW   Google 搜尋「工具」選單側邊欄攤開腳本
// @description  Unfolds Google Search "Tools" dropdown menus (Language, Time, Verbatim, Advanced Search) into a clean vertical left sidebar.
// @description:zh-TW 將 Google 搜尋結果頁面頂部需點擊「工具」才能看到的下拉選單（語言、時間範圍、所有結果、進階搜尋等），直接全部攤開並內嵌展示於頁面左側空白處。
// @namespace    https://greasyfork.org/users/1237813-abc0922001
// @version      1.0.1
// @author       abc0922001
// @license      MIT
// @match        https://www.google.com/search*
// @match        https://www.google.com.tw/search*
// @compatible   chrome
// @compatible   edge
// @compatible   firefox
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * 腳本固定常數設定
   */
  const SIDEBAR_ID = 'gs-tools-sidebar';
  const STYLE_ID = 'gs-tools-sidebar-style';
  const SIDEBAR_WIDTH = 140;
  const SIDEBAR_LEFT = 20;
  const MIN_VIEWPORT_WIDTH = 1250;
  const MIN_LEFT_GUTTER = SIDEBAR_LEFT + SIDEBAR_WIDTH + 8;

  /**
   * 執行期狀態快取，避免重複觸發原生選單或造成觀察器迴圈
   */
  const runtimeState = {
    isRendering: false,
    autoExpandAttemptedUrl: '',
    isAutoExpanding: false,
    cachedDomGroupsUrl: '',
    cachedDomGroups: null,
    debounceTimer: 0,
    rafId: 0
  };

  /**
   * 判斷目前頁面是否為允許顯示側邊欄的一般網頁搜尋分頁
   * 僅在「全部（預設一般搜尋）」與「網頁（udm=14）」分頁啟用，排除圖片、影片、新聞、購物、地圖等分頁
   *
   * @param {URL} url 目前頁面網址物件
   * @returns {boolean} 是否允許顯示側邊欄
   */
  function isEligibleSearchTab(url) {
    if (!url || !url.pathname.startsWith('/search')) {
      return false;
    }
    const params = url.searchParams;
    const tbm = (params.get('tbm') || '').trim().toLowerCase();
    if (tbm !== '') {
      return false;
    }
    const udm = (params.get('udm') || '').trim();
    if (udm !== '' && udm !== '14') {
      return false;
    }
    return true;
  }

  /**
   * 尋找主搜尋結果區域的基準容器（供計算頂部對齊與左側可用空白寬度）
   *
   * @returns {{ topAnchor: HTMLElement | null, columnAnchor: HTMLElement | null }} 基準元素組
   */
  function findLayoutAnchors() {
    const topAnchor =
      document.querySelector('#rso') ||
      document.querySelector('#search') ||
      document.querySelector('#center_col') ||
      document.querySelector('#rcnt');

    const columnAnchor =
      document.querySelector('#center_col') ||
      document.querySelector('#rso') ||
      document.querySelector('#search');

    return { topAnchor, columnAnchor };
  }

  /**
   * 解析 CSS 色彩字串為 RGB 數值陣列
   *
   * @param {string} colorStr CSS rgb/rgba 字串
   * @returns {number[] | null} [r, g, b, a] 或 null
   */
  function parseRgbColor(colorStr) {
    if (!colorStr) {
      return null;
    }
    const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!match) {
      return null;
    }
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    const a = match[4] !== undefined ? Number(match[4]) : 1;
    return [r, g, b, a];
  }

  /**
   * 偵測當前 Google 頁面是否處於深色主題
   * 優先讀取頁面實際背景色計算相對明度，若透明則回退至系統 prefers-color-scheme
   *
   * @returns {boolean} 是否為深色模式
   */
  function detectDarkMode() {
    const candidates = [document.body, document.documentElement];
    for (const el of candidates) {
      if (!el) {
        continue;
      }
      const bg = window.getComputedStyle(el).backgroundColor;
      const rgba = parseRgbColor(bg);
      if (rgba && rgba[3] > 0.05) {
        const [r, g, b] = rgba;
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5;
      }
    }
    const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (colorSchemeMeta && /dark/i.test(colorSchemeMeta.getAttribute('content') || '')) {
      return true;
    }
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /**
   * 注入側邊欄所需的靜態 CSS 樣式表（透過 CSS 變數支援深淺色主題）
   */
  function ensureStylesInjected() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${SIDEBAR_ID} {
        --gs-sb-text: #4d5156;
        --gs-sb-text-hover: #202124;
        --gs-sb-hover-bg: rgba(60, 64, 67, 0.08);
        --gs-sb-border: #dadce0;
        --gs-sb-active: #dd4b39;
        position: absolute;
        left: ${SIDEBAR_LEFT}px;
        inset-block-start: var(--gs-sb-top, 80px);
        width: ${SIDEBAR_WIDTH}px;
        box-sizing: border-box;
        contain: layout style;
        z-index: 98;
        font-family: arial, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        color: var(--gs-sb-text);
        user-select: none;
      }
      #${SIDEBAR_ID}[data-theme="dark"] {
        --gs-sb-text: #bdc1c6;
        --gs-sb-text-hover: #e8eaed;
        --gs-sb-hover-bg: rgba(232, 234, 237, 0.08);
        --gs-sb-border: #3c4043;
        --gs-sb-active: #f28b82;
      }
      @media (prefers-contrast: more) {
        #${SIDEBAR_ID} {
          --gs-sb-text: #202124;
          --gs-sb-border: #5f6368;
          --gs-sb-active: #b3261e;
        }
        #${SIDEBAR_ID}[data-theme="dark"] {
          --gs-sb-text: #ffffff;
          --gs-sb-border: #9aa0a6;
          --gs-sb-active: #f6aea9;
        }
      }
      @media (forced-colors: active) {
        #${SIDEBAR_ID} {
          --gs-sb-text: LinkText;
          --gs-sb-text-hover: LinkText;
          --gs-sb-border: CanvasText;
          --gs-sb-active: Highlight;
        }
      }
      #${SIDEBAR_ID}[hidden] {
        display: none !important;
      }
      #${SIDEBAR_ID} .gs-sb-group {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      #${SIDEBAR_ID} .gs-sb-group:not(:first-child) {
        padding-block-start: 8px;
      }
      #${SIDEBAR_ID} .gs-sb-group:not(:last-child) {
        padding-block-end: 8px;
        border-block-end: 1px solid var(--gs-sb-border);
      }
      #${SIDEBAR_ID} .gs-sb-item {
        margin-block: 1px;
        margin-inline: 0;
        padding: 0;
      }
      #${SIDEBAR_ID} .gs-sb-link {
        display: flex;
        align-items: flex-start;
        gap: 5px;
        inline-size: 100%;
        min-block-size: 24px;
        box-sizing: border-box;
        padding-block: 5px;
        padding-inline: 8px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--gs-sb-text);
        text-decoration: none;
        font: inherit;
        text-align: start;
        cursor: pointer;
        word-break: break-word;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      #${SIDEBAR_ID} .gs-sb-link:hover {
        background-color: var(--gs-sb-hover-bg);
        color: var(--gs-sb-text-hover);
        text-decoration: none;
      }
      #${SIDEBAR_ID} .gs-sb-link:focus-visible {
        outline: 2px solid var(--gs-sb-active);
        outline-offset: 1px;
        color: var(--gs-sb-text-hover);
      }
      #${SIDEBAR_ID} .gs-sb-link:where([data-active="true"], [aria-current="page"], [aria-pressed="true"]) {
        color: var(--gs-sb-active);
        font-weight: 700;
      }
      #${SIDEBAR_ID} .gs-sb-check {
        display: inline-block;
        inline-size: 12px;
        flex-shrink: 0;
        font-weight: 700;
        color: var(--gs-sb-active);
      }
      #${SIDEBAR_ID} .gs-sb-label {
        flex: 1;
        min-inline-size: 0;
      }
      html.gs-sb-silent-probe #hdtbMenus {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 拆解網址中的 tbs 參數為鍵值陣列（支援逗號分隔的多重篩選條件）
   *
   * @param {URLSearchParams} searchParams 查詢參數物件
   * @returns {string[]} tbs 子條件清單（如 ['qdr:d', 'li:1']）
   */
  function parseTbsTokens(searchParams) {
    const raw = searchParams.get('tbs') || '';
    if (!raw) {
      return [];
    }
    return raw
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
  }

  /**
   * 讀取目前網址中已生效的篩選狀態
   *
   * @param {URL} url 目前網址
   * @returns {{
   *   lr: string,
   *   cr: string,
   *   qdr: string,
   *   cdr: string,
   *   cdMin: string,
   *   cdMax: string,
   *   verbatim: boolean,
   *   hasAnyFilter: boolean
   * }} 篩選狀態摘要
   */
  function getActiveFilterState(url) {
    const params = url.searchParams;
    const lr = (params.get('lr') || '').trim();
    const cr = (params.get('cr') || '').trim();
    const tokens = parseTbsTokens(params);

    let qdr = '';
    let cdr = '';
    let cdMin = '';
    let cdMax = '';
    let verbatim = false;

    for (const token of tokens) {
      if (token.startsWith('qdr:')) {
        qdr = token;
      } else if (token === 'cdr:1' || token.startsWith('cdr:')) {
        cdr = token;
      } else if (token.startsWith('cd_min:')) {
        cdMin = token.slice('cd_min:'.length);
      } else if (token.startsWith('cd_max:')) {
        cdMax = token.slice('cd_max:'.length);
      } else if (token === 'li:1') {
        verbatim = true;
      }
    }

    const hasAnyFilter = Boolean(lr || cr || qdr || cdr || verbatim);
    return { lr, cr, qdr, cdr, cdMin, cdMax, verbatim, hasAnyFilter };
  }

  /**
   * 以目前網址為基底，動態建構修改特定篩選條件後的新搜尋網址
   * 自動保留其他維度的篩選條件（如修改時間時保留「完全符合」li:1），並移除分頁 start 參數
   *
   * @param {URL} baseUrl 目前網址
   * @param {{
   *   lr?: string | null,
   *   cr?: string | null,
   *   qdr?: string | null,
   *   verbatim?: boolean | null,
   *   clearAll?: boolean
   * }}updater 欲變更的條件
   * @returns {string} 組合後的完整網址字串
   */
  function buildFilterUrl(baseUrl, updater) {
    const nextUrl = new URL(baseUrl.toString());
    const params = nextUrl.searchParams;
    params.delete('start');

    if (updater.clearAll) {
      params.delete('lr');
      params.delete('cr');
      params.delete('tbs');
      return nextUrl.toString();
    }

    if (updater.lr !== undefined) {
      if (updater.lr) {
        params.set('lr', updater.lr);
      } else {
        params.delete('lr');
      }
    }

    if (updater.cr !== undefined) {
      if (updater.cr) {
        params.set('cr', updater.cr);
      } else {
        params.delete('cr');
      }
    }

    let tokens = parseTbsTokens(params);

    if (updater.qdr !== undefined) {
      tokens = tokens.filter(
        (t) => !t.startsWith('qdr:') && !t.startsWith('cdr:') && !t.startsWith('cd_min:') && !t.startsWith('cd_max:') && !t.startsWith('sbd:')
      );
      if (updater.qdr) {
        tokens.push(updater.qdr);
      }
    }

    if (updater.verbatim !== undefined) {
      tokens = tokens.filter((t) => t !== 'li:1');
      if (updater.verbatim) {
        tokens.push('li:1');
      }
    }

    if (tokens.length > 0) {
      params.set('tbs', tokens.join(','));
    } else {
      params.delete('tbs');
    }

    return nextUrl.toString();
  }

  /**
   * 建構 Google 原生進階搜尋頁面網址（保留目前關鍵字與介面語言）
   *
   * @param {URL} baseUrl 目前網址
   * @returns {string} 進階搜尋網址
   */
  function buildAdvancedSearchUrl(baseUrl) {
    const advUrl = new URL('/advanced_search', baseUrl.origin);
    const q = baseUrl.searchParams.get('q');
    const hl = baseUrl.searchParams.get('hl');
    if (q) {
      advUrl.searchParams.set('q', q);
    }
    if (hl) {
      advUrl.searchParams.set('hl', hl);
    }
    return advUrl.toString();
  }

  /**
   * 正規化選單項目文字（移除多餘空白與換行）
   *
   * @param {string} text 原始文字
   * @returns {string} 清理後的單行文字
   */
  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 尋找頂部「工具（Tools）」切換按鈕
   *
   * @returns {HTMLElement | null} 工具按鈕節點
   */
  function findToolsButton() {
    const direct =
      document.querySelector('#hdtb-tls') ||
      document.querySelector('[aria-controls="hdtbMenus"]');
    if (direct instanceof HTMLElement) {
      return direct;
    }

    const candidates = document.querySelectorAll(
      '#hdtb [role="button"], #hdtb button, [role="navigation"] [role="button"], [role="navigation"] button'
    );
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) {
        continue;
      }
      const txt = normalizeText(el.textContent);
      if (txt === '工具' || txt === 'Tools' || txt === '搜尋工具' || txt === 'Search tools') {
        return el;
      }
    }
    return null;
  }

  /**
   * 依據連結網址或文字內容，推斷該選項在當前網址是否為啟用（Active）狀態
   *
   * @param {string} href 選項連結（可為空）
   * @param {string} label 選項文字
   * @param {string} groupKind 群組類型 ('language' | 'time' | 'results' | 'action')
   * @param {ReturnType<typeof getActiveFilterState>} activeState 目前網址篩選狀態
   * @param {HTMLElement} sourceEl 原生 DOM 節點
   * @returns {boolean} 是否啟用
   */
  function isDomItemActive(href, label, groupKind, activeState, sourceEl) {
    const ariaChecked = sourceEl.getAttribute('aria-checked') || sourceEl.querySelector('[aria-checked]')?.getAttribute('aria-checked');
    if (ariaChecked === 'true') {
      return true;
    }
    if (
      sourceEl.classList.contains('hdtb-msel') ||
      sourceEl.classList.contains('nvELY') ||
      sourceEl.querySelector('.hdtb-msel, .nvELY')
    ) {
      return true;
    }

    if (href) {
      try {
        const itemUrl = new URL(href, window.location.origin);
        const itemState = getActiveFilterState(itemUrl);
        if (groupKind === 'language') {
          if (itemState.lr) {
            return itemState.lr === activeState.lr;
          }
          if (itemState.cr) {
            return itemState.cr === activeState.cr;
          }
          if (!itemState.lr && !itemState.cr) {
            return !activeState.lr && !activeState.cr;
          }
        } else if (groupKind === 'time') {
          if (itemState.qdr) {
            return itemState.qdr === activeState.qdr;
          }
          if (!itemState.qdr && !itemState.cdr) {
            return !activeState.qdr && !activeState.cdr;
          }
        } else if (groupKind === 'results') {
          return itemState.verbatim === activeState.verbatim;
        }
      } catch {
        // 忽略無效相對路徑解析錯誤
      }
    }

    if (groupKind === 'time' && activeState.cdr && /自訂|Custom/i.test(label)) {
      return true;
    }
    return false;
  }

  /**
   * 辨識單一原生選單群組屬於哪一類篩選器（語言 / 時間 / 結果）
   *
   * @param {Array<{ label: string, href: string }>} items 群組內的選項清單
   * @returns {'language' | 'time' | 'results' | 'other'} 群組分類
   */
  function classifyMenuGroup(items) {
    const joinedLabels = items.map((it) => it.label).join(' ');
    const joinedHrefs = items.map((it) => it.href || '').join(' ');

    if (
      /qdr:|cdr:/.test(joinedHrefs) ||
      /不限時間|過去\s*1\s*小時|過去\s*24\s*小時|過去\s*1\s*週|過去\s*1\s*個月|過去\s*1\s*年|自訂日期|Any time|Past hour|Past 24 hours|Past week|Past month|Past year|Custom range/i.test(
        joinedLabels
      )
    ) {
      return 'time';
    }

    if (
      /li:1/.test(joinedHrefs) ||
      /所有結果|完全符合|All results|Verbatim/i.test(joinedLabels)
    ) {
      return 'results';
    }

    if (
      /[?&](lr|cr)=/.test(joinedHrefs) ||
      /不限語言|所有語言|繁體中文|中文網頁|台灣的網頁|Any language|pages/i.test(joinedLabels)
    ) {
      return 'language';
    }

    return 'other';
  }

  /**
   * 針對無 href 的原生互動節點（例如「自訂日期範圍...」）執行代理點擊（Proxy Click）
   *
   * @param {HTMLElement} targetNode 原生選單內的對應節點
   * @param {string} fallbackLabel 供重新查找節點的文字標籤
   */
  function triggerProxyClick(targetNode, fallbackLabel) {
    let liveNode = targetNode && targetNode.isConnected ? targetNode : null;

    if (!liveNode && fallbackLabel) {
      const allMenuItems = document.querySelectorAll(
        '#hdtbMenus g-menu-item, #hdtbMenus [role="menuitem"], #hdtbMenus [role="menuitemradio"], g-menu g-menu-item'
      );
      for (const candidate of allMenuItems) {
        if (candidate instanceof HTMLElement && normalizeText(candidate.textContent) === fallbackLabel) {
          liveNode = candidate;
          break;
        }
      }
    }

    const toolsBtn = findToolsButton();
    if (toolsBtn && toolsBtn.getAttribute('aria-expanded') === 'false') {
      toolsBtn.click();
    }

    if (!liveNode) {
      return;
    }

    const popup = liveNode.closest('g-popup');
    if (popup) {
      const popupTrigger = popup.querySelector('[role="button"], [aria-haspopup="true"], [aria-haspopup="menu"]');
      if (popupTrigger instanceof HTMLElement && popupTrigger.getAttribute('aria-expanded') === 'false') {
        popupTrigger.click();
      }
    }

    const clickable =
      liveNode.querySelector('[role="button"], [jsaction], a, span[tabindex]') ||
      liveNode;

    if (clickable instanceof HTMLElement) {
      clickable.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
      );
      clickable.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
      );
      clickable.click();
    }
  }

  /**
   * 嘗試從當前頁面 DOM 提取 Google 原生「工具」下拉選單群組
   *
   * @param {URL} currentUrl 目前網址
   * @param {ReturnType<typeof getActiveFilterState>} activeState 目前網址篩選狀態
   * @returns {{
   *   language: Array<{ label: string, href: string, active: boolean, proxyNode?: HTMLElement }> | null,
   *   time: Array<{ label: string, href: string, active: boolean, proxyNode?: HTMLElement }> | null,
   *   results: Array<{ label: string, href: string, active: boolean, proxyNode?: HTMLElement }> | null,
   *   clearUrl: string | null,
   *   advancedUrl: string | null
   * }} 提取到的原生群組資料
   */
  function extractNativeMenuGroups(currentUrl, activeState) {
    const extracted = {
      language: null,
      time: null,
      results: null,
      clearUrl: null,
      advancedUrl: null
    };

    const menuContainers = Array.from(
      document.querySelectorAll('#hdtbMenus g-menu, #hdtbMenus [role="menu"], g-menu[role="menu"]')
    );

    for (const menu of menuContainers) {
      if (!(menu instanceof HTMLElement) || menu.closest(`#${SIDEBAR_ID}`)) {
        continue;
      }

      const rawItems = Array.from(
        menu.querySelectorAll('g-menu-item, [role="menuitem"], [role="menuitemradio"]')
      );
      if (rawItems.length < 2) {
        continue;
      }

      const prelimItems = [];
      const seenLabels = new Set();

      for (const itemEl of rawItems) {
        if (!(itemEl instanceof HTMLElement)) {
          continue;
        }
        const label = normalizeText(itemEl.textContent);
        if (!label || seenLabels.has(label)) {
          continue;
        }
        seenLabels.add(label);

        const anchor = itemEl.tagName === 'A' ? itemEl : itemEl.querySelector('a[href]');
        const rawHref = anchor ? anchor.getAttribute('href') || '' : itemEl.getAttribute('href') || '';
        const resolvedHref =
          rawHref && !rawHref.startsWith('javascript:')
            ? new URL(rawHref, currentUrl.origin).toString()
            : '';

        prelimItems.push({
          label,
          href: resolvedHref,
          sourceEl: itemEl
        });
      }

      if (prelimItems.length < 2) {
        continue;
      }

      const kind = classifyMenuGroup(prelimItems);
      if (kind === 'other' || extracted[kind]) {
        continue;
      }

      const finalized = prelimItems.map((entry) => ({
        label: entry.label,
        href: entry.href,
        active: isDomItemActive(entry.href, entry.label, kind, activeState, entry.sourceEl),
        proxyNode: entry.href ? undefined : entry.sourceEl
      }));

      // 若同一群組內完全沒有任何項目被標記為 Active，且網址未啟用對應篩選，預設將第一項（「不限... / 所有...」）標為 Active
      if (!finalized.some((it) => it.active)) {
        const shouldMarkFirst =
          (kind === 'language' && !activeState.lr && !activeState.cr) ||
          (kind === 'time' && !activeState.qdr && !activeState.cdr) ||
          (kind === 'results' && !activeState.verbatim);
        if (shouldMarkFirst && finalized.length > 0) {
          finalized[0].active = true;
        }
      }

      extracted[kind] = finalized;
    }

    // 探測原生「清除」篩選連結
    const clearCandidates = document.querySelectorAll('#hdtbMenus a[href], #hdtb a[href]');
    for (const a of clearCandidates) {
      if (!(a instanceof HTMLAnchorElement)) {
        continue;
      }
      const txt = normalizeText(a.textContent);
      if (txt === '清除' || txt === 'Clear' || txt === '重設' || txt === 'Reset') {
        extracted.clearUrl = a.href;
        break;
      }
    }

    // 探測原生「進階搜尋」連結
    const advAnchor = document.querySelector('a[href*="/advanced_search"]');
    if (advAnchor instanceof HTMLAnchorElement && advAnchor.href) {
      extracted.advancedUrl = advAnchor.href;
    }

    return extracted;
  }

  /**
   * 若頂部「工具」選單尚未在 DOM 中生成子項目，於背景靜默點擊展開一次以誘導載入
   *
   * @param {URL} currentUrl 目前網址
   */
  function trySilentExpandNativeTools(currentUrl) {
    if (
      runtimeState.isAutoExpanding ||
      runtimeState.autoExpandAttemptedUrl === currentUrl.toString()
    ) {
      return;
    }

    const toolsBtn = findToolsButton();
    if (!toolsBtn) {
      return;
    }

    runtimeState.autoExpandAttemptedUrl = currentUrl.toString();
    runtimeState.isAutoExpanding = true;
    document.documentElement.classList.add('gs-sb-silent-probe');

    const menusEl = document.getElementById('hdtbMenus');
    const prevInert = menusEl ? Boolean(menusEl.inert) : false;
    if (menusEl) {
      menusEl.inert = true;
    }

    try {
      const wasCollapsed = toolsBtn.getAttribute('aria-expanded') !== 'true';
      if (wasCollapsed) {
        toolsBtn.click();
      }

      window.setTimeout(() => {
        const activeState = getActiveFilterState(currentUrl);
        const groups = extractNativeMenuGroups(currentUrl, activeState);
        if (groups.language || groups.time || groups.results) {
          runtimeState.cachedDomGroupsUrl = currentUrl.toString();
          runtimeState.cachedDomGroups = groups;
        }

        // 若原先為收合狀態，讀取完後將頂部「工具」列收合復原，避免畫面頂部多出一排重複選單
        if (wasCollapsed && toolsBtn.isConnected && toolsBtn.getAttribute('aria-expanded') === 'true') {
          toolsBtn.click();
        }

        if (menusEl) {
          menusEl.inert = prevInert;
        }
        document.documentElement.classList.remove('gs-sb-silent-probe');
        runtimeState.isAutoExpanding = false;
        scheduleRender();
      }, 180);
    } catch {
      if (menusEl) {
        menusEl.inert = prevInert;
      }
      document.documentElement.classList.remove('gs-sb-silent-probe');
      runtimeState.isAutoExpanding = false;
    }
  }

  /**
   * 建立 URLSearchParams 保底（Fallback）篩選群組資料
   * 當原生 DOM 因 Google A/B 測試未渲染對應選單時，確保 100% 正常顯示與運作
   *
   * @param {URL} currentUrl 目前網址
   * @param {ReturnType<typeof getActiveFilterState>} activeState 目前網址篩選狀態
   * @returns {{
   *   language: Array<{ label: string, href: string, active: boolean }>,
   *   time: Array<{ label: string, href: string, active: boolean, proxyNode?: HTMLElement }>,
   *   results: Array<{ label: string, href: string, active: boolean }>
   * }} 保底群組清單
   */
  function buildFallbackGroups(currentUrl, activeState) {
    const language = [
      {
        label: '不限語言',
        href: buildFilterUrl(currentUrl, { lr: null, cr: null }),
        active: !activeState.lr && !activeState.cr
      },
      {
        label: '繁體中文網頁',
        href: buildFilterUrl(currentUrl, { lr: 'lang_zh-TW', cr: null }),
        active: activeState.lr === 'lang_zh-TW'
      },
      {
        label: '台灣的網頁',
        href: buildFilterUrl(currentUrl, { lr: null, cr: 'countryTW' }),
        active: activeState.cr === 'countryTW'
      }
    ];

    // 若使用者當前網址含有其他自訂 lr 或 cr 參數，動態將該條件補入列表並標示為啟用
    if (activeState.lr && activeState.lr !== 'lang_zh-TW') {
      language.push({
        label: `語言 (${activeState.lr.replace(/^lang_/, '')})`,
        href: buildFilterUrl(currentUrl, { lr: activeState.lr, cr: null }),
        active: true
      });
    }
    if (activeState.cr && activeState.cr !== 'countryTW') {
      language.push({
        label: `地區 (${activeState.cr.replace(/^country/, '')})`,
        href: buildFilterUrl(currentUrl, { lr: null, cr: activeState.cr }),
        active: true
      });
    }

    const timePresets = [
      { label: '不限時間', qdr: null, match: !activeState.qdr && !activeState.cdr },
      { label: '過去 1 小時', qdr: 'qdr:h', match: activeState.qdr === 'qdr:h' },
      { label: '過去 24 小時', qdr: 'qdr:d', match: activeState.qdr === 'qdr:d' },
      { label: '過去 1 週', qdr: 'qdr:w', match: activeState.qdr === 'qdr:w' },
      { label: '過去 1 個月', qdr: 'qdr:m', match: activeState.qdr === 'qdr:m' },
      { label: '過去 1 年', qdr: 'qdr:y', match: activeState.qdr === 'qdr:y' }
    ];

    const time = timePresets.map((preset) => ({
      label: preset.label,
      href: buildFilterUrl(currentUrl, { qdr: preset.qdr }),
      active: preset.match
    }));

    if (activeState.cdr) {
      const rangeText =
        activeState.cdMin || activeState.cdMax
          ? `自訂 (${activeState.cdMin || '...'}–${activeState.cdMax || '...'})`
          : '自訂日期範圍';
      time.push({
        label: rangeText,
        href: currentUrl.toString(),
        active: true
      });
    } else {
      const nativeCustomNode = document.querySelector('#cdr_opt');
      if (nativeCustomNode instanceof HTMLElement) {
        time.push({
          label: '自訂日期範圍...',
          href: '',
          active: false,
          proxyNode: nativeCustomNode
        });
      }
    }

    const results = [
      {
        label: '所有結果',
        href: buildFilterUrl(currentUrl, { verbatim: false }),
        active: !activeState.verbatim
      },
      {
        label: '完全符合',
        href: buildFilterUrl(currentUrl, { verbatim: true }),
        active: activeState.verbatim
      }
    ];

    return { language, time, results };
  }

  /**
   * 整合原生 DOM 提取結果與 URLSearchParams 保底資料，產出最終要渲染的群組陣列
   *
   * @param {URL} currentUrl 目前網址
   * @returns {Array<Array<{ label: string, href: string, active: boolean, proxyNode?: HTMLElement }>>} 垂直群組列表
   */
  function resolveSidebarGroups(currentUrl) {
    const activeState = getActiveFilterState(currentUrl);
    let domGroups = extractNativeMenuGroups(currentUrl, activeState);

    // 若當前 DOM 未展開而有同網址快取，沿用快取；否則嘗試背景靜默展開一次
    if (!domGroups.language && !domGroups.time && !domGroups.results) {
      if (
        runtimeState.cachedDomGroupsUrl === currentUrl.toString() &&
        runtimeState.cachedDomGroups
      ) {
        domGroups = runtimeState.cachedDomGroups;
      } else {
        trySilentExpandNativeTools(currentUrl);
      }
    } else {
      runtimeState.cachedDomGroupsUrl = currentUrl.toString();
      runtimeState.cachedDomGroups = domGroups;
    }

    const fallback = buildFallbackGroups(currentUrl, activeState);

    const languageGroup = domGroups.language || fallback.language;
    const timeGroup = domGroups.time || fallback.time;
    const resultsGroup = domGroups.results || fallback.results;

    const actionGroup = [];
    if (activeState.hasAnyFilter) {
      actionGroup.push({
        label: '清除篩選',
        href: domGroups.clearUrl || buildFilterUrl(currentUrl, { clearAll: true }),
        active: false
      });
    }
    actionGroup.push({
      label: '進階搜尋',
      href: domGroups.advancedUrl || buildAdvancedSearchUrl(currentUrl),
      active: false
    });

    return [languageGroup, timeGroup, resultsGroup, actionGroup];
  }

  /**
   * 計算側邊欄對齊座標與是否具備足夠顯示空間
   *
   * @returns {{ visible: boolean, top: number }} 定位與可見度資訊
   */
  function computeSidebarPlacement() {
    const currentUrl = new URL(window.location.href);
    if (!isEligibleSearchTab(currentUrl)) {
      return { visible: false, top: 0 };
    }

    if (window.innerWidth < MIN_VIEWPORT_WIDTH) {
      return { visible: false, top: 0 };
    }

    const { topAnchor, columnAnchor } = findLayoutAnchors();
    if (!topAnchor || !columnAnchor) {
      return { visible: false, top: 0 };
    }

    const colRect = columnAnchor.getBoundingClientRect();
    if (colRect.width <= 0 || colRect.left < MIN_LEFT_GUTTER) {
      return { visible: false, top: 0 };
    }

    const topRect = topAnchor.getBoundingClientRect();
    const absoluteTop = Math.max(80, Math.round(window.scrollY + topRect.top));

    return { visible: true, top: absoluteTop };
  }

  /**
   * 渲染或更新左側「工具」側邊欄 DOM
   */
  function renderSidebar() {
    if (runtimeState.isRendering) {
      return;
    }
    runtimeState.isRendering = true;

    try {
      // 讀取階段：一次完成版面座標、深淺色主題與篩選群組讀取，避免 DOM 讀寫交錯引發強制同步重排
      const placement = computeSidebarPlacement();
      if (!placement.visible) {
        const existingSidebar = document.getElementById(SIDEBAR_ID);
        if (existingSidebar) {
          existingSidebar.hidden = true;
        }
        return;
      }

      const isDark = detectDarkMode();
      const currentUrl = new URL(window.location.href);
      const groups = resolveSidebarGroups(currentUrl);

      // 寫入階段：注入樣式表並批次更新側邊欄節點與屬性
      ensureStylesInjected();

      let sidebar = document.getElementById(SIDEBAR_ID);
      if (!sidebar) {
        sidebar = document.createElement('nav');
        sidebar.id = SIDEBAR_ID;
        sidebar.setAttribute('aria-label', 'Google 搜尋工具篩選');
        document.body.appendChild(sidebar);
      }

      sidebar.hidden = false;
      sidebar.setAttribute('data-theme', isDark ? 'dark' : 'light');
      sidebar.style.setProperty('--gs-sb-top', `${placement.top}px`);

      // 以結構簽章比對內容是否異動，避免無意義重建 DOM 節點
      const signature = JSON.stringify(
        groups.map((grp) =>
          grp.map((item) => ({
            l: item.label,
            h: item.href,
            a: item.active,
            p: Boolean(item.proxyNode)
          }))
        )
      );

      if (sidebar.getAttribute('data-signature') === signature) {
        return;
      }
      sidebar.setAttribute('data-signature', signature);

      const fragment = document.createDocumentFragment();

      for (const groupItems of groups) {
        if (!groupItems || groupItems.length === 0) {
          continue;
        }
        const ul = document.createElement('ul');
        ul.className = 'gs-sb-group';

        for (const item of groupItems) {
          const li = document.createElement('li');
          li.className = 'gs-sb-item';

          const control = item.href
            ? document.createElement('a')
            : document.createElement('button');

          control.className = 'gs-sb-link';
          control.setAttribute('data-active', item.active ? 'true' : 'false');

          if (control instanceof HTMLAnchorElement) {
            control.href = item.href;
            if (item.active) {
              control.setAttribute('aria-current', 'page');
            }
          } else if (control instanceof HTMLButtonElement) {
            control.type = 'button';
            control.setAttribute('aria-pressed', item.active ? 'true' : 'false');
            control.addEventListener('click', (event) => {
              event.preventDefault();
              triggerProxyClick(item.proxyNode || null, item.label);
            });
          }

          const checkSpan = document.createElement('span');
          checkSpan.className = 'gs-sb-check';
          checkSpan.setAttribute('aria-hidden', 'true');
          checkSpan.textContent = item.active ? '✓' : '';

          const labelSpan = document.createElement('span');
          labelSpan.className = 'gs-sb-label';
          labelSpan.textContent = item.label;

          control.appendChild(checkSpan);
          control.appendChild(labelSpan);
          li.appendChild(control);
          ul.appendChild(li);
        }

        fragment.appendChild(ul);
      }

      sidebar.replaceChildren(fragment);
    } finally {
      runtimeState.isRendering = false;
    }
  }

  /**
   * 排程節流更新（整合 Debounce 與 requestAnimationFrame，避免高頻重繪）
   */
  function scheduleRender() {
    if (runtimeState.debounceTimer) {
      window.clearTimeout(runtimeState.debounceTimer);
    }
    runtimeState.debounceTimer = window.setTimeout(() => {
      runtimeState.debounceTimer = 0;
      if (runtimeState.rafId) {
        window.cancelAnimationFrame(runtimeState.rafId);
      }
      runtimeState.rafId = window.requestAnimationFrame(() => {
        runtimeState.rafId = 0;
        renderSidebar();
      });
    }, 100);
  }

  /**
   * 啟動頁面事件與節流 MutationObserver 監聽
   */
  function initializeSidebarObserver() {
    renderSidebar();

    window.addEventListener('resize', scheduleRender, { passive: true });
    window.addEventListener('popstate', scheduleRender, { passive: true });

    if (window.matchMedia) {
      const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof darkQuery.addEventListener === 'function') {
        darkQuery.addEventListener('change', scheduleRender);
      }
    }

    const observer = new MutationObserver((mutations) => {
      if (runtimeState.isRendering || runtimeState.isAutoExpanding) {
        return;
      }

      let shouldUpdate = false;
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target instanceof HTMLElement && target.closest(`#${SIDEBAR_ID}`)) {
          continue;
        }
        shouldUpdate = true;
        break;
      }

      if (shouldUpdate) {
        scheduleRender();
      }
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-expanded', 'aria-checked']
      });
    }
  }

  initializeSidebarObserver();
})();
