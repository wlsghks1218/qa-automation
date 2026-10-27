import { test, expect } from '@playwright/test';

test.describe('Unifi 전체 사이트 자동 탐색 및 서브페이지 헬스체크', () => {
  const BASE_URL = 'https://www.unifi.me';

  test('ROOT-01: 메인 화면 내 모든 내부 링크를 자동 수집하고 전수 렌더링 검증', async ({ page, request }) => {
    test.setTimeout(180000); // 3분 타임아웃

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

    // 1. 전면 팝업 모달 닫기
    const closeBtn = page.getByRole('button', { name: /close/i });
    if (await closeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }

    // 2. SPA 컴포넌트 렌더링 완료 대기 (메인 앵커 태그가 렌더링될 때까지)
    await page.waitForSelector('a[href]', { timeout: 15000 });

    // 3. 페이지 하단 푸터까지 천천히 스크롤 (레이지 로딩 대응)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(500);
    }

    // 4. href 속성을 가진 모든 링크 추출
    const rawLinks = await page.$$eval('a[href]', (anchors) =>
      anchors.map((a) => a.getAttribute('href')).filter(Boolean) as string[]
    );

    // 5. Unifi 내부 경로 정제 및 중복 제거
    const internalUrls = Array.from(
      new Set(
        rawLinks
          .map((href) => {
            const clean = href.trim();
            if (clean.startsWith('/')) return `${BASE_URL}${clean}`;
            if (clean.includes('unifi.me')) return clean;
            return null;
          })
          .filter(
            (url): url is string =>
              url !== null &&
              !url.includes('mailto:') &&
              !url.includes('tel:') &&
              !url.includes('contact.unifi.me') &&
              !url.includes('contract-audit.unifi.me') &&
              !url.includes('developers.unifi.me')
          )
      )
    );

    console.log(`\n==================================================`);
    console.log(`[탐색 성공] 수집된 Unifi 주요 서브페이지 (${internalUrls.length}개):`);
    internalUrls.forEach((url, idx) => console.log(` ${idx + 1}. ${url}`));
    console.log(`==================================================\n`);

    expect(internalUrls.length, '내부 링크가 1개 이상 수집되어야 합니다.').toBeGreaterThan(0);

    // 6. 수집된 URL 전수 헬스체크
    for (const url of internalUrls) {
      await test.step(`[HealthCheck] ${url}`, async () => {
        const response = await request.get(url, { timeout: 15000 }).catch(() => null);
        if (response) {
          expect(response.status(), `HTTP 에러 (${response.status()}): ${url}`).toBeLessThan(400);
        }

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
      });
    }
  });
});