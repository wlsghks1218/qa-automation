const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { short, locatorCode, urlMatcher, specHeader } = require('./lib/codegen');
const { findTypos } = require('./lib/typo');
const { buildCasesHtml } = require('../app/cases-report');

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
// 클릭 요소 밖의 일반 문구 수집 상한 (약관처럼 문단이 수백 개인 페이지 대비)
const MAX_TEXTS_PER_PAGE = Number(process.env.MAX_TEXTS_PER_PAGE || 200);
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
    // 화면 순서용 좌표: 화면에 고정된 상단 바는 맨 앞, 하단 탭 메뉴는 맨 뒤로 보낸다
    const posOf = (el) => {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + scrollX);
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).position === 'fixed') return { y: r.top < innerHeight / 2 ? Math.round(r.top) : 1e7 + Math.round(r.top), x };
      }
      return { y: Math.round(r.top + scrollY), x };
    };
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
        // 화면 위→아래 순서 정렬용 (문서 기준 좌표)
        pos: posOf(el),
        area: Math.round(r.width * r.height),
        lines: tag === 'input' || tag === 'textarea' || tag === 'select' ? [] : (el.innerText || '').split('\n').map(clean).filter(Boolean).slice(0, 6),
        hasImg: tag === 'img' || !!el.querySelector('img, svg, [role="img"]'),
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

  // 접근성 이름이 안 잡히는 요소(<summary> 펼치기 등): 태그 + 화면 문구로 식별
  if (cand.lines.length) {
    const spec = await tryLocator({ kind: 'text', tag: cand.tag, role: role || cand.tag, name: cand.lines[0] });
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
    text: () => page.locator(spec.tag).filter({ hasText: spec.name }),
  }[spec.kind]();
  return spec.nth === undefined ? base : base.nth(spec.nth);
}

/** 요소를 실제로 클릭해보고 어떤 동작이 일어나는지 관찰 */
async function probe(page, spec, noisy) {
  const loc = buildLocator(page, spec);

  // 마우스 오버로 새로 나타나는 문구(툴팁/말풍선/호버 메뉴)
  let tooltip = null;
  if (!['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(spec.role)) {
    const idle = await pageState(page);
    if (await loc.hover({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await page.waitForTimeout(600);
      const role = await page.getByRole('tooltip').filter({ visible: true }).first().innerText({ timeout: 300 }).catch(() => '');
      const idleLines = new Set(idle.lines);
      const hovered = await pageState(page);
      const box = await loc.boundingBox().catch(() => null);
      // 마우스를 올린 요소 근처(200px 이내)에 새로 나타난 문구만 툴팁으로 본다 (멀리서 저절로 바뀐 문구 제외)
      const nearTarget = async (t) => {
        if (!box) return false;
        const b = await page.getByText(t, { exact: true }).filter({ visible: true }).first().boundingBox({ timeout: 500 }).catch(() => null);
        if (!b) return false;
        const dx = Math.max(0, b.x - (box.x + box.width), box.x - (b.x + b.width));
        const dy = Math.max(0, b.y - (box.y + box.height), box.y - (b.y + b.height));
        return dx <= 200 && dy <= 200;
      };
      tooltip = role.split('\n').map((t) => t.trim().replace(/\s+/g, ' ')).find(Boolean) || null;
      if (!tooltip) {
        for (const t of hovered.lines) {
          if (idleLines.has(t) || noisy.has(t) || !isAssertableText(t)) continue;
          if (await nearTarget(t)) {
            tooltip = t;
            break;
          }
        }
      }
      if (tooltip && !isAssertableText(tooltip)) tooltip = null;
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
    }
  }
  const withTip = (effect) => (tooltip ? { ...effect, tooltip } : effect);
  const effect = await probeClick(page, loc, spec, noisy);
  return withTip(effect);
}

async function probeClick(page, loc, spec, noisy) {
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

/**
 * 클릭 요소 밖의 일반 문구와 이미지를 화면 순서대로 수집.
 * 문구는 줄바꿈 없는 한 덩어리(문단/제목/라벨) 단위로 모은다.
 */
async function collectScreenItems(page) {
  return page.evaluate((selector) => {
    const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');
    const zoneOf = (el) => (el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]') ? 'common' : 'main');
    // 화면 순서용 좌표 (collectCandidates 와 동일): 고정 상단 바는 맨 앞, 고정 하단 메뉴는 맨 뒤
    const posOf = (el) => {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + scrollX);
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).position === 'fixed') return { y: r.top < innerHeight / 2 ? Math.round(r.top) : 1e7 + Math.round(r.top), x };
      }
      return { y: Math.round(r.top + scrollY), x };
    };
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const texts = [];
    const images = [];
    const taken = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(el.tagName)) continue;
      // 클릭 요소 안의 문구/이미지는 그 요소의 '문구' 검사에서 확인한다
      if (el.closest(selector)) continue;
      // 닫힌 모달·숨김 영역은 클릭 탐지(모달 노출)에서 다룬다
      if (el.closest('[aria-hidden="true"], [role="dialog"], dialog, [role="tooltip"]')) continue;
      if (el.matches('img, [role="img"]')) {
        const name = clean(el.getAttribute('alt') || el.getAttribute('aria-label'));
        if (name && shown(el)) images.push({ name, pos: posOf(el), zone: zoneOf(el) });
        continue;
      }
      if (el.closest('svg')) continue;
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !shown(el)) continue;
      let anc = el.parentElement;
      while (anc && !taken.has(anc)) anc = anc.parentElement;
      if (anc) continue;
      const raw = el.innerText || '';
      // 블록 자식이 섞인 요소는 한 문구로 찾을 수 없으므로 자식 단위로 수집되게 둔다
      if (raw.trim().includes('\n')) continue;
      taken.add(el);
      texts.push({ text: clean(raw), pos: posOf(el), zone: zoneOf(el) });
    }
    return { texts, images };
  }, INTERACTIVE_SELECTOR);
}

/**
 * 롤링 배너/슬라이드 탐지: 일정 시간 동안 여러 번 관찰해서
 * DOM 에는 계속 있는데 화면에 보였다 안 보였다 하는 문구를 같은 슬라이드 영역끼리 묶는다.
 */
async function detectRolling(page, samples = 9, interval = 700) {
  const snap = () =>
    page.evaluate(() => {
      const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');
      let clipSeq = Number(document.body.dataset.qaClipSeq || 0);
      const out = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const text = clean(el.innerText);
        if (!text || text.length > 200 || text.includes('\n')) continue;
        const r = el.getBoundingClientRect();
        let visible = r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
        let clip = null;
        let clipY = null;
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.1) visible = false;
          if (a !== el && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
            const ar = a.getBoundingClientRect();
            if (r.right <= ar.left + 2 || r.left >= ar.right - 2 || r.bottom <= ar.top + 2 || r.top >= ar.bottom - 2) {
              visible = false;
              // 실제로 문구를 가린 영역 = 슬라이드 창. 같은 창에 가려지는 문구끼리 한 롤링으로 묶는다
              if (!clip) {
                if (!a.dataset.qaClip) a.dataset.qaClip = String(++clipSeq);
                clip = a.dataset.qaClip;
                clipY = Math.round(ar.top + scrollY);
              }
            }
          }
        }
        out.push({ text, visible, clip, y: clipY ?? Math.round(r.top + scrollY) });
      }
      document.body.dataset.qaClipSeq = String(clipSeq);
      return out;
    });

  const history = new Map(); // text → { shown, seen, clip, y }
  for (let i = 0; i < samples; i++) {
    for (const { text, visible, clip, y } of await snap()) {
      const h = history.get(text) || { shown: 0, seen: 0, clip: null, y, hits: new Set() };
      if (clip && !h.clip) {
        h.clip = clip;
        h.y = y; // 슬라이드 창(가리는 영역)의 위치로 정렬
      }
      if (!h.hits.has(i)) {
        h.hits.add(i);
        h.seen++;
        if (visible) h.shown++;
      } else if (visible && h.shown < h.seen) {
        h.shown++; // 같은 문구가 복제 슬라이드에 여러 번 있는 경우: 하나라도 보이면 보임
      }
      history.set(text, h);
    }
    if (i < samples - 1) await page.waitForTimeout(interval);
  }

  const groups = new Map();
  for (const [text, h] of history) {
    if (h.seen !== samples || h.shown === 0 || h.shown === samples || !h.clip) continue;
    if (!isAssertableText(text)) continue;
    if (!groups.has(h.clip)) groups.set(h.clip, { texts: [], y: h.y });
    const g = groups.get(h.clip);
    g.texts.push(text);
    g.y = Math.min(g.y, h.y);
  }
  // 보였다 안 보였다 하는 문구가 2개 이상이어야 롤링으로 본다 (깜빡임 하나는 제외)
  return [...groups.values()].filter((g) => g.texts.length >= 2).map((g) => ({ texts: g.texts.slice(0, 10), pos: { y: g.y, x: 0 } }));
}

// 진행 로그용: 요소 종류 이름
const ROLE_LABEL = { link: '링크', button: '버튼', tab: '탭', menuitem: '메뉴', combobox: '선택 박스', checkbox: '체크박스', radio: '라디오', switch: '스위치', textbox: '입력창', searchbox: '검색창' };
function kindOf(cand, spec) {
  if (cand.tag === 'summary') return '펼치기';
  const base = ROLE_LABEL[spec.role] || cand.tag;
  if (cand.hasImg && !cand.lines.length) {
    // 헤더 왼쪽 위의 이미지 링크는 대부분 로고
    if (cand.zone === 'common' && cand.pos.y < 200 && cand.pos.x < 400) return '로고';
    return `이미지 ${base}`;
  }
  // 넓은 영역에 여러 줄 문구/이미지를 담은 클릭 요소는 배너(카드)로 본다
  if (['a', 'button'].includes(cand.tag) || ['link', 'button'].includes(spec.role)) {
    if (cand.area >= 300 * 100 && (cand.lines.length >= 2 || cand.hasImg)) return '배너';
  }
  return base;
}

async function analyzePage(context, pagePath, { commonSignatures, collectCommon }) {
  const tag = pagePath;
  const step = (msg) => console.log(`   · [${tag}] ${msg}`);
  const url = `${BASE_URL}${pagePath}`;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const result = { path: pagePath, url, title: '', status: 0, keyTexts: [], texts: [], images: [], rolling: [], tables: [], pageType: 'general', features: [], common: [], skipped: [], errors };

  try {
    const response = await openForAnalysis(page, url);
    result.status = response ? response.status() : 0;
    result.title = await page.title();

    // 접속 차단(봇 차단/오류 응답)이면 화면 요소로 테스트를 만들지 않는다 → 상태 코드 검증만 남겨 결과에 드러나게 함
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    if (result.status >= 400 || BOT_CHECK.test(`${result.title}\n${bodyText}`)) {
      result.blocked = result.status >= 400 ? `HTTP ${result.status}` : '봇 차단/보안 확인 페이지';
      result.pageType = 'blocked';
      console.warn(`   · [${tag}] 접속 차단 (${result.blocked}) → 이 페이지는 접속 상태만 검증합니다.`);
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

    step(`화면 열기 HTTP ${result.status} · 유형 ${PAGE_TYPE_LABEL[result.pageType]} · 핵심 문구 ${result.keyTexts.length}개${result.tables.length ? ` · 표 ${result.tables.length}개` : ''}`);

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
      const signature = `${spec.role}|${spec.name}|${cand.href || ''}`;
      const isCommon = cand.zone === 'common';
      if (isCommon && !collectCommon) continue;
      if (!isCommon && commonSignatures.has(signature)) continue;
      // 부작용 위험 요소(삭제/결제/제출 등)도 노출·문구는 확인하고 클릭만 하지 않는다
      const risky = RISKY.test(spec.name) || cand.type === 'submit';
      resolved.push({ cand, spec, signature, risky, bucket: isCommon ? 'common' : 'features' });
    }

    // 클릭 요소 밖의 일반 문구·이미지, 롤링 배너 (클릭 탐지 전에 원래 화면 상태에서 수집)
    const rolling = await detectRolling(page);
    const rollingTexts = new Set(rolling.flatMap((g) => g.texts));
    // 롤링 문구는 저절로 바뀌므로 클릭/마우스 오버 결과(툴팁·콘텐츠 노출) 판단에서 제외
    rollingTexts.forEach((t) => noisy.add(t));
    const screen = await collectScreenItems(page);
    const keepZone = (z) => collectCommon || z === 'main';
    const seenText = new Set();
    for (const t of screen.texts) {
      if (result.texts.length >= MAX_TEXTS_PER_PAGE) break;
      if (!keepZone(t.zone) || seenText.has(t.text) || noisy.has(t.text) || rollingTexts.has(t.text)) continue;
      if (t.text.length < 2 || t.text.length > 200 || /^[\d\s.,:%+\-$₩()/]+$/.test(t.text)) continue;
      seenText.add(t.text);
      if (await isFindableText(page, t.text)) result.texts.push(t);
    }
    result.images = screen.images.filter((i) => keepZone(i.zone));
    result.rolling = rolling;
    step(`일반 문구 ${result.texts.length}개 · 이미지 ${result.images.length}개${rolling.length ? ` · 롤링 배너 ${rolling.length}개 (문구 ${rollingTexts.size}개)` : ''} 수집`);

    // 페이지당 탐지 개수 제한이 있으므로 상호작용 컴포넌트(버튼/토글/탭)를 링크보다 먼저 탐지한다
    const priority = ({ cand, spec }) => (cand.tag === 'a' || spec.role === 'link' ? 1 : 0);
    resolved.sort((a, b) => priority(a) - priority(b));

    const counts = { common: 0, features: 0 };
    for (const r of resolved) counts[r.bucket]++;
    step(`클릭·입력 가능한 요소 ${resolved.length}개 발견${collectCommon ? ` (헤더/메뉴/푸터 공통 ${counts.common}개 + 본문 ${counts.features}개)` : ''} → 하나씩 동작 확인`);

    const probedBy = { features: 0, common: 0 };
    let n = 0;
    for (const { cand, spec, signature, bucket, risky } of resolved) {
      n++;
      const label = spec.name || cand.href || spec.selector || spec.role;
      const lines = cand.lines.filter((t) => !noisy.has(t));
      const base = { label, signature, locator: spec, href: cand.href, kind: kindOf(cand, spec), lines, hasImg: cand.hasImg, pos: cand.pos };
      const before = result[bucket].length;
      const where = collectCommon && bucket === 'common' ? '공통 ' : '';
      const report = (how) => {
        const added = result[bucket].length > before ? result[bucket][result[bucket].length - 1] : null;
        step(`(${n}/${resolved.length}) ${where}${kindOf(cand, spec)} "${short(String(label), 25)}" ${how} → ${added ? TYPE_LABEL[added.type] : '제외'}`);
      };

      // 클릭 없이 구조만으로 판별되는 패턴
      if (cand.anchorId) {
        // 목차 앵커는 페이지당 10개까지만 (문서 사이트는 수십 개라 테스트가 과도하게 늘어남)
        if (result[bucket].filter((x) => x.type === 'anchor').length < 10) {
          result[bucket].push({ ...base, type: 'anchor', anchorId: cand.anchorId });
        } else {
          result[bucket].push({ ...base, type: 'display', reason: '목차 링크 이동 확인은 페이지당 10개까지' });
        }
        report('구조 확인');
        continue;
      }
      if (cand.tag === 'select') {
        if (cand.option) result[bucket].push({ ...base, type: 'select', value: cand.option });
        report('옵션 확인');
        continue;
      }
      if (['textbox', 'searchbox', 'spinbutton'].includes(spec.role) || cand.tag === 'textarea') {
        result[bucket].push({ ...base, type: 'input', inputType: cand.type || 'text', formButton: cand.formButton });
        report('입력 확인');
        continue;
      }
      if (['checkbox', 'radio', 'switch'].includes(spec.role)) {
        result[bucket].push({ ...base, type: 'check' });
        report('선택 확인');
        continue;
      }
      if (risky) {
        result[bucket].push({ ...base, type: 'display', reason: '부작용 위험(삭제/결제/제출 등)으로 클릭하지 않음' });
        report('클릭 생략(부작용 위험)');
        continue;
      }
      const limit = bucket === 'features' ? MAX_FEATURES_PER_PAGE : MAX_COMMON_FEATURES;
      if (probedBy[bucket] >= limit) {
        // 목록에서 빼지 않고 노출·문구만 확인한다
        result[bucket].push({ ...base, type: 'display', reason: `클릭 확인 상한(${limit}개) 초과` });
        report(`클릭 상한 ${limit}개 초과로 클릭 생략`);
        continue;
      }
      probedBy[bucket]++;

      const effect = await probe(page, spec, noisy);
      if (effect.type === 'unclickable') {
        // 클릭은 안 되더라도 화면에 있는 요소이므로 노출·문구는 확인한다
        result[bucket].push({ ...base, type: 'display', reason: `분석 중 클릭 불가: ${short(effect.reason, 60)}`, ...(effect.tooltip ? { tooltip: effect.tooltip } : {}) });
      } else {
        result[bucket].push({ ...base, ...effect });
      }
      report(`${effect.tooltip ? `마우스 오버 "${short(effect.tooltip, 15)}" · ` : ''}${effect.type === 'unclickable' ? `클릭 불가(${short(effect.reason, 40)})` : '클릭'}`);

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
  display: '노출·문구만 확인',
};

const SAMPLE_INPUT = { email: 'qa@example.com', number: '123', tel: '01012345678', url: 'https://example.com' };

/** 요소의 '동작' 검사 코드: { action: 결과 화면에 표시할 설명, body: 코드 줄 } */
function actionCode(f) {
  // 줄바꿈(<br>)으로 나뉜 문구의 한 줄일 수 있으므로 부분 일치로 찾는다
  const textLoc = (t) => `page.getByText(${JSON.stringify(t)}).filter({ visible: true }).first()`;
  const q = (t, n = 20) => JSON.stringify(short(t, n)).slice(1, -1);
  const body = [];

  switch (f.type) {
    case 'navigate': {
      const u = new URL(f.url);
      // 외부 사이트는 지역/언어별 리다이렉트로 경로가 바뀌므로 도메인까지만 비교
      const external = u.origin !== BASE_URL;
      body.push(`await target.click();`);
      body.push(`await expect(page).toHaveURL(${urlMatcher(f.url, external)});`);
      return { action: `페이지 이동 → ${external ? u.host : u.pathname}`, body };
    }
    case 'brokenLink':
      // 분석 시 연결에 실패한 링크: 정상 페이지로 열리는지 검증 (지금 상태면 실패로 보고됨)
      body.push(`await target.click();`);
      body.push(`await page.waitForLoadState('domcontentloaded');`);
      body.push(`expect(page.url(), '링크 이동 시 브라우저 오류 페이지가 열립니다 (연결 실패 또는 차단).').not.toMatch(/^chrome-error:/);`);
      return { action: '링크 연결 (분석 시 연결 실패)', body };
    case 'newTab': {
      body.push(`const popupPromise = page.waitForEvent('popup');`);
      body.push(`await target.click();`);
      body.push(`const popup = await popupPromise;`);
      body.push(`await expect(popup).toHaveURL(${urlMatcher(f.url, true)});`);
      body.push(`await popup.close();`);
      return { action: `새 탭 열기 → ${new URL(f.url).host}`, body };
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
      return { action: `${TYPE_LABEL[f.type]} "${q(f.text)}"${f.closeName || f.closeKey ? ' 후 닫힘' : ''}`, body };
    case 'toggle':
      body.push(`await target.click();`);
      body.push(`await expect(target).toHaveAttribute('aria-expanded', ${JSON.stringify(f.expanded)});`);
      if (f.collapsed !== null && f.collapsed !== undefined) {
        body.push(`await target.click();`);
        body.push(`await expect(target).toHaveAttribute('aria-expanded', ${JSON.stringify(f.collapsed)});`);
      }
      return { action: `펼침${f.collapsed ? ' → 접힘' : ''}`, body };
    case 'select':
      body.push(`await target.selectOption(${JSON.stringify(f.value)});`);
      body.push(`await expect(target).toHaveValue(${JSON.stringify(f.value)});`);
      return { action: `옵션 선택 "${q(f.value)}"`, body };
    case 'anchor':
      body.push(`await target.click();`);
      body.push(`await expect(page.locator(${JSON.stringify(`[id="${f.anchorId}"]`)})).toBeInViewport();`);
      return { action: `목차 이동 → #${f.anchorId}`, body };
    case 'tab':
      body.push(`await target.click();`);
      body.push(`await expect(target).toHaveAttribute('aria-selected', 'true');`);
      return { action: '탭 전환', body };
    case 'input': {
      const value = SAMPLE_INPUT[f.inputType] || 'qa-test';
      body.push(`await target.fill(${JSON.stringify(value)});`);
      body.push(`await expect(target).toHaveValue(${JSON.stringify(value)});`);
      // 같은 폼의 제출 버튼이 입력 후 활성화되는지 (실제 제출은 하지 않음)
      if (f.formButton) body.push(`await expect(page.getByRole('button', { name: ${JSON.stringify(f.formButton)}, exact: true }).first()).toBeEnabled();`);
      return { action: `입력${f.formButton ? ` → "${q(f.formButton)}" 버튼 활성화` : ''}`, body };
    }
    case 'check':
      body.push(`await target.check();`);
      body.push(`await expect(target).toBeChecked();`);
      return { action: '선택(체크)', body };
    default:
      body.push(`await expect(target).toBeEnabled();`);
      body.push(`await target.click();`);
      body.push(`await page.waitForTimeout(800);`);
      body.push(`expect(errors, '클릭 후 JS 런타임 오류').toEqual([]);`);
      return { action: '클릭 시 오류 없음', body };
  }
}

const num = (n) => String(n).padStart(2, '0');
const q = (t, n = 30) => JSON.stringify(short(t, n)).slice(1, -1);

/** 클릭 요소 하나: 노출 → 문구 → (이미지) → (마우스 오버) → 동작 */
function elementTest(f, no, typos) {
  const out = [];
  // 제목은 화면에 보이는 문구 우선 (이미지 대체텍스트가 섞인 접근성 이름보다 알아보기 쉽다)
  const shownName = f.lines && f.lines.length ? f.lines.join(' ') : f.label;
  out.push(`  test(${JSON.stringify(`${num(no)}. ${f.kind} "${q(shownName)}" (${f.id})`)}, async ({ page }) => {`);
  out.push(`    const { errors } = await openPage(page, TARGET_URL);`);
  out.push(`    const target = ${locatorCode(f.locator)};`);
  out.push(`    const c = checks();`);
  out.push(`    await c.run('노출', async () => { await expect(target).toBeVisible(); }, { gate: true });`);
  // 요소 안 문구는 줄마다 따로 확인 (버튼 문구 / 말풍선 문구 / 배너 제목·설명이 각각 결과로 보이도록)
  for (const l of f.lines || []) {
    out.push(`    await c.run(${JSON.stringify(`문구: "${q(l, 40)}"`)}, async () => { await expect(target).toContainText(${JSON.stringify(l)}); });`);
    if (typos.has(l)) out.push(`    c.warn(${JSON.stringify(l)}, ${JSON.stringify(typos.get(l))});`);
  }
  if (f.hasImg) {
    out.push(`    await c.run('이미지 로드', async () => {`);
    out.push(`      const broken = await target.locator('img').evaluateAll((els) => els.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0).length);`);
    out.push(`      expect(broken, '요소 안 이미지가 깨짐').toBe(0);`);
    out.push(`    });`);
  }
  if (f.tooltip) {
    out.push(`    await c.run(${JSON.stringify(`마우스 오버: "${q(f.tooltip, 25)}" 노출`)}, async () => {`);
    out.push(`      await target.hover();`);
    out.push(`      await expect(page.getByText(${JSON.stringify(f.tooltip)}).filter({ visible: true }).first()).toBeVisible();`);
    out.push(`      await page.mouse.move(0, 0);`);
    out.push(`    });`);
    if (typos.has(f.tooltip)) out.push(`    c.warn(${JSON.stringify(f.tooltip)}, ${JSON.stringify(typos.get(f.tooltip))});`);
  }
  if (f.type === 'display') {
    out.push(`    c.skip('동작', ${JSON.stringify(f.reason || '클릭 확인 생략')});`);
  } else {
    const { action, body } = actionCode(f);
    out.push(`    await c.run(${JSON.stringify(`동작: ${action}`)}, async () => {`);
    body.forEach((l) => out.push(`      ${l}`));
    out.push(`    });`);
  }
  out.push(`    void errors;`);
  out.push(`    c.done();`);
  out.push(`  });`);
  return out;
}

/** 클릭 요소 사이에 있는 일반 문구·이미지 묶음 */
function contentTest(items, no, typos) {
  const first = items[0];
  const imageKind = (name) => (/logo|로고/i.test(name) ? '로고' : '이미지');
  const label = first.kind === 'text' ? `문구 "${q(first.text)}"` : `${imageKind(first.name)} "${q(first.name)}"`;
  const out = [];
  out.push(`  test(${JSON.stringify(`${num(no)}. ${label}${items.length > 1 ? ` 외 ${items.length - 1}개` : ''}`)}, async ({ page }) => {`);
  out.push(`    await openPage(page, TARGET_URL);`);
  out.push(`    const c = checks();`);
  for (const it of items) {
    if (it.kind === 'text') {
      out.push(`    await c.run(${JSON.stringify(`문구 노출: "${q(it.text, 40)}"`)}, async () => {`);
      out.push(`      await expect(page.getByText(${JSON.stringify(it.text)}, { exact: true }).filter({ visible: true }).first()).toBeVisible();`);
      out.push(`    });`);
      if (typos.has(it.text)) out.push(`    c.warn(${JSON.stringify(it.text)}, ${JSON.stringify(typos.get(it.text))});`);
    } else {
      out.push(`    await c.run(${JSON.stringify(`${imageKind(it.name)} 노출: "${q(it.name, 30)}"`)}, async () => {`);
      out.push(`      const img = page.getByRole('img', { name: ${JSON.stringify(it.name)}, exact: true }).filter({ visible: true }).first();`);
      out.push(`      await expect(img).toBeVisible();`);
      out.push(`      expect(await img.evaluate((i) => !(i instanceof HTMLImageElement) || i.naturalWidth > 0), '이미지가 깨짐').toBe(true);`);
      out.push(`    });`);
    }
  }
  out.push(`    c.done();`);
  out.push(`  });`);
  return out;
}

/** 롤링 배너: 슬라이드 문구가 차례로 화면에 나타나는지 */
function rollingTest(g, no, typos) {
  const out = [];
  out.push(`  test(${JSON.stringify(`${num(no)}. 롤링 배너 "${q(g.texts[0], 20)}" 외 ${g.texts.length - 1}개 문구`)}, async ({ page }) => {`);
  out.push(`    test.setTimeout(${30000 + g.texts.length * 20000});`);
  out.push(`    await openPage(page, TARGET_URL);`);
  out.push(`    await page.getByText(${JSON.stringify(g.texts[0])}, { exact: true }).first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));`);
  out.push(`    const c = checks();`);
  for (const t of g.texts) {
    out.push(`    await c.run(${JSON.stringify(`롤링 문구 노출: "${q(t, 40)}"`)}, () => expectShownInRotation(page, ${JSON.stringify(t)}));`);
    if (typos.has(t)) out.push(`    c.warn(${JSON.stringify(t)}, ${JSON.stringify(typos.get(t))});`);
  }
  out.push(`    c.done();`);
  out.push(`  });`);
  return out;
}

/**
 * 페이지 하나의 spec: 화면 위→아래 순서로
 * 클릭 요소(노출·문구·동작) / 일반 문구·이미지 묶음 / 롤링 배너 케이스를 나열한다.
 */
function specSource({ describeTitle, page, features, typos }) {
  const out = specHeader({ describeTitle, env: ENV, supportPath: '../support/site', generator: 'scripts/generate-specs.js' });
  out.push(``);
  out.push(`  const TARGET_URL = ${JSON.stringify(page.url)};`);

  out.push(``);
  out.push(`  test('00. 페이지 로드 (HTTP 상태 · 이미지 · JS 오류)', async ({ page }) => {`);
  out.push(`    const { response, errors } = await openPage(page, TARGET_URL);`);
  out.push(`    await test.step('HTTP 응답 정상', async () => {`);
  out.push(`      expect(response?.status() ?? 0).toBeLessThan(400);`);
  out.push(`    });`);
  if (page.blocked) {
    // 분석 시 접속이 차단된 페이지: 차단이 풀렸는지만 확인하고 나머지는 생략
    out.push(`    await test.step('봇 차단/보안 확인 페이지가 아님', async () => {`);
    out.push(`      await expect(page.getByText(${BOT_CHECK.toString()}).first(), ${JSON.stringify(`분석 시 접속 차단됨 (${page.blocked}). 사이트가 자동화 접근을 막고 있습니다.`)}).toHaveCount(0);`);
    out.push(`    });`);
    out.push(`  });`);
    return [...out, `});`, ``].join('\n');
  }
  for (const t of page.tables || []) {
    out.push(`    await test.step(${JSON.stringify(`표 구조: ${t.nth + 1}번째 표 (컬럼 ${t.columns}개, 데이터 행 있음)`)}, async () => {`);
    out.push(`      const table = page.getByRole('table').nth(${t.nth});`);
    if (t.columns) out.push(`      await expect(table.getByRole('columnheader')).toHaveCount(${t.columns});`);
    out.push(`      expect(await table.getByRole('row').count()).toBeGreaterThan(${t.columns ? 1 : 0});`);
    out.push(`    });`);
  }
  out.push(`    await test.step('이미지 정상 로드', async () => {`);
  out.push(`      await expectNoBrokenImages(page);`);
  out.push(`    });`);
  out.push(`    await test.step('JS 런타임 오류 없음', async () => {`);
  out.push(`      expect.soft(errors).toEqual([]);`);
  out.push(`    });`);
  out.push(`  });`);

  // 화면 순서 정렬 (위→아래, 같은 줄이면 왼쪽→오른쪽)
  const items = [
    ...features.map((f) => ({ kind: 'element', f, pos: f.pos })),
    ...page.texts.map((t) => ({ kind: 'text', text: t.text, pos: t.pos })),
    ...page.images.map((i) => ({ kind: 'image', name: i.name, pos: i.pos })),
    ...page.rolling.map((g) => ({ kind: 'rolling', g, pos: g.pos })),
  ].sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);

  let no = 0;
  let bundle = [];
  const flush = () => {
    if (!bundle.length) return;
    out.push(``, ...contentTest(bundle, ++no, typos));
    bundle = [];
  };
  for (const it of items) {
    if (it.kind === 'text' || it.kind === 'image') {
      bundle.push(it);
      if (bundle.length >= 12) flush();
      continue;
    }
    flush();
    out.push(``, ...(it.kind === 'element' ? elementTest(it.f, ++no, typos) : rollingTest(it.g, ++no, typos)));
  }
  flush();

  out.push(`});`);
  out.push(``);
  return out.join('\n');
}

/**
 * 생성한 spec 코드에서 케이스 목록을 뽑는다: 케이스 제목 + 확인 항목(c.run / c.skip / c.warn / test.step).
 * 코드에서 직접 뽑으므로 목록과 실제 실행 내용이 어긋나지 않는다.
 */
function planFromSource(src) {
  const STR = `('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`;
  const lit = (s) => (s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s));
  const cases = [];
  for (const line of src.split('\n')) {
    let m = line.match(new RegExp(`^  test\\(${STR}, async \\(`));
    if (m) {
      cases.push({ title: lit(m[1]), checks: [] });
      continue;
    }
    const cur = cases[cases.length - 1];
    if (!cur) continue;
    if ((m = line.match(new RegExp(`^\\s+await c\\.run\\(${STR}`)))) cur.checks.push({ name: lit(m[1]), kind: 'run' });
    else if ((m = line.match(new RegExp(`^\\s+c\\.skip\\(${STR}, ${STR}\\)`)))) cur.checks.push({ name: lit(m[1]), kind: 'skip', detail: lit(m[2]) });
    else if ((m = line.match(new RegExp(`^\\s+c\\.warn\\(${STR}, (\\[.*\\])\\);`)))) cur.checks.push({ name: `오타 의심: "${lit(m[1])}"`, kind: 'warn', detail: JSON.parse(m[2]).join(' / ') });
    else if ((m = line.match(new RegExp(`^\\s+await test\\.step\\(${STR}`)))) cur.checks.push({ name: lit(m[1]), kind: 'step' });
  }
  return cases;
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
  console.log(`\n[2/4] 시작 페이지 분석: 링크·버튼·펼치기·탭·입력 요소를 하나씩 직접 눌러 동작 확인 중...`);
  console.log(`  (헤더/메뉴/푸터처럼 모든 페이지에 반복되는 요소는 여기서 한 번만 확인합니다)`);
  const [startPath, ...subPaths] = targetPaths;
  const home = await analyzePage(context, startPath, { commonSignatures: new Set(), collectCommon: true });
  const commonSignatures = new Set([...home.common, ...home.features].map((f) => f.signature));
  console.log(`  -> 시작 페이지 기능 ${home.features.length}개, 공통 기능 ${home.common.length}개`);

  console.log(`\n[3/4] 세부 페이지 ${subPaths.length}개 분석: 각 페이지 본문의 링크·버튼·펼치기·입력 요소 동작 확인 중 (동시 ${CONCURRENCY}개)...`);
  let done = 0;
  const subs = await runPool(subPaths, CONCURRENCY, async (p) => {
    const r = await analyzePage(context, p, { commonSignatures, collectCommon: false });
    done++;
    console.log(`  -> [${done}/${subPaths.length}] ${p} 완료: 기능 ${r.features.length}개 탐지${r.skipped.length ? `, 제외 ${r.skipped.length}개` : ''}`);
    return r;
  });
  await browser.close();

  console.log(`\n[4/4] 오타 의심 검사 + 화면 순서대로 테스트 케이스 작성...`);
  const all = [home, ...subs];

  // 기능 ID: P00 = 헤더/메뉴/푸터 공통 요소, P01~ = 각 페이지 (기획서 매핑에서 사용)
  const pid = (i) => `P${String(i).padStart(2, '0')}`;
  const withId = (prefix, list) => list.map((f, i) => ({ ...f, id: `${prefix}-F${String(i + 1).padStart(2, '0')}` }));
  const commonFeatures = withId(pid(0), home.common);
  all.forEach((r, i) => (r.features = withId(pid(i + 1), r.features)));

  // 사이트 전체 문구를 모아 규칙 기반 오타 의심 검사 (같은 사이트 안 표기 비교가 핵심이라 전체를 한 번에)
  const siteTexts = all.flatMap((r) => [
    ...r.texts.map((t) => t.text),
    ...r.rolling.flatMap((g) => g.texts),
    ...[...r.features, ...r.common].flatMap((f) => [...(f.lines || []), ...(f.tooltip ? [f.tooltip] : [])]),
  ]);
  const typos = findTypos(siteTexts);
  console.log(`  -> 문구 ${new Set(siteTexts).size}개 검사: 오타 의심 ${typos.size}건`);
  for (const [t, reasons] of typos) console.log(`     ⚠ "${short(t, 40)}" - ${reasons.join(' / ')}`);

  const files = [];
  const write = (name, src) => {
    fs.writeFileSync(path.join(OUTPUT_DIR, name), src, 'utf-8');
    files.push(name);
    console.log(`  -> [생성 완료] ${name}`);
  };
  const planPages = [];
  all.forEach((r, i) => {
    // 시작 페이지에는 헤더/메뉴/푸터 공통 요소까지 화면 순서대로 포함한다 (다른 페이지는 본문만)
    const features = i === 0 ? [...commonFeatures, ...r.features] : r.features;
    const describeTitle = `[페이지 · ${PAGE_TYPE_LABEL[r.pageType]}] ${r.path}${r.title ? ` - ${r.title}` : ''}`;
    const src = specSource({ describeTitle, page: r, features, typos });
    write(`${String(i + 1).padStart(2, '0')}-${slugOf(r.path)}.spec.ts`, src);
    planPages.push({
      group: describeTitle,
      path: r.path,
      url: r.url,
      blocked: r.blocked || null,
      screenshot: r.shot ? `screens/${pid(i + 1)}.jpg` : null,
      cases: planFromSource(src),
    });
  });

  // 분석 결과 원본 저장 (기획서 매핑 · AI 분석 · 결과 화면에서 사용)
  const strip = (list) => list.map(({ signature, ...f }) => f);
  fs.mkdirSync(path.join(OUTPUT_DIR, 'screens'), { recursive: true });
  const pages = all.map(({ path: p, url, title, status, blocked, keyTexts, texts, images, rolling, tables, pageType, features, skipped, errors, shot }, i) => {
    const screenshot = shot ? `screens/${pid(i + 1)}.jpg` : null;
    if (shot) fs.writeFileSync(path.join(OUTPUT_DIR, screenshot), shot);
    return {
      id: pid(i + 1),
      path: p,
      url,
      title,
      status,
      keyTexts,
      texts,
      images,
      rolling,
      blocked: blocked || null,
      pageType,
      tables,
      screenshot,
      features: strip(features),
      skipped,
      errors,
    };
  });
  const typoList = [];
  for (const [text, reasons] of typos) {
    const where = all.filter((r) =>
      [...r.texts.map((t) => t.text), ...r.rolling.flatMap((g) => g.texts), ...[...r.features, ...r.common].flatMap((f) => [...(f.lines || []), f.tooltip])].includes(text)
    );
    typoList.push({ text, reasons, pages: where.map((r) => r.path) });
  }
  const analysis = {
    meta: { baseUrl: BASE_URL, startUrl: START_URL, scope: SCOPE, ...ENV, generatedAt: new Date().toISOString() },
    common: { id: pid(0), url: home.url, features: strip(commonFeatures) },
    pages,
    typos: typoList,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf-8');

  // 케이스 목록(실행 전): 테스트 실행 후 같은 목록에 결과를 채워 cases.html 을 다시 만든다
  const plan = { meta: analysis.meta, typos: typoList, pages: planPages };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'cases.json'), JSON.stringify(plan, null, 2), 'utf-8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'cases.html'), buildCasesHtml({ plan }), 'utf-8');
  console.log(`  -> [케이스 목록] cases.html (케이스 ${planPages.reduce((n, p) => n + p.cases.length, 0)}개, 실행 전)`);

  // 요약
  const summary = {};
  for (const r of all) for (const f of [...r.features, ...r.common]) summary[f.type] = (summary[f.type] || 0) + 1;
  const count = (key) => all.reduce((n, r) => n + r[key].length, 0);
  console.log(`\n==================================================`);
  console.log(`분석 완료: 페이지 ${pages.length}개, spec ${files.length}개 (${Math.round((Date.now() - startedAt) / 1000)}초)`);
  console.log(`  클릭 요소 ${Object.values(summary).reduce((a, b) => a + b, 0)}개 · 일반 문구 ${count('texts')}개 · 이미지 ${count('images')}개 · 롤링 배너 ${count('rolling')}개 · 오타 의심 ${typos.size}건`);
  Object.entries(summary).forEach(([type, n]) => console.log(`  ${TYPE_LABEL[type].padEnd(10)} ${n}건`));
  console.log(`상세 분석 결과: tests/generated/analysis.json`);
  console.log(`==================================================`);
})();
