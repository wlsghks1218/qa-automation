const { test, expect } = require('@playwright/test');

const PROMOTION_URL =
  'https://promotion.unifi.me/referral-campaign-jpyc-2?utm_source=unifi_home&utm_medium=cta&utm_campaign=referral_jpyc2&utm_content=august_2026&utm_term=ref2&referral_code=1316_RSHGA';

test.describe('JPYC Promotion 페이지 검증', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PROMOTION_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  });

  test('페이지 전체 문구, 다국어 전환, 내부 스크롤 및 외부 팝업 이동 검증', async ({ page }) => {
    test.setTimeout(60000);

    // 1. 헤더 및 메인 인트로 영역 문구 검증 (filter 패턴으로 수정)
    const langBtn = page.getByRole('button').filter({ hasText: 'EN' }).first();
    await langBtn.waitFor({ state: 'visible', timeout: 15000 });
    await expect(langBtn).toBeVisible();

    await expect(page.getByRole('link', { name: 'Go to Unifi →' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'JPYC Referral Campaign — Round' })).toBeVisible();
    await expect(page.getByText('JPYC Referral Campaign — Round')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Deposit JPYC with friends and' })).toBeVisible();
    await expect(page.getByText('You earn 1%, your invited')).toBeVisible();
    await expect(page.getByText('Top 10 on the leaderboard')).toBeVisible();
    await expect(page.getByText('Invited friends can invite')).toBeVisible();
    await expect(page.getByText('✅ Round 1 participants can').first()).toBeVisible();

    const heroCtaBtn = page.locator('section').filter({ hasText: 'JPYC Referral Campaign —' }).getByRole('button');
    await expect(heroCtaBtn).toBeVisible();
    await expect(page.getByRole('link', { name: 'Check My Status' })).toBeVisible();

    // 2. Invitation Incentive 영역 문구 검증
    await expect(page.getByText('Invitation Incentive', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You and Your Friend Both Earn' })).toBeVisible();
    await expect(page.getByText('When a friend who joined via')).toBeVisible();
    await expect(page.getByText('Both you and your invited')).toBeVisible();
    await expect(page.getByText('You💸1% Yearlyin JPYCBased on')).toBeVisible();
    await expect(page.getByText('Invited Friend🎁2% Yearlyin')).toBeVisible();
    await expect(page.getByText('✅ Round 1 participants can').nth(1)).toBeVisible();
    await expect(page.getByText('Sign up for Unifi & create')).toBeVisible();
    await expect(page.getByText('No requirements — anyone can')).toBeVisible();
    await expect(page.getByText('Share the link with friends')).toBeVisible();
    await expect(page.getByText('Rewards begin once your')).toBeVisible();
    await expect(page.getByText('Receiving JPYC Rewards')).toBeVisible();
    await expect(page.getByText('The longer your friend keeps')).toBeVisible();
    await expect(page.getByText('The invite chain keeps going!')).toBeVisible();
    await expect(page.getByText('Friends you invite can')).toBeVisible();

    // 3. How It Works 및 Reward Calculation 영역 문구 검증
    await expect(page.getByText('Reward Calculation')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How It Works' })).toBeVisible();
    await expect(page.getByText('Rewards are calculated based on your daily average balance.')).toBeVisible();
    await expect(page.getByText('📊Average BalanceRewards are')).toBeVisible();
    await expect(page.getByText('🔒5× Max LimitYour eligible')).toBeVisible();
    await expect(page.getByText('🆕New Purchase & Deposit')).toBeVisible();
    await expect(page.getByText('⚠️Withdrawal Deduction')).toBeVisible();
    await expect(page.getByText('📅Reward Payment')).toBeVisible();

    // 4. Leaderboard Ranking 표(Table) 문구 및 수치 검증
    await expect(page.getByText('Leaderboard Ranking', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top 10 Earns Extra 500,000' })).toBeVisible();
    await expect(page.getByText('The more friends you invite,')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rank' }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Reward' }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Min. Friend Balance' })).toBeVisible();
    await expect(page.getByText('1st')).toBeVisible();
    await expect(page.getByRole('cell', { name: '150,000 JPYC' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '10,000,000 JPYC or more' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2nd' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '80,000 JPYC' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '8,000,000 JPYC or more' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '3rd' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '50,000 JPYC', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '5,000,000 JPYC or more' })).toBeVisible();
    await expect(page.getByText('4th–5th')).toBeVisible();
    await expect(page.getByRole('cell', { name: '40,000 JPYC' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2,000,000 JPYC or more' })).toBeVisible();
    await expect(page.getByText('6th–10th')).toBeVisible();
    await expect(page.getByRole('cell', { name: '28,000 JPYC' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1,000,000 JPYC or more' })).toBeVisible();
    await expect(page.getByText('※ No reward if min. friend')).toBeVisible();

    // 5. Live Leaderboard 타이머 및 표 문구 검증
    await expect(page.getByRole('heading', { name: 'Live Leaderboard' })).toBeVisible();
    await expect(page.getByText('Event Ends In')).toBeVisible();
    await expect(page.getByText('Updated daily at 10:00(10:00')).toBeVisible();
    await expect(page.getByText('0d')).toBeVisible();
    await expect(page.getByText('00h')).toBeVisible();
    await expect(page.getByText('00m')).toBeVisible();
    await expect(page.getByText('00s')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rank' }).nth(1)).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Balance', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Reward' }).nth(1)).toBeVisible();
    await expect(page.getByText('※ To ensure fair operation,')).toBeVisible();
    await expect(page.getByText('Data is based on previous day')).toBeVisible();

    // 6. My Status 영역 문구 및 수치 검증
    await expect(page.getByText('My Status').nth(1)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My Status' })).toBeVisible();
    await expect(page.getByText('Track your invitation')).toBeVisible();
    await expect(page.getByText('My Status').nth(3)).toBeVisible();
    await expect(page.getByText('Current Balance')).toBeVisible();
    await expect(page.getByText('0 JPYC', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Friends Invited')).toBeVisible();
    await expect(page.locator('#my-status').getByText('0', { exact: true })).toBeVisible();
    await expect(page.getByText("Invited Friends' Total Balance (Avg.)")).toBeVisible();
    await expect(page.getByText('0 JPYC', { exact: true }).nth(1)).toBeVisible();
    await expect(page.getByText('※ Data may fluctuate due to real-time updates.※ Rewards are calculated based on')).toBeVisible();

    // 7. FAQ 및 하단 유의사항 문구 검증
    await expect(page.getByText('FAQ')).toBeVisible();
    await expect(page.getByText('1Can I join without any')).toBeVisible();
    await expect(page.getByText('2When and how will I receive')).toBeVisible();
    await expect(page.getByText('3Do assets other than JPYC')).toBeVisible();
    await expect(page.getByText('4Can I receive both Event 1')).toBeVisible();
    await expect(page.getByText('5Can a friend who already')).toBeVisible();

    const bottomCtaSection = page.locator('section').filter({ hasText: 'Start Earning TodayOne invite' });
    await expect(bottomCtaSection).toBeVisible();
    await expect(bottomCtaSection.getByRole('button')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Follow on X' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Important Notes' })).toBeVisible();
    await expect(page.getByText('Reward Payment', { exact: true })).toBeVisible();
    await expect(page.getByText('Rewards will be distributed')).toBeVisible();
    await expect(page.getByText('Rewards are distributed as')).toBeVisible();
    await expect(page.getByText('Eligibility', { exact: true })).toBeVisible();
    await expect(page.getByText('Performance is calculated')).toBeVisible();
    await expect(page.getByText('My limit: own balance (max 10')).toBeVisible();
    await expect(page.getByText('Friend performance only')).toBeVisible();
    await expect(page.getByText('Only newly purchased and')).toBeVisible();
    await expect(page.getByText('Anti-Fraud Policy')).toBeVisible();
    await expect(page.getByText('The following actions may')).toBeVisible();
    await expect(page.getByText('Event Changes')).toBeVisible();
    await expect(page.getByText('The company may modify or')).toBeVisible();
    await expect(page.getByText('Disclaimer')).toBeVisible();
    await expect(page.getByText('The company shall not be')).toBeVisible();

    // 8. 푸터 카피라이트 검증
    await expect(page.getByRole('contentinfo').getByRole('img', { name: 'unifi' })).toBeVisible();
    await expect(page.getByText('©LINE NEXT Inc. All Rights')).toBeVisible();

    // 9. 언어 변경 테스트
    await langBtn.click();
    await page.getByRole('button', { name: '🇯🇵 日本語' }).click();

    await page.getByRole('button', { name: 'JA' }).click();
    await page.getByRole('button', { name: '🇰🇷 한국어' }).click();

    await page.getByRole('button', { name: 'KO' }).click();
    await page.getByRole('button', { name: '🇹🇼 繁體中文' }).click();

    await page.getByRole('button', { name: 'TW' }).click();
    await page.getByRole('button', { name: '🇹🇭 ภาษาไทย' }).click();

    const thPopupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await page.getByRole('link', { name: 'ไปที่ Unifi →' }).click();
    const thPopup = await thPopupPromise;
    await expect(thPopup).toHaveURL(/https:\/\/miniapp\.line\.me\/2008994549-CGfrtgSs\/.*/);
    await thPopup.close();

    await page.getByRole('button', { name: 'TH' }).click();
    await page.getByRole('button', { name: '🇺🇸 English' }).click();

    // 10. 상단 Hero CTA 버튼 클릭 검증
    await heroCtaBtn.click();
    await expect(page).toHaveURL(/https:\/\/miniapp\.line\.me\/.*\/auth\/sign-in.*/);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor({ state: 'visible', timeout: 15000 });

    // 11. Check My Status 클릭 스크롤 이동
    const checkStatusBtn = page.getByRole('link', { name: 'Check My Status' });
    await checkStatusBtn.waitFor({ state: 'visible', timeout: 15000 });
    await checkStatusBtn.scrollIntoViewIfNeeded();
    await checkStatusBtn.click();
    await expect(page.locator('#my-status')).toBeInViewport({ timeout: 5000 });

    // 12. 하단 CTA 버튼 클릭 검증
    const freshBottomCtaSection = page.locator('section').filter({ hasText: 'Start Earning TodayOne invite' });
    const freshBottomCtaBtn = freshBottomCtaSection.getByRole('button');
    await freshBottomCtaBtn.scrollIntoViewIfNeeded();
    await freshBottomCtaBtn.click();
    await expect(page).toHaveURL(/https:\/\/miniapp\.line\.me\/.*\/auth\/sign-in.*/);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('body').waitFor({ state: 'visible', timeout: 15000 });

    // 13. 외부 SNS 및 가이드 팝업 검증
    const xLink = page.getByRole('link', { name: 'Follow on X' });
    await xLink.waitFor({ state: 'visible', timeout: 15000 });
    const xPopupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await xLink.click();
    const xPopup = await xPopupPromise;
    await expect(xPopup).toHaveURL(/https:\/\/x\.com\/unifi_x.*/);
    await xPopup.close();

    const jpycExLink = page.getByRole('link', { name: 'JPYC EX' }).first();
    const jpycExPopupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await jpycExLink.click();
    const jpycExPopup = await jpycExPopupPromise;
    await expect(jpycExPopup).toHaveURL(/https:\/\/jpyc\.co\.jp.*/);
    await jpycExPopup.close();

    const guideLink = page.getByRole('link', { name: 'purchase guide' }).first();
    const guidePopupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await guideLink.click();
    const guidePopup = await guidePopupPromise;
    await expect(guidePopup).toHaveURL(/https:\/\/promotion\.unifi\.me\/jpyc-deposit-guide.*/);
    await guidePopup.close();
  });
});