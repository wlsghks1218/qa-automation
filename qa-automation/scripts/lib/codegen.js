// 생성기들(generate-specs.js, generate-doc-specs.js)이 공유하는 테스트 코드 생성 유틸

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const short = (s, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 분석 단계에서 확정한 로케이터 스펙 → Playwright 코드 */
function locatorCode(spec) {
  const name = JSON.stringify(spec.name);
  const base = {
    role: () => `page.getByRole('${spec.role}', { name: ${name}, exact: true })`,
    label: () => `page.getByLabel(${name}, { exact: true })`,
    placeholder: () => `page.getByPlaceholder(${name}, { exact: true })`,
    css: () => `page.locator(${JSON.stringify(spec.selector)})`,
    text: () => `page.locator(${JSON.stringify(spec.tag)}).filter({ hasText: ${name} })`,
  }[spec.kind]();
  return `${base}.nth(${spec.nth})`;
}

/** URL 비교용 정규식 코드. hostOnly 면 origin 까지만 비교 */
function urlMatcher(url, hostOnly) {
  const u = new URL(url);
  if (hostOnly) return `new RegExp(${JSON.stringify(`^${escapeRegex(u.origin)}`)})`;
  const base = escapeRegex(u.origin + u.pathname.replace(/\/$/, ''));
  return `new RegExp(${JSON.stringify(`^${base}\\/?(?:[?#].*)?$`)})`;
}

/** spec 파일 공통 머리말: 분석 당시 환경(viewport/locale/timezone)을 그대로 고정 */
function specHeader({ describeTitle, env, supportPath, generator }) {
  return [
    `// 자동 생성 파일 - ${generator} 로 재생성됩니다. 직접 수정하지 마세요.`,
    `import { test, expect } from '@playwright/test';`,
    `import { openPage, expectNoBrokenImages, checks, expectShownInRotation } from '${supportPath}';`,
    ``,
    `test.describe(${JSON.stringify(describeTitle)}, () => {`,
    `  test.skip(({ isMobile }) => isMobile, '데스크톱(${env.viewport.width}x${env.viewport.height}) 기준으로 분석된 시나리오입니다.');`,
    `  test.use({ viewport: { width: ${env.viewport.width}, height: ${env.viewport.height} }, locale: ${JSON.stringify(env.locale)}, timezoneId: ${JSON.stringify(env.timezone)} });`,
  ];
}

module.exports = { escapeRegex, short, locatorCode, urlMatcher, specHeader };
