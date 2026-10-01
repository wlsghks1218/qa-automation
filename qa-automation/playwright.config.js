const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',

  /* 
   * 🔥 핵심: 글로벌 testMatch 설정
   * .spec.js, .spec.ts 및 .setup.js, .setup.ts 파일 모두를 테스트 탐색 대상에 포함합니다.
   */
  testMatch: [/.*\.spec\.(js|ts)/, /.*\.setup\.(js|ts)/],

  /* 테스트 파일 내 테스트들을 병렬로 실행 */
  fullyParallel: true,

  /* CI/저사양 환경을 고려한 전체 단일 테스트 타임아웃 (60초) */
  timeout: 60000,

  /* 네트워크나 컴퓨터 성능 지연으로 인한 간헐적 실패 시 1회 자동 재시도 */
  retries: 1,

  /* 리포터 설정 */
  reporter: 'html',

  /* 공통 테스트 옵션 (네트워크 및 액션 대기 타임아웃 확장) */
  use: {
    /* 실패 재시도 시에만 디버깅용 트레이스 수집 */
    trace: 'on-first-retry',

    /* click, fill, scroll 등 각 DOM 요소 조작 대기 시간 (15초) */
    actionTimeout: 15000,

    /* page.goto, page.goBack 등 페이지 이동 및 로딩 대기 시간 (30초) */
    navigationTimeout: 30000,
  },

  /* 프로젝트 실행 환경 분리 */
  projects: [
    // 1. 인증 세션 생성 전용 프로젝트 (setup 파일 전용)
    {
      name: 'setup',
      testMatch: /.*\.setup\.(js|ts)/,
    },

    // 2. 비로그인 테스트 프로젝트 (spec 파일 실행, setup 제외)
    {
      name: 'logged-out',
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: /.*\.spec\.(js|ts)/,
      testIgnore: /.*\.setup\.(js|ts)/,
    },

    // 3. 로그인 세션 기반 테스트 프로젝트 (spec 파일 실행, setup 제외)
    {
      name: 'logged-in',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/user.json',
      },
      dependencies: ['setup'], // setup 프로젝트가 먼저 완수된 뒤 실행됨
      testMatch: /.*\.spec\.(js|ts)/,
      testIgnore: /.*\.setup\.(js|ts)/,
    },
  ],
});