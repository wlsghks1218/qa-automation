// URL 이 로그인 화면인지 빠르게 확인 (화면 구조 기준: 비밀번호 입력창, 로그인/SNS 로그인 버튼)
//   node scripts/login-check.js <URL> [로그인 상태 파일]
// 결과를 JSON 한 줄로 출력: { needLogin, password, buttons: [...], loggedInStillLogin }
const { chromium } = require('@playwright/test');
const fs = require('fs');

const [url, statePath] = process.argv.slice(2);
const LOGIN_TEXT = /(로그인|log\s?in|sign\s?in|카카오|kakao|네이버|naver|google|구글|apple|애플|facebook|페이스북|github|간편\s?로그인|회원가입|sign\s?up)/i;

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(statePath && fs.existsSync(statePath) ? { storageState: statePath } : {}),
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const info = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const password = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible).length;
    const buttons = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter(visible)
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
      .filter((t) => t && t.length <= 30 && re.test(t));
    return { password, buttons: [...new Set(buttons)].slice(0, 6) };
  }, LOGIN_TEXT.source);
  await browser.close();
  // 비밀번호 입력창이 있으면 로그인 화면. 로그인 버튼만 있으면 '로그인하면 더 볼 수 있는 화면'일 수 있다
  console.log(JSON.stringify({ needLogin: info.password > 0, hasLoginButton: info.buttons.length > 0, ...info }));
})().catch((e) => {
  console.log(JSON.stringify({ error: e.message.split('\n')[0] }));
});
