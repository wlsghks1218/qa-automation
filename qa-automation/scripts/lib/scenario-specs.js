// 시나리오(여러 화면을 이어 가는 사용자 흐름) JSON → Playwright spec 생성
// 형식 설명: docs/scenario-format.md
//
// 요소 테스트(generate-specs.js)는 요소 하나를 눌러 본 직후만 확인한다. 시나리오는 사람이 정한 순서대로
// 입력 · 클릭을 이어 가며, 단계마다 사람이 정한 기대 결과를 확인한다 (기대값 = 사람이 쓴 값).
//  - 동작(클릭 · 입력 등)이 실패하면 그 뒤 단계는 실행하지 않는다 (checks 의 gate)
//  - 확인(expect)이 실패해도 다음 단계는 계속 진행한다 (한 번 실행으로 여러 문제를 찾기 위해)
//  - 정리(cleanup) 단계는 앞 단계가 실패해도 항상 실행하고, 실패하면 경고로만 남긴다
const fs = require('fs');
const path = require('path');

const GROUP = '[시나리오] 사용자 흐름';
const SPEC_FILE = 'scenarios.spec.ts';

// 되돌릴 수 없는 동작 · 세션을 끊는 동작 (generate-specs.js 의 ALWAYS_BLOCK 과 동일하게 유지)
const ALWAYS_BLOCK = /(탈퇴|송금|출금하기|결제하기|구매하기|로그아웃|log\s?out|sign\s?out|withdraw|unsubscribe)/i;
// 테스트 환경으로 보이는 host (docs/input-expansion-plan.md Phase 1 의 추정 규칙)
const TEST_HOST = /(^|[.\-_])(dev|stg|stage|staging|test|qa|beta|sandbox|uat|local)([.\-_\d]|$)|^localhost$|^127\.|^10\.|^192\.168\.|\.local$/i;

const ACTIONS = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'hover', 'press', 'read'];
const NEEDS_TARGET = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'read'];
const TARGET_KINDS = ['role', 'label', 'placeholder', 'text', 'testId', 'css'];
const EXPECT_KINDS = ['url', 'text', 'notText', 'visible', 'hidden', 'enabled', 'disabled', 'value', 'count'];
const BUILTIN_VARS = ['unique', 'today', 'now'];
const ROLE_KO = { button: '버튼', link: '링크', textbox: '입력란', checkbox: '체크박스', radio: '라디오', combobox: '선택 상자', tab: '탭', menuitem: '메뉴', option: '옵션', heading: '제목', row: '행', cell: '칸', dialog: '대화상자' };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
// 확인 항목 이름은 "이름|상태|상세" 로 기록되므로 '|' 와 줄바꿈을 뺀다
const clean = (s) => String(s).replace(/[|\r\n]+/g, ' ').trim();

/** 운영 · 테스트 환경 판별. 화면에서 고른 값이 있으면 그 값, 없으면 host 로 추정 (모르면 운영으로 본다) */
function envKind(url, envType) {
  if (envType === 'production') return 'production';
  if (envType === 'beta' || envType === 'staging') return 'test';
  try {
    return TEST_HOST.test(new URL(url).hostname) ? 'test' : 'production';
  } catch {
    return 'production';
  }
}

// ─────────────────────────────────────────────────────────────
// 문자열 안의 {{변수}} → 코드
// ─────────────────────────────────────────────────────────────

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const varsIn = (s) => [...String(s).matchAll(VAR)].map((m) => m[1]);

/** "QA-{{unique}}" → `QA-${v["unique"]}` (변수가 없으면 일반 문자열) */
function tpl(value) {
  const s = String(value);
  if (!varsIn(s).length) return JSON.stringify(s);
  const esc = (t) => t.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(VAR)) {
    out += `${esc(s.slice(last, m.index))}\${v[${JSON.stringify(m[1])}]}`;
    last = m.index + m[0].length;
  }
  return `\`${out}${esc(s.slice(last))}\``;
}

// ─────────────────────────────────────────────────────────────
// 요소 찾기(target) → 로케이터 코드 · 사람이 읽는 이름
// ─────────────────────────────────────────────────────────────

function targetKind(t) {
  return TARGET_KINDS.find((k) => typeof t[k] === 'string' && t[k]);
}

/** 후보 하나의 로케이터 (보이는 것만 · 순서 적용 전) */
function baseLocator(t) {
  const root = t.within ? locatorCode(t.within) : 'page';
  const exact = t.exact !== false;
  const kind = targetKind(t);
  let code = {
    role: () => (t.name === undefined ? `${root}.getByRole(${JSON.stringify(t.role)})` : `${root}.getByRole(${JSON.stringify(t.role)}, { name: ${tpl(t.name)}, exact: ${exact} })`),
    label: () => `${root}.getByLabel(${tpl(t.label)}, { exact: ${exact} })`,
    placeholder: () => `${root}.getByPlaceholder(${tpl(t.placeholder)}, { exact: ${exact} })`,
    text: () => `${root}.getByText(${tpl(t.text)}, { exact: ${exact} })`,
    testId: () => `${root}.getByTestId(${JSON.stringify(t.testId)})`,
    css: () => `${root}.locator(${JSON.stringify(t.css)})`,
  }[kind]();
  if (t.hasText !== undefined) code += `.filter({ hasText: ${tpl(t.hasText)} })`;
  return code;
}

/**
 * target → Playwright 로케이터 코드.
 * 배열이면 앞에서부터 대체 후보(이름이 바뀌어도 찾도록). all: 순서를 정하지 않고 일치하는 전체 (개수 · 숨김 확인용)
 */
function locatorCode(target, { all = false } = {}) {
  const list = Array.isArray(target) ? target : [target];
  const combined = list.map(baseLocator).reduce((a, b) => `${a}.or(${b})`);
  const visible = `${combined}.filter({ visible: true })`;
  return all ? visible : `${visible}.nth(${Number(list[0].nth) || 0})`;
}

function targetLabel(target) {
  const t = Array.isArray(target) ? target[0] : target;
  const kind = targetKind(t);
  const own = {
    role: () => `${ROLE_KO[t.role] || t.role}${t.name !== undefined ? ` "${t.name}"` : ''}`,
    label: () => `입력란 "${t.label}"`,
    placeholder: () => `입력란 "${t.placeholder}"`,
    text: () => `문구 "${t.text}"`,
    testId: () => `요소 [${t.testId}]`,
    css: () => `요소 ${t.css}`,
  }[kind]();
  const has = t.hasText !== undefined ? ` ("${t.hasText}" 포함)` : '';
  return clean(`${t.within ? `${targetLabel(t.within)} 안의 ` : ''}${own}${has}`);
}

// ─────────────────────────────────────────────────────────────
// 검증
// ─────────────────────────────────────────────────────────────

function checkTarget(target, where, errors, used) {
  const list = Array.isArray(target) ? target : [target];
  if (!list.length) return errors.push(`${where}: target 이 비어 있습니다`);
  for (const t of list) {
    if (!isObj(t) || !targetKind(t)) {
      errors.push(`${where}: target 에는 ${TARGET_KINDS.join(' · ')} 중 하나가 필요합니다`);
      continue;
    }
    for (const k of ['name', 'label', 'placeholder', 'text', 'hasText']) if (t[k] !== undefined) used.push([where, String(t[k])]);
    if (t.within !== undefined) checkTarget(t.within, `${where} within`, errors, used);
  }
}

function checkExpect(e, where, errors, used) {
  const kinds = isObj(e) ? EXPECT_KINDS.filter((k) => e[k] !== undefined) : [];
  if (kinds.length !== 1) return errors.push(`${where}: 확인 하나에는 ${EXPECT_KINDS.join(' · ')} 중 정확히 하나를 씁니다`);
  const kind = kinds[0];
  const val = e[kind];
  if (['url', 'text', 'notText'].includes(kind)) {
    if (typeof val !== 'string' || !val) return errors.push(`${where}: ${kind} 는 문자열입니다`);
    used.push([where, val]);
    if (kind === 'text' && e.in !== undefined) checkTarget(e.in, `${where} in`, errors, used);
  } else if (['visible', 'hidden', 'enabled', 'disabled'].includes(kind)) {
    checkTarget(val, where, errors, used);
  } else if (kind === 'value') {
    if (!isObj(val) || val.equals === undefined) return errors.push(`${where}: value 는 { target, equals } 입니다`);
    checkTarget(val.target, where, errors, used);
    used.push([where, String(val.equals)]);
  } else if (kind === 'count') {
    const modes = isObj(val) ? ['equals', 'min', 'delta'].filter((k) => val[k] !== undefined) : [];
    if (modes.length !== 1) return errors.push(`${where}: count 는 { target, equals | min | delta } 입니다`);
    checkTarget(val.target, where, errors, used);
    if (modes[0] === 'equals') used.push([where, String(val.equals)]);
    if (modes[0] === 'min' && !Number.isFinite(Number(val.min))) errors.push(`${where}: count.min 은 숫자입니다`);
    if (modes[0] === 'delta') {
      if (!isObj(val.delta) || typeof val.delta.from !== 'string' || !Number.isFinite(Number(val.delta.by))) errors.push(`${where}: count.delta 는 { from: 변수 이름, by: 숫자 } 입니다`);
      else used.push([where, `{{${val.delta.from}}}`]);
    }
  }
}

function checkStep(s, where, errors, known, { cleanup = false } = {}) {
  if (!isObj(s) || !ACTIONS.includes(s.action)) return errors.push(`${where}: action 은 ${ACTIONS.join(' · ')} 중 하나입니다`);
  const used = [];
  if (NEEDS_TARGET.includes(s.action)) {
    if (s.target === undefined) errors.push(`${where}: ${s.action} 에는 target 이 필요합니다`);
    else checkTarget(s.target, where, errors, used);
  } else if (s.action === 'press' && s.target !== undefined) checkTarget(s.target, where, errors, used);
  if (s.action === 'goto') {
    if (typeof s.url !== 'string' || !s.url) errors.push(`${where}: goto 에는 url 이 필요합니다`);
    else used.push([where, s.url]);
  }
  if (['fill', 'select'].includes(s.action)) {
    if (typeof s.value !== 'string') errors.push(`${where}: ${s.action} 에는 value(문자열)가 필요합니다`);
    else used.push([where, s.value]);
  }
  if (s.action === 'press' && (typeof s.key !== 'string' || !s.key)) errors.push(`${where}: press 에는 key 가 필요합니다 (예: "Enter")`);
  if (s.action === 'read') {
    if (typeof s.as !== 'string' || !/^[\w가-힣]+$/.test(s.as)) errors.push(`${where}: read 에는 as(저장할 변수 이름)가 필요합니다`);
    if (s.what !== undefined && !['text', 'value', 'count'].includes(s.what)) errors.push(`${where}: read.what 은 text · value · count 중 하나입니다`);
  }
  const expects = s.expect === undefined ? [] : Array.isArray(s.expect) ? s.expect : [s.expect];
  if (cleanup && expects.length) errors.push(`${where}: 정리 단계에는 expect 를 쓸 수 없습니다`);
  expects.forEach((e, j) => checkExpect(e, `${where} 확인 ${j + 1}`, errors, used));

  // 변수는 쓰기 전에 정의되어 있어야 한다. 비밀값은 리포트 · 트레이스에 평문으로 남으므로 아직 받지 않는다
  for (const [at, text] of used) {
    for (const name of varsIn(text)) {
      if (/^secret:/i.test(name)) errors.push(`${at}: 비밀값({{${name}}})은 아직 지원하지 않습니다. 로그인은 프로그램의 저장된 로그인을 사용하세요`);
      else if (!known.has(name)) errors.push(`${at}: 정의되지 않은 변수 {{${name}}}`);
    }
  }
  if (s.action === 'read' && typeof s.as === 'string') known.add(s.as);
}

/** 형식 검사. 문제 목록(빈 배열이면 정상)을 돌려준다 */
function validateScenario(sc) {
  const errors = [];
  if (!isObj(sc)) return ['시나리오는 JSON 객체여야 합니다'];
  if (typeof sc.name !== 'string' || !sc.name.trim()) errors.push('name(시나리오 이름)이 필요합니다');
  if (sc.startUrl !== undefined && typeof sc.startUrl !== 'string') errors.push('startUrl 은 문자열입니다');
  if (!Array.isArray(sc.steps) || !sc.steps.length) errors.push('steps(단계)가 하나 이상 필요합니다');

  const known = new Set(BUILTIN_VARS);
  if (sc.variables !== undefined && !isObj(sc.variables)) errors.push('variables 는 { 이름: 값 } 객체입니다');
  for (const [name, value] of Object.entries(isObj(sc.variables) ? sc.variables : {})) {
    if (!/^[\w가-힣]+$/.test(name) || BUILTIN_VARS.includes(name)) errors.push(`variables.${name}: 쓸 수 없는 변수 이름입니다`);
    for (const ref of varsIn(String(value))) {
      if (/^secret:/i.test(ref)) errors.push(`variables.${name}: 비밀값({{${ref}}})은 아직 지원하지 않습니다`);
      else if (!known.has(ref)) errors.push(`variables.${name}: 정의되지 않은 변수 {{${ref}}}`);
    }
    known.add(name);
  }
  if (typeof sc.startUrl === 'string') for (const ref of varsIn(sc.startUrl)) if (!known.has(ref)) errors.push(`startUrl: 정의되지 않은 변수 {{${ref}}}`);

  (Array.isArray(sc.steps) ? sc.steps : []).forEach((s, i) => checkStep(s, `단계 ${i + 1}`, errors, known));
  if (sc.cleanup !== undefined && !Array.isArray(sc.cleanup)) errors.push('cleanup 은 단계 배열입니다');
  (Array.isArray(sc.cleanup) ? sc.cleanup : []).forEach((s, i) => checkStep(s, `정리 ${i + 1}`, errors, known, { cleanup: true }));
  return errors;
}

/** 되돌릴 수 없는 동작(탈퇴 · 결제 · 송금 등)을 누르는 단계 */
function irreversibleSteps(sc) {
  return [...sc.steps, ...(sc.cleanup || [])]
    .filter((s) => ['click', 'press'].includes(s.action) && s.target !== undefined && ALWAYS_BLOCK.test(targetLabel(s.target)))
    .map((s) => targetLabel(s.target));
}

// ─────────────────────────────────────────────────────────────
// 단계 · 확인 → 코드와 케이스 목록(과정 · 기대결과)
// ─────────────────────────────────────────────────────────────

/** 동작 하나 → { title(사람이 읽는 과정), lines(코드) } */
function actionCode(s) {
  const loc = s.target !== undefined ? locatorCode(s.target) : null;
  const label = s.target !== undefined ? targetLabel(s.target) : '';
  switch (s.action) {
    case 'goto':
      return { title: `이동: ${s.url}`, lines: [`await page.goto(new URL(${tpl(s.url)}, BASE).href, { waitUntil: 'domcontentloaded' });`] };
    case 'click':
      return { title: `클릭: ${label}`, lines: [`await ${loc}.click();`] };
    case 'fill':
      return { title: `입력: ${label} ← "${s.value}"`, lines: [`await ${loc}.fill(${tpl(s.value)});`] };
    case 'select':
      return { title: `선택: ${label} → "${s.value}"`, lines: [`await ${loc}.selectOption({ label: ${tpl(s.value)} });`] };
    case 'check':
      return { title: `체크: ${label}`, lines: [`await ${loc}.check();`] };
    case 'uncheck':
      return { title: `체크 해제: ${label}`, lines: [`await ${loc}.uncheck();`] };
    case 'hover':
      return { title: `마우스 올리기: ${label}`, lines: [`await ${loc}.hover();`] };
    case 'press':
      return { title: `키 입력: ${s.key}${label ? ` (${label})` : ''}`, lines: [loc ? `await ${loc}.press(${JSON.stringify(s.key)});` : `await page.keyboard.press(${JSON.stringify(s.key)});`] };
    default: {
      // read: 화면의 값을 변수에 담아 뒤 단계에서 쓴다
      const what = s.what || 'text';
      const key = JSON.stringify(s.as);
      const line = {
        text: `v[${key}] = (await ${loc}.innerText()).trim();`,
        value: `v[${key}] = await ${loc}.inputValue();`,
        count: `v[${key}] = String(await ${locatorCode(s.target, { all: true })}.count());`,
      }[what];
      return { title: `읽기: ${label}의 ${{ text: '문구', value: '입력값', count: '개수' }[what]} → {{${s.as}}}`, lines: [line] };
    }
  }
}

/** 확인 하나 → { expected(기대결과), lines } */
function expectCode(e) {
  const kind = EXPECT_KINDS.find((k) => e[k] !== undefined);
  const val = e[kind];
  switch (kind) {
    case 'url':
      return { expected: `주소가 ${val}`, lines: [`await expect(page).toHaveURL(urlPattern(BASE, ${tpl(val)}));`] };
    case 'text':
      return e.in !== undefined
        ? { expected: `${targetLabel(e.in)}에 "${val}" 표시`, lines: [`await expect(${locatorCode(e.in)}).toContainText(${tpl(val)});`] }
        : { expected: `"${val}" 표시`, lines: [`await expect(page.getByText(${tpl(val)}).filter({ visible: true }).first()).toBeVisible();`] };
    case 'notText':
      return { expected: `"${val}" 가 보이지 않음`, lines: [`await expect(page.getByText(${tpl(val)}).filter({ visible: true })).toHaveCount(0);`] };
    case 'visible':
      return { expected: `${targetLabel(val)} 노출`, lines: [`await expect(${locatorCode(val)}).toBeVisible();`] };
    case 'hidden':
      return { expected: `${targetLabel(val)} 가 보이지 않음`, lines: [`await expect(${locatorCode(val, { all: true })}).toHaveCount(0);`] };
    case 'enabled':
      return { expected: `${targetLabel(val)} 를 누를 수 있음`, lines: [`await expect(${locatorCode(val)}).toBeEnabled();`] };
    case 'disabled':
      return { expected: `${targetLabel(val)} 가 비활성`, lines: [`await expect(${locatorCode(val)}).toBeDisabled();`] };
    case 'value':
      return { expected: `${targetLabel(val.target)}의 값이 "${val.equals}"`, lines: [`await expect(${locatorCode(val.target)}).toHaveValue(${tpl(String(val.equals))});`] };
    default: {
      const all = locatorCode(val.target, { all: true });
      const label = targetLabel(val.target);
      if (val.equals !== undefined) return { expected: `${label} 개수가 ${val.equals}`, lines: [`await expect(${all}).toHaveCount(Number(${tpl(String(val.equals))}));`] };
      if (val.min !== undefined) return { expected: `${label} 개수가 ${val.min} 이상`, lines: [`await expect.poll(() => ${all}.count()).toBeGreaterThanOrEqual(${Number(val.min)});`] };
      const by = Number(val.delta.by);
      return {
        expected: `${label} 개수가 {{${val.delta.from}}} 보다 ${Math.abs(by)} ${by < 0 ? '적음' : '많음'}`,
        lines: [`await expect(${all}).toHaveCount(Number(v[${JSON.stringify(val.delta.from)}]) + ${by < 0 ? `(${by})` : by});`],
      };
    }
  }
}

/**
 * 시나리오 하나 → test 코드 + 케이스 목록.
 * checks: [{ name, small, step, expected, kind }] — cases.html 의 소분류 · 과정 · 기대결과
 */
function scenarioTest(sc, title) {
  const out = [];
  const checks = [];
  const start = sc.startUrl || '/';
  const stepCount = sc.steps.length + (sc.cleanup || []).length;

  out.push(`  test(${JSON.stringify(title)}, async ({ page }) => {`);
  out.push(`    test.setTimeout(${60000 + stepCount * 20000});`);
  out.push(`    const v: Record<string, string> = scenarioVars();`);
  for (const [name, value] of Object.entries(sc.variables || {})) out.push(`    v[${JSON.stringify(name)}] = ${tpl(String(value))};`);
  out.push(`    const c = checks();`);
  out.push(`    let opened: Awaited<ReturnType<typeof openPage>> | undefined;`);

  const openName = clean(`시작: ${short(start)} 열기`);
  checks.push({ name: openName, kind: 'run', small: '시작', step: `${start} 접속`, expected: '페이지가 정상으로 열림 (HTTP 400 미만)' });
  out.push(`    await c.run(${JSON.stringify(openName)}, async () => {`);
  out.push(`      opened = await openPage(page, new URL(${tpl(start)}, BASE).href);`);
  out.push(`      expect(opened.response?.status() ?? 0, 'HTTP 상태').toBeLessThan(400);`);
  out.push(`    }, { gate: true });`);

  sc.steps.forEach((s, i) => {
    const a = actionCode(s);
    const stepTitle = clean(s.name || a.title);
    const name = clean(`${i + 1}. ${short(stepTitle, 60)}`);
    checks.push({ name, kind: 'run', small: `${i + 1}단계`, step: stepTitle, expected: '동작이 수행됨' });
    out.push(`    await c.run(${JSON.stringify(name)}, async () => {`);
    a.lines.forEach((l) => out.push(`      ${l}`));
    out.push(`    }, { gate: true });`);

    const expects = s.expect === undefined ? [] : Array.isArray(s.expect) ? s.expect : [s.expect];
    expects.forEach((e, j) => {
      const x = expectCode(e);
      const expName = clean(`${i + 1}-${j + 1}. 확인: ${short(x.expected, 60)}`);
      checks.push({ name: expName, kind: 'run', small: `${i + 1}단계 확인`, step: `${stepTitle} 후 화면 확인`, expected: clean(x.expected) });
      out.push(`    await c.run(${JSON.stringify(expName)}, async () => {`);
      x.lines.forEach((l) => out.push(`      ${l}`));
      out.push(`    });`);
    });
  });

  // 흐름 전체에서 생긴 문제 (요소 테스트의 '페이지 로드' 확인과 같은 기준)
  const tail = [
    ['JS 런타임 오류 없음', '스크립트', 'JS 런타임 오류 없음', `expect(opened?.errors ?? []).toEqual([]);`],
    ['네트워크 요청 실패 없음 (같은 사이트 404 · 5xx)', '네트워크', '같은 사이트 요청에 404 · 5xx · 연결 실패 없음', `const failed = [...new Set(opened?.network ?? [])]; expect(failed, \`실패한 요청: \${failed.slice(0, 3).join(' / ')}\`).toEqual([]);`],
  ];
  for (const [name, small, expected, line] of tail) {
    checks.push({ name, kind: 'run', small, step: '흐름을 진행하는 동안 감시', expected });
    out.push(`    await c.run(${JSON.stringify(name)}, async () => { ${line} });`);
  }

  // 정리: 앞 단계가 실패해도 실행. 실패는 경고 (만든 데이터가 남았을 수 있음을 알린다)
  (sc.cleanup || []).forEach((s, i) => {
    const a = actionCode(s);
    const stepTitle = clean(s.name || a.title);
    const name = clean(`정리 ${i + 1}. ${short(stepTitle, 60)}`);
    checks.push({ name, kind: 'soft', small: '정리', step: stepTitle, expected: '만든 데이터를 되돌림 (실패하면 경고)' });
    out.push(`    try {`);
    a.lines.forEach((l) => out.push(`      ${l}`));
    out.push(`      c.soft(${JSON.stringify(name)}, true);`);
    out.push(`    } catch (e) {`);
    out.push(`      c.soft(${JSON.stringify(name)}, false, String((e as Error).message || e).split('\\n')[0]);`);
    out.push(`    }`);
  });

  out.push(`    c.done();`);
  out.push(`  });`);
  return { lines: out, checks };
}

// ─────────────────────────────────────────────────────────────
// 폴더의 시나리오 읽기 → 실행 가능 여부 판정 → spec 작성
// ─────────────────────────────────────────────────────────────

/** 폴더의 *.json 을 이름순으로 읽는다. 읽지 못한 파일도 이유와 함께 돌려준다 */
function loadScenarios(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
    .map((file) => {
      try {
        // 메모장 등이 붙이는 BOM 제거
        const scenario = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8').replace(/^﻿/, ''));
        return { file, scenario, errors: validateScenario(scenario) };
      } catch (e) {
        return { file, scenario: null, errors: [`JSON 형식 오류: ${e.message}`] };
      }
    });
}

/**
 * 시나리오 폴더 → 실행할 spec 작성.
 * 반환: [{ id, file, name, title, status: 'ready' | 'blocked' | 'invalid', reason, checks }]
 *  - invalid: 형식 오류 · blocked: 안전 규칙으로 실행하지 않음 (운영 서버 · 되돌릴 수 없는 동작)
 * outDir 의 이전 시나리오 spec 은 항상 지운다 (시나리오를 지웠는데 예전 테스트가 도는 일이 없도록).
 */
function prepareScenarios({ dir, baseUrl, envType = null, outDir, env = null, supportPath = '../../support/site' }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  const kind = envKind(baseUrl, envType);
  const items = loadScenarios(dir).map(({ file, scenario, errors }, i) => {
    const id = `S${String(i + 1).padStart(2, '0')}`;
    const name = scenario && typeof scenario.name === 'string' && scenario.name.trim() ? clean(scenario.name) : file;
    const item = { id, file, name, title: `${id} ${name}`, status: 'ready', reason: '', checks: [] };
    if (errors.length) return { ...item, status: 'invalid', reason: errors.slice(0, 5).join(' / ') };
    const risky = irreversibleSteps(scenario);
    if (kind === 'production' && scenario.allowProduction !== true) {
      return { ...item, status: 'blocked', reason: '운영 서버로 보여 실행하지 않음 (시나리오는 데이터를 바꿉니다. 테스트 환경에서 실행하거나 환경을 베타 · 스테이징으로 지정하세요)' };
    }
    if (risky.length && kind === 'production') {
      return { ...item, status: 'blocked', reason: `운영 서버에서는 되돌릴 수 없는 동작을 실행하지 않음: ${risky.join(', ')}` };
    }
    if (risky.length && scenario.allowIrreversible !== true) {
      return { ...item, status: 'blocked', reason: `되돌릴 수 없는 동작이 있어 실행하지 않음: ${risky.join(', ')} (실행하려면 시나리오에 "allowIrreversible": true)` };
    }
    return { ...item, scenario };
  });

  const ready = items.filter((it) => it.status === 'ready');
  if (ready.length) {
    const vp = (env && env.viewport) || { width: 1440, height: 900 };
    const out = [
      `// 자동 생성 파일 - 시나리오 JSON 으로 재생성됩니다. 직접 수정하지 마세요.`,
      `import { test, expect } from '@playwright/test';`,
      `import { openPage, checks, scenarioVars, urlPattern } from '${supportPath}';`,
      ``,
      `// 데이터를 바꾸는 흐름이므로 한 번에 하나씩 순서대로, 실패해도 다시 실행하지 않는다`,
      `test.describe.configure({ mode: 'default', retries: 0 });`,
      ``,
      `const BASE = ${JSON.stringify(baseUrl)};`,
      ``,
      `test.describe(${JSON.stringify(GROUP)}, () => {`,
      `  test.skip(({ isMobile }) => isMobile, '데스크톱 화면 기준 시나리오입니다.');`,
      `  test.use({ viewport: { width: ${vp.width}, height: ${vp.height} }${env && env.locale ? `, locale: ${JSON.stringify(env.locale)}` : ''}${env && env.timezone ? `, timezoneId: ${JSON.stringify(env.timezone)}` : ''} });`,
    ];
    for (const it of ready) {
      const t = scenarioTest(it.scenario, it.title);
      it.checks = t.checks;
      out.push(``, ...t.lines);
    }
    out.push(`});`, ``);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, SPEC_FILE), out.join('\n'), 'utf-8');
  }
  return items.map(({ scenario, ...rest }) => rest);
}

module.exports = { GROUP, envKind, validateScenario, loadScenarios, prepareScenarios };
