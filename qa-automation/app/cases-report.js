// 테스트 케이스 보기 페이지(cases.html) 생성
// 페이지별 화면 캡처 + 화면 순서대로 케이스와 항목별 결과(노출·문구·동작·오타 의심)를 한 파일로 보여준다.
// 외부 리소스 없이 결과 폴더 안에서 바로 열린다 (화면 캡처는 같은 폴더의 screens/ 참조).
//
// 단독 실행: node app/cases-report.js <cases.json> <출력.html> [results.json]

const fs = require('fs');
const path = require('path');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABEL = { passed: '통과', failed: '실패', flaky: '불안정', skipped: '건너뜀', pending: '미실행' };
const CHECK_SEV = ['passed', 'skipped', 'warning', 'failed'];
const CHECK_ICON = { passed: '✓', failed: '✗', skipped: '–', warning: '⚠', pending: '○' };
const RUN_SEV = ['passed', 'skipped', 'flaky', 'failed'];

/** describe 제목 "[페이지 · 목록형] /path - 제목" → /path */
const pathOfGroup = (title) => (title.match(/^\[페이지 · [^\]]+\] (\S+)/) || [])[1] || null;
const orderOf = (title) => {
  const m = title.match(/^(\d+)\./);
  return m ? Number(m[1]) : 9999;
};

/** 같은 케이스의 브라우저별 실행을 하나로 합친다 */
function mergeRuns(runs) {
  const worst = runs.reduce((a, b) => (RUN_SEV.indexOf(b.status) > RUN_SEV.indexOf(a.status) ? b : a));
  const checks = new Map();
  for (const r of runs) {
    for (const c of r.checks || []) {
      const prev = checks.get(c.name);
      const failedIn = c.status === 'failed' ? [r.browser] : [];
      if (!prev) checks.set(c.name, { ...c, failedIn });
      else {
        prev.failedIn.push(...failedIn);
        if (CHECK_SEV.indexOf(c.status) > CHECK_SEV.indexOf(prev.status)) Object.assign(prev, { status: c.status, detail: c.detail });
      }
    }
  }
  return {
    status: worst.status,
    browsers: runs.map((r) => ({ name: r.browser, status: r.status })),
    checks: [...checks.values()],
    error: runs.map((r) => r.error).find(Boolean) || '',
  };
}

/**
 * 생성기 케이스 목록의 한 케이스 + 실행 결과(없을 수 있음).
 * 계획된 항목 순서를 유지하고, 결과가 있는 항목은 그 상태로 채운다.
 */
function mergePlanned(pc, runs) {
  const fromRuns = runs.length ? mergeRuns(runs) : null;
  const byName = new Map(((fromRuns && fromRuns.checks) || []).map((c) => [c.name, c]));
  const checks = pc.checks.map((p) => {
    const got = byName.get(p.name);
    if (got) return got;
    // 오타 의심은 분석 단계에서 이미 알 수 있다. 단계(test.step) 항목은 테스트 전체 결과를 따른다
    if (p.kind === 'warn') return { name: p.name, status: 'warning', detail: p.detail || '', failedIn: [] };
    if (p.kind === 'skip') return { name: p.name, status: 'skipped', detail: p.detail || '', failedIn: [] };
    if (fromRuns && p.kind === 'step') return { name: p.name, status: fromRuns.status === 'flaky' ? 'passed' : fromRuns.status, detail: '', failedIn: [] };
    return { name: p.name, status: 'pending', detail: '', failedIn: [] };
  });
  // 목록에 없던 결과 항목(실행 중 추가된 경고 등)은 뒤에 붙인다
  for (const c of byName.values()) if (!pc.checks.some((p) => p.name === c.name)) checks.push(c);
  if (!fromRuns) return { status: 'pending', browsers: [], checks, error: '' };
  return { ...fromRuns, checks };
}

function caseRow(title, merged, multi) {
  const chips = merged.checks
    .map((c) => {
      const tip = [c.detail, c.failedIn.length && multi ? `실패: ${c.failedIn.join(', ')}` : ''].filter(Boolean).join(' · ');
      return `<span class="chk ${c.status}"${tip ? ` title="${esc(tip)}"` : ''}>${CHECK_ICON[c.status] || ''} ${esc(c.name)}</span>`;
    })
    .join('');
  const failedDetails = merged.checks
    .filter((c) => c.status === 'failed' || c.status === 'warning')
    .map((c) => `<div class="why ${c.status}"><b>${esc(c.name)}</b> ${esc(c.detail)}</div>`)
    .join('');
  // 항목 기록이 없는 케이스(페이지 로드 등)는 Playwright 오류 메시지를 그대로 보여준다
  const error = !merged.checks.length && merged.error ? `<pre>${esc(merged.error)}</pre>` : '';
  const dots = multi ? `<span class="bdots">${merged.browsers.map((b) => `<span class="bdot ${b.status}">${esc(b.name)}</span>`).join('')}</span>` : '';
  const hasWarn = merged.checks.some((c) => c.status === 'warning');
  return `
      <tr class="case ${merged.status}${hasWarn ? ' warn' : ''}" data-text="${esc(`${title} ${merged.checks.map((c) => c.name).join(' ')}`.toLowerCase())}">
        <td class="st"><span class="badge ${merged.status}">${STATUS_LABEL[merged.status] || merged.status}</span>${dots}</td>
        <td><div class="title">${esc(title)}</div>${chips ? `<div class="checks">${chips}</div>` : ''}${failedDetails}${error}</td>
      </tr>`;
}

/**
 * plan: 생성기가 만든 케이스 목록(cases.json) - 분석 직후 '미실행' 상태로도 보여줄 수 있다
 * result: 테스트 실행 결과(summary). 있으면 같은 케이스·항목에 결과를 채운다
 */
function buildCasesHtml({ plan, result = {}, screensBase = 'screens' }) {
  const tests = result.tests || null;
  const multi = ((tests && tests.browsers) || []).length > 1;
  const typos = result.typos || plan?.typos || [];
  const resultGroups = new Map(((tests && tests.groups) || []).map((g) => [g.title, g]));

  let checkTotal = 0;
  let checkFailed = 0;
  let caseCount = 0;
  const count = { passed: 0, failed: 0, flaky: 0, skipped: 0, pending: 0 };

  // 페이지가 적으면 모두 펼쳐서, 많으면 실패한 페이지만 펼쳐서 보여준다
  const openAll = (plan?.pages || []).length + ((tests && tests.groups) || []).filter((g) => !(plan?.pages || []).some((p) => p.group === g.title)).length <= 3;
  const renderSection = (gi, title, page, cases) => {
    const failed = cases.filter((c) => ['failed', 'flaky'].includes(c.merged.status)).length;
    cases.forEach(({ merged }) => {
      caseCount++;
      count[merged.status] = (count[merged.status] || 0) + 1;
      checkTotal += merged.checks.filter((c) => c.status !== 'warning').length;
      checkFailed += merged.checks.filter((c) => c.status === 'failed').length;
    });
    const shot = page && page.screenshot ? `${screensBase}/${path.basename(page.screenshot)}` : null;
    const meta = page && page.url
      ? `<div class="pmeta"><a href="${esc(page.url)}" target="_blank" rel="noopener">${esc(page.url)}</a>${page.blocked ? ` · <b class="bad">접속 차단 (${esc(page.blocked)})</b>` : ''}</div>`
      : '';
    const pending = cases.every((c) => c.merged.status === 'pending');
    return `
    <details class="page" id="g${gi}" ${failed || openAll ? 'open' : ''}>
      <summary>
        <span class="ptitle">${esc(title)}</span>
        <span class="pill">${cases.length}개 케이스</span>
        ${pending ? '<span class="pill">미실행</span>' : failed ? `<span class="pill fail">실패 ${failed}</span>` : '<span class="pill pass">모두 통과</span>'}
      </summary>
      ${meta}
      <div class="pbody${shot ? '' : ' noshot'}">
        ${shot ? `<a class="shot" href="${esc(shot)}" target="_blank" title="화면 캡처 크게 보기"><img src="${esc(shot)}" alt="${esc(title)} 화면 캡처" loading="lazy"></a>` : ''}
        <table class="cases"><tbody>${cases.map((c) => caseRow(c.title, c.merged, multi)).join('')}</tbody></table>
      </div>
    </details>`;
  };

  // 1) 생성기 케이스 목록 기준 (화면 순서). 결과가 있으면 같은 제목의 케이스에 채운다
  const sections = [];
  const tocItems = [];
  const used = new Set();
  (plan?.pages || []).forEach((p) => {
    const g = resultGroups.get(p.group);
    if (g) used.add(p.group);
    const cases = p.cases.map((pc) => {
      const runs = g ? g.tests.filter((t) => t.title === pc.title) : [];
      return { title: pc.title, merged: mergePlanned(pc, runs) };
    });
    const gi = sections.length;
    sections.push(renderSection(gi, p.group, p, cases));
    tocItems.push({ gi, label: p.path, bad: cases.some((c) => ['failed', 'flaky'].includes(c.merged.status)) });
  });

  // 2) 목록에 없는 결과 그룹 (기획서 기반 · AI 분석 테스트 등)
  for (const g of (tests && tests.groups) || []) {
    if (used.has(g.title)) continue;
    const byTitle = new Map();
    g.tests.forEach((t) => byTitle.set(t.title, [...(byTitle.get(t.title) || []), t]));
    const cases = [...byTitle.entries()]
      .map(([title, runs]) => ({ title, merged: mergeRuns(runs) }))
      .sort((a, b) => orderOf(a.title) - orderOf(b.title) || a.title.localeCompare(b.title));
    const gi = sections.length;
    sections.push(renderSection(gi, g.title, null, cases));
    tocItems.push({ gi, label: g.title, bad: cases.some((c) => ['failed', 'flaky'].includes(c.merged.status)) });
  }

  const toc = tocItems.map((t) => `<a href="#g${t.gi}" class="${t.bad ? 'bad' : ''}">${esc(t.label)}</a>`).join('');

  const started = result.startedAt ? new Date(result.startedAt).toLocaleString('ko-KR') : plan?.meta?.generatedAt ? new Date(plan.meta.generatedAt).toLocaleString('ko-KR') : '';
  const target = [result.url || plan?.meta?.startUrl, result.fileName].filter(Boolean).join(' + ');
  const scope = result.scope || plan?.meta?.scope;
  const typoHtml = typos.length
    ? `<section class="typos"><h2>오타 의심 문구 <small>${typos.length}건 · 규칙 기반 검사 (확정 아님)</small></h2><ul>${typos
        .map((t) => `<li>"${esc(t.text)}" <span class="muted">- ${esc((t.reasons || []).join(' / '))}${t.pages ? ` · ${esc(t.pages.join(', '))}` : ''}</span></li>`)
        .join('')}</ul></section>`
    : '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>테스트 케이스 - ${esc(target)}</title>
<style>
  :root {
    --bg: #f6f7f9; --surface: #fff; --surface-2: #f1f3f5; --text: #1c1f23; --muted: #6b7280; --border: #e3e6ea;
    --pass: #2b8a3e; --pass-weak: #ebfbee; --fail: #c92a2a; --fail-weak: #fff5f5; --warn: #e8590c; --warn-weak: #fff4e6; --skip: #868e96;
    --accent: #3b5bdb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141517; --surface: #1c1e21; --surface-2: #25282c; --text: #e9ecef; --muted: #9aa1a9; --border: #33373c;
      --pass: #51cf66; --pass-weak: #1f3326; --fail: #ff6b6b; --fail-weak: #3a2124; --warn: #ff922b; --warn-weak: #3a2a1c; --skip: #868e96;
      --accent: #748ffc;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
  .wrap { max-width: 1280px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  h2 small { font-weight: 400; color: var(--muted); font-size: 13px; }
  .muted { color: var(--muted); }
  .sub { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 18px 0; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
  .tile .k { font-size: 12px; color: var(--muted); }
  .tile .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile.pass .v { color: var(--pass); } .tile.fail .v { color: var(--fail); } .tile.warn .v { color: var(--warn); }
  .bar { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 10px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
  .bar input[type=search] { flex: 1; min-width: 180px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; }
  .bar label { display: inline-flex; gap: 5px; align-items: center; font-size: 13px; white-space: nowrap; }
  .bar button { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .toc { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .toc a { font-size: 12.5px; padding: 2px 9px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); color: var(--text); text-decoration: none; }
  .toc a.bad { border-color: var(--fail); color: var(--fail); }
  .typos { background: var(--warn-weak); border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; }
  .typos ul { margin: 0; padding-left: 20px; }
  .page { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
  .page > summary { list-style: none; display: flex; gap: 8px; align-items: center; padding: 12px 16px; cursor: pointer; background: var(--surface-2); }
  .page > summary::-webkit-details-marker { display: none; }
  .ptitle { flex: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill { font-size: 12px; border-radius: 999px; padding: 1px 9px; background: var(--surface); border: 1px solid var(--border); white-space: nowrap; }
  .pill.pass { color: var(--pass); border-color: transparent; background: var(--pass-weak); }
  .pill.fail { color: var(--fail); border-color: transparent; background: var(--fail-weak); }
  .pmeta { padding: 8px 16px 0; font-size: 12.5px; overflow-wrap: anywhere; }
  .pmeta a { color: var(--accent); }
  .bad { color: var(--fail); }
  .pbody { display: grid; grid-template-columns: 260px 1fr; gap: 16px; padding: 12px 16px 16px; align-items: start; }
  .pbody.noshot { grid-template-columns: 1fr; }
  .shot { position: sticky; top: 64px; display: block; max-height: calc(100vh - 90px); overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
  .shot img { display: block; width: 100%; }
  table.cases { width: 100%; border-collapse: collapse; }
  table.cases td { border-top: 1px solid var(--border); padding: 9px 6px; vertical-align: top; }
  table.cases tr:first-child td { border-top: 0; }
  td.st { width: 74px; white-space: nowrap; }
  .title { font-weight: 500; overflow-wrap: anywhere; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 6px; padding: 1px 8px; }
  .badge.passed { background: var(--pass-weak); color: var(--pass); }
  .badge.failed { background: var(--fail-weak); color: var(--fail); }
  .badge.flaky { background: var(--warn-weak); color: var(--warn); }
  .badge.skipped, .badge.pending { background: var(--surface-2); color: var(--skip); }
  .bdots { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .bdot { font-size: 11px; color: var(--muted); }
  .bdot::before { content: '●'; margin-right: 3px; }
  .bdot.passed::before { color: var(--pass); } .bdot.failed::before { color: var(--fail); } .bdot.flaky::before { color: var(--warn); } .bdot.skipped::before { color: var(--skip); }
  .checks { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .chk { font-size: 12px; border-radius: 6px; padding: 1px 7px; border: 1px solid var(--border); color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chk.passed { background: var(--pass-weak); color: var(--pass); border-color: transparent; }
  .chk.failed { background: var(--fail-weak); color: var(--fail); border-color: transparent; font-weight: 600; }
  .chk.warning { background: var(--warn-weak); color: var(--warn); border-color: transparent; }
  .why { font-size: 12.5px; margin-top: 5px; padding: 5px 8px; border-radius: 6px; overflow-wrap: anywhere; }
  .why.failed { background: var(--fail-weak); color: var(--fail); }
  .why.warning { background: var(--warn-weak); color: var(--warn); }
  pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--fail-weak); color: var(--fail); font: 12px/1.5 Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
  tr.hide, details.hide { display: none; }
  @media (max-width: 760px) {
    .pbody { grid-template-columns: 1fr; }
    .shot { position: static; max-height: 260px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>테스트 케이스${tests ? ' · 실행 결과' : ' <small class="muted" style="font-size:14px;font-weight:400">(실행 전)</small>'}</h1>
  <div class="sub">${esc(target)} · ${result.mode === 'ai' ? 'AI 테스트' : '규칙 기반 테스트'} · ${scope === 'all' ? '세부 사이트 모두' : '입력한 범위만'}${started ? ` · ${esc(started)}` : ''}${tests && tests.browsers.length ? ` · ${esc(tests.browsers.map((b) => b.name).join(', '))}` : ''}</div>

  <div class="tiles">
    <div class="tile"><div class="k">페이지</div><div class="v">${sections.length}</div></div>
    <div class="tile"><div class="k">케이스</div><div class="v">${caseCount}</div></div>
    ${tests ? `
    <div class="tile pass"><div class="k">통과</div><div class="v">${count.passed}</div></div>
    <div class="tile fail"><div class="k">실패</div><div class="v">${count.failed + count.flaky}</div></div>
    <div class="tile"><div class="k">확인 항목 (실패)</div><div class="v">${checkTotal} <span class="muted" style="font-size:14px">(${checkFailed})</span></div></div>` : `
    <div class="tile"><div class="k">확인 항목</div><div class="v">${checkTotal}</div></div>`}
    <div class="tile warn"><div class="k">오타 의심</div><div class="v">${typos.length}</div></div>
  </div>

  ${typoHtml}

  <div class="bar">
    <input type="search" id="q" placeholder="케이스 · 문구 검색">
    <label><input type="checkbox" id="onlyBad"> 실패·경고만</label>
    <button type="button" id="openAll">모두 펼치기</button>
    <button type="button" id="closeAll">모두 접기</button>
  </div>
  <nav class="toc">${toc}</nav>

  ${sections.join('') || '<p class="muted">실행된 테스트가 없습니다.</p>'}
</div>
<script>
  const q = document.getElementById('q');
  const onlyBad = document.getElementById('onlyBad');
  function apply() {
    const term = q.value.trim().toLowerCase();
    document.querySelectorAll('details.page').forEach((d) => {
      let shown = 0;
      d.querySelectorAll('tr.case').forEach((tr) => {
        const bad = tr.classList.contains('failed') || tr.classList.contains('flaky') || tr.classList.contains('warn');
        const hit = (!term || tr.dataset.text.includes(term)) && (!onlyBad.checked || bad);
        tr.classList.toggle('hide', !hit);
        if (hit) shown++;
      });
      d.classList.toggle('hide', shown === 0);
      if ((term || onlyBad.checked) && shown) d.open = true;
    });
  }
  q.addEventListener('input', apply);
  onlyBad.addEventListener('change', apply);
  document.getElementById('openAll').onclick = () => document.querySelectorAll('details.page').forEach((d) => (d.open = true));
  document.getElementById('closeAll').onclick = () => document.querySelectorAll('details.page').forEach((d) => (d.open = false));
</script>
</body>
</html>
`;
}

module.exports = { buildCasesHtml };

if (require.main === module) {
  const [casesJson, out, resultsJson] = process.argv.slice(2);
  if (!casesJson || !out) {
    console.error('사용법: node app/cases-report.js <cases.json> <출력.html> [results.json]');
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(casesJson, 'utf-8'));
  const result = { mode: 'basic' };
  if (resultsJson) result.tests = require('./server').summarizeReport(resultsJson);
  // 화면 캡처를 출력 파일 옆 screens/ 로 복사
  const srcScreens = path.join(path.dirname(casesJson), 'screens');
  const dstScreens = path.join(path.dirname(out), 'screens');
  if (fs.existsSync(srcScreens) && path.resolve(srcScreens) !== path.resolve(dstScreens)) fs.cpSync(srcScreens, dstScreens, { recursive: true });
  fs.writeFileSync(out, buildCasesHtml({ plan, result }), 'utf-8');
  console.log(`생성 완료: ${out}`);
}
