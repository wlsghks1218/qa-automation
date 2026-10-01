const { execSync } = require('child_process');
const path = require('path');

console.log('==================================================');
console.log('       Unifi E2E QA Automation Tool v1.0.0       ');
console.log('==================================================\n');

// ★ [핵심] 상대방 PC에 Playwright 브라우저가 없으면 자동으로 다운로드 설치
try {
  console.log('[+] 테스트 실행용 Chromium 브라우저 점검 및 설치 중...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
} catch (e) {
  console.log('[!] 브라우저 점검 완료.');
}

// 기존 테스트 실행 로직
try {
    console.log('\n[1/2] Playwright E2E 테스트 실행 중...');
  
  // --project=logged-out 옵션을 추가하여 logged-out 프로젝트만 실행
  execSync('npx playwright test --project=logged-out --reporter=html', {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  console.log('\n[2/2] 모든 테스트 완료!');

  console.log('\n[2/2] 모든 테스트 완료!');
} catch (error) {
  console.log('\n[!] 일부 테스트 항목이 실패했습니다. 리포트에서 상세 내용을 확인하세요.');
} finally {
  console.log('\n[+] HTML 리포트를 브라우저로 엽니다...');
  try {
    execSync('npx playwright show-report', { stdio: 'inherit' });
  } catch (e) {
    // 리포트 실행 완료
  }
}