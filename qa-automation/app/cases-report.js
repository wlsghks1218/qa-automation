// 테스트 케이스 보기 페이지(cases.html) 생성
// 대분류(페이지) · 중분류(요소) · 소분류(확인 항목) · 과정 · 기대결과 · 결과 · 이유 표로 보여준다.
// 분석 직후에는 결과가 '미실행'인 TC 목록, 테스트 후에는 같은 목록에 결과가 채워진다.
// 외부 리소스 없이 결과 폴더 안에서 바로 열린다 (화면 캡처는 같은 폴더의 screens/ 참조).
//
// 단독 실행: node app/cases-report.js <cases.json> <출력.html> [results.json]

const fs = require('fs');
const path = require('path');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABEL = {
  passed: '통과', failed: '실패', flaky: '불안정', skipped: '건너뜀', pending: '미실행', warning: '경고',
  not_found: '화면에서 못 찾음', manual: '수동 확인 필요',
};
const CHECK_SEV = ['passed', 'skipped', 'warning', 'failed'];
const RUN_SEV = ['passed', 'skipped', 'flaky', 'failed'];

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
    if (got) return { ...got, kind: p.kind };
    // 오타 의심은 분석 단계에서 이미 알 수 있다. 단계(test.step) 항목은 테스트 전체 결과를 따른다
    if (p.kind === 'warn') return { name: p.name, kind: p.kind, status: 'warning', detail: p.detail || '', failedIn: [] };
    if (p.kind === 'skip') return { name: p.name, kind: p.kind, status: 'skipped', detail: p.detail || '', failedIn: [] };
    if (fromRuns && p.kind === 'step') {
      const status = fromRuns.status === 'flaky' ? 'passed' : fromRuns.status;
      return { name: p.name, kind: p.kind, status, detail: status === 'failed' ? fromRuns.error : '', failedIn: [] };
    }
    return { name: p.name, kind: p.kind, status: 'pending', detail: '', failedIn: [] };
  });
  // 목록에 없던 결과 항목(실행 중 추가된 경고 등)은 뒤에 붙인다
  for (const c of byName.values()) if (!pc.checks.some((p) => p.name === c.name)) checks.push(c);
  if (!fromRuns) return { status: 'pending', browsers: [], checks, error: '' };
  return { ...fromRuns, checks };
}

// ─────────────────────────────────────────────────────────────
// 케이스 제목 / 확인 항목 → 중분류 · 소분류 · 과정 · 기대결과
// ─────────────────────────────────────────────────────────────

/** '07. 배너 "USDT 결제…" (P01-F12)' → { target: '배너 "USDT 결제…"', middle: 번호·ID 뺀 제목 } */
function parseCaseTitle(title) {
  const middle = title.replace(/^\d+\.\s*/, '').replace(/\s*\(P\d+-F\d+\)$/, '');
  const m = middle.match(/^(.*?)\s*"(.*)"/);
  return { target: m ? `${m[1]} "${m[2]}"` : middle, middle };
}

const quoted = (name) => (name.match(/"(.*)"/) || [])[1] || '';

/** 동작 설명(생성기의 action 문구) → [과정, 기대결과] */
function describeAction(action, target) {
  const rules = [
    [/^페이지 이동 → (.+)$/, (m) => [`${target} 클릭`, `${m[1]} 페이지로 이동`]],
    [/^외부 사이트 이동 → (.+)$/, (m) => [`${target} 클릭`, `외부 사이트 ${m[1]} 로 이동 (이동 여부만 확인)`]],
    [/^새 탭 열기 → (.+)$/, (m) => [`${target} 클릭`, `새 탭에서 ${m[1]} 열림`]],
    [/^링크 연결/, () => [`${target} 클릭`, '정상 페이지로 연결 (분석 시 연결 실패)']],
    [/^모달\/시트 노출 "(.*)" 후 닫힘$/, (m) => [`${target} 클릭 → 닫기`, `"${m[1]}" 팝업이 열리고 닫기로 닫힘`]],
    [/^(모달\/시트 노출|콘텐츠 노출) "(.*)"$/, (m) => [`${target} 클릭`, `"${m[2]}" 표시`]],
    [/^펼침 → 접힘$/, () => [`${target} 클릭 → 다시 클릭`, '펼쳐졌다가 다시 누르면 접힘']],
    [/^펼침$/, () => [`${target} 클릭`, '내용이 펼쳐짐']],
    [/^옵션 선택 "(.*)"$/, (m) => [`${target}에서 "${m[1]}" 선택`, `"${m[1]}" 선택됨`]],
    [/^목차 이동 → (.+)$/, (m) => [`${target} 클릭`, `${m[1]} 위치로 이동`]],
    [/^탭 전환$/, () => [`${target} 클릭`, '해당 탭이 선택됨']],
    [/^표 정렬$/, () => [`${target} 클릭`, '표의 행 순서가 그 기준으로 정렬됨']],
    [/^입력 → "(.*)" 버튼 활성화$/, (m) => [`${target}에 값 입력`, `입력값 반영, "${m[1]}" 버튼 활성화`]],
    [/^입력$/, () => [`${target}에 값 입력`, '입력값 반영']],
    [/^선택\(체크\)$/, () => [`${target} 체크`, '체크됨']],
    [/^클릭 시 오류 없음$/, () => [`${target} 클릭`, '오류 없이 동작']],
  ];
  for (const [re, fn] of rules) {
    const m = action.match(re);
    if (m) return fn(m);
  }
  return [`${target} 조작`, action];
}

/** 확인 항목 하나 → { small(소분류), step(과정), expected(기대결과) } */
function describeCheck(check, info) {
  const { name } = check;
  const t = info.target;
  const q = quoted(name);
  if (name === '노출') return { small: '노출', step: `화면에서 ${t} 확인`, expected: '화면에 노출됨' };
  if (name.startsWith('문구 노출:')) return { small: '문구', step: '화면에서 문구 확인', expected: `"${q}" 표시` };
  if (name.startsWith('문구:')) return { small: '문구', step: `${t}의 문구 확인`, expected: `"${q}" 표시` };
  if (/^(로고|이미지) 노출:/.test(name)) return { small: '노출', step: `화면에서 ${name.split(' ')[0]} "${q}" 확인`, expected: '노출되고 깨지지 않음' };
  if (name === '이미지 로드') return { small: '이미지', step: `${t} 안의 이미지 확인`, expected: '이미지가 깨지지 않고 표시됨' };
  if (name.startsWith('마우스 오버:')) return { small: '마우스 오버', step: `${t}에 마우스 올리기`, expected: `"${q}" 표시` };
  if (name.startsWith('롤링 문구 노출:')) return { small: '롤링', step: '롤링 영역을 보며 대기 (최대 20초)', expected: `"${q}" 가 차례로 표시` };
  if (name.startsWith('오타 의심:')) return { small: '오타', step: '사이트 전체 문구와 비교 (규칙 기반)', expected: `"${q}" 에 오타 없음` };
  if (name === '동작' && check.kind === 'skip') return { small: '동작', step: `${t} 클릭`, expected: '-' };
  if (name.startsWith('동작:')) {
    const [step, expected] = describeAction(name.slice(3).trim(), t);
    return { small: '동작', step, expected };
  }
  if (name === 'HTTP 응답 정상') return { small: '접속', step: '페이지 접속', expected: 'HTTP 응답 정상 (400 미만)' };
  if (name === '이미지 정상 로드') return { small: '이미지', step: '페이지 끝까지 스크롤', expected: '깨진 이미지 없음' };
  if (name === 'JS 런타임 오류 없음') return { small: '스크립트', step: '페이지 접속', expected: 'JS 런타임 오류 없음' };
  if (name.startsWith('표 구조:')) return { small: '표', step: '화면의 표 확인', expected: name.replace(/^표 구조:\s*/, '') };
  if (name.startsWith('봇 차단')) return { small: '접속', step: '페이지 접속', expected: '봇 차단/보안 확인 화면이 아님' };
  return { small: name, step: '', expected: '' };
}

// ─────────────────────────────────────────────────────────────
// 표의 행 만들기
// ─────────────────────────────────────────────────────────────

/** 생성기 케이스 하나 → 확인 항목마다 한 행 */
function rowsFromPlanCase(pageLabel, page, screensBase, pc, merged) {
  const info = parseCaseTitle(pc.title);
  const shot = page && page.screenshot ? `${screensBase}/${path.basename(page.screenshot)}` : null;
  const base = { big: pageLabel, bigLink: page && page.url, shot, middle: info.middle, caseKey: `${pageLabel}\n${pc.title}` };
  if (!merged.checks.length) {
    return [{ ...base, small: '-', step: '', expected: '', status: merged.status, reason: merged.error }];
  }
  const multi = merged.browsers.length > 1;
  return merged.checks.map((c) => {
    const d = describeCheck(c, info);
    const where = multi && c.failedIn && c.failedIn.length ? `[${c.failedIn.join(', ')}] ` : '';
    return { ...base, ...d, status: c.status, reason: c.status === 'passed' ? '' : `${where}${c.detail || ''}` };
  });
}

/** 기획서 / AI 분석 TC → 행 (TC 자체에 과정·기대결과가 있다) */
function rowsFromDocTcs(groupLabel, doc) {
  return (doc.testCases || []).map((tc) => {
    const m = tc.mapping;
    const ex = tc.execution;
    const status = ex ? ex.status : m && m.status !== 'automated' ? m.status : 'pending';
    const reason = [m && m.status !== 'automated' ? m.reason : '', m && m.conflict ? `실제 동작 차이: ${m.conflict}` : '', ex && ex.error ? ex.error : '']
      .filter(Boolean)
      .join(' / ');
    return {
      big: groupLabel,
      middle: tc.feature || tc.source || '-',
      small: `${tc.id} ${tc.title}`,
      step: [tc.precondition ? `(사전조건) ${tc.precondition}` : '', ...(tc.steps || []).map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join('\n'),
      expected: tc.expected || '',
      status: status === 'flaky' ? 'failed' : status,
      reason,
      caseKey: `${groupLabel}\n${tc.id}`,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────

/**
 * plan: 생성기가 만든 케이스 목록(cases.json) - 분석 직후 '미실행' 상태로도 보여줄 수 있다
 * result: 실행 결과(summary). 있으면 같은 케이스·항목에 결과를 채운다. 기획서/AI TC 도 함께 표시
 */
function buildCasesHtml({ plan, result = {}, screensBase = 'screens' }) {
  const tests = result.tests || null;
  const typos = result.typos || plan?.typos || [];
  const resultGroups = new Map(((tests && tests.groups) || []).map((g) => [g.title, g]));
  const rows = [];
  const used = new Set();

  // 1) 생성기 케이스 목록 (페이지별, 화면 순서)
  for (const p of plan?.pages || []) {
    const g = resultGroups.get(p.group);
    if (g) used.add(p.group);
    const pageTitle = p.group.replace(/^\[[^\]]+\]\s*\S+\s*(-\s*)?/, '');
    const pageLabel = `${p.path}${pageTitle ? `\n${pageTitle}` : ''}`;
    for (const pc of p.cases) {
      const runs = g ? g.tests.filter((t) => t.title === pc.title) : [];
      rows.push(...rowsFromPlanCase(pageLabel, p, screensBase, pc, mergePlanned(pc, runs)));
    }
  }

  // 2) 기획서 / AI 분석 TC
  const docGroups = [];
  if (result.doc) docGroups.push(['기획서', result.doc]);
  if (result.ai && result.ai.doc) docGroups.push(['AI 분석', result.ai.doc]);
  for (const [label, doc] of docGroups) {
    rows.push(...rowsFromDocTcs(`${label}${doc.documentTitle ? `\n${doc.documentTitle}` : ''}`, doc));
    for (const title of resultGroups.keys()) if (title.startsWith(`[${label}]`)) used.add(title);
  }

  // 3) 그 외 결과 그룹 (목록에 없는 테스트)
  for (const g of (tests && tests.groups) || []) {
    if (used.has(g.title)) continue;
    const byTitle = new Map();
    g.tests.forEach((t) => byTitle.set(t.title, [...(byTitle.get(t.title) || []), t]));
    for (const [title, runs] of byTitle) {
      const merged = mergeRuns(runs);
      const pc = { title, checks: merged.checks.map((c) => ({ name: c.name, kind: 'run' })) };
      rows.push(...rowsFromPlanCase(g.title, null, screensBase, pc, merged));
    }
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const caseCount = new Set(rows.map((r) => r.caseKey)).size;
  const pageCount = new Set(rows.map((r) => r.big)).size;
  const started = result.startedAt
    ? new Date(result.startedAt).toLocaleString('ko-KR')
    : plan?.meta?.generatedAt ? new Date(plan.meta.generatedAt).toLocaleString('ko-KR') : '';
  const target = [result.url || plan?.meta?.startUrl, result.fileName].filter(Boolean).join(' + ');
  const scope = result.scope || plan?.meta?.scope;
  const browsers = tests ? tests.browsers.map((b) => b.name).join(', ') : '';

  const nl = (s) => esc(s).replace(/\n/g, '<br>');
  const body = rows
    .map((r) => {
      const links = r.bigLink
        ? `<div class="links"><a href="${esc(r.bigLink)}" target="_blank" rel="noopener">페이지 열기</a>${r.shot ? ` · <a href="${esc(r.shot)}" target="_blank">화면 캡처</a>` : ''}</div>`
        : '';
      const text = `${r.big} ${r.middle} ${r.small} ${r.step} ${r.expected} ${r.reason}`.toLowerCase();
      return `<tr class="r ${r.status}" data-big="${esc(r.big)}" data-case="${esc(r.caseKey)}" data-text="${esc(text)}">`
        + `<td class="c-big"><span class="v">${nl(r.big)}</span>${links}</td><td class="c-mid">${nl(r.middle)}</td><td class="c-small">${nl(r.small)}</td>`
        + `<td>${nl(r.step)}</td><td>${nl(r.expected)}</td><td class="c-st"><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>`
        + `<td class="c-why">${nl(r.reason)}</td></tr>`;
    })
    .join('\n');

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
  body { margin: 0; background: var(--bg); color: var(--text); font: 13.5px/1.5 -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
  .wrap { max-width: 1600px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h1 small { font-size: 14px; font-weight: 400; color: var(--muted); }
  h2 { font-size: 15px; margin: 0 0 6px; }
  h2 small { font-weight: 400; color: var(--muted); font-size: 12.5px; }
  .muted { color: var(--muted); }
  .sub { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin: 18px 0; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
  .tile .k { font-size: 12px; color: var(--muted); }
  .tile .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile.pass .v { color: var(--pass); } .tile.fail .v { color: var(--fail); } .tile.warn .v { color: var(--warn); }
  .typos { background: var(--warn-weak); border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; }
  .typos ul { margin: 0; padding-left: 20px; }
  .bar { position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 10px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .bar input[type=search], .bar select { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; }
  .bar input[type=search] { flex: 1; min-width: 180px; }
  .bar select { max-width: 260px; }
  .bar button { padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
  .bar .count { color: var(--muted); font-size: 12.5px; }
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 1100px; }
  th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  td + td, th + th { border-left: 1px solid var(--border); }
  thead th { background: var(--surface-2); font-size: 12.5px; color: var(--muted); font-weight: 600; white-space: nowrap; }
  .c-big { width: 13%; font-weight: 600; background: var(--surface); }
  .c-mid { width: 17%; background: var(--surface); }
  .c-small { width: 8%; white-space: nowrap; }
  .c-st { width: 84px; white-space: nowrap; }
  .c-why { width: 22%; color: var(--fail); font-size: 12.5px; }
  tr.warning .c-why, tr.skipped .c-why, tr.manual .c-why, tr.not_found .c-why { color: var(--muted); }
  .links { font-weight: 400; font-size: 12px; margin-top: 4px; }
  .links a { color: var(--accent); }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 6px; padding: 1px 8px; }
  .badge.passed { background: var(--pass-weak); color: var(--pass); }
  .badge.failed, .badge.flaky { background: var(--fail-weak); color: var(--fail); }
  .badge.warning, .badge.manual, .badge.not_found { background: var(--warn-weak); color: var(--warn); }
  .badge.skipped, .badge.pending { background: var(--surface-2); color: var(--skip); }
  tr.hide, td.merged { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>테스트 케이스 <small>${tests ? '실행 결과' : '실행 전'}</small></h1>
  <div class="sub">${esc(target)} · ${result.mode === 'ai' ? 'AI 테스트' : '규칙 기반 테스트'} · ${scope === 'all' ? '세부 사이트 모두' : '입력한 범위만'}${started ? ` · ${esc(started)}` : ''}${browsers ? ` · ${esc(browsers)}` : ''}</div>

  <div class="tiles">
    <div class="tile"><div class="k">대분류</div><div class="v">${pageCount}</div></div>
    <div class="tile"><div class="k">중분류</div><div class="v">${caseCount}</div></div>
    <div class="tile"><div class="k">확인 항목</div><div class="v">${rows.length}</div></div>
    ${tests ? `<div class="tile pass"><div class="k">통과</div><div class="v">${count('passed')}</div></div>
    <div class="tile fail"><div class="k">실패</div><div class="v">${count('failed') + count('flaky')}</div></div>
    <div class="tile"><div class="k">건너뜀·미실행</div><div class="v">${count('skipped') + count('pending')}</div></div>` : ''}
    <div class="tile warn"><div class="k">오타 의심</div><div class="v">${typos.length}</div></div>
  </div>

  ${typos.length ? `<section class="typos"><h2>오타 의심 문구 <small>${typos.length}건 · 규칙 기반 검사 (확정 아님)</small></h2><ul>${typos
    .map((t) => `<li>"${esc(t.text)}" <span class="muted">- ${esc((t.reasons || []).join(' / '))}${t.pages ? ` · ${esc(t.pages.join(', '))}` : ''}</span></li>`)
    .join('')}</ul></section>` : ''}

  <div class="bar">
    <input type="search" id="q" placeholder="검색 (요소 · 문구 · 기대결과 · 이유)">
    <select id="big"><option value="">대분류 전체</option>${[...new Set(rows.map((r) => r.big))].map((b) => `<option value="${esc(b)}">${esc(b.split('\n')[0])}</option>`).join('')}</select>
    <select id="st"><option value="">결과 전체</option><option value="bad">실패·경고만</option>${['passed', 'failed', 'warning', 'skipped', 'pending'].map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select>
    <button type="button" id="csv">엑셀(CSV) 다운로드</button>
    <span class="count" id="count"></span>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>대분류</th><th>중분류</th><th>소분류</th><th>과정</th><th>기대결과</th><th>결과</th><th>이유</th></tr></thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>
</div>
<script>
  const rows = Array.from(document.querySelectorAll('tr.r'));
  const $ = (id) => document.getElementById(id);
  const BAD = ['failed', 'flaky', 'warning', 'not_found', 'manual'];

  // 보이는 줄 기준으로 대분류 · 중분류 칸을 세로로 합친다 (필터를 바꾸면 다시 계산)
  function merge() {
    for (const [cls, key] of [['c-big', 'big'], ['c-mid', 'case']]) {
      let head = null;
      for (const tr of rows) {
        if (tr.classList.contains('hide')) continue;
        const td = tr.querySelector('.' + cls);
        if (head && head.key === tr.dataset[key]) {
          td.classList.add('merged');
          head.td.rowSpan = ++head.span;
        } else {
          td.classList.remove('merged');
          td.rowSpan = 1;
          head = { key: tr.dataset[key], td, span: 1 };
        }
      }
    }
  }

  function apply() {
    const term = $('q').value.trim().toLowerCase();
    const big = $('big').value;
    const st = $('st').value;
    let shown = 0;
    for (const tr of rows) {
      const status = tr.classList[1];
      const ok = (!term || tr.dataset.text.includes(term)) && (!big || tr.dataset.big === big) && (!st || (st === 'bad' ? BAD.includes(status) : status === st));
      tr.classList.toggle('hide', !ok);
      if (ok) shown++;
    }
    $('count').textContent = shown + ' / ' + rows.length + '개 항목';
    merge();
  }

  // 지금 보이는 줄을 CSV 로 (엑셀에서 한글이 깨지지 않도록 BOM 포함)
  $('csv').onclick = () => {
    const cell = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['대분류', '중분류', '소분류', '과정', '기대결과', '결과', '이유'].map(cell).join(',')];
    for (const tr of rows) {
      if (tr.classList.contains('hide')) continue;
      const tds = tr.querySelectorAll('td');
      const big = tds[0].querySelector('.v').innerText.trim();
      lines.push([big, ...Array.from(tds).slice(1).map((td) => td.innerText.trim())].map(cell).join(','));
    }
    const blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'testcases.csv';
    a.click();
  };

  $('q').addEventListener('input', apply);
  $('big').addEventListener('change', apply);
  $('st').addEventListener('change', apply);
  apply();
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
