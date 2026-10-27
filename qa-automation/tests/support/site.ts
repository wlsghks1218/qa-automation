import { Page, expect } from '@playwright/test';

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

/**
 * 페이지 진입 + 팝업 처리. 이후 발생하는 JS 런타임 오류를 수집해서 반환합니다.
 */
export async function openPage(page: Page, url: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 테스트 도중 뒤늦게 뜨는 팝업 자동 처리
  await page.addLocatorHandler(
    page.getByRole('button', { name: POPUP_DISMISS }),
    async (btn) => {
      await btn.click({ timeout: 2000 }).catch(() => {});
    },
    { noWaitAfter: true }
  );

  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const first = page.getByRole('button', { name: POPUP_DISMISS }).first();
  await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await dismissPopups(page);

  return { response, errors };
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
