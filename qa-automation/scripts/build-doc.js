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
  // 버전 이력(docs/changelog.json) → 최신 버전이 위로 오는 표
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'changelog.json'), 'utf-8'));
  const rows = [...changelog]
    .reverse()
    .map(
      (v) =>
        `<tr><td class="k">v${esc(v.version)}</td><td style="white-space:nowrap">${esc(v.date)}</td><td><ul>${v.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${
          v.tag ? `<div class="small">배포 태그 <code>${esc(v.tag)}</code></div>` : ''
        }</td></tr>`
    )
    .join('');
  const changelogTable = `<table><tr><th>버전</th><th>날짜</th><th>변경 내용</th></tr>${rows}</table>`;
  // 배포 기록: git 의 배포 태그(qa-kc-v*) → 날짜 · 커밋 · 커밋 메시지 (git 이 없으면 생략)
  let deployTable = '<p class="small">git 기록을 읽을 수 없어 배포 기록을 생략했습니다.</p>';
  try {
    const out = require('child_process').execFileSync(
      'git',
      ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)|%(creatordate:short)|%(objectname:short)|%(subject)', 'refs/tags/qa-kc-v*'],
      { cwd: ROOT, encoding: 'utf-8' }
    );
    const tags = out.trim().split('\n').filter(Boolean).map((l) => l.split('|'));
    if (tags.length) {
      deployTable = `<table><tr><th>배포 태그</th><th>날짜</th><th>커밋</th><th>커밋 메시지</th></tr>${tags
        .map(([tag, date, hash, subject]) => `<tr><td class="k"><code>${esc(tag)}</code></td><td style="white-space:nowrap">${esc(date)}</td><td><code>${esc(hash)}</code></td><td>${esc(subject)}</td></tr>`)
        .join('')}</table>`;
    }
  } catch {
    // git 이 없는 환경
  }
  const html = fs
    .readFileSync(SRC, 'utf-8')
    .replace(/\{\{VERSION\}\}/g, version)
    .replace('{{CHANGELOG}}', changelogTable)
    .replace('{{DEPLOYLOG}}', deployTable);
  // 미리보기용: 치환이 끝난 HTML 도 저장 (DOC_HTML_OUT=경로)
  if (process.env.DOC_HTML_OUT) fs.writeFileSync(process.env.DOC_HTML_OUT, html, 'utf-8');
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
