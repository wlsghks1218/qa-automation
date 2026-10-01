const { test, expect } = require('@playwright/test');

const GUIDE_URL = 'https://unifi-web.line-apps-beta.com/guide';

test.describe('Unifi Guide 페이지 테스트', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(GUIDE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    });

    test('가이드 페이지 타이틀 및 롤링 배너 1~5번 선택 검증', async ({ page }, testInfo) => {
        // 1. 상단 타이틀 검증
        await expect(page.getByText(/Earn daily interest|Hold JPYC|보관만해도 매일/i).first()).toBeVisible();
        await expect(page.getByText(/automatically|자동으로 쌓여요/i).first()).toBeVisible();

        // 2. 1번 버튼 선택 및 검증
        const btn1 = page.getByRole('button').nth(1);
        await btn1.scrollIntoViewIfNeeded();
        await btn1.click();
        await expect(page.getByRole('heading', { name: /What is JPYC\?|JPYC가 뭐예요\?/i })).toBeVisible();
        await expect(page.getByText(/1:1 JPY-pegged stablecoin|스테이블 코인/i).first()).toBeVisible();

        // 3. 2번 버튼 선택 및 검증
        const btn2 = page.getByRole('button').nth(2);
        await btn2.click();
        await expect(page.getByRole('heading', { name: /How is interest generated\?|어떻게 이자를 주는 건가요\?/i })).toBeVisible();
        await expect(page.getByText(/global partners|글로벌 파트너사/i).first()).toBeVisible();

        // 4. 3번 버튼 선택 및 검증 (수정됨)
        const btn3 = page.getByRole('button').nth(3);
        await btn3.click();
        await expect(page.getByRole('heading', { name: /Interest Rate Structure|이율은 어떻게 구성되나요\?/i })).toBeVisible();
        await expect(page.getByText(/Base 2%|limited \+3%|5% annual interest|기본 2%|총 5%/i).first()).toBeVisible();

        // 5. 4번 버튼 선택 및 검증 (.first() 추가하여 Strict Mode 해결)
        const btn4 = page.getByRole('button').nth(4);
        await btn4.click();
        await expect(page.getByRole('heading', { name: /Deposits & Withdrawals|입출금은 자유로운가요\?/i }).first()).toBeVisible();
        await expect(page.getByText(/Freely deposit & withdraw|자유롭게 입출금/i).first()).toBeVisible();

        // 6. 5번 버튼 선택 및 검증 (수정됨)
        const btn5 = page.getByRole('button').nth(5);
        await btn5.click();
        await expect(page.getByRole('heading', { name: /When is interest paid\?|이자는 언제 들어오나요\?/i })).toBeVisible();
        await expect(page.getByText(/Paid daily|00:00 UTC|이자가 지급돼요/i).first()).toBeVisible();

        // 7. 이율 비교 영역 검증
        const comparisonSection = page.getByText(/Earn higher interest|높은 이율로/i);
        await comparisonSection.scrollIntoViewIfNeeded();
        await expect(comparisonSection).toBeVisible();

        await expect(page.getByText(/Est\. interest|예상이자/i).first()).toBeVisible();
        await expect(page.getByText(/Store in Unifi|Unifi 보관/i).first()).toBeVisible();

        // 툴팁 클릭 및 안내 문구 확인 (수정)
        const tooltipBtn = page.locator('._33ae2aff > ._43647cff').or(page.getByRole('button', { name: /info|tooltip/i })).first();
        if (await tooltipBtn.isVisible()) {
            await tooltipBtn.click();
            await expect(page.getByText(/example|average|applied|적용한 예시|금융 상품|상이할 수 있습니다/i).first()).toBeVisible();
        }

        // 8. Unifi 이자 제공 이유 영역 검증
        const reasonHeading = page.getByText(/Why Unifi pays interest|이자를 주는 이유/i);
        await reasonHeading.scrollIntoViewIfNeeded();
        await expect(reasonHeading).toBeVisible();

        await expect(page.getByText(/Securely store|안전하게 보관/i).first()).toBeVisible();
        await expect(page.getByText(/Generate stable returns|안정적인 수익/i).first()).toBeVisible();

        // 9. 하단 CTA 버튼 클릭 및 이동 검증 (로그인/비로그인 환경 분기)
        const ctaBtn = page.getByRole('button', { name: /Hold JPYC and earn interest|Deposit JPYC & Earn Interest|JPYC 보관하고 이자받기/i });
        await ctaBtn.scrollIntoViewIfNeeded();
        await expect(ctaBtn).toBeVisible();
        await ctaBtn.click();

        if (testInfo.project.name === 'logged-out') {
            await expect(page).toHaveURL(/.*\/auth\/sign-in\?returnUrl=.*deposit.*JPYC.*/);
        } else {
            await expect(page).toHaveURL(/.*\/deposit\?currency=JPYC.*/);
        }
    });
});