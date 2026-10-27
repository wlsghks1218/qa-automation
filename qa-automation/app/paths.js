const path = require('path');
const fs = require('fs');

// 코드 위치(읽기 전용)와 데이터 위치(쓰기 가능)를 분리한다.
//  - 개발 모드: 모두 프로젝트 폴더
//  - 설치된 앱: app/main.js 가 QA_* 환경변수로 사용자 데이터 폴더를 지정

const CODE_ROOT = path.join(__dirname, '..');
const USER_DIR = process.env.QA_USER_DIR || CODE_ROOT; // .env, settings.json
const WORKSPACE = process.env.QA_WORKSPACE || CODE_ROOT; // 생성된 테스트, test-results

const paths = {
  CODE_ROOT,
  USER_DIR,
  WORKSPACE,
  ENV_PATH: path.join(USER_DIR, '.env'),
  SETTINGS_PATH: path.join(USER_DIR, 'settings.json'),
  GENERATED_DIR: path.join(WORKSPACE, 'tests', 'generated'),
  DEFAULT_RESULTS_DIR: process.env.QA_DEFAULT_RESULTS || path.join(CODE_ROOT, 'results'),
  GENERATOR: path.join(CODE_ROOT, 'scripts', 'generate-specs.js'),
  PLAYWRIGHT_CONFIG: path.join(__dirname, 'playwright.generated.config.js'),
  PLAYWRIGHT_CLI: path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js'),
};

/** 설치된 앱: 생성된 spec 이 import 하는 공통 헬퍼를 작업 폴더로 복사 (앱 버전과 항상 동일하게) */
function prepareWorkspace() {
  if (WORKSPACE === CODE_ROOT) return;
  const dest = path.join(WORKSPACE, 'tests', 'support');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(CODE_ROOT, 'tests', 'support', 'site.ts'), path.join(dest, 'site.ts'));
}

module.exports = { ...paths, prepareWorkspace };
