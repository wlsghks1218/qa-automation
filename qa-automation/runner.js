const { execSync } = require('child_process');
const path = require('path');

// 사용법: node runner.js <URL>
//   URL을 주면 사이트를 분석해 TC를 생성한 뒤 생성된 테스트를 실행
//   URL이 없으면 기존 tests/ 전체 실행
const targetUrl = process.argv[2];

try {
  if (targetUrl) {
    console.log(`[1/2] ${targetUrl} 분석 및 TC 생성 중...`);
    execSync(`node "${path.join(__dirname, 'scripts', 'generate-specs.js')}" "${targetUrl}"`, {
      stdio: 'inherit',
      shell: true,
    });
    console.log('\n[2/2] 생성된 테스트 실행 중...');
    execSync('npx playwright test --config app/playwright.generated.config.js', { stdio: 'inherit', shell: true });
  } else {
    console.log('Playwright 테스트 실행 중...');
    execSync('npx playwright test', { stdio: 'inherit', shell: true });
  }
  console.log('\n모든 테스트 완료!');
} catch (error) {
  console.log('\n일부 테스트 실패.');
} finally {
  try {
    execSync('npx playwright show-report', { stdio: 'inherit', shell: true });
  } catch (e) {
    // 리포트 종료
  }
}
