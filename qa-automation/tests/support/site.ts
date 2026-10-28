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
