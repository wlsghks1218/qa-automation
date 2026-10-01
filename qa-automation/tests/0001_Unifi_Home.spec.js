const { test, expect } = require('@playwright/test');

const BASE_URL = 'https://unifi-web.line-apps-beta.com/';

test.describe('Unifi Mini 메인 화면 테스트', () => {
  test.beforeEach(async ({ page }) => {
    // 1. DOM 로드
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 2. 저사양 PC를 위해 메인 화면 UI 요소가 보일 때까지 보장 대기
    await page.locator('#root').waitFor({ state: 'visible', timeout: 30000 });
  });

  test('메인 로고 노출 확인', async ({ page }) => {
    const logoImg = page.getByRole('heading', { level: 2 }).locator('img').first();
    await expect(logoImg).toBeVisible({ timeout: 15000 });
  });

  test('로그인/회원가입 버튼 또는 마이페이지 노출 확인', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'logged-out') {
      const loginBtn = page.getByRole('button', { name: /Log In|Sign Up|로그인|회원가입/i }).first();
      await expect(loginBtn).toBeVisible({ timeout: 15000 });
      await loginBtn.click();

      await expect(page).toHaveURL(/.*\/auth\/sign-in.*/);
      await expect(page.locator('#root')).toBeVisible();
    } else if (testInfo.project.name === 'logged-in') {
      await expect(page.getByRole('button').first()).toBeVisible();
      await expect(page.getByRole('button').nth(1)).toBeVisible();
      await expect(page.getByRole('button').nth(2)).toBeVisible();
    }
  });

  test('메인 타이틀 및 롤링 문구 노출 검증', async ({ page }) => {
    await expect(page.getByText(/Earn daily interest|매일 이자가 쌓이는/i)).toBeVisible();
    await expect(page.getByText(/A new way to save|새로운 예치 경험/i)).toBeVisible();

    await expect(page.getByText(/Up to 2% annual rate|최대 연 이율2%까지/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Withdraw anytime, no fees|수수료 없이 자유롭게 해지/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Low minimum deposit|소액으로도 부담 없이 시작/i)).toBeVisible({ timeout: 15000 });

    const ctaButton = page.getByRole('button', { name: /Get Started with Unifi|Unifi 알아보고/i });
    await expect(ctaButton).toBeVisible();
    await ctaButton.click();

    await expect(page).toHaveURL(/.*\/guide/);
    await page.getByRole('banner').getByRole('button').click();
  });

  test('JPYC 혜택 확인하기', async ({ page }) => {
    const jpycHeading = page.getByRole('heading', { name: /Check JPYC Benefits|JPYC 혜택 확인하기/i });
    await jpycHeading.scrollIntoViewIfNeeded();
    await expect(jpycHeading).toBeVisible({ timeout: 15000 });

    const jpycLink = page.getByRole('link', {
      name: /Get more JPYC with your friends|친구와 함께 더 많은 JPYC 받기/i,
    });
    await expect(jpycLink).toBeVisible();

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await jpycLink.click();
    const newPage = await popupPromise;

    await expect(newPage).toHaveURL(/https:\/\/promotion\.unifi\.me\/referral-campaign-jpyc-2.*/);
    await newPage.close();
  });

  test('캐시백 배너', async ({ page }) => {
    const cashbackLink = page.getByRole('link', { name: /Up to 15% cashback|결제 시 최대 15% 캐시백/i });
    await cashbackLink.scrollIntoViewIfNeeded();
    await expect(cashbackLink).toBeVisible({ timeout: 15000 });

    await cashbackLink.click();
    await expect(page).toHaveURL(/.*\/benefits/);
  });

  test('KAIA 안내', async ({ page }) => {
    const kaiaHeading = page.getByRole('heading', { name: /Check KAIA Benefits|KAIA 혜택 확인하기/i });
    await kaiaHeading.scrollIntoViewIfNeeded();
    await expect(kaiaHeading).toBeVisible({ timeout: 15000 });

    const kaiaButton = page.getByRole('button', { name: /Better Together: KAIA & USDT|함께하면 더 큰 혜택/i });
    await expect(kaiaButton).toBeVisible();

    await kaiaButton.click();
    await expect(page).toHaveURL(/.*\/reward\/kaia/);
    await page.getByRole('banner').getByRole('button').click();
  });

  test('USDT 혜택 확인하기', async ({ page }, testInfo) => {
    // 1. USDT 혜택 영역 타이틀 노출 확인
    const usdtHeading = page.getByRole('heading', {
      name: /Check USDT Benefits|USDT 혜택 확인하기/i,
    });
    await usdtHeading.scrollIntoViewIfNeeded();
    await expect(usdtHeading).toBeVisible();

    // 2. [링크 1] 연 7% 이자 혜택 받기
    const usdtInterestLink = page.getByRole('link', {
      name: /Earn up to 7% interest|Earn up to 0% interest|연 7% 더 높아진 이자 혜택/i,
    });
    await expect(usdtInterestLink).toBeVisible();
    await usdtInterestLink.click();

    if (testInfo.project.name === 'logged-out') {
      await expect(page).toHaveURL(/.*\/auth\/sign-in\?returnUrl=.*plus.*usdt.*/);
    } else if (testInfo.project.name === 'logged-in') {
      await expect(page).toHaveURL(/.*\/plus\/usdt.*/);
    }

    // goBack 이후 DOM 재로드 대기
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });

    // 3. [링크 2] 부스트 참여하고 USDT 받기
    const boostLink = page.getByRole('link', {
      name: /Join Boost & Earn USDT|부스트 참여하고 USDT 받기/i,
    });
    await boostLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(boostLink).toBeVisible();
    await boostLink.click();
    await expect(page).toHaveURL(/.*\/reward\/usdt.*/);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });

    // 4. [버튼 1] 매일 USDT 리워드 받기
    const dailyMissionBtn = page.getByRole('button', {
      name: /Receive USDT rewards daily|매일 USDT 리워드 받기/i,
    });
    await dailyMissionBtn.waitFor({ state: 'visible', timeout: 15000 });
    await expect(dailyMissionBtn).toBeVisible();
    await dailyMissionBtn.click();
    await expect(page).toHaveURL(/.*\/benefits\/daily-mission.*/);

    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });

    // 5. [링크 3] 역대급 이율 혜택 (팝업)
    const renewalNoticeLink = page.getByRole('link', {
      name: /Best Rate Benefits|역대급 이율 혜택/i,
    });
    await renewalNoticeLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(renewalNoticeLink).toBeVisible();

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await renewalNoticeLink.click();
    const popupPage = await popupPromise;

    await expect(popupPage).toHaveURL(/https:\/\/promotion\.unifi\.me\/unifi-interest-renewal.*/);
    await popupPage.close();
  });

  test('Unifi 제대로 알고 쓰기', async ({ page }) => {
    // 1. 헤더 타이틀 스크롤 이동 및 노출 확인
    const guideHeading = page.getByRole('heading', {
      name: /Master the Unifi Essentials|Unifi 제대로 알고 쓰기/i,
    });
    await guideHeading.scrollIntoViewIfNeeded();
    await expect(guideHeading).toBeVisible();

    // 2. JPYC 가이드 이동
    const jpycGuideLink = page.getByRole('link', { name: /Learn about JPYC|JPYC 안내/i });
    await jpycGuideLink.scrollIntoViewIfNeeded();
    await jpycGuideLink.click();
    await expect(page).toHaveURL(/.*\/doc\/jpyc.*/);
    await page.getByRole('banner').getByRole('button').click();

    // 3. 스테이블코인 경험 가이드 이동 (외부 프로모션)
    const unifiExpLink = page.getByRole('link', { name: /Stablecoin Experience|스테이블 코인 경험/i });
    await unifiExpLink.scrollIntoViewIfNeeded();
    await unifiExpLink.click();
    await expect(page).toHaveURL(/https:\/\/unifi-micro-promotion\.website\.line-apps-dev\.com.*/);
    
    // 다시 메인으로 복귀 후 대기
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });

    // 4. 지갑 가이드 이동
    const walletGuideLink = page.getByRole('link', { name: /About Non-custodial Wallets|비수탁형 지갑/i });
    await walletGuideLink.scrollIntoViewIfNeeded();
    await walletGuideLink.click();
    await expect(page).toHaveURL(/.*\/doc\/wallet.*/);
    await page.getByRole('banner').getByRole('button').click();

    // 5. 이자 관리 가이드 이동
    const trustGuideLink = page.getByRole('link', { name: /How to Manage Interest|수익 관리 방법/i });
    await trustGuideLink.scrollIntoViewIfNeeded();
    await trustGuideLink.click();
    await expect(page).toHaveURL(/.*\/doc\/trust.*/);
    await page.getByRole('banner').getByRole('button').click();

    // 6. 핵심 가이드 요약 이동
    const quickSummaryLink = page.getByRole('link', { name: /Quick Summary|핵심만 쏙쏙/i });
    await quickSummaryLink.scrollIntoViewIfNeeded();
    await quickSummaryLink.click();
    await expect(page).toHaveURL(/.*\/guide.*/);
    await page.getByRole('banner').getByRole('button').click();

    // 7. 자산 입금 모달 열기 및 모달 내부 Close 버튼만 지정하여 닫기
    const transferGuideBtn = page.getByRole('button', { name: /Transfer Assets|입금 가이드/i });
    await transferGuideBtn.scrollIntoViewIfNeeded();
    await transferGuideBtn.click();
    const modalCloseBtn = page.getByRole('button', { name: /Close|닫기/i }).last();
    await modalCloseBtn.waitFor({ state: 'visible', timeout: 10000 });
    await expect(modalCloseBtn).toBeVisible();
    await modalCloseBtn.click();
  });

  test('자주 묻는 질문 (FAQ) 검증', async ({ page }) => {
    // 1. FAQ 헤더 타이틀 스크롤 및 노출 검증 (한/영 대응)
    const faqHeading = page.getByRole('heading', { name: /FAQ|자주 묻는 질문/i });
    await faqHeading.scrollIntoViewIfNeeded();
    await expect(faqHeading).toBeVisible({ timeout: 15000 });

    // 2. 질문 1 (예치는 무엇인가요?) 노출 및 아코디언 토글 검증
    const q1Header = page.getByRole('heading', { name: /What is a deposit\?|예치는 무엇인가요\?/i });
    await expect(q1Header).toBeVisible();
    await q1Header.click();
    await expect(page.getByText(/USDT|Unifi/i).first()).toBeVisible();

    // 3. 질문 2 (예치 가능 토큰) 노출 및 아코디언 토글 검증
    const q2Header = page.getByRole('heading', { name: /Which tokens are eligible for deposit\?|예치는 어떤 토큰이 가능한가요\?/i });
    await expect(q2Header).toBeVisible();
    await q2Header.click();
    await expect(page.getByText(/Kaia|USDT/i).first()).toBeVisible();

    // 4. FAQ 더보기 링크 검증 및 클릭 이동
    const viewMoreLink = page.getByRole('link', { name: /View more|자주 묻는 질문 더보기/i });
    await expect(viewMoreLink).toBeVisible();
    await viewMoreLink.click();

    // 5. FAQ 이동 페이지 URL 검증 및 메인 복귀
    await expect(page).toHaveURL(/.*\/faq\?category=deposit.*/);
    await page.getByRole('banner').getByRole('button').click();
  });

  test('하단 푸터(Footer) 영역 검증', async ({ page }) => {
    // 1. 푸터 영역으로 스크롤 이동 및 로고 노출 검증
    const footerLogo = page.getByRole('contentinfo').getByRole('heading', { level: 1 }).locator('img');
    await footerLogo.scrollIntoViewIfNeeded();
    await expect(footerLogo).toBeVisible({ timeout: 15000 });

    // 2. 서비스 이용약관 섹션 검증
    await expect(page.getByRole('heading', { name: /Terms of Service|서비스 이용약관/i })).toBeVisible();

    // 서비스 이용약관 -> Unifi
    const termsUnifiLink = page.getByRole('link', { name: /^Unifi$/i }).first();
    await expect(termsUnifiLink).toBeVisible();
    await termsUnifiLink.click();
    await expect(page).toHaveURL(/.*\/term\/TERMS_OF_SERVICE\/UNIFI.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 서비스 이용약관 -> Unifi Wallet
    const termsWalletLink = page.getByRole('link', { name: /Unifi Wallet|Unifi 지갑/i }).first();
    await termsWalletLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(termsWalletLink).toBeVisible();
    await termsWalletLink.click();
    await expect(page).toHaveURL(/.*\/term\/TERMS_OF_SERVICE\/WALLET.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 서비스 이용약관 -> Aggregator
    const termsAggregatorLink = page.getByRole('link', { name: /Aggregator|어그리게이터/i });
    await termsAggregatorLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(termsAggregatorLink).toBeVisible();
    await termsAggregatorLink.click();
    await expect(page).toHaveURL(/.*\/term\/TERMS_OF_SERVICE\/AGGREGATOR.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 3. 개인정보 처리방침 섹션 검증
    await expect(page.getByRole('heading', { name: /Privacy Policy|개인정보 처리방침/i })).toBeVisible();

    // 개인정보 처리방침 -> Unifi
    const privacyUnifiLink = page.getByRole('link', { name: /^Unifi$/i }).last();
    await expect(privacyUnifiLink).toBeVisible();
    await privacyUnifiLink.click();
    await expect(page).toHaveURL(/.*\/term\/PRIVACY_POLICY\/UNIFI.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 개인정보 처리방침 -> Unifi Wallet
    const privacyWalletLink = page.getByRole('link', { name: /Unifi Wallet|Unifi 지갑/i }).last();
    await privacyWalletLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(privacyWalletLink).toBeVisible();
    await privacyWalletLink.click();
    await expect(page).toHaveURL(/.*\/term\/PRIVACY_POLICY\/WALLET.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 4. 광고성 정보수신 동의 / 마케팅 섹션 검증
    const marketingLink = page.getByRole('link', { name: /Marketing|마케팅/i });
    await marketingLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(marketingLink).toBeVisible();
    await marketingLink.click();
    await expect(page).toHaveURL(/.*\/term\/MARKETING_POLICY\/UNIFI.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 5. Developers (개발자) 외부 링크 검증
    const devLink = page.getByRole('link', { name: /For Developers|개발자/i });
    await devLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(devLink).toBeVisible();
    await expect(devLink).toHaveAttribute('href', 'https://minidapp-developers.line-apps-beta.com');
    await expect(devLink).toHaveAttribute('target', '_blank');

    // 6. 서비스 이용 정보 섹션 검증
    await expect(page.getByRole('heading', { name: /Service Info|서비스 이용 정보/i })).toBeVisible();

    // 공지사항
    const noticeLink = page.getByRole('link', { name: /Notices|공지사항/i });
    await expect(noticeLink).toBeVisible();
    await noticeLink.click();
    await expect(page).toHaveURL(/.*\/announcement.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // FAQ
    const faqFooterLink = page.getByRole('contentinfo').getByRole('link', { name: /FAQ/i });
    await faqFooterLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(faqFooterLink).toBeVisible();
    await faqFooterLink.click();
    await expect(page).toHaveURL(/.*\/faq.*/);
    await page.goBack({ waitUntil: 'domcontentloaded' });

    // 보안 감사 보고서
    const auditLink = page.getByRole('link', { name: /Security Audits|보안 감사 보고서/i });
    await auditLink.waitFor({ state: 'visible', timeout: 15000 });
    await expect(auditLink).toBeVisible();
    await expect(auditLink).toHaveAttribute('href', 'https://unifi-contract-audit.line-apps-beta.com');
    await expect(auditLink).toHaveAttribute('target', '_blank');

    // 7. 고객센터 섹션 검증
    await expect(page.getByRole('heading', { name: /Customer Center|고객센터/i })).toBeVisible();

    const quickHelpBtn = page.getByRole('button', { name: /Quick Help|빠른 답변 받기/i });
    await expect(quickHelpBtn).toBeVisible();

    const contactLink = page.getByRole('link', { name: /Help|문의하기/i });
    await expect(contactLink).toBeVisible();
    await expect(contactLink).toHaveAttribute('href', 'http://contact.unifi.me');
    await expect(contactLink).toHaveAttribute('target', '_blank');

    // 8. 카피라이트 및 SNS 소셜 링크 검증
    await expect(page.getByText(/©LINE NEXT Inc\./i)).toBeVisible();

    const xSocialLink = page.getByRole('link', { name: /x\.com/i }).or(page.locator('a[href*="x.com"]'));
    await expect(xSocialLink).toHaveAttribute('href', 'https://x.com/unifi_x');
    await expect(xSocialLink).toHaveAttribute('target', '_blank');

    const mediumSocialLink = page.getByRole('link', { name: /medium\.com/i }).or(page.locator('a[href*="medium.com"]'));
    await expect(mediumSocialLink).toHaveAttribute('href', 'https://medium.com/@unifi_x');
    await expect(mediumSocialLink).toHaveAttribute('target', '_blank');
  });

  test('하단 바 탭 네비게이션 검증', async ({ page }, testInfo) => {
    // 1. 하단 바 영역 선언
    const getBottomNav = () => page.getByRole('navigation', { name: /bottom bar/i }).or(page.locator('nav'));

    // 2. 하단 바 5개 탭 버튼/링크 노출 검증 (한/영 대응)
    await expect(getBottomNav().getByRole('link', { name: /Home|홈/i })).toBeVisible();
    await expect(getBottomNav().getByRole('link', { name: /K-Pick|혜택/i })).toBeVisible();
    await expect(getBottomNav().getByRole('link', { name: /Reward|리워드/i })).toBeVisible();

    // 3. [K-Pick 탭] 이동 및 URL 검증
    await getBottomNav().getByRole('link', { name: /K-Pick|혜택/i }).click();
    await expect(page).toHaveURL(/.*\/benefits$/);

    // 4. [리워드 탭] 이동 및 URL 검증
    await getBottomNav().getByRole('link', { name: /Reward|리워드/i }).click();
    await expect(page).toHaveURL(/.*\/benefits\/daily-mission.*/);

    // 5. [내 자산 탭] 이동 및 URL 검증 (로그인 상태별 분기)
    const assetsTab = getBottomNav().getByRole('button', { name: /Assets|내 자산|자산/i }).or(getBottomNav().getByRole('link', { name: /Assets|내 자산|자산/i }));
    await assetsTab.click();
    if (testInfo.project.name === 'logged-out') {
      await expect(page).toHaveURL(/.*\/auth\/sign-in\?returnUrl=.*my.*/);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });
    } else {
      await expect(page).toHaveURL(/.*\/my.*/);
    }

    // 6. [마이 탭] 이동 및 URL 검증 (로그인 상태별 분기)
    const myTab = getBottomNav().getByRole('button', { name: /My|마이/i }).or(getBottomNav().getByRole('link', { name: /My|마이/i }));
    await myTab.click();
    if (testInfo.project.name === 'logged-out') {
      await expect(page).toHaveURL(/.*\/auth\/sign-in\?returnUrl=.*setting.*/);
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await page.locator('#root').waitFor({ state: 'visible', timeout: 15000 });
    } else {
      await expect(page).toHaveURL(/.*\/setting.*/);
    }

    // 7. [홈 탭] 클릭하여 메인 복귀 확인
    await getBottomNav().getByRole('link', { name: /Home|홈/i }).click();
    await expect(page).toHaveURL(BASE_URL);
  });
});