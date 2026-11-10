// 동작 흐름 설명서 PDF 생성: docs/how-it-works.html → docs/QA_Automation_KC_동작흐름.pdf
//   node scripts/build-doc.js [추가로 복사할 경로 ...]
// 프로그램 동작이 바뀌면 docs/how-it-works.html 을 고치고 다시 실행한다. 버전은 app/version.json 에서 읽는다.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { name, version } = require('../app/version.json');
const SRC = path.join(ROOT, 'docs', 'how-it-works.html');
const OUT = path.join(ROOT, 'docs', `${name}_동작흐름.pdf`);

(async () => {
  const html = fs.readFileSync(SRC, 'utf-8').replace(/\{\{VERSION\}\}/g, version);
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font-size:8px;color:#888;font-family:Malgun Gothic,sans-serif;padding:0 15mm;display:flex;justify-content:space-between"><span>${name} 동작 흐름 · v${version}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
  await browser.close();
  console.log(`생성 완료: ${OUT}`);
  for (const dest of process.argv.slice(2)) {
    const target = fs.existsSync(dest) && fs.statSync(dest).isDirectory() ? path.join(dest, path.basename(OUT)) : dest;
    fs.copyFileSync(OUT, target);
    console.log(`복사: ${target}`);
  }
})();
