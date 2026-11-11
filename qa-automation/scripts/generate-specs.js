const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { short, escapeRegex, locatorCode, urlMatcher, specHeader, textPattern, hasNumber } = require('./lib/codegen');
const { findTypos } = require('./lib/typo');
const { version: APP_VERSION } = require('../app/version.json');
// 분석 재사용 캐시 (앱이 QA_CACHE_DIR 를 넘겨줄 때만). 페이지 URL → { 화면 구조 키, 분석 결과 }
const CACHE_FILE = process.env.QA_CACHE_DIR ? path.join(process.env.QA_CACHE_DIR, 'analysis-cache.json') : null;
let analysisCache = null;
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
// 세부 페이지의 세부 페이지까지 새 페이지가 없을 때까지 따라간다 (단계·개수 상한은 무한 탐색 방지용)
const CRAWL_DEPTH = Number(process.env.CRAWL_DEPTH || 10);
const MAX_PAGES = Number(process.env.MAX_PAGES || 50);
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
// 로그아웃은 로그인 상태로 테스트할 때 세션이 끊기므로 누르지 않는다
const BASE_RISKY = /(삭제|탈퇴|로그아웃|송금|출금하기|결제하기|구매하기|log\s?out|sign\s?out|delete|withdraw)/i;
// 로그인 상태 파일 (앱에서 '로그인 창 열기'로 저장). 있으면 로그인된 상태로 분석한다
const STORAGE_STATE = process.env.QA_STORAGE_STATE && fs.existsSync(process.env.QA_STORAGE_STATE) ? process.env.QA_STORAGE_STATE : null;
// 로그인 상태(안전 모드)에서는 실제 계정 데이터를 바꾸는 버튼도 누르지 않는다 (노출·문구만 확인)
const DATA_CHANGING = /(출근|퇴근|출석|체크인|저장|등록|신청|제출|전송|보내기|발송|승인|반려|초기화|변경|업로드|작성\s?완료|save|submit|send|apply|register|approve|reject|reset|upload|check\s?in)/i;
// '전체 동작 확인'(앱 옵션, 테스트 계정·테스트 서버용): 저장·등록·제출·삭제까지 실제로 누른다.
// 이때도 되돌릴 수 없는 동작(탈퇴·결제·송금)과 세션을 끊는 로그아웃은 누르지 않는다
const CLICK_ALL = process.env.QA_CLICK_ALL === '1';
const ALWAYS_BLOCK = /(탈퇴|송금|출금하기|결제하기|구매하기|로그아웃|log\s?out|sign\s?out|withdraw|unsubscribe)/i;
const RISKY = {
  test: (name) => (CLICK_ALL ? ALWAYS_BLOCK.test(name) : BASE_RISKY.test(name) || (!!STORAGE_STATE && DATA_CHANGING.test(name))),
};
const RISKY_REASON = CLICK_ALL
  ? '되돌릴 수 없는 동작(탈퇴·결제·송금) 또는 로그아웃이라 클릭하지 않음'
  : STORAGE_STATE
    ? '안전 모드: 삭제·제출·저장·출근 등 데이터가 바뀌는 버튼은 클릭하지 않음 (전체 동작 확인을 켜면 실행)'
    : '안전 모드: 삭제·결제·제출 등 부작용 위험 버튼은 클릭하지 않음 (전체 동작 확인을 켜면 실행)';

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
// 오류 · 이용 불가 안내 화면 (tests/support/site.ts 의 ERROR_SCREEN 과 동일하게 유지)
const ERROR_SCREEN = /(이용s*불가|사용할 수 없|지원(되|하)지 않|접근(이)?s*(제한|거부|불가)|권한이 없|오류가 발생|일시적인 오류|서비스 점검|nots+(available|supported)|unavailable|accesss+denied|forbidden|something went wrong|ご利用いただけません|エラーが発生|アクセスできません)/i;
// 다국어(XLT) 확인 언어 목록: 기본 언어로 분석하고, 이 언어들로도 화면을 열어 번역 · 치환 상태를 확인
const XLT_LOCALES = (process.env.XLT_LOCALES || '').split(',').map((l) => l.trim()).filter(Boolean);
const BOT_CHECK = /just a moment|attention required|verify you are human|checking your browser|잠시만 기다리십시오|보안 확인 수행 중|사람인지 확인/i;

// 모달/시트 안의 닫기 컨트롤
// 로그인 상태에서는 '확인'이 "정말 진행할까요?"의 승인일 수 있으므로 닫기·취소·ESC 로만 닫는다
const DIALOG_CLOSE = STORAGE_STATE && !CLICK_ALL ? /^(닫기|close|취소|cancel|×|✕|x)$/i : /^(닫기|close|취소|cancel|확인|×|✕|x)$/i;

// 화면 구조로 판별하는 페이지 유형 (URL 규칙은 사이트마다 달라 쓰지 않는다)
const PAGE_TYPE_LABEL = { form: '입력폼형', list: '목록형', document: '문서형', general: '일반형', blocked: '접속 차단' };

// ─────────────────────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────────────────────

/** (브라우저 안에서 실행) 저장된 sessionStorage 를 같은 사이트에만, 아직 없는 값만 채운다. tests/support/site.ts 와 동일 */
function restoreSessionStorage(saved) {
  const s = saved.find((x) => x.origin === location.origin);
  if (!s) return;
  try {
    for (const { name, value } of s.items) if (sessionStorage.getItem(name) === null) sessionStorage.setItem(name, value);
  } catch {
    // 저장소를 쓸 수 없는 페이지
  }
}

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

/**
 * 같은 사이트 판별용 도메인: www.naver.com, news.naver.com → naver.com / shop.example.co.kr → example.co.kr
 * 같은 사이트(서브도메인 포함)는 세부 페이지까지 모두 분석하고, 다른 사이트(광고·외부 링크)는 이동만 확인한다.
 */
// 누구나 서브도메인을 받는 호스팅 도메인: 서브도메인 하나가 곧 서로 다른 사이트다
const HOSTING_SUFFIX = /\.(lovable\.app|vercel\.app|netlify\.app|github\.io|gitlab\.io|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|herokuapp\.com|onrender\.com|fly\.dev|railway\.app|azurewebsites\.net|cloudfront\.net|amazonaws\.com|blogspot\.com|wordpress\.com|tistory\.com|notion\.site|wixsite\.com|webflow\.io|framer\.app|replit\.app|glitch\.me|surge\.sh|ngrok\.io|ngrok-free\.app)$/i;

function siteOf(hostname) {
  const parts = hostname.split('.');
  if (/^[\d.]+$/.test(hostname) || parts.length <= 2) return hostname;
  const hosting = hostname.match(HOSTING_SUFFIX);
  if (hosting) return `${hostname.slice(0, hosting.index).split('.').pop()}${hosting[0]}`;
  const lastTwo = parts.slice(-2).join('.');
  return /^(co|or|go|ac|ne|re|pe|com|net|org|gov|edu)\.[a-z]{2}$/.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}
const START_SITE = siteOf(new URL(TARGET).hostname);
const isSameSite = (u) => /^https?:$/.test(u.protocol) && siteOf(u.hostname) === START_SITE;

// 광고·유입 추적용 파라미터: 같은 페이지가 주소만 달라 여러 번 분석되지 않도록 지운다
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|referral_code|dp_tracking_id|tracking_id|trk)$/i;
// 웹 페이지가 아닌 파일 링크: 페이지로 분석하지 않고 링크 동작으로만 확인
const FILE_EXT = /\.(pdf|zip|rar|7z|gz|dmg|exe|msi|apk|ipa|jpe?g|png|gif|webp|svg|mp4|mp3|mov|avi|docx?|xlsx?|pptx?|hwp|csv|txt|xml|json)$/i;
function cleanUrl(u) {
  const c = new URL(u.href);
  c.hash = '';
  for (const k of [...c.searchParams.keys()]) if (TRACKING_PARAM.test(k)) c.searchParams.delete(k);
  return c;
}

// 분석 대상 표기: 시작 주소와 같은 origin 이면 경로(/a/b?x), 다른 서브도메인이면 전체 URL
const targetOf = (u) => (u.origin === BASE_URL ? u.pathname + u.search : u.origin + u.pathname + u.search);
const urlOfTarget = (t) => (/^https?:/.test(t) ? t : `${BASE_URL}${t}`);

async function extractInternalTargets(page) {
  const rawHrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'))
      .filter(Boolean)
  );
  const found = [];
  for (const raw of rawHrefs) {
    const trimmed = raw.trim();
    if (/^(mailto:|tel:|#|javascript:)/.test(trimmed)) continue;
    try {
      const parsed = new URL(trimmed, page.url());
      // 같은 사이트만 페이지 분석 대상. 다른 사이트 링크는 링크 기능 테스트(이동 확인)로만 검증
      if (isSameSite(parsed) && !FILE_EXT.test(parsed.pathname)) found.push(cleanUrl(parsed));
    } catch {
      // 파싱 실패 링크 무시
    }
  }
  return found;
}

/** 시작 페이지 → 세부 페이지 → 그 세부 페이지 … 새 페이지가 없을 때까지 (최대 MAX_PAGES) */
async function discoverPaths(page) {
  const start = new URL(START_URL);
  const keyOf = (u) => `${u.host}${templateOf(u.pathname)}${u.search}`;
  const seen = new Set([keyOf(start)]);
  const result = [targetOf(start)];
  let frontier = [result[0]];
  let capped = false;

  for (let depth = 0; depth < CRAWL_DEPTH && frontier.length; depth++) {
    const nextFrontier = [];
    for (const t of frontier) {
      try {
        await openForAnalysis(page, urlOfTarget(t));
        await scrollThrough(page);
      } catch {
        continue;
      }
      for (const u of await extractInternalTargets(page)) {
        if (seen.has(keyOf(u))) continue;
        if (result.length >= MAX_PAGES) {
          capped = true;
          continue;
        }
        seen.add(keyOf(u));
        result.push(targetOf(u));
        nextFrontier.push(targetOf(u));
      }
    }
    if (nextFrontier.length) console.log(`  -> ${depth + 1}단계 세부 페이지 ${nextFrontier.length}개 발견 (누적 ${result.length}개)`);
    frontier = nextFrontier;
  }
  if (capped) console.warn(`  -> 페이지가 더 있지만 최대 ${MAX_PAGES}개까지만 분석합니다 (MAX_PAGES 로 조정 가능).`);
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
    // 지금 선택된 항목 (시트를 열었을 때 새로 보이는 기본 선택 상태를 구분하기 위해)
    const selected = Array.from(document.querySelectorAll('[role="radio"], input[type="radio"], [role="checkbox"], input[type="checkbox"], [role="tab"], [role="option"]'))
      .filter((e) => e.getBoundingClientRect().width > 0 && (e.checked || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true'))
      .map((e) => `${e.getAttribute('role') || (e.type === 'radio' ? 'radio' : 'checkbox')}|${(e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.innerText || '').trim().replace(/\s+/g, ' ')}`);
    return { url: location.href, lines, overlays, selected };
  });
}

/** 요소마다 data-qa-idx 를 부여하고 기본 속성 수집 */
async function collectCandidates(page) {
  return page.evaluate((selector) => {
    // Shadow DOM(웹 컴포넌트) 안의 요소까지 찾는다
    const deepAll = (sel) => {
      const found = [];
      const walk = (root) => {
        root.querySelectorAll(sel).forEach((e) => found.push(e));
        root.querySelectorAll('*').forEach((e) => e.shadowRoot && walk(e.shadowRoot));
      };
      walk(document);
      return found;
    };
    // 이름이 바뀌어도 찾을 수 있게 구조 경로(id 기준 nth-of-type)도 기록 → 테스트의 대체 로케이터
    const cssPath = (el) => {
      const segs = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.body && segs.length < 8; n = n.parentElement) {
        if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && !/\d{3,}|:r/.test(n.id)) {
          segs.unshift(`#${n.id}`);
          return segs.join(' > ');
        }
        const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
        segs.unshift(same.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})` : n.tagName.toLowerCase());
      }
      return `body > ${segs.join(' > ')}`;
    };
    const all = deepAll(selector);
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
      // 비활성 요소(로그인 전 잔액 링크 등)도 '비활성 상태로 보이는지'를 확인 대상으로 남긴다
      const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');

      el.setAttribute('data-qa-idx', String(idx));
      // 공통 영역: 헤더 · 푸터 · 사이트 메뉴. 본문 안 내비게이션(페이지 번호 · 목차 · 탭 목록)은 그 페이지의 기능
      const zone = (() => {
        const z = el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]');
        if (!z || z.matches('header, footer, [role="banner"], [role="contentinfo"]')) return z;
        const label = `${z.getAttribute('aria-label') || ''} ${z.className || ''}`;
        return z.closest('main, article, [role="main"]') || /pag|페이지|breadcrumb|toc|목차/i.test(label) ? null : z;
      })();
      const tag = el.tagName.toLowerCase();
      const href = el.getAttribute('href');
      const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');

      // 같은 페이지 내 앵커(목차 등): 이동 대상이 실제로 있어야 의미가 있다
      let anchorId = null;
      if (tag === 'a' && href && href.length > 1 && href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        if (document.getElementById(id)) anchorId = id;
      }
      // 건너뛰기 링크(본문 바로가기 등): 평소엔 투명하거나 화면 밖에 있다가 키보드 포커스 때만 보인다 → 클릭이 아니라 Tab 포커스 + Enter 로 확인
      let skipLink = false;
      if (anchorId) {
        let transparent = false;
        for (let a = el; a && a !== document.body; a = a.parentElement) if (Number(getComputedStyle(a).opacity) === 0) transparent = true;
        skipLink = transparent || r.bottom <= 0 || r.right <= 0 || r.left >= innerWidth || (r.width <= 2 && r.height <= 2);
      }

      // 입력 요소: 라벨/placeholder(셀렉터용), 같은 폼의 제출 버튼(활성화 검증용), select 의 선택 가능한 값
      let label = '';
      let placeholder = '';
      let formButton = '';
      let option = '';
      let selectOptions = [];
      if (['input', 'textarea', 'select'].includes(tag)) {
        label = clean(el.labels && el.labels[0] ? el.labels[0].innerText : '');
        placeholder = clean(el.getAttribute('placeholder'));
        const form = el.closest('form');
        const btn = form && (form.querySelector('button[type="submit"], input[type="submit"]') || form.querySelector('button'));
        if (btn) formButton = clean(btn.innerText || btn.value);
        if (tag === 'select') {
          const opt = Array.from(el.options).find((o) => o.value && !o.disabled && !o.selected);
          if (opt) option = opt.value;
          selectOptions = Array.from(el.options)
            .filter((o) => o.value && !o.disabled)
            .map((o) => ({ value: o.value, text: clean(o.text) }));
        }
      }

      // 목록 반복 항목(표의 행, 달력 날짜, 같은 형식의 상세 링크 등): 같은 그룹이면 대표 1개만 테스트한다.
      // 그룹 = 같은 목록 안에서 같은 위치(열·순서)에 있는 같은 종류의 요소. 메뉴처럼 링크마다 목적지가 다르면 묶지 않는다.
      let repeatKey = null;
      if (!zone) {
        const LIST = 'table, [role="table"], [role="grid"], ul, ol, [role="list"], [role="listbox"]';
        const container = el.closest(LIST);
        if (container) {
          const sig = (n) =>
            `${n.tagName}.${n.getAttribute('role') || ''}.${(typeof n.className === 'string' ? n.className : '')
              .split(/\s+/)
              .filter((c) => c && !/(active|select|current|today|disabled|focus|hover|open|checked|is-|--)/i.test(c))
              .sort()
              .join('.')}`;
          const segs = [];
          let repeats = false;
          for (let n = el; n && n !== container; n = n.parentElement) {
            const sibs = n.parentElement ? Array.from(n.parentElement.children) : [n];
            const same = sibs.filter((s) => sig(s) === sig(n));
            // 표의 칸(열)은 의미가 다르므로 위치를 유지, 그 외 반복 단위는 '*' 로 묶는다
            const isCol = n.matches('td, th, [role="cell"], [role="columnheader"]');
            if (!isCol && same.length >= 3) {
              repeats = true;
              segs.push(`${sig(n)}*`);
            } else {
              segs.push(`${sig(n)}:${sibs.indexOf(n)}`);
            }
          }
          if (repeats) {
            if (!container.dataset.qaList) container.dataset.qaList = String((window.__qaListSeq = (window.__qaListSeq || 0) + 1));
            // 링크는 목적지 형식까지 같아야 같은 그룹 (/notice/1, /notice/2 는 같고 /a, /b 는 다름)
            let dest = '';
            if (href) {
              try {
                dest = new URL(href, location.href).pathname.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24,})(?=\/|$)/gi, '/:id');
              } catch {}
            }
            repeatKey = `${container.dataset.qaList}|${segs.join('/')}|${dest}`;
          }
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
        skipLink,
        disabled,
        // 화면 낭독기에서 숨긴 영역(무한 스크롤 배너의 복제본 등)
        ariaHidden: !!el.closest('[aria-hidden="true"]'),
        label,
        placeholder,
        formButton,
        option,
        selectOptions,
        repeatKey,
        cssPath: cssPath(el),
        // 입력 검증 규칙 (필수 · 형식 · 최대 길이)
        required: !!(el.required || el.getAttribute('aria-required') === 'true'),
        pattern: el.getAttribute('pattern') || '',
        maxLength: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : 0,
        download: tag === 'a' && el.hasAttribute('download'),
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
    // 이름 끝의 숫자 배지(알림 수 · 건수 '1', '99+')는 시간이 지나면 바뀌므로 숫자를 빼고 '숫자 있어도/없어도' 찾는다
    const badge = name.match(/^(.*\S)\s+\d+\+?$/);
    if (badge && !/^\d/.test(badge[1])) {
      const spec = await tryLocator({ kind: 'roleBadge', role, name: badge[1] });
      if (spec) return spec;
    }
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
  // 마지막 수단: 이름도 고유 속성도 없는 아이콘 버튼(뒤로가기 화살표 등)은 화면 구조 경로로 찾는다.
  // 구조가 바뀌면 깨질 수 있고, 화면 낭독기 이름이 없는 것 자체가 접근성 문제이므로 결과에 함께 표시한다
  if (cand.cssPath && cand.hasImg && !cand.lines.length) {
    const spec = await tryLocator({ kind: 'css', selector: cand.cssPath, role: role || cand.tag, name, unnamed: true });
    if (spec) return spec;
  }
  return null;
}

/** "휴가 신청 · 근태 정정" → 뒤에 숫자 배지가 붙어도(… 1, … 99+) 없어도 맞는 이름 패턴 */
const badgeNamePattern = (name) => new RegExp(`^${escapeRegex(name)}(\\s*\\d+\\+?)?$`);

function buildLocator(page, spec) {
  const base = {
    role: () => page.getByRole(spec.role, { name: spec.name, exact: true }),
    roleBadge: () => page.getByRole(spec.role, { name: badgeNamePattern(spec.name) }),
    label: () => page.getByLabel(spec.name, { exact: true }),
    placeholder: () => page.getByPlaceholder(spec.name, { exact: true }),
    css: () => page.locator(spec.selector),
    text: () => page.locator(spec.tag).filter({ hasText: spec.name }),
  }[spec.kind]().filter({ visible: true });
  return spec.nth === undefined ? base : base.nth(spec.nth);
}

/** 요소를 실제로 클릭해보고 어떤 동작이 일어나는지 관찰 */
async function probe(page, spec, noisy, reset) {
  const loc = buildLocator(page, spec);

  // 마우스 오버로 새로 나타나는 문구(툴팁/말풍선/호버 메뉴)
  let tooltip = null;
  let hoverLinks = [];
  // 화면에 보이는 링크 목록 (마우스 오버로 새로 나타나는 하위 메뉴 링크를 찾기 위해)
  const visibleLinks = () =>
    page
      .evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .filter((a) => {
            const r = a.getBoundingClientRect();
            const s = getComputedStyle(a);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.1;
          })
          .map((a) => ({ name: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), href: a.href, blank: a.target === '_blank' }))
          .filter((l) => l.name && l.name.length <= 40 && /^https?:/.test(l.href))
      )
      .catch(() => []);
  if (!['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(spec.role)) {
    const idle = await pageState(page);
    const linksBefore = new Set((await visibleLinks()).map((l) => `${l.name}|${l.href}`));
    if (await loc.hover({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await page.waitForTimeout(600);
      // 호버 메뉴(메가 메뉴): 마우스를 올렸을 때만 보이는 하위 링크 (최대 8개)
      const seen = new Set();
      hoverLinks = (await visibleLinks())
        .filter((l) => !linksBefore.has(`${l.name}|${l.href}`) && !seen.has(l.name) && seen.add(l.name))
        .slice(0, 8);
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
  // 하위 메뉴 링크가 나타났으면 그 메뉴의 문구는 툴팁이 아니다
  if (hoverLinks.length && tooltip && hoverLinks.some((l) => l.name === tooltip)) tooltip = null;
  const withTip = (effect) => ({ ...effect, ...(tooltip ? { tooltip } : {}), ...(hoverLinks.length ? { hoverLinks } : {}) });
  let effect = await probeClick(page, loc, spec, noisy);
  // 드롭다운이 열렸으면 옵션을 하나씩 눌러 동작 확인
  if (effect.type === 'dropdownOpen') effect = reset ? await probeDropdownOptions(page, spec, effect, reset) : { type: 'none', dirty: true };
  return withTip(effect);
}

/** 표 머리글 안의 요소면 그 표의 앞쪽 행 내용(정렬 확인용), 아니면 null */
const tableRowsOf = (loc) =>
  loc
    .evaluate((el) => {
      if (!el.closest('th, [role="columnheader"]')) return null;
      const t = el.closest('table, [role="table"], [role="grid"]');
      if (!t) return null;
      const rows = Array.from(t.querySelectorAll('tbody tr, [role="rowgroup"]:not(:first-child) [role="row"]'));
      return rows.slice(0, 10).map((r) => r.textContent.trim().replace(/\s+/g, ' ')).join('|');
    })
    .catch(() => null);

// 문구가 화면에서 정확히 그 문구인 요소로 찾아지는지 (여러 메뉴 · 표 한 줄을 이어 붙인 가짜 문구 제외)
const isVisibleText = async (page, t) => (await page.getByText(t, { exact: true }).filter({ visible: true }).count().catch(() => 0)) > 0;

/**
 * 화면의 대표 목록(표·리스트 중 항목이 가장 많은 것)의 항목 문구. 검색·필터 결과 확인용.
 * tests/support/site.ts 의 listRows 와 동일하게 유지.
 */
function listRowsInPage() {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  };
  const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');
  const outside = (c) => !c.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]');
  const rowsOf = (c) => {
    let items;
    if (c.matches('table')) items = Array.from(c.querySelectorAll(':scope > tbody > tr, :scope > tr')).filter((r) => !r.querySelector('th'));
    else if (c.matches('[role="table"], [role="grid"]')) items = Array.from(c.querySelectorAll('[role="row"]')).filter((r) => !r.querySelector('[role="columnheader"]'));
    else items = Array.from(c.children).filter((n) => n.matches('li, [role="listitem"], [role="option"]'));
    return items.filter(vis).map((n) => clean(n.innerText || n.textContent)).filter(Boolean);
  };
  // 머리글이 있는 데이터 표가 있으면 항상 그 표 (검색으로 행이 줄어도 같은 표를 본다)
  const dataTable = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]')).find(
    (t) => outside(t) && vis(t) && t.querySelector('th, [role="columnheader"]')
  );
  if (dataTable) return rowsOf(dataTable).slice(0, 100);
  let best = [];
  for (const c of document.querySelectorAll('ul, ol, [role="list"], [role="listbox"]')) {
    if (!outside(c)) continue;
    const texts = rowsOf(c);
    if (texts.length > best.length) best = texts;
  }
  return best.slice(0, 100);
}
/**
 * 표의 열 구성과 열마다의 값 형식. 값이 열과 맞게 나오는지(칸 수 · 날짜/시간/숫자 형식) 확인용.
 * tests/support/site.ts 의 tableData 와 같은 기준으로 셀을 읽는다.
 */
function tableLayoutInPage(table) {
  const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');
  const headRow = table.querySelector('thead tr') || table.querySelector('tr');
  if (!headRow) return null;
  const heads = Array.from(headRow.children).map((h) => clean(h.innerText));
  const body = Array.from(table.querySelectorAll('tbody tr')).filter((r) => r !== headRow && r.children.length === heads.length);
  const PLACEHOLDER = /^[-–—·]?$/;
  const KINDS = [
    ['date', /^\d{4}[-./]\d{1,2}[-./]\d{1,2}/],
    ['time', /^\d{1,2}:\d{2}(:\d{2})?$/],
    ['number', /^[-+]?[\d,]+(\.\d+)?\s*[가-힣%a-zA-Z]{0,3}$/],
  ];
  const cols = heads.map((name, i) => {
    const vals = body.slice(0, 30).map((r) => clean(r.children[i].innerText)).filter((v) => !PLACEHOLDER.test(v));
    const kind = vals.length ? (KINDS.find(([, re]) => vals.every((v) => re.test(v))) || ['text'])[0] : 'any';
    return { name, kind };
  });
  const r = table.getBoundingClientRect();
  return { heads, cols, rows: body.length, pos: { y: Math.round(r.top + scrollY), x: Math.round(r.left + scrollX) } };
}

/** 검색어로 쓸 값: 첫 항목에서 글자가 들어간 2~15자 단어 (실행 시점의 실제 데이터) */
const pickTerm = (row) => (row || '').split(/\s+/).find((w) => w.length >= 2 && w.length <= 15 && /[가-힣A-Za-z]/.test(w) && !/[()[\]{}|]/.test(w)) || null;
const NONE_TERM = 'zzqx없는검색어9';
const EMPTY_RE = /없|no (result|data|match)|not found|empty/i;
const SEARCH_HINT = /검색|search|찾기|조회|filter|필터/i;
const OPTION_SEL = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
// 페이지네이션 버튼 이름 (다음 · 이전 · 처음 · 마지막 · 페이지 번호)
const PAGER = /^(다음|이전|처음|마지막|다음 페이지|이전 페이지|next|prev|previous|first|last|next page|previous page|›|»|‹|«|>|<|>>|<<|\d{1,3})$/i;

/** 검색창: 목록의 실제 값으로 검색 → 결과가 그 값만 남는지, 없는 값 검색 → 결과 없음인지 */
async function probeSearch(page, loc) {
  const before = await page.evaluate(listRowsInPage).catch(() => []);
  if (before.length < 2) return null;
  const term = pickTerm(before[0]);
  if (!term) return null;
  const ok = await loc.fill(term).then(() => true).catch(() => false);
  if (!ok) return null;
  await loc.press('Enter').catch(() => {});
  await page.waitForTimeout(1500);
  const after = await page.evaluate(listRowsInPage).catch(() => []);
  if (!(after.length > 0 && after.every((r) => r.includes(term)))) return null;
  let noneEmpty = false;
  if (await loc.fill(NONE_TERM).then(() => true).catch(() => false)) {
    await loc.press('Enter').catch(() => {});
    await page.waitForTimeout(1500);
    const none = await page.evaluate(listRowsInPage).catch(() => null);
    noneEmpty = !!none && (none.length === 0 || none.every((r) => EMPTY_RE.test(r)));
  }
  return { type: 'search', noneEmpty, dirty: true };
}

/** 열린 드롭다운의 옵션을 하나씩 눌러 결과(선택 값 표시 · 목록 필터 · 페이지 이동)를 관찰 */
async function probeDropdownOptions(page, spec, opened, reset) {
  // 옵션이 많으면(연도 선택 등) 고르게 최대 8개
  const names = opened.names.length <= 8 ? opened.names : Array.from({ length: 8 }, (_, i) => opened.names[Math.round((i * (opened.names.length - 1)) / 7)]);
  const options = [];
  for (const name of [...new Set(names)]) {
    if (RISKY.test(name)) {
      options.push({ name, effect: 'skip' });
      continue;
    }
    await reset();
    const trigger = buildLocator(page, spec);
    const urlBefore = page.url();
    const listBefore = (await page.evaluate(listRowsInPage).catch(() => [])).join('|');
    const textBefore = await trigger.innerText({ timeout: 2000 }).catch(() => '');
    if (!(await trigger.click({ timeout: 5000 }).then(() => true).catch(() => false))) break;
    await page.waitForTimeout(500);
    const opt = page.getByRole(opened.role, { name, exact: true }).filter({ visible: true }).first();
    if (!(await opt.click({ timeout: 3000 }).then(() => true).catch(() => false))) {
      options.push({ name, effect: 'unclickable' });
      continue;
    }
    await page.waitForTimeout(1200);
    if (stripHash(page.url()) !== stripHash(urlBefore) && /^https?:/.test(page.url())) {
      options.push({ name, effect: 'navigate', url: page.url() });
      continue;
    }
    const textAfter = await trigger.innerText({ timeout: 1000 }).catch(() => '');
    const listAfter = (await page.evaluate(listRowsInPage).catch(() => [])).join('|');
    if (textAfter !== textBefore && textAfter.includes(name)) options.push({ name, effect: 'selected' });
    else if (listAfter !== listBefore) options.push({ name, effect: 'filtered' });
    else options.push({ name, effect: 'none' });
  }
  return { type: 'dropdown', optionRole: opened.role, options, dirty: true };
}

async function probeClick(page, loc, spec, noisy) {
  const before = await pageState(page);
  const expandedBefore = await loc.getAttribute('aria-expanded', { timeout: 1000 }).catch(() => null);
  const rowsBefore = await tableRowsOf(loc);
  const optionsBefore = await page.locator(OPTION_SEL).filter({ visible: true }).count().catch(() => 0);
  // 페이지네이션 후보: 다음/이전/숫자 버튼 → 누른 뒤 목록 내용이 바뀌는지
  const pagerLike = PAGER.test(spec.name || '');
  const listBefore = pagerLike ? (await page.evaluate(listRowsInPage).catch(() => [])).join('|') : '';

  // 같은 주소로 다시 불러오는 링크(현재 페이지를 가리키는 로고 등) 구분용 표시: 새로 불러오면 사라진다
  await page.evaluate(() => (window.__qaLoaded = true)).catch(() => {});
  let popup = null;
  let download = null;
  const onPopup = (p) => (popup = p);
  const onDownload = (d) => (download = d);
  page.context().on('page', onPopup); // rel="noopener · noreferrer" 새 탭은 page 의 popup 이벤트가 오지 않으므로 브라우저 단위로 감지
  page.on('download', onDownload);
  try {
    // 저절로 움직이는 요소는 '멈출 때까지' 기다리면 끝나지 않으므로 마우스를 올린 뒤 바로 누른다
    if (spec.moving) {
      await loc.hover({ force: true, timeout: 3000 });
      await loc.click({ force: true, timeout: 5000 });
    } else {
      await loc.click({ timeout: 5000 });
    }
  } catch (e) {
    page.context().off('page', onPopup);
    page.off('download', onDownload);
    return { type: 'unclickable', reason: e.message.split('\n')[0], dirty: true };
  }
  await page.waitForTimeout(1500);
  // 새 탭이 늦게 열리는 링크(외부 마켓 등)가 있으므로 화면 변화가 없으면 조금 더 기다린다
  if (!popup && !download && stripHash(page.url()) === stripHash(before.url)) {
    await page.context().waitForEvent('page', { timeout: 2500 }).then((p) => (popup = p)).catch(() => {});
  }
  page.context().off('page', onPopup);
  page.off('download', onDownload);

  // 파일 다운로드 (엑셀 다운로드 등): 파일 이름 기록, 테스트에서 파일이 비어 있지 않은지 확인
  if (download) {
    const filename = download.suggestedFilename();
    await download.cancel().catch(() => {});
    if (popup) await popup.close().catch(() => {});
    return { type: 'download', filename, dirty: false };
  }

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
    // 직접 연 페이지에서 누르니 이전 화면(빈 탭)으로 돌아감 → 뒤로가기 버튼
    if (page.url() === 'about:blank') return { type: 'back', dirty: true };
    if (!/^https?:/.test(page.url())) return { type: 'none', dirty: true };
    return { type: 'navigate', url: page.url(), dirty: true };
  }
  // 주소는 같지만 페이지를 새로 불러옴 → 같은 페이지로 이동 (새로 뜬 팝업 · 안내를 클릭 결과로 오해하지 않도록 여기서 끝낸다)
  if (/^https?:/.test(page.url()) && !(await page.evaluate(() => window.__qaLoaded === true).catch(() => true))) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { type: 'navigate', url: page.url(), dirty: true };
  }

  // 페이지네이션: 주소는 그대로인데 목록 내용이 바뀜
  if (pagerLike && listBefore) {
    const listAfter = (await page.evaluate(listRowsInPage).catch(() => [])).join('|');
    if (listAfter && listAfter !== listBefore) return { type: 'paginate', dirty: true };
  }

  // 드롭다운/메뉴: 클릭 후 옵션(option · menuitem)이 새로 나타났으면 옵션 목록을 기록 (옵션별 동작은 probe 에서 확인)
  const optionLoc = page.locator(OPTION_SEL).filter({ visible: true });
  if ((await optionLoc.count().catch(() => 0)) > optionsBefore) {
    const opts = await optionLoc
      .evaluateAll((els) => els.map((e) => ({ role: e.getAttribute('role'), name: (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\s+/g, ' ') })))
      .catch(() => []);
    const role = (opts[0] && opts[0].role) || 'option';
    const names = opts.filter((o) => o.role === role && o.name && o.name.length <= 40).map((o) => o.name);
    if (names.length) return { type: 'dropdownOpen', role, names, dirty: true };
  }

  const after = await pageState(page);
  // 숫자만 바뀐 줄(새로고침 후 '전체 690건' → '693건', 시계 등)은 새로 나타난 문구로 보지 않는다
  const shape = (t) => t.replace(/\d+(?:[.,:]\d+)*/g, '#');
  const beforeShapes = new Set(before.lines.map(shape));
  // 다시 나타난 팝업 · 안내 띠(닫기 · "보지 않기" 문구가 든 줄)는 클릭 결과가 아니다
  const fresh = (t) => !beforeShapes.has(shape(t)) && !noisy.has(t) && isAssertableText(t) && !POPUP_DISMISS.test(t) && !isPopupControl(t);

  const beforeKeys = new Set(before.overlays.map((o) => o.key));
  const newOverlay = after.overlays.find((o) => !beforeKeys.has(o.key));
  if (newOverlay) {
    let text = null;
    for (const t of [...newOverlay.lines.filter(fresh), ...newOverlay.lines.filter(isAssertableText)]) {
      if (await isVisibleText(page, t)) {
        text = t;
        break;
      }
    }
    if (text) {
      // 시트 · 모달 안의 항목(메뉴 · 제목)을 화면 순서대로 기록 → 테스트에서 항목과 순서까지 확인
      const items = [];
      for (const t of newOverlay.lines) {
        if (items.length >= 8) break;
        if (items.includes(t) || noisy.has(t) || !isAssertableText(t) || t.length > 40) continue;
        if (await isVisibleText(page, t)) items.push(t);
      }
      // 시트 안에서 선택되어 있는 항목(라디오 · 체크박스 · 선택된 탭): 기본 선택 상태도 기획 대상이다
      const selected = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('[role="radio"], input[type="radio"], [role="checkbox"], input[type="checkbox"], [role="tab"], [role="option"]'))
            .filter((e) => e.getBoundingClientRect().width > 0 && (e.checked || e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true'))
            .map((e) => ({ role: e.getAttribute('role') || (e.type === 'radio' ? 'radio' : 'checkbox'), name: (e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.innerText || '').trim().replace(/\s+/g, ' ') }))
            .filter((x) => x.name && x.name.length <= 30)
        )
        .catch(() => []);
      const selectedBefore = new Set(before.selected || []);
      const newlySelected = selected.filter((x) => !selectedBefore.has(`${x.role}|${x.name}`)).slice(0, 4);
      return { type: 'modal', text, ...(items.length >= 2 ? { items } : {}), ...(newlySelected.length ? { selected: newlySelected } : {}), ...(await probeDialogClose(page, text)), dirty: true };
    }
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

  // 표 머리글 정렬 버튼: 행 순서가 바뀌었으면 '표 정렬'
  if (rowsBefore !== null) {
    const rowsAfter = await tableRowsOf(loc);
    if (rowsAfter !== null && rowsAfter !== rowsBefore) return { type: 'sort', dirty: true };
  }

  for (const t of after.lines.filter(fresh)) {
    if (await isVisibleText(page, t)) return { type: 'reveal', text: t, dirty: true };
  }

  return { type: 'none', dirty: before.lines.length !== after.lines.length };
}

/**
 * 모달/시트가 뜬 상태에서 닫기 방법을 찾는다: 닫기 버튼 → ESC 순서.
 * 반환: { closeName } | { closeKey: 'Escape' } | {}
 */
async function probeDialogClose(page, text) {
  // 창 문구가 창 밖(누른 버튼 등)에도 있을 수 있으므로 '0개'가 아니라 '창이 열린 지금보다 줄었는가'로 판정
  const opened = await page.getByText(text).filter({ visible: true }).count();
  const isGone = async () => {
    await page.waitForTimeout(700);
    return (await page.getByText(text).filter({ visible: true }).count()) < opened;
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
    const zoneOf = (el) => {
      const z = el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]');
      if (!z) return 'main';
      if (z.matches('header, footer, [role="banner"], [role="contentinfo"]')) return 'common';
      const label = `${z.getAttribute('aria-label') || ''} ${z.className || ''}`;
      return z.closest('main, article, [role="main"]') || /pag|페이지|breadcrumb|toc|목차/i.test(label) ? 'main' : 'common';
    };
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
    // Shadow DOM(웹 컴포넌트) 안의 문구까지
    const deepEls = [];
    const walk = (root) =>
      root.querySelectorAll('*').forEach((e) => {
        deepEls.push(e);
        if (e.shadowRoot) walk(e.shadowRoot);
      });
    walk(document.body);
    for (const el of deepEls) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(el.tagName)) continue;
      // 클릭 요소 안의 문구/이미지는 그 요소의 '문구' 검사에서 확인한다
      if (el.closest(selector)) continue;
      // 개발 문서의 코드 예시는 문구(오타) 확인 대상이 아니다
      if (el.closest('pre, code, kbd, samp')) continue;
      // 표의 데이터 행은 실제 데이터라 계속 바뀌므로 문구로 확인하지 않는다 (표 구조 확인으로 대신)
      if (el.closest('tbody tr, [role="row"]') && !el.closest('thead, [role="columnheader"]')) continue;
      // 반복 목록(같은 형식 항목 3개 이상)은 첫 항목의 문구만 대표로 확인
      const item = el.closest('li, [role="listitem"]');
      if (item && item.parentElement) {
        const sibs = Array.from(item.parentElement.children).filter((s) => s.tagName === item.tagName);
        if (sibs.length >= 3 && sibs[0] !== item) continue;
      }
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
          if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.1) {
            visible = false;
            // display:none · 투명 처리로 숨기는 슬라이드: 숨겨진 슬라이드의 부모(슬라이드 목록)를 같은 롤링 영역으로 본다
            const box = a.parentElement;
            if (!clip && box && box !== document.body) {
              if (!box.dataset.qaClip) box.dataset.qaClip = String(++clipSeq);
              clip = box.dataset.qaClip;
              const br = box.getBoundingClientRect();
              clipY = Math.round(br.top + scrollY);
            }
          }
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
    // 항상 보이는 문구는 롤링이 아니다. 계속 숨어 있던 문구는 같은 영역에 롤링이 있을 때만 포함(관찰 시간 동안 차례가 안 온 슬라이드)
    if (h.seen !== samples || h.shown === samples || !h.clip) continue;
    if (!isAssertableText(text)) continue;
    if (!groups.has(h.clip)) groups.set(h.clip, { texts: [], toggled: 0, y: h.y });
    const g = groups.get(h.clip);
    g.texts.push(text);
    if (h.shown > 0) {
      g.toggled++;
      g.y = Math.min(g.y, h.y);
    }
  }
  // 보였다 안 보였다 하는 문구가 2개 이상이어야 롤링으로 본다 (깜빡임 하나는 제외)
  return [...groups.values()].filter((g) => g.toggled >= 2).map((g) => ({ texts: g.texts.slice(0, 10), pos: { y: g.y, x: 0 } }));
}

// 진행 로그용: 요소 종류 이름
const ROLE_LABEL = { link: '링크', button: '버튼', tab: '탭', menuitem: '메뉴', combobox: '선택 박스', checkbox: '체크박스', radio: '라디오', switch: '스위치', textbox: '입력창', searchbox: '검색창' };
function kindOf(cand, spec) {
  if (cand.tag === 'summary') return '펼치기';
  if (spec.unnamed) return `이름 없는 아이콘 ${ROLE_LABEL[spec.role] || cand.tag}`;
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

/**
 * collectCommon: 헤더/메뉴/푸터 요소까지 분석 (시작 페이지, 그리고 서브도메인마다 첫 페이지)
 * commonAsFeatures: 서브도메인 첫 페이지처럼 공통 요소를 그 페이지 기능으로 함께 테스트할 때
 */
async function analyzePage(newContext, pagePath, { commonSignatures, collectCommon, commonAsFeatures = false }) {
  const tag = pagePath;
  const step = (msg) => console.log(`   · [${tag}] ${msg}`);
  const url = urlOfTarget(pagePath);
  let cacheKey = null;
  // 페이지마다 새 브라우저 컨텍스트: 다른 페이지 분석 중 누른 버튼(사이드바 접기 등)이 남긴 상태가 섞이지 않게
  const context = await newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const result = { path: pagePath, url, title: '', status: 0, keyTexts: [], texts: [], images: [], rolling: [], tables: [], iframes: [], dataActions: [], pageType: 'general', features: [], common: [], skipped: [], errors };

  // 처음 연 상태(쿠키 · localStorage · sessionStorage)를 기억해두고, 클릭 탐지 후마다 이 상태로 되돌린다.
  // 생성된 테스트는 매번 새 브라우저에서 시작하므로, 분석도 같은 상태에서 관찰해야 결과가 어긋나지 않는다.
  let initialCookies = [];
  let initialStorage = { l: {}, s: {} };
  const resetState = async () => {
    await context.clearCookies().catch(() => {});
    if (initialCookies.length) await context.addCookies(initialCookies).catch(() => {});
    if (new URL(page.url()).origin !== new URL(url).origin) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page
      .evaluate((snap) => {
        localStorage.clear();
        for (const [k, v] of Object.entries(snap.l)) localStorage.setItem(k, v);
        sessionStorage.clear();
        for (const [k, v] of Object.entries(snap.s)) sessionStorage.setItem(k, v);
      }, initialStorage)
      .catch(() => {});
    await openForAnalysis(page, url).catch(() => {});
  };

  try {
    const response = await openForAnalysis(page, url);
    result.status = response ? response.status() : 0;
    result.title = await page.title();
    initialCookies = await context.cookies();
    initialStorage = await page
      .evaluate(() => ({ l: { ...localStorage }, s: { ...sessionStorage } }))
      .catch(() => ({ l: {}, s: {} }));

    // 접속 차단(봇 차단/오류 응답)이면 화면 요소로 테스트를 만들지 않는다 → 상태 코드 검증만 남겨 결과에 드러나게 함
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    if (result.status >= 400 || BOT_CHECK.test(`${result.title}\n${bodyText}`)) {
      result.blocked = result.status >= 400 ? `HTTP ${result.status}` : '봇 차단/보안 확인 페이지';
      result.pageType = 'blocked';
      console.warn(`   · [${tag}] 접속 차단 (${result.blocked}) → 이 페이지는 접속 상태만 검증합니다.`);
      return result;
    }

    // 오류 · 이용 불가 안내 화면: 테스트는 계속 만들지만(그 화면이 기획상 맞을 수 있음) 결과에 알린다
    result.errorScreen = await page
      .evaluate((src) => {
        const re = new RegExp(src, 'i');
        const visible = (el) => el.getBoundingClientRect().width > 0;
        const clickable = Array.from(document.querySelectorAll('a[href], button, [role="button"], input, select, textarea')).filter(visible).length;
        if (clickable > 4) return null;
        const heads = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).filter(visible).map((h) => h.innerText.trim());
        return heads.find((h) => re.test(h)) || null;
      }, ERROR_SCREEN.source)
      .catch(() => null);
    if (result.errorScreen) console.warn(`   · [${tag}] [주의] 안내 화면이 열림: "${result.errorScreen}" (언어 ${LOCALE}) — 이 화면 기준으로만 테스트됩니다. 언어 · 지역 · 로그인 조건을 바꿔 실행하면 실제 기능을 테스트할 수 있습니다.`);

    await scrollThrough(page);

    // AI 분석용 전체 화면 캡처 (너무 긴 페이지는 위쪽 6000px 까지)
    const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEWPORT.height);
    result.shot = await page
      .screenshot({ type: 'jpeg', quality: 60, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(height, 6000) } })
      .catch(() => null);

    // 분석 재사용: 화면 구조(클릭 요소 · 제목 · 링크 목적지, 숫자 제외)가 이전 분석과 같으면 클릭 탐지를 다시 하지 않는다
    if (analysisCache) {
      const structure = await page
        .evaluate(() => {
          const shape = (t) => (t || '').trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').slice(0, 60);
          return Array.from(document.querySelectorAll('a[href], button, [role="button"], [role="tab"], input, select, textarea, summary, h1, h2, h3'))
            .map((e) => `${e.tagName}|${shape(e.getAttribute('href'))}|${shape(e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder'))}`)
            .join('\n');
        })
        .catch(() => '');
      cacheKey = require('crypto')
        .createHash('md5')
        .update([APP_VERSION, LOCALE, STORAGE_STATE ? 'login' : '', CLICK_ALL ? 'all' : '', collectCommon, commonAsFeatures, structure].join('\n'))
        .digest('hex');
      const hit = analysisCache[url];
      if (hit && hit.key === cacheKey) {
        step('화면 구조가 이전 분석과 같아 이전 분석 결과를 재사용 (클릭 탐지 생략)');
        Object.assign(result, hit.result, { status: result.status, title: result.title, shot: result.shot, errors, cached: true });
        return result;
      }
    }

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
      // 열 이름과 열마다의 값 형식(날짜 · 시간 · 숫자 · 글자) → '표 데이터 형식' 케이스
      const layout = await t.evaluate(tableLayoutInPage).catch(() => null);
      if (rows > 0) result.tables.push({ nth: i, columns, rows, ...(layout && layout.heads.length >= 2 && layout.rows >= 1 ? { layout } : {}) });
    }

    // 임베드(iframe): 지도 · 결제 · 영상 · 채팅 위젯 등. 안의 요소까지는 분석하지 않고 정상 로드만 확인
    result.iframes = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('iframe'))
          .filter((f) => {
            const r = f.getBoundingClientRect();
            return r.width > 20 && r.height > 20;
          })
          .map((f) => ({ src: f.src || '', title: (f.title || f.name || '').trim() }))
          .slice(0, 10)
      )
      .catch(() => []);

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
    // 커버리지 집계: 찾은 클릭 요소가 어떻게 처리됐는지 (동작 확인 · 노출만 · 제외 사유별)
    const cov = { found: candidates.length, unidentified: 0, popup: 0, commonElsewhere: 0, repeated: 0 };
    result.coverage = cov;
    for (const cand of candidates) {
      const spec = await resolveLocator(page, cand);
      if (!spec) {
        cov.unidentified++;
        result.skipped.push({ reason: '식별 불가 (접근성 이름·고유 속성 없음)', tag: cand.tag, href: cand.href });
        continue;
      }
      if (isPopupControl(spec.name)) {
        cov.popup++;
        continue;
      }
      const signature = `${spec.role}|${spec.name}|${cand.href || ''}`;
      const isCommon = cand.zone === 'common';
      // 헤더 · 메뉴 · 푸터 공통 요소는 시작 페이지(또는 서브도메인 첫 페이지)에서 확인
      if ((isCommon && !collectCommon) || (!isCommon && commonSignatures.has(signature))) {
        cov.commonElsewhere++;
        continue;
      }
      // 부작용 위험 요소(삭제/결제/제출 등)도 노출·문구는 확인하고 클릭만 하지 않는다
      const risky = RISKY.test(spec.name) || (cand.type === 'submit' && !CLICK_ALL);
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

    // 복제본: 흐르는 배너 · 무한 캐러셀은 같은 항목을 복제해 이어 붙인다. 숨김 처리된 복제본 · 목적지가 같은 같은 이름 요소는 하나만 테스트
    const cloneKey = ({ cand, spec }) => (cand.href && !cand.href.startsWith('#') ? `${cand.tag}|${cand.href}|${cand.hasImg}` : null);
    const kept = new Map();
    for (const r of resolved) {
      const k = cloneKey(r);
      if (!k) continue;
      const prev = kept.get(k);
      if (!prev) {
        kept.set(k, r);
      } else if (r.cand.ariaHidden || !r.spec.name || r.spec.name === prev.spec.name) {
        r.clone = true;
      } else if (prev.cand.ariaHidden || !prev.spec.name) {
        prev.clone = true;
        kept.set(k, r);
      }
    }
    const clones = resolved.filter((r) => r.clone);
    if (clones.length) {
      for (let i = resolved.length - 1; i >= 0; i--) if (resolved[i].clone) resolved.splice(i, 1);
      cov.repeated += clones.length;
      result.skipped.push({ reason: `복제 항목: 같은 목적지 · 같은 이름(또는 숨김 복제본) ${clones.length}개는 하나만 확인` });
      step(`복제 항목 ${clones.length}개 (흐르는 배너 · 캐러셀 복제본 등) → 같은 목적지는 하나만 확인`);
    }

    // 움직이는 요소: 저절로 흐르는 배너 · 캐러셀. 위치를 두 번 재서 움직이면 표시 → 마우스를 올려 멈추는지까지 관찰
    const positions = () =>
      page
        .evaluate((ids) => ids.map((id) => { const e = document.querySelector(`[data-qa-idx="${id}"]`); const r = e ? e.getBoundingClientRect() : null; return r && r.width > 0 && r.height > 0 ? Math.round(r.left) : null; }), resolved.map((r) => r.cand.idx))
        .catch(() => []);
    const p1 = await positions();
    await page.waitForTimeout(800);
    const p2 = await positions();
    resolved.forEach((r, i) => {
      if (p1[i] !== null && p2[i] !== null && Math.abs(p1[i] - p2[i]) >= 3) r.moving = true;
    });
    for (const r of resolved.filter((x) => x.moving)) {
      const loc = buildLocator(page, r.spec);
      if (!(await loc.hover({ force: true, timeout: 2000 }).then(() => true).catch(() => false))) continue;
      await page.waitForTimeout(300);
      const a = await loc.boundingBox().catch(() => null);
      await page.waitForTimeout(800);
      const b = await loc.boundingBox().catch(() => null);
      r.pauseOnHover = !!(a && b && Math.abs(a.x - b.x) < 3);
      await page.mouse.move(0, 0);
    }
    const movingCount = resolved.filter((r) => r.moving).length;
    if (movingCount) step(`저절로 움직이는 요소 ${movingCount}개 (흐르는 배너 등) → 움직임 · 마우스 오버 시 멈춤 확인`);

    // 목록 반복 항목(표의 행 버튼, 달력 날짜, 같은 형식의 상세 링크 등)은 대표 1개만 테스트한다
    const repeatGroups = new Map();
    for (const r of resolved) {
      if (!r.cand.repeatKey) continue;
      if (!repeatGroups.has(r.cand.repeatKey)) repeatGroups.set(r.cand.repeatKey, []);
      repeatGroups.get(r.cand.repeatKey).push(r);
    }
    const dropped = new Set();
    for (const g of repeatGroups.values()) {
      if (g.length < 3) continue;
      g[0].repeatCount = g.length;
      g.slice(1).forEach((r) => dropped.add(r));
      result.skipped.push({ reason: `목록 반복 항목: 같은 유형 ${g.length}개 중 대표 1개만 확인`, name: g[0].spec.name || g[0].cand.href });
    }
    for (let i = resolved.length - 1; i >= 0; i--) if (dropped.has(resolved[i])) resolved.splice(i, 1);
    cov.repeated = dropped.size;
    if (dropped.size) step(`목록 반복 항목 ${dropped.size + [...repeatGroups.values()].filter((g) => g.length >= 3).length}개 → 같은 유형끼리 묶어 대표 ${[...repeatGroups.values()].filter((g) => g.length >= 3).length}개만 확인`);

    // 페이지당 탐지 개수 제한이 있으므로 상호작용 컴포넌트(버튼/토글/탭)를 링크보다 먼저 탐지한다
    const priority = ({ cand, spec }) => (cand.tag === 'a' || spec.role === 'link' ? 1 : 0);
    resolved.sort((a, b) => priority(a) - priority(b));

    const counts = { common: 0, features: 0 };
    for (const r of resolved) counts[r.bucket]++;
    step(`클릭·입력 가능한 요소 ${resolved.length}개 발견${collectCommon ? ` (헤더/메뉴/푸터 공통 ${counts.common}개 + 본문 ${counts.features}개)` : ''} → 하나씩 동작 확인`);

    const probedBy = { features: 0, common: 0 };
    let n = 0;
    for (const { cand, spec, signature, bucket, risky, repeatCount, moving, pauseOnHover } of resolved) {
      n++;
      // 이름 없는 아이콘 버튼은 화면 위치로 부른다 (구조 경로는 사람이 알아보기 어렵다)
      const label = spec.name || cand.href || (spec.unnamed ? `${cand.zone === 'common' ? '머리글' : '본문'} ${cand.pos.x < 400 ? '왼쪽' : cand.pos.x > 1000 ? '오른쪽' : '가운데'} 위치` : spec.selector) || spec.role;
      // 숫자만 있는 줄(알림 수 · 건수 · 금액 등)은 시간이 지나면 바뀌므로 문구 확인에서 뺀다
      const lines = cand.lines
        .filter((t) => !noisy.has(t) && !/^[\d\s.,:%+\-$₩()/]+$/.test(t))
        // 이름 끝 숫자 배지가 있는 요소(… 1)는 문구 확인에서도 숫자를 뺀다
        .map((t) => (spec.kind === 'roleBadge' ? t.replace(/\s+\d+\+?$/, '') : t));
      // fallbacks: 이름이 바뀌어도 찾을 수 있는 대체 로케이터 (태그+문구 → 구조 경로)
      const fallbacks = [
        ...(spec.kind !== 'text' && lines[0] ? [{ kind: 'text', tag: cand.tag, name: lines[0] }] : []),
        ...(cand.cssPath ? [{ kind: 'css', selector: cand.cssPath }] : []),
      ];
      const base = { label, signature, locator: spec, fallbacks, pageUrl: url, href: cand.href, kind: kindOf(cand, spec), lines, hasImg: cand.hasImg, pos: cand.pos, ...(repeatCount ? { repeatCount } : {}), ...(moving ? { moving, pauseOnHover } : {}) };
      const before = result[bucket].length;
      const where = collectCommon && bucket === 'common' ? '공통 ' : '';
      const report = (how) => {
        const added = result[bucket].length > before ? result[bucket][result[bucket].length - 1] : null;
        step(`(${n}/${resolved.length}) ${where}${kindOf(cand, spec)} "${short(String(label), 25)}" ${how} → ${added ? TYPE_LABEL[added.type] : '제외'}`);
      };

      // 클릭 없이 구조만으로 판별되는 패턴
      if (cand.disabled) {
        result[bucket].push({ ...base, type: 'disabled' });
        report('비활성 상태 확인');
        continue;
      }
      if (cand.anchorId) {
        // 목차 앵커는 페이지당 10개까지만 (문서 사이트는 수십 개라 테스트가 과도하게 늘어남)
        if (cand.skipLink) {
          result[bucket].push({ ...base, locator: { ...spec, anyVisibility: true }, fallbacks: [], type: 'anchor', anchorId: cand.anchorId, skipLink: true });
        } else if (result[bucket].filter((x) => x.type === 'anchor').length < 10) {
          result[bucket].push({ ...base, type: 'anchor', anchorId: cand.anchorId });
        } else {
          result[bucket].push({ ...base, type: 'display', reason: '목차 링크 이동 확인은 페이지당 10개까지' });
        }
        report('구조 확인');
        continue;
      }
      if (cand.tag === 'select') {
        // 옵션을 하나씩 선택해 본다 (많으면 고르게 최대 8개)
        const all = cand.selectOptions || [];
        const options = all.length <= 8 ? all : Array.from({ length: 8 }, (_, i) => all[Math.round((i * (all.length - 1)) / 7)]);
        if (options.length) result[bucket].push({ ...base, type: 'select', value: options[0].value, options });
        report(`옵션 ${options.length}개 확인`);
        continue;
      }
      if (['textbox', 'searchbox', 'spinbutton'].includes(spec.role) || cand.tag === 'textarea') {
        // 검색창이면 목록의 실제 값으로 검색해 결과가 맞게 걸러지는지까지 확인
        const isSearch = spec.role === 'searchbox' || cand.type === 'search' || SEARCH_HINT.test(`${spec.name} ${cand.label} ${cand.placeholder}`);
        const searched = isSearch ? await probeSearch(page, buildLocator(page, spec)) : null;
        if (searched) {
          result[bucket].push({ ...base, ...searched });
          await resetState();
          report('검색 확인');
        } else {
          if (isSearch) await resetState();
          result[bucket].push({ ...base, type: 'input', inputType: cand.type || 'text', formButton: cand.formButton, required: cand.required, pattern: cand.pattern, maxLength: cand.maxLength });
          report('입력 확인');
        }
        continue;
      }
      if (['checkbox', 'radio', 'switch'].includes(spec.role)) {
        result[bucket].push({ ...base, type: 'check' });
        report('선택 확인');
        continue;
      }
      if (risky) {
        result[bucket].push({ ...base, type: 'display', reason: RISKY_REASON });
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

      const effect = await probe(page, moving ? { ...spec, moving } : spec, noisy, resetState);
      if (effect.type === 'unclickable') {
        // 클릭은 안 되더라도 화면에 있는 요소이므로 노출·문구는 확인한다
        result[bucket].push({ ...base, type: 'display', reason: `분석 중 클릭 불가: ${short(effect.reason, 60)}`, ...(effect.tooltip ? { tooltip: effect.tooltip } : {}) });
      } else {
        result[bucket].push({ ...base, ...effect });
        // 전체 동작 확인으로 실제 데이터를 바꿨을 수 있는 클릭은 따로 기록 (결과 화면 · analysis.json)
        if (CLICK_ALL && (DATA_CHANGING.test(label) || BASE_RISKY.test(label) || cand.type === 'submit')) {
          result.dataActions.push({ label: short(String(label), 40), effect: TYPE_LABEL[effect.type] || effect.type });
        }
      }
      report(`${effect.tooltip ? `마우스 오버 "${short(effect.tooltip, 15)}" · ` : ''}${effect.type === 'unclickable' ? `클릭 불가(${short(effect.reason, 40)})` : '클릭'}`);

      if (effect.dirty) {
        await resetState();
      }
    }
    // 다음 실행에서 재사용할 수 있게 저장 (화면 캡처 · 오류 목록 제외)
    if (analysisCache && cacheKey && !result.cached) {
      const { shot, errors: _e, cached: _c, ...rest } = result;
      analysisCache[url] = { key: cacheKey, savedAt: new Date().toISOString(), result: rest };
    }
  } catch (e) {
    result.skipped.push({ reason: `페이지 분석 실패: ${e.message.split('\n')[0]}` });
  } finally {
    await context.close().catch(() => {});
  }
  if (commonAsFeatures) {
    result.features = [...result.common, ...result.features];
    result.common = [];
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
  search: '검색',
  dropdown: '드롭다운 옵션',
  sort: '표 정렬',
  download: '파일 다운로드',
  paginate: '목록 페이지 이동',
  display: '노출·문구만 확인',
  disabled: '비활성 상태',
  back: '뒤로가기',
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
      // 다른 사이트(광고·외부 링크)는 그 페이지를 분석하지 않고 해당 사이트로 이동하는지만 확인
      const external = u.origin !== BASE_URL;
      body.push(`await target.click();`);
      body.push(`await expect(page).toHaveURL(${urlMatcher(f.url, external)});`);
      const action = !isSameSite(u) ? `외부 사이트 이동 → ${u.host}` : external ? `페이지 이동 → ${u.host}${u.pathname}` : `페이지 이동 → ${u.pathname}`;
      return { action, body };
    }
    case 'download':
      // 파일 다운로드: 다운로드가 시작되고 파일이 비어 있지 않은지
      body.push(`const downloadPromise = page.waitForEvent('download');`);
      body.push(`await target.click();`);
      body.push(`const download = await downloadPromise;`);
      body.push(`const file = await download.path();`);
      body.push(`expect((await import('fs')).statSync(file).size, '내려받은 파일이 비어 있음').toBeGreaterThan(0);`);
      return { action: `파일 다운로드${f.filename ? ` "${q(f.filename, 30)}"` : ''}`, body };
    case 'paginate':
      // 페이지네이션: 누르면 목록 내용이 바뀌는지
      body.push(`const before = (await listRows(page)).join('|');`);
      body.push(`await target.click();`);
      body.push(`await expect.poll(async () => (await listRows(page)).join('|'), { message: '눌러도 목록이 바뀌지 않음' }).not.toBe(before);`);
      return { action: '목록 페이지 이동', body };
    case 'brokenLink':
      // 분석 시 연결에 실패한 링크: 정상 페이지로 열리는지 검증 (지금 상태면 실패로 보고됨)
      body.push(`await target.click();`);
      body.push(`await page.waitForLoadState('domcontentloaded');`);
      body.push(`expect(page.url(), '링크 이동 시 브라우저 오류 페이지가 열립니다 (연결 실패 또는 차단).').not.toMatch(/^chrome-error:/);`);
      return { action: '링크 연결 (분석 시 연결 실패)', body };
    case 'newTab': {
      body.push(`const popupPromise = page.context().waitForEvent('page');`);
      body.push(`await target.click();`);
      body.push(`const popup = await popupPromise;`);
      // 분석 때 새 탭 주소를 못 얻은 경우(about:blank 후 바로 닫힘 등)는 새 탭이 열리는지만 확인
      const valid = /^https?:/.test(f.url || '');
      if (valid) body.push(`await expect(popup).toHaveURL(${urlMatcher(f.url, true)});`);
      body.push(`await popup.close();`);
      return { action: valid ? `새 탭 열기 → ${new URL(f.url).host}` : '새 탭 열기', body };
    }
    case 'modal':
    case 'reveal':
      // 열린 창의 문구가 화면 다른 곳(누른 버튼 자체 등)에도 있을 수 있으므로
      // '보이는가'가 아니라 '보이는 개수가 늘었다가 원래대로 돌아오는가'로 판정한다
      body.push(`const shown = page.getByText(${textPattern(f.text, false)}).filter({ visible: true });`);
      body.push(`const before = await shown.count();`);
      body.push(`await target.click();`);
      body.push(`await expect.poll(() => shown.count(), { message: ${JSON.stringify(`클릭 후 "${short(f.text, 30)}" 이(가) 나타나지 않음`)} }).toBeGreaterThan(before);`);
      if (f.items) {
        // 시트 안 항목이 모두 보이고 분석 때와 같은 순서(위→아래, 같은 줄이면 왼→오른)인지
        body.push(`const items = ${JSON.stringify(f.items)};`);
        body.push(`const boxes = [];`);
        body.push(`for (const t of items) {`);
        body.push(`  const el = page.getByText(t, { exact: true }).filter({ visible: true }).last();`);
        body.push(`  await expect(el, '시트 항목이 보이지 않음: ' + t).toBeVisible();`);
        body.push(`  boxes.push(await el.boundingBox());`);
        body.push(`}`);
        body.push(`const inOrder = boxes.every((b, i) => i === 0 || !b || !boxes[i - 1] || b.y > boxes[i - 1].y + 2 || (Math.abs(b.y - boxes[i - 1].y) <= 2 && b.x >= boxes[i - 1].x));`);
        body.push(`expect(inOrder, '시트 항목 순서가 다름: ' + items.join(' › ')).toBe(true);`);
      }
      for (const s of f.selected || []) {
        // 기본 선택 상태 (분석 때 선택되어 있던 항목)
        const sel = ['tab', 'option'].includes(s.role) ? `toHaveAttribute('aria-selected', 'true')` : `toBeChecked()`;
        body.push(`await expect(page.getByRole(${JSON.stringify(s.role)}, { name: ${JSON.stringify(s.name)}, exact: true }).filter({ visible: true }).last(), ${JSON.stringify(`기본 선택이 "${s.name}" 이(가) 아님`)}).${sel};`);
      }
      // 모달: 분석 때 확인된 닫기 방법으로 닫히는지까지 검증
      if (f.closeName) {
        body.push(`await page.getByRole('button', { name: ${JSON.stringify(f.closeName)}, exact: true }).filter({ visible: true }).last().click();`);
        body.push(`await expect.poll(() => shown.count(), { message: '닫기 후에도 창이 남아 있음' }).toBe(before);`);
      } else if (f.closeKey) {
        body.push(`await page.keyboard.press(${JSON.stringify(f.closeKey)});`);
        body.push(`await expect.poll(() => shown.count(), { message: '닫기 후에도 창이 남아 있음' }).toBe(before);`);
      }
      return { action: `${TYPE_LABEL[f.type]} "${q(f.text)}"${f.items ? ` · 항목 ${f.items.map((t) => q(t, 15)).join(' › ')}` : ''}${f.closeName || f.closeKey ? ' 후 닫힘' : ''}`, body };
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
      if (f.skipLink) {
        // 건너뛰기 링크: 키보드 사용자처럼 포커스 후 Enter → 대상 영역으로 이동(주소 #대상 또는 포커스가 대상 안으로)하는지
        body.push(`await target.focus();`);
        body.push(`await page.keyboard.press('Enter');`);
        body.push(`await expect.poll(() => page.evaluate((id) => { const t = document.getElementById(id); return location.hash === '#' + id || (!!t && t.contains(document.activeElement)); }, ${JSON.stringify(f.anchorId)}), { message: '건너뛰기 링크로 대상 영역에 이동하지 않음' }).toBe(true);`);
        return { action: `건너뛰기 링크 (포커스 + Enter) → #${f.anchorId}`, body };
      }
      body.push(`await target.click();`);
      body.push(`await expect(page.locator(${JSON.stringify(`[id="${f.anchorId}"]`)})).toBeInViewport();`);
      return { action: `목차 이동 → #${f.anchorId}`, body };
    case 'sort':
      // 표 머리글 정렬: 누르기 전과 행 순서가 달라지는지
      body.push(`const rows = () => target.evaluate((el) => { const t = el.closest('table, [role="table"], [role="grid"]'); return t ? Array.from(t.querySelectorAll('tbody tr, [role="rowgroup"]:not(:first-child) [role="row"]')).slice(0, 10).map((r) => (r.textContent || '').trim().replace(/\\s+/g, ' ')).join('|') : ''; });`);
      body.push(`const before = await rows();`);
      body.push(`await target.click();`);
      body.push(`await expect.poll(rows, { message: '정렬 버튼을 눌러도 표의 행 순서가 바뀌지 않음' }).not.toBe(before);`);
      return { action: '표 정렬', body };
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
    case 'disabled':
      // 누르지 않고 상태만 확인 (disabled 속성 또는 aria-disabled)
      body.push(`await expect(target).toBeDisabled();`);
      return { action: '비활성 상태 (누를 수 없음)', body };
    case 'back': {
      // 다른 화면에서 들어온 뒤 누르면 그 화면으로 돌아가는지 (같은 사이트 첫 화면 → 이 화면 → 뒤로가기)
      const home = `${BASE_URL}/`;
      if (stripHash(f.pageUrl || '') !== home) {
        body.push(`await page.goto(${JSON.stringify(home)}, { waitUntil: 'domcontentloaded' });`);
        body.push(`await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });`);
        body.push(`await page.waitForTimeout(1500);`);
        body.push(`await target.click();`);
        body.push(`await expect(page).toHaveURL(${urlMatcher(home, false)});`);
      } else {
        body.push(`await target.click();`);
        body.push(`await expect.poll(() => page.url(), { message: '뒤로가기를 눌러도 이전 화면으로 돌아가지 않음' }).toBe('about:blank');`);
      }
      return { action: '뒤로가기 → 이전 화면', body };
    }
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
  const rep = f.repeatCount ? ` · 목록 ${f.repeatCount}개 중 대표` : '';
  out.push(`  test(${JSON.stringify(`${num(no)}. ${f.kind} "${q(shownName)}"${rep} (${f.id})`)}, async ({ page }) => {`);
  out.push(`    const { errors } = await openPage(page, TARGET_URL);`);
  out.push(`    const c = checks();`);
  // 기본 로케이터로 못 찾으면 대체 로케이터(문구 → 구조 경로)로 찾고 경고만 남긴다 (이름이 조금 바뀐 경우)
  const fallbacks = (f.fallbacks || []).map((fb) => locatorCode({ ...fb, nth: 0 }));
  if (fallbacks.length) {
    const FB = { text: '화면 문구', css: '구조 경로' };
    out.push(`    const { target, used } = await firstFound(page, [${[locatorCode(f.locator), ...fallbacks].join(', ')}]);`);
    out.push(`    c.soft('로케이터: 기본 이름으로 찾음', used === 0, \`기본 로케이터로 못 찾아 대체 로케이터(\${${JSON.stringify(['', ...(f.fallbacks || []).map((fb) => FB[fb.kind])])}[used]})로 찾음 — 이름이나 문구가 바뀌었을 수 있음\`);`);
  } else {
    out.push(`    const target = ${locatorCode(f.locator)};`);
  }
  if (f.skipLink) {
    // 건너뛰기 링크는 평소 숨어 있다가 키보드 포커스를 받을 때 쓰인다
    out.push(`    await c.run('노출 (키보드 포커스 시)', async () => { await target.focus(); await expect(target).toBeFocused(); }, { gate: true });`);
  } else {
    out.push(`    await c.run('노출', async () => { await expect(target).toBeVisible(); }, { gate: true });`);
  }
  if (f.moving) {
    // 저절로 흐르는 요소: 움직이는지, (분석 때 그랬다면) 마우스를 올리면 멈추는지
    out.push(`    const xAt = async () => (await target.boundingBox())?.x ?? 0;`);
    out.push(`    await c.run('움직임: 저절로 흐름', async () => { const a = await xAt(); await expect.poll(async () => Math.abs((await xAt()) - a), { message: '요소가 움직이지 않음' }).toBeGreaterThan(2); });`);
    if (f.pauseOnHover) {
      out.push(`    await c.run('움직임: 마우스를 올리면 멈춤', async () => { await target.hover({ force: true }); await page.waitForTimeout(300); const a = await xAt(); await page.waitForTimeout(800); expect(Math.abs((await xAt()) - a), '마우스를 올려도 계속 움직임').toBeLessThan(3); await page.mouse.move(0, 0); });`);
    }
  }
  if (f.locator.unnamed) out.push(`    c.soft('접근성: 화면 낭독기용 이름 있음', false, '이름(aria-label · 대체 텍스트)이 없는 아이콘 — 화면 낭독기 사용자는 용도를 알 수 없고, 테스트는 화면 구조 경로로 찾음');`);
  // 요소 안 문구는 줄마다 따로 확인 (버튼 문구 / 말풍선 문구 / 배너 제목·설명이 각각 결과로 보이도록)
  for (const l of f.lines || []) {
    out.push(`    await c.run(${JSON.stringify(`문구: "${q(l, 40)}"${hasNumber(l) ? ' (숫자는 형식만 확인)' : ''}`)}, async () => { await expect(target).toContainText(${textPattern(l, false)}); });`);
    if (typos.has(l)) out.push(`    c.warn(${JSON.stringify(l)}, ${JSON.stringify(typos.get(l))});`);
  }
  // 입력 검증 규칙: 제출하지 않고 브라우저의 유효성 검사(checkValidity)로 확인 → 데이터가 바뀌지 않는다
  if (f.type === 'input' || f.type === 'search') {
    const valid = `await target.evaluate((e) => (e as HTMLInputElement).checkValidity())`;
    if (f.required) {
      out.push(`    await c.run('입력 검증: 필수 입력 (비우면 제출 불가)', async () => { await target.fill(''); expect(${valid}, '비어 있어도 유효한 값으로 처리됨').toBe(false); });`);
    }
    const BAD = { email: ['이메일', 'not-an-email'], url: ['URL', 'not a url'] }[f.inputType];
    if (BAD) {
      out.push(`    await c.run(${JSON.stringify(`입력 검증: ${BAD[0]} 형식 (잘못된 값 거부)`)}, async () => {`);
      out.push(`      await target.fill(${JSON.stringify(BAD[1])});`);
      out.push(`      expect(${valid}, '잘못된 형식이 유효한 값으로 처리됨').toBe(false);`);
      out.push(`      await target.fill(${JSON.stringify(SAMPLE_INPUT[f.inputType])});`);
      out.push(`      expect(${valid}, '올바른 형식이 거부됨').toBe(true);`);
      out.push(`    });`);
    }
    if (f.pattern) {
      out.push(`    await c.run('입력 검증: 정해진 형식(pattern) 외 값 거부', async () => { await target.fill('!@#$%^'); expect(${valid}, '형식에 맞지 않는 값이 유효로 처리됨').toBe(false); });`);
    }
    if (f.maxLength) {
      out.push(`    await c.run(${JSON.stringify(`입력 검증: 최대 ${f.maxLength}자`)}, async () => {`);
      out.push(`      await target.fill('').catch(() => {});`);
      out.push(`      await target.pressSequentially('가'.repeat(${f.maxLength + 5}), { delay: 0 });`);
      out.push(`      expect((await target.inputValue()).length, '최대 길이보다 길게 입력됨').toBeLessThanOrEqual(${f.maxLength});`);
      out.push(`    });`);
    }
  }
  // 마우스 오버 메뉴(메가 메뉴)의 하위 링크: 올리면 나타나고, 누르면 이동하는지
  for (const l of f.hoverLinks || []) {
    const u = new URL(l.href);
    out.push(`    await c.run(${JSON.stringify(`마우스 오버 메뉴: "${q(l.name, 20)}" → ${isSameSite(u) ? u.pathname : u.host}`)}, async () => {`);
    out.push(`      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });`);
    out.push(`      await page.waitForTimeout(800);`);
    out.push(`      await target.hover();`);
    out.push(`      const link = page.getByRole('link', { name: ${JSON.stringify(l.name)}, exact: true }).filter({ visible: true }).first();`);
    if (l.blank) {
      out.push(`      const popupPromise = page.context().waitForEvent('page');`);
      out.push(`      await link.click();`);
      out.push(`      const popup = await popupPromise;`);
      out.push(`      await expect(popup).toHaveURL(${urlMatcher(l.href, true)});`);
      out.push(`      await popup.close();`);
    } else {
      out.push(`      await link.click();`);
      out.push(`      await expect(page).toHaveURL(${urlMatcher(l.href, u.origin !== BASE_URL)});`);
    }
    out.push(`    });`);
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
  } else if (f.type === 'select') {
    // 선택 박스: 옵션을 하나씩 선택
    for (const o of f.options) {
      out.push(`    await c.run(${JSON.stringify(`동작: 옵션 "${q(o.text || o.value, 25)}" 선택`)}, async () => {`);
      out.push(`      await target.selectOption(${JSON.stringify(o.value)});`);
      out.push(`      await expect(target).toHaveValue(${JSON.stringify(o.value)});`);
      out.push(`    });`);
    }
  } else if (f.type === 'dropdown') {
    // 드롭다운: 매번 처음 상태에서 열고 옵션 하나를 눌러 결과 확인
    const EFFECT = { navigate: '페이지 이동', selected: '선택 값 표시', filtered: '목록 변경', none: '오류 없음' };
    for (const o of f.options) {
      const name = `동작: 옵션 "${q(o.name, 25)}" 선택 → ${EFFECT[o.effect] || ''}`;
      if (o.effect === 'skip') {
        out.push(`    c.skip(${JSON.stringify(`동작: 옵션 "${q(o.name, 25)}" 선택`)}, ${JSON.stringify(RISKY_REASON)});`);
        continue;
      }
      if (o.effect === 'unclickable') {
        out.push(`    c.skip(${JSON.stringify(`동작: 옵션 "${q(o.name, 25)}" 선택`)}, '분석 중 옵션을 누를 수 없었음');`);
        continue;
      }
      out.push(`    await c.run(${JSON.stringify(name)}, async () => {`);
      out.push(`      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });`);
      out.push(`      await page.waitForTimeout(1200);`);
      out.push(`      const listBefore = (await listRows(page)).join('|');`);
      out.push(`      await target.click();`);
      out.push(`      await page.getByRole(${JSON.stringify(f.optionRole)}, { name: ${JSON.stringify(o.name)}, exact: true }).filter({ visible: true }).first().click();`);
      if (o.effect === 'navigate') {
        out.push(`      await expect(page).toHaveURL(${urlMatcher(o.url, new URL(o.url).origin !== BASE_URL)});`);
      } else if (o.effect === 'selected') {
        out.push(`      await expect(target).toContainText(${JSON.stringify(o.name)});`);
      } else if (o.effect === 'filtered') {
        out.push(`      await expect.poll(async () => (await listRows(page)).join('|'), { message: '옵션을 골라도 목록이 바뀌지 않음' }).not.toBe(listBefore);`);
      } else {
        out.push(`      await page.waitForTimeout(500);`);
        out.push(`      expect(errors, '옵션 선택 후 JS 런타임 오류').toEqual([]);`);
      }
      out.push(`    });`);
    }
  } else if (f.type === 'search') {
    // 검색창: 실행 시점 목록의 실제 값으로 검색 → 결과가 그 값만 남는지 / 없는 값 → 결과 없음
    out.push(`    await c.run('동작: 목록에 있는 값으로 검색 → 그 값만 표시', async () => {`);
    out.push(`      const term = pickTerm((await listRows(page))[0]);`);
    out.push(`      expect(term, '검색해 볼 목록 데이터가 없음').toBeTruthy();`);
    out.push(`      await target.fill(term!);`);
    out.push(`      await target.press('Enter');`);
    out.push(`      await expect.poll(async () => { const r = await listRows(page); return r.length > 0 && r.every((t) => t.includes(term!)); }, { message: \`"\${term}" 검색 결과가 없거나 다른 항목이 섞여 있음\` }).toBe(true);`);
    out.push(`    });`);
    if (f.noneEmpty) {
      out.push(`    await c.run('동작: 없는 값으로 검색 → 결과 없음', async () => {`);
      out.push(`      await target.fill(${JSON.stringify(NONE_TERM)});`);
      out.push(`      await target.press('Enter');`);
      out.push(`      await expect.poll(async () => { const r = await listRows(page); return r.length === 0 || r.every((t) => ${EMPTY_RE.toString()}.test(t)); }, { message: '없는 값을 검색했는데 결과가 나옴' }).toBe(true);`);
      out.push(`    });`);
    }
  } else {
    const { action, body } = actionCode(f);
    out.push(`    await c.run(${JSON.stringify(`동작: ${action}`)}, async () => {`);
    // 움직이는 요소: 마우스를 올린 뒤 바로 누른다 (멈추길 기다리면 시간 초과)
    body.forEach((l) => out.push(`      ${f.moving ? l.replace('await target.click();', 'await target.hover({ force: true }); await target.click({ force: true });') : l}`));
    out.push(`    });`);
    // 흐름: 목록 대표 링크 → 상세 페이지 → 뒤로가기 → 목록으로 돌아오는지
    if (f.repeatCount && f.type === 'navigate' && new URL(f.url).origin === BASE_URL) {
      out.push(`    await c.run('흐름: 목록 → 상세 → 뒤로가기 → 목록 복귀', async () => {`);
      out.push(`      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });`);
      out.push(`      await page.waitForTimeout(800);`);
      out.push(`      await target.click();`);
      out.push(`      await expect(page).toHaveURL(${urlMatcher(f.url, false)});`);
      out.push(`      await page.goBack();`);
      out.push(`      await expect(page).toHaveURL(${urlMatcher(f.pageUrl || BASE_URL, false)});`);
      out.push(`      await expect(target, '뒤로가기 후 목록이 보이지 않음').toBeVisible();`);
      out.push(`    });`);
    }
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
      out.push(`    await c.run(${JSON.stringify(`문구 노출: "${q(it.text, 40)}"${hasNumber(it.text) ? ' (숫자는 형식만 확인)' : ''}`)}, async () => {`);
      out.push(`      await expect(page.getByText(${hasNumber(it.text) ? textPattern(it.text, true) : `${JSON.stringify(it.text)}, { exact: true }`}).filter({ visible: true }).first()).toBeVisible();`);
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

/** 표 데이터 형식: 열 구성 · 모든 행의 칸 수 · 열마다 값 형식(날짜/시간/숫자)이 맞는지 */
function tableTest(t, no) {
  const { heads, cols } = t.layout;
  const KIND = {
    date: ['날짜', String.raw`^\d{4}[-./]\d{1,2}[-./]\d{1,2}`],
    time: ['시간', String.raw`^\d{1,2}:\d{2}(:\d{2})?$`],
    number: ['숫자', String.raw`^[-+]?[\d,]+(\.\d+)?\s*[가-힣%a-zA-Z]{0,3}$`],
  };
  const out = [];
  out.push(`  test(${JSON.stringify(`${num(no)}. 표 데이터 형식 "${q(heads.join(' · '), 40)}"`)}, async ({ page }) => {`);
  out.push(`    await openPage(page, TARGET_URL);`);
  out.push(`    const data = await tableData(page.getByRole('table').nth(${t.nth}));`);
  out.push(`    const c = checks();`);
  out.push(`    await c.run(${JSON.stringify(`열 구성: ${heads.join(' · ')}`)}, async () => { expect(data.heads).toEqual(${JSON.stringify(heads)}); }, { gate: true });`);
  out.push(`    await c.run(${JSON.stringify(`모든 행의 칸 수 = 열 ${heads.length}개`)}, async () => {`);
  out.push(`      const bad = data.rows.filter((r) => r.length !== ${heads.length} && r.length > 1).map((r) => r.join(' | '));`);
  out.push(`      expect(bad, '열 개수와 칸 수가 다른 행').toEqual([]);`);
  out.push(`    });`);
  cols.forEach((col, i) => {
    if (!KIND[col.kind]) return;
    const [label, re] = KIND[col.kind];
    out.push(`    await c.run(${JSON.stringify(`"${q(col.name, 15)}" 열 = ${label} 형식`)}, async () => {`);
    out.push(`      const bad = data.rows.filter((r) => r.length === ${heads.length}).map((r) => r[${i}]).filter((v) => !/^[-–—·]?$/.test(v) && !new RegExp(${JSON.stringify(re)}).test(v));`);
    out.push(`      expect(bad, ${JSON.stringify(`"${col.name}" 열에 ${label} 형식이 아닌 값`)}).toEqual([]);`);
    out.push(`    });`);
  });
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
/** 페이지 단위 점검 케이스: 로드 · 네트워크 · 성능 · 임베드 / 모바일 / 접근성 / 404 / 공통 메뉴 */
// 언어 고유 글자: 다른 언어 화면에 이 글자가 남아 있으면 번역 누락 의심
const LANG_SCRIPT = { ko: /[가-힣]/, ja: /[ぁ-ゟ゠-ヿ]/, th: /[฀-๿]/ };

/** 다국어(XLT) 한 언어: 그 언어로 열었을 때 치환 · 번역 상태 */
function xltTest(page, loc) {
  const out = [];
  const baseLang = LOCALE.split('-')[0];
  const lang = loc.split('-')[0];
  out.push(``);
  out.push(`  test(${JSON.stringify(`00-5. 다국어 (${loc})`)}, async ({ browser }) => {`);
  // 로그인 상태로 실행 중이면 다른 언어 화면도 같은 로그인으로 연다
  out.push(`    const ctx = await browser.newContext({ locale: ${JSON.stringify(loc)}, viewport: { width: ${VIEWPORT.width}, height: ${VIEWPORT.height} }, ...(process.env.QA_STORAGE_STATE ? { storageState: process.env.QA_STORAGE_STATE } : {}) });`);
  out.push(`    const p = await ctx.newPage();`);
  out.push(`    const { response } = await openPage(p, TARGET_URL);`);
  out.push(`    const c = checks();`);
  out.push(`    await c.run(${JSON.stringify(`${loc}: HTTP 응답 정상`)}, async () => { expect(response?.status() ?? 0).toBeLessThan(400); });`);
  out.push(`    const notice = await errorScreenText(p);`);
  out.push(`    c.soft(${JSON.stringify(`${loc}: 서비스 화면 (안내 화면 아님)`)}, !notice, '안내 화면이 열림: ' + notice + ' — 이 언어를 지원하지 않는 기획이면 정상');`);
  out.push(`    await c.run(${JSON.stringify(`${loc}: 문구 치환 누락 없음 ({{변수}} · 번역 키)`)}, async () => { expect(await textIssues(p), '변수 · 번역 키가 그대로 보이는 문구').toEqual([]); });`);
  out.push(`    const body = await p.locator('body').innerText();`);
  if (LANG_SCRIPT[baseLang] && lang !== baseLang) {
    out.push(`    const left = body.split('\\n').map((t) => t.trim()).filter((t) => ${LANG_SCRIPT[baseLang].toString()}.test(t));`);
    out.push(`    c.soft(${JSON.stringify(`${loc}: 기본 언어(${LOCALE}) 문구가 남아 있지 않음 (번역 누락)`)}, left.length === 0, left.length + '줄 · 예: ' + left.slice(0, 3).join(' / '));`);
  }
  // 분석 때(기본 언어) 핵심 문구가 그대로 있으면 번역이 적용되지 않은 것
  const keys = (page.keyTexts || []).filter((t) => !hasNumber(t)).slice(0, 5);
  if (keys.length) {
    out.push(`    const same = ${JSON.stringify(keys)}.filter((t) => body.includes(t));`);
    out.push(`    c.soft(${JSON.stringify(`${loc}: 핵심 문구가 번역됨`)}, same.length < ${keys.length}, '기본 언어 문구가 그대로: ' + same.slice(0, 3).join(' / '));`);
  }
  out.push(`    await ctx.close();`);
  out.push(`    c.done();`);
  out.push(`  });`);
  return out;
}

function pageLevelTests(page, { isStart, commonFeatures }) {
  const out = [];
  out.push(``);
  out.push(`  test('00. 페이지 로드 (HTTP · 이미지 · JS 오류 · 네트워크 · 성능)', async ({ page }) => {`);
  out.push(`    const { response, errors, network, consoleErrors, mixed } = await openPage(page, TARGET_URL);`);
  out.push(`    const c = checks();`);
  out.push(`    await c.run('HTTP 응답 정상', async () => { expect(response?.status() ?? 0).toBeLessThan(400); });`);
  if (page.blocked) {
    // 분석 시 접속이 차단된 페이지: 차단이 풀렸는지만 확인하고 나머지는 생략
    out.push(`    await c.run('봇 차단/보안 확인 페이지가 아님', async () => {`);
    out.push(`      await expect(page.getByText(${BOT_CHECK.toString()}).first(), ${JSON.stringify(`분석 시 접속 차단됨 (${page.blocked}). 사이트가 자동화 접근을 막고 있습니다.`)}).toHaveCount(0);`);
    out.push(`    });`);
    out.push(`    c.done();`);
    out.push(`  });`);
    return out;
  }
  for (const t of page.tables || []) {
    out.push(`    await c.run(${JSON.stringify(`표 구조: ${t.nth + 1}번째 표 (컬럼 ${t.columns}개, 데이터 행 있음)`)}, async () => {`);
    out.push(`      const table = page.getByRole('table').nth(${t.nth});`);
    if (t.columns) out.push(`      await expect(table.getByRole('columnheader')).toHaveCount(${t.columns});`);
    out.push(`      expect(await table.getByRole('row').count()).toBeGreaterThan(${t.columns ? 1 : 0});`);
    out.push(`    });`);
  }
  out.push(`    await c.run('이미지 정상 로드', async () => { expect(await brokenImages(page), '깨진 이미지').toEqual([]); });`);
  out.push(`    await c.run('JS 런타임 오류 없음', async () => { expect(errors).toEqual([]); });`);
  // 화면에 안 보이는 API · 리소스 실패도 잡는다 (같은 사이트의 404 · 5xx · 연결 실패)
  out.push(`    await c.run('네트워크 요청 실패 없음 (같은 사이트 404 · 5xx)', async () => { expect([...new Set(network)], \`실패한 요청: \${[...new Set(network)].slice(0, 3).join(' / ')}\`).toEqual([]); });`);
  // 화면 문구 이상: 치환 안 된 변수({{token}}) · 번역 키 그대로 노출 · undefined/NaN
  out.push(`    await c.run('문구 치환 누락 없음 ({{변수}} · 번역 키 · undefined/NaN)', async () => { expect(await textIssues(page), '변수 · 번역 키가 그대로 보이는 문구').toEqual([]); });`);
  // 안내 화면: 분석 때 이미 안내 화면이었으면(기획상 맞을 수 있음) 그 화면이 유지되는지, 아니었으면 안내 화면으로 바뀌지 않았는지
  if (page.errorScreen) {
    out.push(`    await c.run(${JSON.stringify(`안내 화면 유지: "${q(page.errorScreen, 40)}" (분석 때 ${LOCALE} 에서 열린 화면)`)}, async () => { expect(await errorScreenText(page), '분석 때와 다른 화면이 열림').toBeTruthy(); });`);
  } else {
    out.push(`    await c.run('오류 · 이용 불가 안내 화면이 아님', async () => { const t = await errorScreenText(page); expect(t, '안내 화면이 열림: ' + t).toBeNull(); });`);
  }
  if (page.iframes && page.iframes.length) {
    out.push(`    await c.run(${JSON.stringify(`임베드(iframe) ${page.iframes.length}개 정상 로드`)}, async () => {`);
    out.push(`      const bad = page.frames().filter((f) => f !== page.mainFrame() && /^chrome-error:/.test(f.url())).map((f) => f.url() || f.name());`);
    out.push(`      expect(bad, '오류 페이지로 열린 임베드').toEqual([]);`);
    out.push(`    });`);
  }
  out.push(`    c.soft('콘솔 오류 없음', consoleErrors.length === 0, [...new Set(consoleErrors)].slice(0, 3).join(' / '));`);
  out.push(`    c.soft('보안: https 페이지에 http 리소스 없음', mixed.length === 0, [...new Set(mixed)].slice(0, 3).join(' / '));`);
  // 성능 기준: LCP 4초(Core Web Vitals '나쁨' 경계) · 전체 로드 10초. 초과하면 경고
  out.push(`    const perf = await perfMetrics(page);`);
  out.push(`    c.soft('성능: 주요 콘텐츠 표시(LCP) 4초 이내', !perf.lcp || perf.lcp <= 4000, \`LCP \${(perf.lcp / 1000).toFixed(1)}초\`);`);
  out.push(`    c.soft('성능: 페이지 전체 로드 10초 이내', !perf.load || perf.load <= 10000, \`로드 \${(perf.load / 1000).toFixed(1)}초\`);`);
  out.push(`    c.done();`);
  out.push(`  });`);

  // 모바일 화면: 가로 스크롤(레이아웃 넘침) 없는지
  out.push(``);
  out.push(`  test('00-1. 모바일 화면(390×844) 레이아웃', async ({ page }) => {`);
  out.push(`    await page.setViewportSize({ width: 390, height: 844 });`);
  out.push(`    await openPage(page, TARGET_URL);`);
  out.push(`    const c = checks();`);
  out.push(`    const o = await mobileOverflow(page);`);
  out.push(`    await c.run('모바일: 가로로 넘치는 요소 없음 (가로 스크롤 없음)', async () => { expect(o.overflow, \`화면보다 \${o.overflow}px 넓음: \${o.wide.join(' / ')}\`).toBeLessThanOrEqual(1); });`);
  out.push(`    c.done();`);
  out.push(`  });`);

  // 접근성: 위반은 실패가 아니라 경고 (사이트 대부분에 있어 실패로 두면 결과가 묻힌다)
  out.push(``);
  out.push(`  test('00-2. 접근성 점검 (WCAG 2 A/AA)', async ({ page }) => {`);
  out.push(`    await openPage(page, TARGET_URL);`);
  out.push(`    const c = checks();`);
  out.push(`    const violations = await axeScan(page).catch(() => null);`);
  out.push(`    if (violations === null) c.skip('접근성 점검', '접근성 검사 도구를 실행하지 못함');`);
  out.push(`    else if (!violations.length) c.soft('접근성: 위반 없음', true);`);
  out.push(`    else for (const v of violations.slice(0, 10)) c.soft(\`접근성: \${v.help} (\${v.impact})\`, false, \`\${v.count}곳 · 규칙 \${v.id} · 예: \${v.target}\`);`);
  out.push(`    c.done();`);
  out.push(`  });`);

  // 시작 페이지: 없는 주소를 열었을 때 404 안내가 나오는지
  if (isStart) {
    out.push(``);
    out.push(`  test('00-3. 없는 주소 → 404 안내', async ({ page }) => {`);
    out.push(`    const res = await page.goto(new URL('/qa-not-found-zzqx-404', TARGET_URL).href, { waitUntil: 'domcontentloaded' });`);
    out.push(`    await page.waitForTimeout(1500);`);
    out.push(`    const c = checks();`);
    out.push(`    const status = res?.status() ?? 0;`);
    out.push(`    const text = await page.locator('body').innerText().catch(() => '');`);
    out.push(`    c.soft('없는 주소 → 404 상태 또는 안내 문구', status >= 400 || /404|찾을 수 없|존재하지 않|없는 페이지|not found/i.test(text), \`HTTP \${status} · 404 안내 없이 다른 화면이 표시됨\`);`);
    out.push(`    c.done();`);
    out.push(`  });`);
  }

  // 다국어(XLT): 다른 언어로 같은 화면을 열어 번역 · 치환 상태를 확인. 언어별 지원 여부는 기획에 따라 다르므로 안내 화면은 경고로만 남긴다
  for (const loc of XLT_LOCALES.filter((l) => l !== LOCALE)) out.push(...xltTest(page, loc));

  // 세부 페이지: 시작 페이지에서 확인한 헤더 · 메뉴 · 푸터가 이 페이지에도 보이는지 (노출만)
  if (!isStart && commonFeatures && commonFeatures.length) {
    out.push(``);
    out.push(`  test(${JSON.stringify(`00-4. 공통 메뉴 노출 (헤더 · 메뉴 · 푸터 ${Math.min(commonFeatures.length, 12)}개)`)}, async ({ page }) => {`);
    out.push(`    await openPage(page, TARGET_URL);`);
    out.push(`    const c = checks();`);
    for (const f of commonFeatures.slice(0, 12)) {
      const shown = f.lines && f.lines.length ? f.lines.join(' ') : f.label;
      out.push(`    await c.run(${JSON.stringify(`노출: ${f.kind} "${q(shown, 25)}"`)}, async () => { await expect(${locatorCode(f.locator)}).toBeVisible(); });`);
    }
    out.push(`    c.done();`);
    out.push(`  });`);
  }
  return out;
}

function specSource({ describeTitle, page, features, typos, isStart = false, commonFeatures = [] }) {
  const out = specHeader({ describeTitle, env: ENV, supportPath: '../support/site', generator: 'scripts/generate-specs.js' });
  out.push(``);
  out.push(`  const TARGET_URL = ${JSON.stringify(page.url)};`);
  out.push(...pageLevelTests(page, { isStart, commonFeatures }));
  if (page.blocked) return [...out, `});`, ``].join('\n');

  // 화면 순서 정렬 (위→아래, 같은 줄이면 왼쪽→오른쪽)
  const items = [
    ...features.map((f) => ({ kind: 'element', f, pos: f.pos })),
    ...page.texts.map((t) => ({ kind: 'text', text: t.text, pos: t.pos })),
    ...page.images.map((i) => ({ kind: 'image', name: i.name, pos: i.pos })),
    ...page.rolling.map((g) => ({ kind: 'rolling', g, pos: g.pos })),
    // 표: 머리글 바로 아래 순서에 '표 데이터 형식' 케이스
    ...(page.tables || []).filter((t) => t.layout).map((t) => ({ kind: 'table', t, pos: { y: t.layout.pos.y + 1, x: t.layout.pos.x } })),
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
    const build = { element: () => elementTest(it.f, no + 1, typos), rolling: () => rollingTest(it.g, no + 1, typos), table: () => tableTest(it.t, no + 1) }[it.kind];
    // 케이스 하나를 만들다 오류가 나도 그 케이스만 빼고 계속 (분석 전체를 잃지 않도록)
    try {
      const lines = build();
      no++;
      out.push(``, ...lines);
    } catch (e) {
      console.warn(`   ⚠ [${page.path}] 케이스 생성 건너뜀 (${it.kind}${it.f ? ` "${short(String(it.f.label), 20)}"` : ''}): ${e.message}`);
    }
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
    // 경고형 점검(성능 · 콘솔 · 404 등). 이름이 실행 때 정해지는 접근성 항목은 결과에서 추가된다
    else if ((m = line.match(new RegExp(`^\\s+c\\.soft\\(${STR}`)))) cur.checks.push({ name: lit(m[1]), kind: 'soft' });
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

  // Headless Shell 을 따로 포함하지 않으므로 전체 Chromium 으로 백그라운드 실행
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  // 생성된 테스트와 같은 시작 상태(로그인 상태 파일만 있는 새 브라우저)로 만든다
  // 로그인 상태 파일의 sessionStorage(Playwright 기본 저장에는 없음)는 페이지 스크립트보다 먼저 넣는다
  const savedSession = STORAGE_STATE ? JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf-8')).sessionStorage || [] : [];
  const newContext = async () => {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      locale: LOCALE,
      timezoneId: TIMEZONE,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
    });
    if (savedSession.length) await ctx.addInitScript(restoreSessionStorage, savedSession);
    return ctx;
  };
  if (CACHE_FILE) {
    try {
      analysisCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } catch {
      analysisCache = {};
    }
  }
  const context = await newContext(); // 페이지 발굴용
  if (STORAGE_STATE) console.log('[로그인] 저장된 로그인 상태로 분석합니다.');

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
  const home = await analyzePage(newContext, startPath, { commonSignatures: new Set(), collectCommon: true });
  const commonSignatures = new Set([...home.common, ...home.features].map((f) => f.signature));
  if (STORAGE_STATE && [...home.common, ...home.features].some((f) => f.inputType === 'password')) {
    console.warn('[로그인] 저장된 로그인으로 열었는데 비밀번호 입력창이 보입니다. 로그인이 만료되었을 수 있으니 "로그인 창 열기"로 다시 로그인해주세요.');
  }
  console.log(`  -> 시작 페이지 기능 ${home.features.length}개, 공통 기능 ${home.common.length}개`);

  // 다른 서브도메인(같은 사이트)은 헤더/메뉴가 다를 수 있으므로 서브도메인마다 첫 페이지에서 그 공통 요소도 확인
  const firstOfHost = new Set();
  const seenHosts = new Set([new URL(START_URL).host]);
  for (const p of subPaths) {
    const host = new URL(urlOfTarget(p)).host;
    if (!seenHosts.has(host)) {
      seenHosts.add(host);
      firstOfHost.add(p);
    }
  }

  console.log(`\n[3/4] 세부 페이지 ${subPaths.length}개 분석: 각 페이지 본문의 링크·버튼·펼치기·입력 요소 동작 확인 중 (동시 ${CONCURRENCY}개)...`);
  let done = 0;
  const subs = await runPool(subPaths, CONCURRENCY, async (p) => {
    const ownCommon = firstOfHost.has(p);
    const r = await analyzePage(newContext, p, { commonSignatures, collectCommon: ownCommon, commonAsFeatures: ownCommon });
    done++;
    console.log(`  -> [${done}/${subPaths.length}] ${p} 완료: 기능 ${r.features.length}개 탐지${r.skipped.length ? `, 제외 ${r.skipped.length}개` : ''}`);
    return r;
  });
  await browser.close();
  if (CACHE_FILE && analysisCache) {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(analysisCache), 'utf-8');
    const reused = [home, ...subs].filter((r) => r.cached).length;
    if (reused) console.log(`  -> 화면 구조가 그대로인 ${reused}개 페이지는 이전 분석을 재사용했습니다.`);
  }

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
    // 같은 호스트의 세부 페이지는 시작 페이지의 헤더 · 메뉴 · 푸터가 보이는지도 확인
    const sameHost = new URL(r.url).host === new URL(home.url).host;
    const src = specSource({ describeTitle, page: r, features, typos, isStart: i === 0, commonFeatures: i > 0 && sameHost ? commonFeatures : [] });
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
  // 커버리지: 찾은 클릭 요소 중 동작까지 확인한 비율. 다른 페이지에서 확인한 공통 요소 · 대표로 묶인 반복 항목은 분모에서 뺀다
  const coverageOf = (r, i) => {
    const c = r.coverage || { found: 0, unidentified: 0, popup: 0, commonElsewhere: 0, repeated: 0 };
    const feats = i === 0 ? [...r.common, ...r.features] : r.features;
    const action = feats.filter((f) => !['display', 'none'].includes(f.type)).length;
    const errorOnly = feats.filter((f) => f.type === 'none').length;
    const displayOnly = feats.filter((f) => f.type === 'display').length;
    const denom = action + errorOnly + displayOnly + c.unidentified;
    const rate = denom ? Math.round(((action + errorOnly) / denom) * 100) : 100;
    const warnings = [];
    if (c.unidentified) warnings.push(`식별할 수 없어 테스트하지 못한 요소 ${c.unidentified}개`);
    if (denom && rate < 70) warnings.push(`동작 확인률 ${rate}% (70% 미만)`);
    return { ...c, action, errorOnly, displayOnly, rate, warnings };
  };
  const pages = all.map(({ path: p, url, title, status, blocked, errorScreen, keyTexts, texts, images, rolling, tables, iframes, dataActions, pageType, features, skipped, errors, shot, cached }, i) => {
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
      errorScreen: errorScreen || null,
      pageType,
      tables,
      screenshot,
      features: strip(features),
      skipped,
      errors,
      iframes: iframes || [],
      dataActions: dataActions || [],
      coverage: blocked ? null : coverageOf(all[i], i),
      ...(cached ? { cached: true } : {}),
    };
  });
  const typoList = [];
  for (const [text, reasons] of typos) {
    const where = all.filter((r) =>
      [...r.texts.map((t) => t.text), ...r.rolling.flatMap((g) => g.texts), ...[...r.features, ...r.common].flatMap((f) => [...(f.lines || []), f.tooltip])].includes(text)
    );
    typoList.push({ text, reasons, pages: where.map((r) => r.path) });
  }
  // 사이트 전체 커버리지 합계
  const covPages = pages.filter((p) => p.coverage);
  const sum = (k) => covPages.reduce((n, p) => n + (p.coverage[k] || 0), 0);
  const covDenom = sum('action') + sum('errorOnly') + sum('displayOnly') + sum('unidentified');
  const coverage = {
    found: sum('found'),
    action: sum('action'),
    errorOnly: sum('errorOnly'),
    displayOnly: sum('displayOnly'),
    unidentified: sum('unidentified'),
    commonElsewhere: sum('commonElsewhere'),
    repeated: sum('repeated'),
    rate: covDenom ? Math.round(((sum('action') + sum('errorOnly')) / covDenom) * 100) : 100,
    lowPages: covPages.filter((p) => p.coverage.warnings.length).map((p) => ({ path: p.path, warnings: p.coverage.warnings })),
  };
  console.log(`  -> 커버리지: 클릭 요소 ${coverage.found}개 중 동작 확인 ${coverage.action + coverage.errorOnly}개 · 노출만 ${coverage.displayOnly}개 · 식별 불가 ${coverage.unidentified}개 → 동작 확인률 ${coverage.rate}%`);
  const analysis = {
    meta: { baseUrl: BASE_URL, startUrl: START_URL, scope: SCOPE, ...ENV, generatedAt: new Date().toISOString(), appVersion: APP_VERSION },
    common: { id: pid(0), url: home.url, features: strip(commonFeatures) },
    pages,
    coverage,
    typos: typoList,
    // 결과를 볼 때 알아야 할 점 (안내 화면만 열린 페이지 등)
    notices: pages.filter((p) => p.errorScreen).map((p) => `${p.path}: 안내 화면 "${p.errorScreen}" 이(가) 열려 이 화면 기준으로만 테스트했습니다 (언어 ${LOCALE}). 기획상 맞는 화면이면 정상이며, 다른 언어 · 지역 · 로그인 조건으로 실행하면 실제 기능을 테스트할 수 있습니다.`),
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
