import { Page, expect, test } from '@playwright/test';

// 팝업/쿠키 배너 처리 패턴 (scripts/generate-specs.js 의 분석 로직과 동일하게 유지)
const POPUP_DISMISS = /(오늘\s*하루|\d+\s*일\s*동안|다시)\s*(보지|열지)\s*않기|don'?t\s+show\s+(again|today)/i;
const POPUP_CONSENT = /^(accept|accept all|allow all|agree|모두 허용|동의|동의합니다)$/i;
const POPUP_CLOSE = /^(닫기|close|dismiss|×|✕)$/i;

export async function dismissPopups(page: Page) {
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
    // 아래 addLocatorHandler 가 같은 버튼을 먼저 눌러 사라질 수 있으므로 짧게 시도하고 넘어간다
    await target.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

/** 같은 사이트 판별 (generate-specs.js 의 siteOf 와 같은 기준) */
function siteOf(hostname: string) {
  const parts = hostname.split('.');
  if (/^[\d.]+$/.test(hostname) || parts.length <= 2) return hostname;
  const hosting = hostname.match(/\.(lovable\.app|vercel\.app|netlify\.app|github\.io|pages\.dev|web\.app|firebaseapp\.com|herokuapp\.com)$/i);
  if (hosting) return `${hostname.slice(0, hosting.index).split('.').pop()}${hosting[0]}`;
  const lastTwo = parts.slice(-2).join('.');
  return /^(co|or|go|ac|ne|re|pe|com|net|org|gov|edu)\.[a-z]{2}$/.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}
const sameSite = (a: string, b: string) => {
  try {
    return siteOf(new URL(a).hostname) === siteOf(new URL(b).hostname);
  } catch {
    return false;
  }
};
const shortUrl = (u: string) => (u.length > 120 ? `${u.slice(0, 117)}…` : u);

/**
 * 페이지 진입 + 팝업 처리. 이후 발생하는 문제를 모아서 반환합니다.
 *  errors: JS 런타임 오류 · network: 같은 사이트 요청 실패(404 · 5xx · 연결 실패)
 *  consoleErrors: console.error · mixed: https 페이지의 http 리소스
 */
/** 로그인 상태 파일의 sessionStorage (Playwright 기본 storageState 에는 없음) */
type SavedSession = { origin: string; items: { name: string; value: string }[] }[];
let savedSession: SavedSession | null = null;
function loadSavedSession(): SavedSession {
  if (savedSession) return savedSession;
  savedSession = [];
  const file = process.env.QA_STORAGE_STATE;
  try {
    if (file) savedSession = JSON.parse(require('fs').readFileSync(file, 'utf-8')).sessionStorage || [];
  } catch {
    // 로그인 상태 파일을 읽을 수 없으면 sessionStorage 없이 진행
  }
  return savedSession!;
}

export async function openPage(page: Page, url: string) {
  // sessionStorage 에 로그인을 두는 사이트(Web3Auth 등): 페이지 스크립트보다 먼저 같은 사이트에만 채운다 (generate-specs.js 의 restoreSessionStorage 와 동일)
  const session = loadSavedSession();
  if (session.length) {
    await page.context().addInitScript((saved: SavedSession) => {
      const s = saved.find((x) => x.origin === location.origin);
      if (!s) return;
      try {
        for (const { name, value } of s.items) if (sessionStorage.getItem(name) === null) sessionStorage.setItem(name, value);
      } catch {
        // 저장소를 쓸 수 없는 페이지
      }
    }, session);
  }
  const errors: string[] = [];
  const network: string[] = [];
  const consoleErrors: string[] = [];
  const mixed: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    const s = r.status();
    const u = r.url();
    if ((s >= 500 || s === 404) && sameSite(u, url)) network.push(`${s} ${r.request().method()} ${shortUrl(u)}`);
    if (url.startsWith('https:') && u.startsWith('http:')) mixed.push(shortUrl(u));
  });
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText || '';
    // 페이지 이동으로 취소된 요청(ERR_ABORTED)은 정상
    if (!/ABORTED|cancel/i.test(err) && sameSite(r.url(), url)) network.push(`연결 실패(${err}) ${r.method()} ${shortUrl(r.url())}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  });

  // 테스트 도중 뒤늦게 뜨는 팝업 자동 처리
  // 같은 문구의 버튼이 여러 개(상단 띠 배너 + 팝업)일 수 있으므로 보이는 첫 번째만 누른다.
  // 눌러도 사라지지 않는 팝업이 테스트마다 끼어들어 모든 확인을 시간 초과로 만들지 않도록 3번까지만 개입한다
  await page.addLocatorHandler(
    page.getByRole('button', { name: POPUP_DISMISS }).filter({ visible: true }).first(),
    async (btn) => {
      await btn.click({ timeout: 2000 }).catch(() => {});
    },
    { noWaitAfter: true, times: 3 }
  );

  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const first = page.getByRole('button', { name: POPUP_DISMISS }).first();
  await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await dismissPopups(page);

  return { response, errors, network, consoleErrors, mixed };
}

/** 깨진 이미지 주소 목록 (끝까지 스크롤해서 레이지 로딩 이미지까지) */
export async function brokenImages(page: Page): Promise<string[]> {
  await scrollThrough(page);
  return page.$$eval('img', (imgs) =>
    (imgs as HTMLImageElement[]).filter((img) => img.complete && img.naturalWidth === 0 && !!img.currentSrc).map((img) => img.currentSrc)
  );
}

/**
 * 후보 로케이터 중 화면에서 처음 찾아지는 것 (기본 로케이터 → 문구 기반 → 구조 경로 순).
 * 버튼 이름이 조금 바뀌어도 바로 실패하지 않도록 한다. fallback 을 썼으면 used > 0.
 */
export async function firstFound(page: Page, candidates: import('@playwright/test').Locator[], timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (let i = 0; i < candidates.length; i++) {
      if (await candidates[i].isVisible().catch(() => false)) return { target: candidates[i], used: i };
    }
    await page.waitForTimeout(300);
  }
  return { target: candidates[0], used: 0 };
}

/** 모바일 화면에서 가로로 넘치는 정도와 넘치는 요소 (스크롤 영역 안의 요소는 제외) */
export async function mobileOverflow(page: Page) {
  return page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const inScroller = (el: Element) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(auto|scroll|hidden)/.test(s.overflowX)) return true;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= window.innerWidth + 2 || inScroller(el)) continue;
      const cls = typeof (el as HTMLElement).className === 'string' ? `.${(el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : '';
      wide.push(`${el.tagName.toLowerCase()}${cls} (${Math.round(r.right - window.innerWidth)}px 넘침) "${((el as HTMLElement).innerText || '').trim().slice(0, 20)}"`);
      if (wide.length >= 5) break;
    }
    return { overflow, wide };
  });
}

/** 성능: DOMContentLoaded · load · LCP(가장 큰 콘텐츠가 그려진 시점) ms */
export async function perfMetrics(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ dcl: number; load: number; lcp: number }>((resolve) => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        let lcp = 0;
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) lcp = Math.max(lcp, e.startTime);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          // LCP 를 지원하지 않는 브라우저 (WebKit 등)
        }
        setTimeout(() => resolve({ dcl: Math.round(nav?.domContentLoadedEventEnd || 0), load: Math.round(nav?.loadEventEnd || 0), lcp: Math.round(lcp) }), 300);
      })
  );
}

/** 접근성 점검 (axe-core, WCAG 2 A/AA). 위반 규칙별 요약 */
export async function axeScan(page: Page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const rank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return res.violations
    .map((v) => ({ id: v.id, impact: v.impact || 'minor', help: v.help, count: v.nodes.length, target: String(v.nodes[0]?.target?.[0] || '') }))
    .sort((a, b) => (rank[a.impact] ?? 9) - (rank[b.impact] ?? 9));
}

/**
 * 화면 문구 이상: 치환되지 않은 변수({{token}} · ${amount} · {name}) · 번역 키 그대로 노출(uf_pay_home_title)
 * · undefined / NaN / [object Object] / Invalid Date. 코드 예시(pre · code)와 입력창 값은 제외
 */
export async function textIssues(page: Page) {
  return page.evaluate(() => {
    const BAD = [
      /\{\{\s*[\w.]+\s*\}\}/,
      /\$\{[\w.]+\}/,
      /(^|[^\w{])\{[a-zA-Z_][\w.]*\}(?!\})/,
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/,
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}$/,
      /(^|[\s(:])(undefined|NaN|\[object Object\]|Invalid Date)(?=$|[\s),.])/,
    ];
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 5; n = walker.nextNode()) {
      const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
      const el = n.parentElement;
      if (!t || !el || el.closest('pre, code, script, style, noscript, textarea, template')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (BAD.some((re) => re.test(t)) && !out.includes(t)) out.push(t.slice(0, 60));
    }
    return out;
  });
}

// 오류 · 이용 불가 안내 화면 문구 (generate-specs.js 의 ERROR_SCREEN 과 동일하게 유지)
const ERROR_SCREEN = /(이용\s*불가|사용할 수 없|지원(되|하)지 않|접근(이)?\s*(제한|거부|불가)|권한이 없|오류가 발생|일시적인 오류|서비스 점검|not\s+(available|supported)|unavailable|access\s+denied|forbidden|something went wrong|ご利用いただけません|エラーが発生|アクセスできません)/i;

/** 지금 화면이 오류 · 이용 불가 안내 화면이면 그 제목, 아니면 null (클릭 요소가 거의 없고 제목이 안내 문구) */
export async function errorScreenText(page: Page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const visible = (el: Element) => el.getBoundingClientRect().width > 0;
    const clickable = Array.from(document.querySelectorAll('a[href], button, [role="button"], input, select, textarea')).filter(visible).length;
    if (clickable > 4) return null;
    const heads = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).filter(visible).map((h) => (h as HTMLElement).innerText.trim());
    return heads.find((h) => re.test(h)) || null;
  }, ERROR_SCREEN.source);
}

/** 레이지 로딩 요소까지 렌더링되도록 끝까지 스크롤 후 상단 복귀 */
export async function scrollThrough(page: Page) {
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

export async function expectNoBrokenImages(page: Page) {
  await scrollThrough(page);
  const broken = await page.$$eval('img', (imgs) =>
    (imgs as HTMLImageElement[])
      .filter((img) => img.complete && img.naturalWidth === 0 && !!img.currentSrc)
      .map((img) => img.currentSrc)
  );
  expect.soft(broken, `깨진 이미지: ${broken.join(', ')}`).toEqual([]);
}

/**
 * 한 요소의 노출 · 문구 · 동작을 각각 따로 판정한다.
 * 결과는 annotation(type 'check')으로 남겨 결과 화면에 항목별로 표시되고,
 * 하나라도 실패하면 done() 에서 테스트를 실패 처리한다.
 * gate 로 표시한 검사(노출)가 실패하면 뒤 검사는 건너뛴다 (요소가 없으면 의미 없음).
 */
export function checks() {
  const failures: string[] = [];
  let blocked = '';
  const note = (description: string) => test.info().annotations.push({ type: 'check', description });
  return {
    async run(name: string, fn: () => Promise<void>, { gate = false } = {}) {
      if (blocked) return note(`${name}|skipped|${blocked} 실패로 확인 불가`);
      await test.step(name, async () => {
        try {
          await fn();
          note(`${name}|passed|`);
        } catch (e) {
          const msg = String((e as Error).message || e).replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 4).join(' ');
          note(`${name}|failed|${msg}`);
          failures.push(`[${name}] ${msg}`);
          if (gate) blocked = name;
        }
      });
    },
    /** 의도적으로 확인하지 않는 항목 (부작용 위험 등) */
    skip(name: string, reason: string) {
      note(`${name}|skipped|${reason}`);
    },
    /** 규칙 기반 오타 의심: 실패로 보지 않고 경고로만 남긴다 */
    warn(text: string, reasons: string[]) {
      note(`오타 의심: "${text}"|warning|${reasons.join(' / ')}`);
    },
    /** 실패로 보지 않는 점검 (성능 · 접근성 · 콘솔 오류 등): 문제가 있으면 경고 */
    soft(name: string, ok: boolean, detail = '') {
      note(`${name}|${ok ? 'passed' : 'warning'}|${ok ? '' : detail}`);
    },
    done() {
      if (failures.length) throw new Error(failures.join('\n'));
    },
  };
}

/**
 * 롤링 배너/슬라이드 문구가 일정 시간 안에 실제로 화면에 나타나는지 확인.
 * (화면 밖으로 밀려난 슬라이드나 투명 처리된 슬라이드는 '보이는 것'으로 치지 않는다)
 */
export async function expectShownInRotation(page: Page, text: string, timeout = 20000) {
  await expect
    .poll(
      () =>
        page.getByText(text, { exact: true }).evaluateAll((els) =>
          els.some((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= innerWidth) return false;
            for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
              const s = getComputedStyle(a);
              if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.1) return false;
              if (a !== el && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
                const ar = a.getBoundingClientRect();
                if (r.right <= ar.left + 2 || r.left >= ar.right - 2 || r.bottom <= ar.top + 2 || r.top >= ar.bottom - 2) return false;
              }
            }
            return true;
          })
        ),
      { timeout, message: `롤링 문구가 ${timeout / 1000}초 안에 화면에 나타나지 않음: "${text}"` }
    )
    .toBe(true);
}

/**
 * 화면의 대표 목록(표·리스트 중 항목이 가장 많은 것)의 항목 문구. 검색·필터 결과 확인용.
 * (scripts/generate-specs.js 의 listRowsInPage 와 동일하게 유지)
 */
export async function listRows(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const vis = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
      };
      const clean = (t: string | null) => (t || '').trim().replace(/\s+/g, ' ');
      const outside = (c: Element) => !c.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]');
      const rowsOf = (c: Element) => {
        let items: Element[];
        if (c.matches('table')) items = Array.from(c.querySelectorAll(':scope > tbody > tr, :scope > tr')).filter((r) => !r.querySelector('th'));
        else if (c.matches('[role="table"], [role="grid"]')) items = Array.from(c.querySelectorAll('[role="row"]')).filter((r) => !r.querySelector('[role="columnheader"]'));
        else items = Array.from(c.children).filter((n) => n.matches('li, [role="listitem"], [role="option"]'));
        return items.filter(vis).map((n) => clean((n as HTMLElement).innerText || n.textContent)).filter(Boolean);
      };
      // 머리글이 있는 데이터 표가 있으면 항상 그 표 (검색으로 행이 줄어도 같은 표를 본다)
      const dataTable = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]')).find(
        (t) => outside(t) && vis(t) && t.querySelector('th, [role="columnheader"]')
      );
      if (dataTable) return rowsOf(dataTable).slice(0, 100);
      let best: string[] = [];
      for (const c of Array.from(document.querySelectorAll('ul, ol, [role="list"], [role="listbox"]'))) {
        if (!outside(c)) continue;
        const texts = rowsOf(c);
        if (texts.length > best.length) best = texts;
      }
      return best.slice(0, 100);
    })
    .catch(() => []);
}

/** 검색어로 쓸 값: 첫 항목에서 글자가 들어간 2~15자 단어 (실행 시점의 실제 데이터) */
export function pickTerm(row: string | undefined): string | null {
  return (row || '').split(/\s+/).find((w) => w.length >= 2 && w.length <= 15 && /[가-힣A-Za-z]/.test(w) && !/[()[\]{}|]/.test(w)) || null;
}

/** 표의 머리글과 본문 행의 칸 값 (표 데이터 형식 확인용, generate-specs.js 의 tableLayoutInPage 와 같은 기준) */
export async function tableData(table: import('@playwright/test').Locator): Promise<{ heads: string[]; rows: string[][] }> {
  return table.evaluate((t) => {
    const clean = (s: string) => (s || '').trim().replace(/\s+/g, ' ');
    const headRow = t.querySelector('thead tr') || t.querySelector('tr');
    const heads = headRow ? Array.from(headRow.children).map((h) => clean((h as HTMLElement).innerText)) : [];
    const rows = Array.from(t.querySelectorAll('tbody tr'))
      .filter((r) => r !== headRow)
      .map((r) => Array.from(r.children).map((c) => clean((c as HTMLElement).innerText)));
    return { heads, rows };
  });
}
