const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { short, locatorCode, urlMatcher, specHeader } = require('./lib/codegen');

// 사용법: node scripts/generate-specs.js <URL> [--scope=all|single]
//   --scope=all    : 입력한 URL + 연결된 세부 페이지 모두 분석 (기본값)
//   --scope=single : 입력한 URL 한 페이지만 분석
const args = process.argv.slice(2);
const TARGET = args.find((a) => !a.startsWith('--')) || process.env.TARGET_URL;
const SCOPE = (args.find((a) => a.startsWith('--scope=')) || `--scope=${process.env.SCOPE || 'all'}`).split('=')[1];
if (!TARGET || !['all', 'single'].includes(SCOPE)) {
  console.error('사용법: node scripts/generate-specs.js <URL> [--scope=all|single]');
  process.exit(1);
}
const BASE_URL = new URL(TARGET).origin;
const START_URL = new URL(TARGET).href;
const OUTPUT_DIR = process.env.QA_OUTPUT_DIR || path.join(__dirname, '../tests/generated');
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 3);
const MAX_FEATURES_PER_PAGE = Number(process.env.MAX_FEATURES_PER_PAGE || 25);
// 헤더/내비/푸터 공통 요소 탐지 상한 (문서 사이트처럼 메뉴 링크가 수백 개인 경우 대비)
const MAX_COMMON_FEATURES = Number(process.env.MAX_COMMON_FEATURES || 20);
const CRAWL_DEPTH = Number(process.env.CRAWL_DEPTH || 1);
const MAX_PAGES = Number(process.env.MAX_PAGES || 30);
const VIEWPORT = { width: 1440, height: 900 };
// 다국어 사이트는 locale 에 따라 문구가 달라지므로 분석 환경을 생성된 테스트에도 그대로 고정
const LOCALE = process.env.LOCALE || Intl.DateTimeFormat().resolvedOptions().locale;
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const ENV = { viewport: VIEWPORT, locale: LOCALE, timezone: TIMEZONE };

// tests/support/site.ts 의 팝업 처리 로직과 동일하게 유지
const POPUP_DISMISS = /(오늘\s*하루|\d+\s*일\s*동안|다시)\s*(보지|열지)\s*않기|don'?t\s+show\s+(again|today)/i;
const POPUP_CONSENT = /^(accept|accept all|allow all|agree|모두 허용|동의|동의합니다)$/i;
const POPUP_CLOSE = /^(닫기|close|dismiss|×|✕)$/i;
const isPopupControl = (name) => [POPUP_DISMISS, POPUP_CONSENT, POPUP_CLOSE].some((re) => re.test(name));

// 실서비스에 부작용을 줄 수 있는 요소는 클릭 탐지 대상에서 제외
const RISKY = /(삭제|탈퇴|로그아웃|송금|출금하기|결제하기|구매하기|logout|delete|withdraw)/i;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[aria-expanded]',
  'details > summary',
  'input:not([type="hidden"])',
  'textarea',
  'select',
].join(', ');

// Cloudflare 등 봇 차단/보안 확인 페이지
const BOT_CHECK = /just a moment|attention required|verify you are human|checking your browser|잠시만 기다리십시오|보안 확인 수행 중|사람인지 확인/i;

// 모달/시트 안의 닫기 컨트롤
const DIALOG_CLOSE = /^(닫기|close|취소|cancel|확인|×|✕|x)$/i;

// 화면 구조로 판별하는 페이지 유형 (URL 규칙은 사이트마다 달라 쓰지 않는다)
const PAGE_TYPE_LABEL = { form: '입력폼형', list: '목록형', document: '문서형', general: '일반형', blocked: '접속 차단' };

// ─────────────────────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────────────────────

async function dismissPopups(page) {
  for (let i = 0; i < 4; i++) {
    let target = null;
    for (const name of [POPUP_DISMISS, POPUP_CONSENT, POPUP_CLOSE]) {
      const btn = page.getByRole('button', { name }).first();
      if (await btn.isVisible()) {
        target = btn;
        break;
      }
    }
    if (!target) return;
    await target.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function openForAnalysis(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  if (!page.context().__popupSeen) {
    // 컨텍스트 최초 진입 시에만 팝업이 늦게 뜨는 것을 기다림 (이후엔 '보지 않기' 상태가 유지됨)
    const first = page.getByRole('button', { name: POPUP_DISMISS }).first();
    await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    page.context().__popupSeen = true;
  }
  await dismissPopups(page);
  return response;
}

async function scrollThrough(page) {
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

const stripHash = (u) => u.split('#')[0];

function isAssertableText(t) {
  return t.length >= 2 && t.length <= 60 && !/^[\d\s.,:%+\-$₩]+$/.test(t);
}

async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// ─────────────────────────────────────────────────────────────
// 1단계: 시작 URL에서 내부 경로 발굴 (BFS)
// ─────────────────────────────────────────────────────────────

/**
 * 경로를 템플릿으로 정규화: /notice/123, /post/019fcaf8-... 처럼 ID만 다른 상세 페이지는
 * 같은 화면이므로 하나만 분석한다.
 */
function templateOf(pathname) {
  return pathname
    .split('/')
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{24,}$/i.test(seg) ? ':id' : seg
    )
    .join('/');
}

async function extractInternalPaths(page) {
  const rawHrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter(Boolean)
  );
  const paths = [];
  for (const raw of rawHrefs) {
    const trimmed = raw.trim();
    if (/^(mailto:|tel:|#|javascript:)/.test(trimmed)) continue;
    try {
      const parsed = new URL(trimmed, page.url());
      // 같은 origin만 페이지 분석 대상. 외부/서브도메인 링크는 링크 기능 테스트로만 검증
      if (parsed.origin === BASE_URL) paths.push(parsed.pathname + parsed.search);
    } catch {
      // 파싱 실패 링크 무시
    }
  }
  return paths;
}

async function discoverPaths(page) {
  const startPath = new URL(START_URL).pathname + new URL(START_URL).search;
  const seenTemplates = new Set([templateOf(new URL(START_URL).pathname)]);
  const result = [startPath];
  let frontier = [startPath];

  for (let depth = 0; depth < CRAWL_DEPTH && frontier.length && result.length < MAX_PAGES; depth++) {
    const nextFrontier = [];
    for (const p of frontier) {
      try {
        await openForAnalysis(page, `${BASE_URL}${p}`);
        await scrollThrough(page);
      } catch {
        continue;
      }
      for (const found of await extractInternalPaths(page)) {
        const template = templateOf(found.split('?')[0]) + (found.includes('?') ? '?' + found.split('?')[1] : '');
        if (seenTemplates.has(template) || result.length >= MAX_PAGES) continue;
        seenTemplates.add(template);
        result.push(found);
        nextFrontier.push(found);
      }
    }
    frontier = nextFrontier;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// 2단계: 페이지별 기능 분석
// ─────────────────────────────────────────────────────────────

/** 화면의 텍스트 라인 + 고정 레이어(모달/바텀시트 후보) 스냅샷 */
async function pageState(page) {
  return page.evaluate(() => {
    const lines = document.body.innerText
      .split('\n')
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter(Boolean);

    const overlays = [];
    const minArea = window.innerWidth * window.innerHeight * 0.1;
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      const isDialog = el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
      if ((s.position !== 'fixed' && !isDialog) || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (!isDialog && r.width * r.height < minArea) continue;
      const text = el.innerText.trim();
      if (!text) continue;
      overlays.push({
        key: text.slice(0, 80),
        lines: text.split('\n').map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean),
      });
    }
    return { url: location.href, lines, overlays };
  });
}

/** 요소마다 data-qa-idx 를 부여하고 기본 속성 수집 */
async function collectCandidates(page) {
  return page.evaluate((selector) => {
    const all = Array.from(document.querySelectorAll(selector));
    const out = [];
    all.forEach((el, idx) => {
      // 중첩된 인터랙티브 요소는 바깥 요소 하나만 사용
      if (el.parentElement && el.parentElement.closest(selector)) return;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') return;
      if (el.disabled) return;

      el.setAttribute('data-qa-idx', String(idx));
      const zone = el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]');
      const tag = el.tagName.toLowerCase();
      const href = el.getAttribute('href');
      const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');

      // 같은 페이지 내 앵커(목차 등): 이동 대상이 실제로 있어야 의미가 있다
      let anchorId = null;
      if (tag === 'a' && href && href.length > 1 && href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        if (document.getElementById(id)) anchorId = id;
      }

      // 입력 요소: 라벨/placeholder(셀렉터용), 같은 폼의 제출 버튼(활성화 검증용), select 의 선택 가능한 값
      let label = '';
      let placeholder = '';
      let formButton = '';
      let option = '';
      if (['input', 'textarea', 'select'].includes(tag)) {
        label = clean(el.labels && el.labels[0] ? el.labels[0].innerText : '');
        placeholder = clean(el.getAttribute('placeholder'));
        const form = el.closest('form');
        const btn = form && (form.querySelector('button[type="submit"], input[type="submit"]') || form.querySelector('button'));
        if (btn) formButton = clean(btn.innerText || btn.value);
        if (tag === 'select') {
          const opt = Array.from(el.options).find((o) => o.value && !o.disabled && !o.selected);
          if (opt) option = opt.value;
        }
      }

      out.push({
        idx,
        tag,
        type: el.getAttribute('type') || '',
        href,
        target: el.getAttribute('target'),
        zone: zone ? 'common' : 'main',
        anchorId,
        label,
        placeholder,
        formButton,
        option,
      });
    });
    return out;
  }, INTERACTIVE_SELECTOR);
}

/** ariaSnapshot 으로 role/접근성 이름을 얻어 테스트에서 그대로 쓸 수 있는 로케이터를 만든다 */
async function resolveLocator(page, cand) {
  const el = page.locator(`[data-qa-idx="${cand.idx}"]`);
  const snap = await el.ariaSnapshot({ timeout: 2000 }).catch(() => null);
  const m = snap && snap.split('\n')[0].match(/^- ([a-z]+)(?: (".*?"))?(?:\s*\[.*\])?:?$/);
  const role = m ? m[1] : null;
  let name = '';
  if (m && m[2]) {
    try {
      name = JSON.parse(m[2]);
    } catch {
      name = m[2].slice(1, -1);
    }
  }

  const tryLocator = async (spec) => {
    const ids = await buildLocator(page, spec)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-qa-idx')))
      .catch(() => []);
    const nth = ids.indexOf(String(cand.idx));
    return nth >= 0 ? { ...spec, nth } : null;
  };

  // Playwright 권장 우선순위: role+name → label → placeholder → (링크 href) → 고유 속성
  if (role && name) {
    const spec = await tryLocator({ kind: 'role', role, name });
    if (spec) return spec;
  }
  if (cand.label) {
    const spec = await tryLocator({ kind: 'label', role: role || 'textbox', name: cand.label });
    if (spec) return spec;
  }
  if (cand.placeholder) {
    const spec = await tryLocator({ kind: 'placeholder', role: role || 'textbox', name: cand.placeholder });
    if (spec) return spec;
  }
  if (cand.href) {
    const spec = await tryLocator({ kind: 'css', selector: `a[href=${JSON.stringify(cand.href)}]`, role: role || 'link', name });
    if (spec) return spec;
  }

  // 이름 없는 아이콘 버튼 등: 페이지 내에서 유일한 속성으로 식별 (테스트 ID 우선)
  const attrSelector = await el
    .evaluate((node) => {
      const priority = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'id', 'name', 'aria-controls'];
      const attrs = Array.from(node.attributes)
        .map((a) => a.name)
        .filter((n) => n !== 'data-qa-idx' && n !== 'class' && n !== 'style' && (priority.includes(n) || n.startsWith('data-')))
        .sort((a, b) => (priority.indexOf(a) + 1 || 99) - (priority.indexOf(b) + 1 || 99));
      for (const attr of attrs) {
        const value = node.getAttribute(attr);
        // click/true/button 같은 범용 값은 다른 요소에 쉽게 생기므로 식별자로 쓰지 않는다
        if (!value || /^(true|false|click|button|link|on|off|0|1)$/i.test(value)) continue;
        const selector = `${node.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      return null;
    })
    .catch(() => null);
  if (attrSelector) {
    const spec = await tryLocator({ kind: 'css', selector: attrSelector, role: role || cand.tag, name });
    if (spec) return spec;
  }
  return null;
}

function buildLocator(page, spec) {
  const base = {
    role: () => page.getByRole(spec.role, { name: spec.name, exact: true }),
    label: () => page.getByLabel(spec.name, { exact: true }),
    placeholder: () => page.getByPlaceholder(spec.name, { exact: true }),
    css: () => page.locator(spec.selector),
  }[spec.kind]();
  return spec.nth === undefined ? base : base.nth(spec.nth);
}

/** 요소를 실제로 클릭해보고 어떤 동작이 일어나는지 관찰 */
async function probe(page, spec, noisy) {
  const loc = buildLocator(page, spec);
  const before = await pageState(page);
  const expandedBefore = await loc.getAttribute('aria-expanded', { timeout: 1000 }).catch(() => null);

  let popup = null;
  const onPopup = (p) => (popup = p);
  page.on('popup', onPopup);
  try {
    await loc.click({ timeout: 5000 });
  } catch (e) {
    page.off('popup', onPopup);
    return { type: 'unclickable', reason: e.message.split('\n')[0], dirty: true };
  }
  await page.waitForTimeout(1500);
  page.off('popup', onPopup);

  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    return { type: 'newTab', url, dirty: false };
  }

  if (stripHash(page.url()) !== stripHash(before.url)) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    // 브라우저 오류 페이지(연결 실패/차단)로 이동하면 깨진 링크로 기록
    if (/^chrome-error:/.test(page.url())) return { type: 'brokenLink', dirty: true };
    // 직접 연 페이지에서 '뒤로가기' 등은 about:blank 로 간다 → 테스트로 재현할 의미가 없음
    if (!/^https?:/.test(page.url())) return { type: 'none', dirty: true };
    return { type: 'navigate', url: page.url(), dirty: true };
  }

  const after = await pageState(page);
  const beforeLines = new Set(before.lines);
  const fresh = (t) => !beforeLines.has(t) && !noisy.has(t) && isAssertableText(t);

  const beforeKeys = new Set(before.overlays.map((o) => o.key));
  const newOverlay = after.overlays.find((o) => !beforeKeys.has(o.key));
  if (newOverlay) {
    const text = newOverlay.lines.find(fresh) || newOverlay.lines.find(isAssertableText);
    if (text) return { type: 'modal', text, ...(await probeDialogClose(page, text)), dirty: true };
  }

  if (spec.role === 'tab') {
    const selected = await loc.getAttribute('aria-selected', { timeout: 1000 }).catch(() => null);
    if (selected === 'true') return { type: 'tab', dirty: true };
  }

  if (expandedBefore !== null) {
    const expandedAfter = await loc.getAttribute('aria-expanded', { timeout: 1000 }).catch(() => null);
    if (expandedAfter !== null && expandedAfter !== expandedBefore) {
      // 한 번 더 눌러 원래 상태로 돌아오는지까지 확인 (아코디언/드롭다운)
      await loc.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
      const restored = await loc.getAttribute('aria-expanded', { timeout: 1000 }).catch(() => null);
      return { type: 'toggle', expanded: expandedAfter, collapsed: restored === expandedBefore ? expandedBefore : null, dirty: true };
    }
  }

  const revealed = after.lines.find(fresh);
  if (revealed) return { type: 'reveal', text: revealed, dirty: true };

  return { type: 'none', dirty: before.lines.length !== after.lines.length };
}

/**
 * 모달/시트가 뜬 상태에서 닫기 방법을 찾는다: 닫기 버튼 → ESC 순서.
 * 반환: { closeName } | { closeKey: 'Escape' } | {}
 */
async function probeDialogClose(page, text) {
  const isGone = async () => {
    await page.waitForTimeout(700);
    return (await page.getByText(text).filter({ visible: true }).count()) === 0;
  };

  const closeBtn = page.getByRole('button', { name: DIALOG_CLOSE }).filter({ visible: true }).last();
  if ((await closeBtn.count()) > 0) {
    const snap = await closeBtn.ariaSnapshot({ timeout: 1000 }).catch(() => '');
    const m = snap.split('\n')[0].match(/^- button "(.*?)"/);
    const name = m ? m[1] : null;
    if (name && (await closeBtn.click({ timeout: 2000 }).then(() => true).catch(() => false)) && (await isGone())) {
      return { closeName: name };
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  if (await isGone()) return { closeKey: 'Escape' };
  return {};
}

/** 텍스트가 테스트에서 실제로 찾아지는지 확인 (생성 후 깨지는 단언 방지) */
async function isFindableText(page, text) {
  return (await page.getByText(text, { exact: true }).filter({ visible: true }).count().catch(() => 0)) > 0;
}

async function analyzePage(context, pagePath, { commonSignatures, collectCommon }) {
  const url = `${BASE_URL}${pagePath}`;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const result = { path: pagePath, url, title: '', status: 0, keyTexts: [], tables: [], pageType: 'general', features: [], common: [], skipped: [], errors };

  try {
    const response = await openForAnalysis(page, url);
    result.status = response ? response.status() : 0;
    result.title = await page.title();

    // 접속 차단(봇 차단/오류 응답)이면 화면 요소로 테스트를 만들지 않는다 → 상태 코드 검증만 남겨 결과에 드러나게 함
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    if (result.status >= 400 || BOT_CHECK.test(`${result.title}\n${bodyText}`)) {
      result.blocked = result.status >= 400 ? `HTTP ${result.status}` : '봇 차단/보안 확인 페이지';
      result.pageType = 'blocked';
      console.warn(`   [접속 차단] ${url} - ${result.blocked}. 이 페이지는 기능 분석을 건너뜁니다.`);
      return result;
    }

    await scrollThrough(page);

    // AI 분석용 전체 화면 캡처 (너무 긴 페이지는 위쪽 6000px 까지)
    const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEWPORT.height);
    result.shot = await page
      .screenshot({ type: 'jpeg', quality: 60, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(height, 6000) } })
      .catch(() => null);

    // 동적으로 바뀌는 텍스트(카운트다운, 시세 등)는 단언 대상에서 제외
    const s1 = await pageState(page);
    await page.waitForTimeout(1500);
    const s2 = await pageState(page);
    const s1Lines = new Set(s1.lines);
    const s2Lines = new Set(s2.lines);
    const noisy = new Set([...s1.lines.filter((t) => !s2Lines.has(t)), ...s2.lines.filter((t) => !s1Lines.has(t))]);

    // 표/그리드 구조: 컬럼 헤더 수와 데이터 행 존재 여부 (최대 3개)
    const tables = page.getByRole('table');
    const tableCount = Math.min(await tables.count(), 3);
    for (let i = 0; i < tableCount; i++) {
      const t = tables.nth(i);
      if (!(await t.isVisible())) continue;
      const columns = await t.getByRole('columnheader').count();
      const rows = await t.getByRole('row').count();
      if (rows > 0) result.tables.push({ nth: i, columns, rows });
    }

    // 화면 구조로 페이지 유형 판별 (URL 규칙이 아니라 실제 구성 요소 기준)
    const signals = await page.evaluate(() => {
      const visible = (el) => el.getBoundingClientRect().width > 0;
      const count = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible).length;
      return {
        inputs: count('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select'),
        toggles: count('[aria-expanded], details'),
        anchors: Array.from(document.querySelectorAll('a[href^="#"]')).filter((a) => a.getAttribute('href').length > 1).length,
        headings: count('h1, h2, h3'),
        textLength: (document.querySelector('main') || document.body).innerText.length,
      };
    });
    result.pageType =
      signals.inputs >= 2 ? 'form'
        : result.tables.length || signals.toggles >= 3 ? 'list'
        : signals.textLength > 3000 && (signals.headings >= 3 || signals.anchors >= 3) ? 'document'
        : 'general';

    // 핵심 콘텐츠: 헤딩 우선, 없으면 본문 단락
    const textCandidates = await page.evaluate(() => {
      const pick = (sel) =>
        Array.from(document.querySelectorAll(sel))
          .filter((el) => !el.closest('header, nav, footer'))
          .map((el) => el.innerText.trim().replace(/\s+/g, ' '))
          .filter(Boolean);
      const headings = pick('h1, h2, h3, h4, [role="heading"]');
      return headings.length ? headings : pick('p, strong');
    });
    for (const t of textCandidates) {
      if (result.keyTexts.length >= 5) break;
      if (!isAssertableText(t) || noisy.has(t) || result.keyTexts.includes(t)) continue;
      if (await isFindableText(page, t)) result.keyTexts.push(t);
    }

    // 인터랙티브 요소 수집 및 로케이터 확정 (프로브 전에 모두 확정해야 reload 후에도 재사용 가능)
    const candidates = await collectCandidates(page);
    const resolved = [];
    for (const cand of candidates) {
      const spec = await resolveLocator(page, cand);
      if (!spec) {
        result.skipped.push({ reason: '식별 불가 (접근성 이름·고유 속성 없음)', tag: cand.tag, href: cand.href });
        continue;
      }
      if (isPopupControl(spec.name)) continue;
      if (RISKY.test(spec.name) || cand.type === 'submit') {
        result.skipped.push({ reason: '부작용 위험 요소', name: spec.name });
        continue;
      }
      const signature = `${spec.role}|${spec.name}|${cand.href || ''}`;
      const isCommon = cand.zone === 'common';
      if (isCommon && !collectCommon) continue;
      if (!isCommon && commonSignatures.has(signature)) continue;
      resolved.push({ cand, spec, signature, bucket: isCommon ? 'common' : 'features' });
    }

    // 페이지당 탐지 개수 제한이 있으므로 상호작용 컴포넌트(버튼/토글/탭)를 링크보다 먼저 탐지한다
    const priority = ({ cand, spec }) => (cand.tag === 'a' || spec.role === 'link' ? 1 : 0);
    resolved.sort((a, b) => priority(a) - priority(b));

    const probedBy = { features: 0, common: 0 };
    for (const { cand, spec, signature, bucket } of resolved) {
      const label = spec.name || cand.href || spec.selector || spec.role;
      const base = { label, signature, locator: spec, href: cand.href };

      // 클릭 없이 구조만으로 판별되는 패턴
      if (cand.anchorId) {
        // 목차 앵커는 페이지당 10개까지만 (문서 사이트는 수십 개라 테스트가 과도하게 늘어남)
        if (result[bucket].filter((x) => x.type === 'anchor').length < 10) {
          result[bucket].push({ ...base, type: 'anchor', anchorId: cand.anchorId });
        }
        continue;
      }
      if (cand.tag === 'select') {
        if (cand.option) result[bucket].push({ ...base, type: 'select', value: cand.option });
        continue;
      }
      if (['textbox', 'searchbox', 'spinbutton'].includes(spec.role) || cand.tag === 'textarea') {
        result[bucket].push({ ...base, type: 'input', inputType: cand.type || 'text', formButton: cand.formButton });
        continue;
      }
      if (['checkbox', 'radio', 'switch'].includes(spec.role)) {
        result[bucket].push({ ...base, type: 'check' });
        continue;
      }
      const limit = bucket === 'features' ? MAX_FEATURES_PER_PAGE : MAX_COMMON_FEATURES;
      if (probedBy[bucket] >= limit) {
        result.skipped.push({ reason: `${bucket === 'features' ? '페이지' : '공통 영역'}당 최대 ${limit}개 초과`, name: label });
        continue;
      }
      probedBy[bucket]++;

      const effect = await probe(page, spec, noisy);
      if (effect.type === 'unclickable') {
        result.skipped.push({ reason: `클릭 불가: ${effect.reason}`, name: label });
      } else {
        result[bucket].push({ ...base, ...effect });
      }

      if (effect.dirty) {
        await openForAnalysis(page, url).catch(() => {});
      }
    }
  } catch (e) {
    result.skipped.push({ reason: `페이지 분석 실패: ${e.message.split('\n')[0]}` });
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// 3단계: 분석 결과 → spec.ts 생성
// ─────────────────────────────────────────────────────────────

const TYPE_LABEL = {
  navigate: '페이지 이동',
  newTab: '새 탭 열기',
  modal: '모달/시트 노출',
  toggle: '펼침/접힘',
  tab: '탭 전환',
  reveal: '콘텐츠 노출',
  input: '입력 필드',
  check: '선택 컨트롤',
  none: '클릭 안정성',
  brokenLink: '깨진 링크',
  select: '선택 박스',
  anchor: '목차/앵커 이동',
};

const SAMPLE_INPUT = { email: 'qa@example.com', number: '123', tel: '01012345678', url: 'https://example.com' };

function featureTest(f, id) {
  const title = `${id} [${TYPE_LABEL[f.type]}] ${JSON.stringify(short(f.label)).slice(1, -1)}`;
  const loc = locatorCode(f.locator);
  // 줄바꿈(<br>)으로 나뉜 문구의 한 줄일 수 있으므로 부분 일치로 찾는다
  const textLoc = (t) => `page.getByText(${JSON.stringify(t)}).filter({ visible: true }).first()`;
  const body = [];

  switch (f.type) {
    case 'navigate': {
      const u = new URL(f.url);
      // 외부 사이트는 지역/언어별 리다이렉트로 경로가 바뀌므로 도메인까지만 비교
      const external = u.origin !== BASE_URL;
      body.push(`await target.click();`);
      body.push(`await expect(page).toHaveURL(${urlMatcher(f.url, external)});`);
      return { title: `${title} → ${external ? u.host : u.pathname}`, body };
    }
    case 'brokenLink':
      // 분석 시 연결에 실패한 링크: 정상 페이지로 열리는지 검증 (지금 상태면 실패로 보고됨)
      body.push(`await target.click();`);
      body.push(`await page.waitForLoadState('domcontentloaded');`);
      body.push(`expect(page.url(), '링크 이동 시 브라우저 오류 페이지가 열립니다 (연결 실패 또는 차단).').not.toMatch(/^chrome-error:/);`);
      return { title: `${title} → 연결 실패 링크`, body };
    case 'newTab': {
      const host = new URL(f.url).host;
      body.push(`const popupPromise = page.waitForEvent('popup');`);
      body.push(`await target.click();`);
      body.push(`const popup = await popupPromise;`);
      body.push(`await expect(popup).toHaveURL(${urlMatcher(f.url, true)});`);
      body.push(`await popup.close();`);
      return { title: `${title} → ${host}`, body };
    }
    case 'modal':
    case 'reveal':
      body.push(`await target.click();`);
      body.push(`await expect(${textLoc(f.text)}).toBeVisible();`);
      // 모달: 분석 때 확인된 닫기 방법으로 닫히는지까지 검증
      if (f.closeName) {
        body.push(`await page.getByRole('button', { name: ${JSON.stringify(f.closeName)}, exact: true }).filter({ visible: true }).last().click();`);
        body.push(`await expect(${textLoc(f.text)}).toBeHidden();`);
      } else if (f.closeKey) {
        body.push(`await page.keyboard.press(${JSON.stringify(f.closeKey)});`);
        body.push(`await expect(${textLoc(f.text)}).toBeHidden();`);
      }
      return {
        title: `${title} → "${JSON.stringify(short(f.text, 20)).slice(1, -1)}"${f.closeName || f.closeKey ? ' 노출 후 닫힘' : ''}`,
        body,
      };
    case 'toggle':
      body.push(`await target.click();`);
      body.push(`await expect(target).toHaveAttribute('aria-expanded', ${JSON.stringify(f.expanded)});`);
      if (f.collapsed !== null && f.collapsed !== undefined) {
        body.push(`await target.click();`);
        body.push(`await expect(target).toHaveAttribute('aria-expanded', ${JSON.stringify(f.collapsed)});`);
      }
      return { title: `${title}${f.collapsed ? ' (펼침 → 접힘)' : ''}`, body };
    case 'select':
      body.push(`await target.selectOption(${JSON.stringify(f.value)});`);
      body.push(`await expect(target).toHaveValue(${JSON.stringify(f.value)});`);
      return { title, body };
    case 'anchor':
      body.push(`await target.click();`);
      body.push(`await expect(page.locator(${JSON.stringify(`[id="${f.anchorId}"]`)})).toBeInViewport();`);
      return { title: `${title} → #${f.anchorId}`, body };
    case 'tab':
      body.push(`await target.click();`);
      body.push(`await expect(target).toHaveAttribute('aria-selected', 'true');`);
      return { title, body };
    case 'input': {
      const value = SAMPLE_INPUT[f.inputType] || 'qa-test';
      body.push(`await target.fill(${JSON.stringify(value)});`);
      body.push(`await expect(target).toHaveValue(${JSON.stringify(value)});`);
      // 같은 폼의 제출 버튼이 입력 후 활성화되는지 (실제 제출은 하지 않음)
      if (f.formButton) body.push(`await expect(page.getByRole('button', { name: ${JSON.stringify(f.formButton)}, exact: true }).first()).toBeEnabled();`);
      return { title, body };
    }
    case 'check':
      body.push(`await target.check();`);
      body.push(`await expect(target).toBeChecked();`);
      return { title, body };
    default:
      body.push(`await expect(target).toBeEnabled();`);
      body.push(`await target.click();`);
      body.push(`await page.waitForTimeout(800);`);
      body.push(`expect(errors, '클릭 후 JS 런타임 오류').toEqual([]);`);
      return { title, body };
  }
}

function specSource({ describeTitle, url, page, features, includeContent }) {
  const out = specHeader({ describeTitle, env: ENV, supportPath: '../support/site', generator: 'scripts/generate-specs.js' });
  out.push(``);
  out.push(`  const TARGET_URL = ${JSON.stringify(url)};`);

  if (includeContent) {
    out.push(``);
    out.push(`  test('C-01 [콘텐츠] 페이지 로드 및 핵심 콘텐츠 노출', async ({ page }) => {`);
    out.push(`    const { response, errors } = await openPage(page, TARGET_URL);`);
    out.push(``);
    out.push(`    await test.step('HTTP 응답 정상', async () => {`);
    out.push(`      expect(response?.status() ?? 0).toBeLessThan(400);`);
    out.push(`    });`);
    if (page.blocked) {
      // 분석 시 접속이 차단된 페이지: 차단이 풀렸는지만 확인하고 나머지는 생략
      out.push(``);
      out.push(`    await test.step('봇 차단/보안 확인 페이지가 아님', async () => {`);
      out.push(`      await expect(page.getByText(${BOT_CHECK.toString()}).first(), ${JSON.stringify(`분석 시 접속 차단됨 (${page.blocked}). 사이트가 자동화 접근을 막고 있습니다.`)}).toHaveCount(0);`);
      out.push(`    });`);
      out.push(`  });`);
      return [...out, `});`, ``].join('\n');
    }
    for (const t of page.keyTexts) {
      out.push(``);
      out.push(`    await test.step(${JSON.stringify(`핵심 텍스트 노출: ${short(t)}`)}, async () => {`);
      out.push(`      await expect(page.getByText(${JSON.stringify(t)}, { exact: true }).filter({ visible: true }).first()).toBeVisible();`);
      out.push(`    });`);
    }
    out.push(``);
    for (const t of page.tables || []) {
      out.push(``);
      out.push(`    await test.step(${JSON.stringify(`표 구조: ${t.nth + 1}번째 표 (컬럼 ${t.columns}개, 데이터 행 있음)`)}, async () => {`);
      out.push(`      const table = page.getByRole('table').nth(${t.nth});`);
      if (t.columns) out.push(`      await expect(table.getByRole('columnheader')).toHaveCount(${t.columns});`);
      out.push(`      expect(await table.getByRole('row').count()).toBeGreaterThan(${t.columns ? 1 : 0});`);
      out.push(`    });`);
    }
    out.push(``);
    out.push(`    await test.step('이미지 정상 로드', async () => {`);
    out.push(`      await expectNoBrokenImages(page);`);
    out.push(`    });`);
    out.push(``);
    out.push(`    await test.step('JS 런타임 오류 없음', async () => {`);
    out.push(`      expect.soft(errors).toEqual([]);`);
    out.push(`    });`);
    out.push(`  });`);
  }

  features.forEach((f, i) => {
    const { title, body } = featureTest(f, `F-${String(i + 1).padStart(2, '0')}`);
    const usesErrors = body.some((l) => l.includes('errors'));
    out.push(``);
    out.push(`  test(${JSON.stringify(title)}, async ({ page }) => {`);
    out.push(`    const { ${usesErrors ? 'errors' : 'response: _'} } = await openPage(page, TARGET_URL);`);
    out.push(`    const target = ${locatorCode(f.locator)};`);
    body.forEach((l) => out.push(`    ${l}`));
    out.push(`  });`);
  });

  out.push(`});`);
  out.push(``);
  return out.join('\n');
}

function slugOf(pagePath) {
  if (pagePath === '/') return 'home';
  const slug = pagePath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 40 ? slug.substring(0, 40) : slug;
}

// ─────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────

(async () => {
  const startedAt = Date.now();
  if (fs.existsSync(OUTPUT_DIR)) {
    console.log(`[0/4] 이전 생성 파일 정리 중: ${OUTPUT_DIR}`);
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  let targetPaths;
  if (SCOPE === 'single') {
    console.log(`[1/4] 단일 페이지 모드: ${START_URL}`);
    targetPaths = [new URL(START_URL).pathname + new URL(START_URL).search];
  } else {
    console.log(`[1/4] 자율 크롤러 시작: ${START_URL} 진입...`);
    const discoveryPage = await context.newPage();
    targetPaths = await discoverPaths(discoveryPage);
    await discoveryPage.close();
  }
  console.log(`  -> 분석 대상 경로 총 ${targetPaths.length}개:`);
  targetPaths.forEach((p, idx) => console.log(`   ${String(idx).padStart(2, '0')}. ${p}`));

  // 시작 페이지를 먼저 분석해서 헤더/내비/푸터 공통 기능을 확정 → 다른 페이지에서는 중복 제외
  console.log(`\n[2/4] 시작 페이지 + 공통 레이아웃(헤더/내비/푸터) 기능 분석 중...`);
  const [startPath, ...subPaths] = targetPaths;
  const home = await analyzePage(context, startPath, { commonSignatures: new Set(), collectCommon: true });
  const commonSignatures = new Set([...home.common, ...home.features].map((f) => f.signature));
  console.log(`  -> 시작 페이지 기능 ${home.features.length}개, 공통 기능 ${home.common.length}개`);

  console.log(`\n[3/4] 서브페이지 ${subPaths.length}개 기능 분석 중 (동시 ${CONCURRENCY}개)...`);
  const subs = await runPool(subPaths, CONCURRENCY, async (p) => {
    const r = await analyzePage(context, p, { commonSignatures, collectCommon: false });
    console.log(`  -> ${p}: 기능 ${r.features.length}개 탐지${r.skipped.length ? `, 제외 ${r.skipped.length}개` : ''}`);
    return r;
  });
  await browser.close();

  console.log(`\n[4/4] 기능별 테스트 코드 작성...`);
  const files = [];
  const write = (name, src) => {
    fs.writeFileSync(path.join(OUTPUT_DIR, name), src, 'utf-8');
    files.push(name);
    console.log(`  -> [생성 완료] tests/generated/${name}`);
  };

  if (home.common.length) {
    write(
      '00-common-layout.spec.ts',
      specSource({ describeTitle: '[공통 레이아웃] 헤더 · 내비게이션 · 푸터', url: home.url, page: home, features: home.common, includeContent: false })
    );
  }
  [home, ...subs].forEach((r, i) => {
    write(
      `${String(i + 1).padStart(2, '0')}-${slugOf(r.path)}.spec.ts`,
      specSource({ describeTitle: `[페이지 · ${PAGE_TYPE_LABEL[r.pageType]}] ${r.path}${r.title ? ` - ${r.title}` : ''}`, url: r.url, page: r, features: r.features, includeContent: true })
    );
  });

  // 분석 결과 원본 저장 (기획서 매핑에서도 사용)
  // 기능 ID 는 생성된 테스트 번호와 동일: P01-F03 = 01번 spec 의 F-03, P00 = 공통 레이아웃
  const pid = (i) => `P${String(i).padStart(2, '0')}`;
  const withId = (prefix, list) => list.map(({ signature, ...f }, i) => ({ id: `${prefix}-F${String(i + 1).padStart(2, '0')}`, ...f }));
  fs.mkdirSync(path.join(OUTPUT_DIR, 'screens'), { recursive: true });
  const pages = [home, ...subs].map(({ path: p, url, title, status, blocked, keyTexts, tables, pageType, features, skipped, errors, shot }, i) => {
    const screenshot = shot ? `screens/${pid(i + 1)}.jpg` : null;
    if (shot) fs.writeFileSync(path.join(OUTPUT_DIR, screenshot), shot);
    return {
      id: pid(i + 1),
      path: p,
      url,
      title,
      status,
      keyTexts,
      blocked: blocked || null,
      pageType,
      tables,
      screenshot,
      features: withId(pid(i + 1), features),
      skipped,
      errors,
    };
  });
  const analysis = {
    meta: { baseUrl: BASE_URL, startUrl: START_URL, scope: SCOPE, ...ENV, generatedAt: new Date().toISOString() },
    common: { id: pid(0), url: home.url, features: withId(pid(0), home.common) },
    pages,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf-8');

  // 요약
  const summary = {};
  for (const r of [home, ...subs]) for (const f of [...r.features, ...r.common]) summary[f.type] = (summary[f.type] || 0) + 1;
  console.log(`\n==================================================`);
  console.log(`분석 완료: 페이지 ${pages.length}개, spec ${files.length}개 (${Math.round((Date.now() - startedAt) / 1000)}초)`);
  Object.entries(summary).forEach(([type, n]) => console.log(`  ${TYPE_LABEL[type].padEnd(10)} ${n}건`));
  console.log(`상세 분석 결과: tests/generated/analysis.json`);
  console.log(`==================================================`);
})();
