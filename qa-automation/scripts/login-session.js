// 사람이 직접 로그인하는 창 (ID/PW, SNS 로그인, 문자·앱 인증, 캡차 등 어떤 방식이든)
//   node scripts/login-session.js <URL> <저장할 로그인 상태 파일>
// 표준입력으로 'save' 를 받으면 현재 로그인 상태(쿠키·저장소)를 파일로 저장하고 종료한다.
// 사용자가 창을 닫으면 저장하지 않고 종료 코드 2 로 끝난다.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const [url, statePath] = process.argv.slice(2);
if (!url || !statePath) {
  console.error('사용법: node scripts/login-session.js <URL> <저장할 로그인 상태 파일>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chromium', args: ['--start-maximized'] });
  // 이미 저장된 로그인이 있으면 이어서 연다 (만료 여부 확인·재로그인용)
  const context = await browser.newContext({
    viewport: null,
    ...(fs.existsSync(statePath) ? { storageState: statePath } : {}),
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('[로그인] 열린 창에서 로그인을 끝낸 뒤 프로그램의 "로그인 완료"를 눌러주세요.');

  let saving = false;
  browser.on('disconnected', () => {
    if (!saving) {
      console.log('[로그인] 창이 닫혀 로그인 상태를 저장하지 않았습니다.');
      process.exit(2);
    }
  });

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk) => {
    if (!chunk.includes('save') || saving) return;
    saving = true;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    const { cookies, origins } = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    console.log(`[로그인] 로그인 상태 저장 완료 (쿠키 ${cookies.length}개, 저장소 ${origins.length}개 사이트)`);
    await browser.close().catch(() => {});
    process.exit(0);
  });
})().catch((e) => {
  console.error(`[로그인] 로그인 창을 열 수 없습니다: ${e.message.split('\n')[0]}`);
  process.exit(1);
});
