// 기획서 TC 매핑 결과 → Playwright spec 생성 (기대값은 기획서 기준)
const fs = require('fs');
const path = require('path');
const { short, locatorCode, urlMatcher, specHeader } = require('./codegen');

const ACTION_LABEL = { click: '클릭', fill: '입력', check: '선택' };

function featureIndex(analysis) {
  const map = new Map();
  analysis.common.features.forEach((f) => map.set(f.id, f));
  analysis.pages.forEach((p) => p.features.forEach((f) => map.set(f.id, f)));
  return map;
}

function tcTest(tc, m, analysis, features) {
  const startUrl = (analysis.pages.find((p) => p.id === m.startPage) || analysis.pages[0]).url;
  const opensTab = m.expectations.some((e) => e.kind === 'newTab');
  const out = [];
  out.push(`  test(${JSON.stringify(`${tc.id} ${tc.title}`)}, async ({ page }) => {`);
  out.push(`    await openPage(page, ${JSON.stringify(startUrl)});`);
  if (opensTab) out.push(`    let popup: import('@playwright/test').Page | undefined;`);

  m.steps.forEach((s, i) => {
    const f = features.get(s.featureId);
    const loc = locatorCode(f.locator);
    const label = `${i + 1}. ${ACTION_LABEL[s.action]}: ${short(f.label)}`;
    const isLast = i === m.steps.length - 1;
    out.push(`    await test.step(${JSON.stringify(label)}, async () => {`);
    if (s.action === 'fill') {
      out.push(`      await ${loc}.fill(${JSON.stringify(s.value || 'qa-test')});`);
    } else if (s.action === 'check') {
      out.push(`      await ${loc}.check();`);
    } else if (opensTab && isLast) {
      out.push(`      const popupPromise = page.waitForEvent('popup', { timeout: 10000 });`);
      out.push(`      await ${loc}.click();`);
      out.push(`      popup = await popupPromise;`);
    } else {
      out.push(`      await ${loc}.click();`);
    }
    out.push(`    });`);
  });

  m.expectations.forEach((e) => {
    const label = `기대 결과: ${e.kind === 'visible' || e.kind === 'hidden' ? short(features.get(e.featureId).label) : short(e.value)} ${
      { url: '페이지로 이동', newTab: '새 탭으로 열림', text: '문구 노출', visible: '노출', hidden: '숨김' }[e.kind]
    }`;
    out.push(`    await test.step(${JSON.stringify(label)}, async () => {`);
    switch (e.kind) {
      case 'url':
        out.push(`      await expect(page).toHaveURL(${urlMatcher(new URL(e.value, analysis.meta.baseUrl).href)});`);
        break;
      case 'newTab': {
        const host = /^https?:\/\//.test(e.value) ? e.value : `https://${e.value.replace(/^\/+/, '')}`;
        out.push(`      expect(popup, '새 탭이 열리지 않았습니다.').toBeTruthy();`);
        out.push(`      await expect(popup!).toHaveURL(new RegExp(${JSON.stringify(new URL(host).host.replace(/^www\./, '').replace(/[.]/g, '\\.'))}));`);
        break;
      }
      case 'text':
        out.push(`      await expect(page.getByText(${JSON.stringify(e.value)}).filter({ visible: true }).first()).toBeVisible();`);
        break;
      case 'visible':
        out.push(`      await expect(${locatorCode(features.get(e.featureId).locator)}).toBeVisible();`);
        break;
      case 'hidden':
        out.push(`      await expect(${locatorCode(features.get(e.featureId).locator)}).toBeHidden();`);
        break;
    }
    out.push(`    });`);
  });

  out.push(`  });`);
  return out;
}

/**
 * 자동화 가능한 TC만 spec 으로 작성. 반환값: 생성된 TC 수
 * group: 결과 화면/리포트의 그룹 이름 접두어 ('기획서' 또는 'AI 분석')
 */
function writeDocSpecs({ doc, mappings, analysis, outDir, group = '기획서', fileName = 'doc-testcases.spec.ts' }) {
  const features = featureIndex(analysis);
  const automated = mappings.filter((m) => m.status === 'automated');
  if (!automated.length) return 0;

  const out = specHeader({
    describeTitle: `[${group}] ${doc.documentTitle}`,
    env: { viewport: analysis.meta.viewport, locale: analysis.meta.locale, timezone: analysis.meta.timezone },
    supportPath: '../../support/site',
    generator: `app/server.js (${group})`,
  });
  for (const m of automated) {
    const tc = doc.testCases.find((t) => t.id === m.tcId);
    out.push(``, ...tcTest(tc, m, analysis, features));
  }
  out.push(`});`, ``);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, fileName), out.join('\n'), 'utf-8');
  return automated.length;
}

module.exports = { writeDocSpecs };
