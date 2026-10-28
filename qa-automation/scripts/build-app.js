// 설치 파일 빌드
//   node scripts/build-app.js win   → dist/QA_Automation_KC_v0.001_Setup.exe
//   node scripts/build-app.js mac   → dist/QA_Automation_KC_v0.001_arm64.dmg  (macOS 에서만 가능)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Playwright 는 모듈을 불러오는 시점에 브라우저 경로를 정하므로, build-icons(→ playwright)를 require 하기 전에 지정해야 한다
const browsersDir = path.join(ROOT, 'build', 'pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir;
const { buildIcons } = require('./build-icons');
const target = process.argv[2] || (process.platform === 'darwin' ? 'mac' : 'win');
if (!['win', 'mac'].includes(target)) {
  console.error('사용법: node scripts/build-app.js [win|mac]');
  process.exit(1);
}
if (target === 'mac' && process.platform !== 'darwin') {
  console.error('macOS 설치 파일은 macOS 에서만 빌드할 수 있습니다. (맥북에서 실행하거나 GitHub Actions "Build App" 사용)');
  process.exit(1);
}

// 앱 버전 0.001 → 설치 파일용 semver 0.0.1 (1.002 → 1.0.2)
const { version } = require('../app/version.json');
const n = Number(version);
const semver = `${Math.floor(n)}.0.${Math.round((n % 1) * 1000)}`;

const run = (args, env = {}) =>
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

(async () => {
  // 앱에 포함할 테스트용 브라우저: Chrome(Chromium) · Safari(WebKit) · Firefox (대상 PC에 따로 설치할 필요 없음)
  // 아이콘 생성에도 브라우저가 필요하므로 먼저 받는다 (빈 CI 서버에서도 동작하도록)
  console.log(`[1/3] 테스트 브라우저 준비 (build/pw-browsers)`);
  const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  // --no-shell: Chromium Headless Shell(약 270MB)은 받지 않는다. 백그라운드 실행도 전체 Chromium 으로 한다 (channel: 'chromium')
  run([cli, 'install', '--no-shell', 'chromium', 'webkit', 'firefox'], { PLAYWRIGHT_BROWSERS_PATH: browsersDir });
  // 실행 잠금 파일 등은 포함하지 않는다
  // 이전 빌드에서 받아둔 Headless Shell 도 포함하지 않는다
  for (const f of fs.readdirSync(browsersDir)) {
    if (f.startsWith('.') || f.startsWith('chromium_headless_shell')) fs.rmSync(path.join(browsersDir, f), { recursive: true, force: true });
  }

  console.log(`\n[2/3] 아이콘 생성`);
  await buildIcons();

  console.log(`\n[3/3] 설치 파일 빌드: QA_Automation_KC v${version} (${target})`);
  const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  run([builder, `--${target}`, '--publish', 'never', `-c.extraMetadata.version=${semver}`], { QA_DISPLAY_VERSION: version });

  console.log(`\n빌드 완료 → dist/`);
  fs.readdirSync(path.join(ROOT, 'dist'))
    .filter((f) => f.includes(`v${version}`) && /\.(exe|dmg)$/.test(f))
    .forEach((f) => console.log(`  ${f}`));
})();
