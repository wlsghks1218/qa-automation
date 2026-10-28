// 프로그램이 생성한 테스트(tests/generated) 실행 전용 설정
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
const { WORKSPACE, GENERATED_DIR } = require('./paths');

const BROWSERS = {
  // channel 'chromium': 별도 Headless Shell 없이 전체 Chromium 으로 백그라운드 실행 (설치 파일 용량 절감)
  chromium: { name: 'Chrome', use: { ...devices['Desktop Chrome'], channel: 'chromium' } },
  webkit: { name: 'Safari', use: { ...devices['Desktop Safari'] } },
  firefox: { name: 'Firefox', use: { ...devices['Desktop Firefox'] } },
};

module.exports = defineConfig({
  testDir: path.join(GENERATED_DIR, process.env.QA_TEST_SUBDIR || ''),
  outputDir: path.join(WORKSPACE, 'test-results'),
  fullyParallel: true,
  // 같은 사이트에 동시 접속이 몰리면 응답이 늦어져 무더기 타임아웃이 나므로 동시 실행 수를 제한
  workers: Number(process.env.QA_WORKERS || 4),
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  // 네트워크 일시 지연 대비 1회 재시도. 재시도로 통과한 테스트는 결과에 '불안정'으로 표시된다
  retries: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // QA_BROWSERS=chromium,webkit,firefox (기본 chromium). WebKit 은 Safari 와 같은 엔진
  projects: (process.env.QA_BROWSERS || 'chromium')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => BROWSERS[b])
    .map((b) => BROWSERS[b]),
});
