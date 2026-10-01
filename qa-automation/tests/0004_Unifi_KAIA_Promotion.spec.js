const { test, expect } = require('@playwright/test');

const GUIDE_URL = 'https://unifi-web.line-apps-beta.com/reward/kaia';

test.describe('KAIA Promotion 페이지 테스트', () => {
  test.beforeEach(async ({ page }) => {
    // 1. DOM 로드
    await page.goto(GUIDE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 2. 스펙/네트워크 저사양 환경을 고려하여 메인 UI(탭 영역) 렌더링을 보장
    await page.getByRole('tablist').waitFor({ state: 'visible', timeout: 30000 });
  });

  test('KAIA Promotion 페이지 검증', async ({ page }, testInfo) => {
    test.setTimeout(60000);

    // 1. 탭 및 메인 헤더 영역 문구 검증
    await expect(page.getByRole('tab', { name: /KAIA 보상|KAIA Reward/i }).first()).toBeVisible();
    await expect(page.getByText(/KAIA 위임하고 KAIA 보상 받기|Delegate KAIA and earn KAIA rewards/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /KAIA 듀얼 리워드|KAIA Dual Rewards/i })).toBeVisible();
    await expect(page.getByRole('img', { name: 'KAIA Reward' })).toBeVisible();

    // 2. 스테이킹 보상 영역 검증
    await expect(page.getByText(/스테이킹 보상|Staking Rewards/i).first()).toBeVisible();
    await expect(page.getByText(/KAIA 스테이킹|KAIA Staking/i).first()).toBeVisible();
    await expect(page.getByText(/KAIA 자산을 위임하고|Delegate KAIA assets/i)).toBeVisible();
    await expect(page.getByText(/적립 리워드|Accrued Reward/i).first()).toBeVisible();
    await expect(page.getByText(/잠든 보상 깨우기|Unlock Idle Rewards/i)).toBeVisible();
    await expect(page.getByText(/지갑 속에 잠들어 있는 혜택들|Delegate to unlock your wallet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /위임하기|Delegate/i })).toBeVisible();
    await expect(page.getByText(/위임 가능 KAIA|Delegatable KAIA/i)).toBeVisible();
    await expect(page.getByText('0 KAIA', { exact: true })).toBeVisible();

    // 3. 특별 기여 보상 영역 검증
    await expect(page.getByText(/특별 기여 보상|Special Contribution Rewards/i).first()).toBeVisible();
    await expect(page.getByText(/USDT 함께 보유 시 추가 보상|Extra rewards with USDT/i)).toBeVisible();
    await expect(page.getByText(/KAIA를 위임중 USDT를 보유하면|Hold USDT while delegating KAIA/i)).toBeVisible();
    await expect(page.getByText(/USDT를 예치해 추가 리워드를 받아보세요!|Deposit USDT and earn an extra reward!/i)).toBeVisible();
    await expect(page.getByText(/수령 가능 리워드|Claimable Reward/i)).toBeVisible();
    await expect(page.getByText(/스페셜 리워드 깨우기|Wake up special rewards/i)).toBeVisible();
    await expect(page.getByText(/USDT 예치 시 최대 450 KAIA 보상 가능해요|Deposit 10,000 USDT to earn up to 450 KAIA/i)).toBeVisible();
    await expect(page.getByText(/USDT 원금|Deposited USDT/i)).toBeVisible();
    await expect(page.getByText('0 USDT', { exact: true })).toBeVisible();

    // 4. 미션 체크 구간 (STAGE 및 라운드) 영역 검증
    await expect(page.getByText(/미션 체크 구간|Mission Check Period/i)).toBeVisible();
    await expect(page.getByText(/KAIA를 위임하고 USDT|Delegate KAIA and deposit USDT/i)).toBeVisible();
    await expect(page.getByText('?', { exact: true })).toBeVisible();
    await expect(page.getByText('STAGE 3')).toBeVisible();
    await expect(page.getByText('1R')).toBeVisible();
    await expect(page.getByText(/종료|Ended/i).first()).toBeVisible();
    await expect(page.getByText('2R')).toBeVisible();
    await expect(page.getByText(/종료|Ended/i).nth(1)).toBeVisible();
    await expect(page.getByText('3R')).toBeVisible();
    await expect(page.getByText(/종료|Ended/i).nth(2)).toBeVisible();
    await expect(page.getByRole('button', { name: /전체 보기|View all/i })).toBeVisible();

    // 5. 보상 지급 기준 및 유의사항 문구 검증
    await expect(page.getByText(/보상 지급 기준 안내|Reward Distribution Criteria/i)).toBeVisible();
    await expect(page.getByText(/\[스테이킹 보상\]|\[Staking Rewards\]/i)).toBeVisible();
    await expect(page.getByText(/KAIA 연동 시점부터 이자는 자동으로 발생하며|Rewards accrue automatically upon delegation/i)).toBeVisible();
    await expect(page.getByText(/위임 해지 시 즉시 수령은 불가하며|Immediate withdrawal is not available/i)).toBeVisible();
    await expect(page.getByText(/카이아 네트워크 상황에 따라 지속적으로 변동|fluctuate continuously based on Kaia network/i)).toBeVisible();
    await expect(page.getByText(/\[특별 기여 보상\]|\[Special Contribution Rewards\]/i)).toBeVisible();
    await expect(page.getByText(/KAIA 위임을 시작하는 시점부터|begins automatically upon KAIA delegation/i)).toBeVisible();
    await expect(page.getByText(/1:10 비율|1:10 ratio/i)).toBeVisible();
    await expect(page.getByText(/미션 구간|mission period/i)).toBeVisible();
    await expect(page.getByText(/보상은 6|distributed in installments over 6/i)).toBeVisible();
    await expect(page.getByText(/완전히 소각|permanently burned/i)).toBeVisible();
    await expect(page.getByText(/상한선|cap/i)).toBeVisible();
    await expect(page.getByText(/서비스 이용 전 알아두시면 좋아요|Good to know before using this service/i)).toBeVisible();
    await expect(page.getByText(/자산 연동 및 자산 비율 유지 서비스는|asset-linking and ratio-maintenance services/i)).toBeVisible();

    // 6. 탭 이동 검증 (USDT 보상 ↔ KAIA 보상)
    const usdtTab = page.getByRole('tab', { name: /USDT 보상|USDT Reward/i });
    await usdtTab.click();
    await expect(page).toHaveURL(/.*\/reward\/usdt.*/);

    const kaiaTab = page.getByRole('tab', { name: /KAIA 보상|KAIA Reward/i });
    await kaiaTab.click();
    await expect(page).toHaveURL(/.*\/reward\/kaia.*/);

    // 7. '위임하기' 버튼 클릭 시 비로그인 분기 이동 및 복귀 검증
    const delegateBtn = page.getByRole('button', { name: /위임하기|Delegate/i });
    await delegateBtn.scrollIntoViewIfNeeded();
    await delegateBtn.click();
    await expect(page).toHaveURL(/.*\/auth\/sign-in\?returnUrl=.*staking.*/);

    // 이전 리워드 페이지로 복귀
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 8. '전체 보기' 클릭 후 미션 페이지 검증 및 상단 뒤로가기 버튼으로 복귀
    const freshViewAllBtn = page.getByRole('button', { name: /전체 보기|View all/i });
    // 저사양 PC를 위해 요소가 준비될 때까지 보장 대기
    await freshViewAllBtn.waitFor({ state: 'visible', timeout: 15000 });
    await freshViewAllBtn.scrollIntoViewIfNeeded();
    await freshViewAllBtn.click();
    await expect(page).toHaveURL(/.*\/reward\/kaia\/missions.*/);

    await expect(page.getByText('STAGE 3')).toBeVisible();
    await expect(page.getByText('STAGE 2')).toBeVisible();
    await expect(page.getByText('STAGE 1')).toBeVisible();

    // 미션 목록 상단 뒤로가기 버튼 클릭으로 메인 리워드 페이지 복귀
    await page.getByRole('banner').getByRole('button').click();
    await expect(page).toHaveURL(/.*\/reward\/kaia.*/);

    // 9. 외부 블로그 팝업 링크 ('여기' / 'here') 검증
    const blogLink = page.getByRole('link', { name: /여기|here/i });
    await blogLink.waitFor({ state: 'visible', timeout: 15000 });
    await blogLink.scrollIntoViewIfNeeded();

    const blogPopupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await blogLink.click();
    const blogPopup = await blogPopupPromise;

    await expect(blogPopup).toHaveURL(/https:\/\/blog\.kaia\.io\/the-complete-guide-to-cr-mission-1-deposit-stake-and-earn-en.*/);
    await blogPopup.close();
  });
});