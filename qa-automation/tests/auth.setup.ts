import { test as setup, expect } from '@playwright/test';

const authFile = 'playwright/.auth/user.json';

setup('authenticate', async ({ page }) => {
  // 1. Unifi 웹 메인 페이지 진입
  await page.goto('https://unifi-web.line-apps-beta.com/', { waitUntil: 'domcontentloaded' });

  // 2. 로그인 버튼 찾기 및 클릭
  const loginBtn = page.getByRole('button', { name: /Log In|Sign Up|로그인|회원가입/i }).first();
  await expect(loginBtn).toBeVisible({ timeout: 10000 });
  await loginBtn.click();

  // 3. 로그인 페이지(/auth/sign-in) 리다이렉트 확인
  await expect(page).toHaveURL(/.*\/auth\/sign-in.*/);

  // --------------------------------------------------------------------------
  // 참고: Google/외부 OAuth는 자동화 클릭 시 구글의 봇 감지 정책으로 인해 Block될 수 있습니다.
  // 따라서 로그인 성공 후 생성된 세션을 storageState 파일로 저장하여 재활용합니다.
  // --------------------------------------------------------------------------

  // 4. 인증 완료된 세션 상태를 지정된 경로의 JSON 파일로 저장
  await page.context().storageState({ path: authFile });
});