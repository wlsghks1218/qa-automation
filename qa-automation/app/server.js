const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  ENV_PATH, SETTINGS_PATH, WORKSPACE, GENERATED_DIR, DEFAULT_RESULTS_DIR,
  GENERATOR, PLAYWRIGHT_CONFIG, PLAYWRIGHT_CLI, AUTH_DIR, LOGIN_SCRIPT, CODE_ROOT, USER_DIR, prepareWorkspace,
} = require('./paths');
require('dotenv').config({ path: ENV_PATH, quiet: true });

const { generateDocTestCases, mapDocToFeatures, toCsv } = require('./doc-testcases');
const { importTcFile, looksLikeTcFile, ruleMapTcs } = require('./tc-import');
const { PROVIDERS } = require('./llm');
const { analyzeSiteWithAi } = require('./site-ai');
const { buildCasesHtml } = require('./cases-report');
const { encryptionAvailable, sealFile, openSealed, tempPath, createSecretStore, maskSecrets } = require('./secure-store');
const { normalizeRunConfig, storableConfig, secretRefsOf } = require('./run-config');
const { createProjectStore } = require('./projects');
const { findPreviousRun, compareAnalysis } = require('./compare-runs');
const { createBaselineStore } = require('./baseline');
// 테스트 진행률(완료/전체)을 출력하는 리포터 → 앱 프로그레스 바
const PROGRESS_REPORTER = path.join(__dirname, 'progress-reporter.js');
const { writeDocSpecs } = require('../scripts/lib/doc-specs');
const { name: APP_NAME, version: VERSION } = require('./version.json');

const PUBLIC_DIR = path.join(__dirname, 'public');
const IDLE_EXIT_MS = 60 * 1000; // 개발 모드: 창을 닫고 1분간 작업이 없으면 종료
let APP_URL = 'http://127.0.0.1';

// ─────────────────────────────────────────────────────────────
// 사용자 설정 (결과 저장 폴더 등) - settings.json
// ─────────────────────────────────────────────────────────────

// authMaxAgeDays: 저장된 로그인을 자동 삭제하기까지의 일수 (0 이면 자동 삭제 안 함)
const DEFAULT_SETTINGS = { resultsDir: DEFAULT_RESULTS_DIR, llmProvider: 'gemini', llmModels: {}, authMaxAgeDays: 7 };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = loadSettings();
// 승인된 기준선 저장소 (URL · 범위별)
const baselines = createBaselineStore(path.join(USER_DIR, 'baselines'));
// 비밀값(암호화) · 사이트별 마지막 실행 설정
const secrets = createSecretStore(path.join(USER_DIR, 'secrets'));
const projects = createProjectStore(path.join(USER_DIR, 'projects'));
const runDirs = new Map(); // 실행 ID → 결과 폴더 (폴더 설정을 바꿔도 이번 세션 결과 링크 유지)

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

/** 현재 선택된 AI 공급자 설정 */
function currentLlm() {
  const provider = PROVIDERS[settings.llmProvider] ? settings.llmProvider : 'gemini';
  const info = PROVIDERS[provider];
  return { provider, label: info.label, apiKey: process.env[info.envKey], model: settings.llmModels[provider] || info.defaultModel };
}

function llmSettingsView() {
  return {
    provider: currentLlm().provider,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, keyUrl: p.keyUrl, defaultModel: p.defaultModel,
      model: settings.llmModels[id] || '', hasKey: !!process.env[p.envKey],
    })),
  };
}

function setResultsDir(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  fs.accessSync(resolved, fs.constants.W_OK);
  settings.resultsDir = resolved;
  saveSettings();
}

function resolveResultFile(relPath) {
  const [id, ...rest] = decodeURIComponent(relPath).split('/');
  const base = runDirs.get(id) || path.join(settings.resultsDir, id);
  return { base, rel: rest.join('/') };
}

// OS 연동 동작. 설치된 앱(Electron)에서는 main.js 가 네이티브 대화상자로 교체한다
const hooks = {
  pickFolder: (initial) => (process.platform === 'darwin' ? pickFolderMac() : pickFolderWin(initial)),
  openPath: (dir) => spawn(process.platform === 'darwin' ? 'open' : 'explorer', [dir], { detached: true, stdio: 'ignore' }).unref(),
};

function pickFolderMac() {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "테스트 결과를 저장할 폴더를 선택하세요")']);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf-8')));
    child.on('close', () => resolve(out.trim() || null));
  });
}

/** Windows 폴더 선택 대화상자 */
function pickFolderWin(initial) {
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = '테스트 결과를 저장할 폴더를 선택하세요'
    $f.SelectedPath = '${initial.replace(/'/g, "''")}'
    $f.ShowNewFolderButton = $true
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    if ($f.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $f.SelectedPath }`;
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf-8')));
    child.on('close', () => resolve(out.trim() || null));
  });
}

const state = { running: false, phase: '', logs: [], result: null, child: null, stopRequested: false, progress: null };

/** 진행률: 분석 단계는 '분석한 페이지 / 전체 페이지', 테스트 단계는 '끝난 케이스 / 전체 케이스' */
function setProgress(p) {
  state.progress = p;
  broadcast('progress', p);
}

/** 생성기·테스트 출력에서 진행 상황을 읽는다. 진행 전용 줄([진행])은 로그에 남기지 않는다 */
function handleProgress(line) {
  let m = line.match(/^\[진행\] (\d+)\/(\d+) (\d+) (\d+)$/);
  if (m) {
    setProgress({ stage: 'test', done: +m[1], total: +m[2], passed: +m[3], failed: +m[4] });
    return true;
  }
  if ((m = line.match(/분석 대상 경로 총 (\d+)개/))) setProgress({ stage: 'analysis', done: 0, total: +m[1] });
  else if (/-> 시작 페이지 기능 \d+개/.test(line) && state.progress) setProgress({ ...state.progress, done: 1 });
  else if ((m = line.match(/-> \[(\d+)\/(\d+)\] /))) setProgress({ stage: 'analysis', done: +m[1] + 1, total: +m[2] + 1 });
  return false;
}

/** 실행 중인 자식 프로세스와 그 아래 브라우저·워커까지 모두 종료 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** 중지 버튼을 눌렀으면 다음 단계로 넘어가지 않는다 */
function checkStop() {
  if (state.stopRequested) throw new Error('사용자가 테스트를 중지했습니다.');
}
const clients = new Set();
let lastSeen = Date.now();

// ─────────────────────────────────────────────────────────────
// 실시간 로그 (SSE)
// ─────────────────────────────────────────────────────────────

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(payload));
}

// 이번 실행에서 꺼낸 비밀값 (로그에 나오면 **** 로 가린다)
const activeSecrets = new Set();

/** 비밀값을 꺼내 쓸 때는 반드시 이 함수로 (로그 가림 목록에 등록) */
function useSecret(id) {
  const value = id ? secrets.readSecret(id) : null;
  const collect = (v) => {
    if (typeof v === 'string') activeSecrets.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(value);
  return value;
}

function log(line) {
  const clean = maskSecrets(line, activeSecrets).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  if (!clean.trim()) return;
  state.logs.push(clean);
  if (state.logs.length > 2000) state.logs.shift();
  broadcast('log', clean);
  // 실행 중이면 결과 폴더의 run.log 에도 전체 로그를 남긴다 (화면 로그는 최근 줄만 보관)
  if (state.logFile) {
    try {
      fs.appendFileSync(state.logFile, `${clean}\n`, 'utf-8');
    } catch {
      // 로그 파일 기록 실패는 실행에 영향 주지 않음
    }
  }
}

function setPhase(phase) {
  state.phase = phase;
  broadcast('phase', phase);
}

/**
 * 현재 런타임(개발: node, 설치된 앱: Electron 내장 node)으로 스크립트 실행.
 * ELECTRON_RUN_AS_NODE 는 Electron 실행 파일을 순수 node 로 동작시킨다 (일반 node 에서는 무시됨).
 */
function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: WORKSPACE,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0' },
      // macOS/Linux: 중지할 때 프로세스 그룹째 종료할 수 있도록 별도 그룹으로 실행
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    state.child = child;
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach((l) => handleProgress(l.replace(/\r$/, '')) || log(l));
      });
      stream.on('end', () => buf && log(buf));
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('close', (code) => {
      if (state.child === child) state.child = null;
      resolve(code);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// 로그인: 사람이 직접 로그인한 상태(쿠키·저장소)를 사이트(host)별로 저장해 분석·테스트에 사용
// ─────────────────────────────────────────────────────────────

// 저장 파일: 암호화(<host>.json.enc). 암호화를 쓸 수 없는 환경(개발 모드 등)에서만 평문(<host>.json)
const hostFile = (url) => new URL(url).host.replace(/[^a-z0-9.-]/gi, '_');
const authPlainPath = (url) => path.join(AUTH_DIR, `${hostFile(url)}.json`);
const authEncPath = (url) => path.join(AUTH_DIR, `${hostFile(url)}.json.enc`);
const authFileOf = (url) => [authEncPath(url), authPlainPath(url)].find((p) => fs.existsSync(p)) || null;
const DAY = 24 * 60 * 60 * 1000;

function clearAuth(url) {
  fs.rmSync(authEncPath(url), { force: true });
  fs.rmSync(authPlainPath(url), { force: true });
}

function authInfo(url) {
  try {
    const base = { host: new URL(url).host, active: !!loginSession && loginSession.host === new URL(url).host, maxAgeDays: settings.authMaxAgeDays };
    const file = authFileOf(url);
    if (!file) return { ...base, saved: false };
    const savedAt = fs.statSync(file).mtimeMs;
    // 오래된 로그인은 자동 삭제 (설정: authMaxAgeDays, 기본 7일)
    if (settings.authMaxAgeDays > 0 && Date.now() - savedAt > settings.authMaxAgeDays * DAY) {
      clearAuth(url);
      log(`[로그인] ${base.host} 저장된 로그인이 ${settings.authMaxAgeDays}일이 지나 자동 삭제했습니다.`);
      return { ...base, saved: false, expired: true };
    }
    return { ...base, saved: true, savedAt, encrypted: file.endsWith('.enc') };
  } catch {
    return { saved: false, active: false };
  }
}

/** 저장된 로그인을 실행용 임시 파일로 꺼낸다 → { path, cleanup }. 실행이 끝나면 cleanup() */
function openAuth(url) {
  return openSealed(authEncPath(url), authPlainPath(url));
}

/** 시작 시: 예전 평문 로그인 파일을 암호화 파일로 옮기고 오래된 로그인 정리 */
function migrateAuthFiles() {
  // 앱이 비정상 종료돼 남은 로그인 임시 파일 정리
  try {
    const tmp = require('os').tmpdir();
    for (const f of fs.readdirSync(tmp)) if (/^qa-kc-(auth|login)-[0-9a-f]+\.json$/.test(f)) fs.rmSync(path.join(tmp, f), { force: true });
  } catch {
    // 임시 폴더를 읽을 수 없으면 건너뜀
  }
  if (!fs.existsSync(AUTH_DIR)) return;
  for (const f of fs.readdirSync(AUTH_DIR)) {
    const p = path.join(AUTH_DIR, f);
    if (f.endsWith('.json') && encryptionAvailable()) {
      sealFile(p, `${p}.enc`, p);
      log(`[로그인] 저장된 로그인 ${f} 을(를) 암호화했습니다.`);
    }
    if (/\.json(\.enc)?$/.test(f) && settings.authMaxAgeDays > 0 && fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs > settings.authMaxAgeDays * DAY) {
      fs.rmSync(p, { force: true });
    }
  }
}

let loginSession = null; // { child, host, url, temp }

function startLogin(url) {
  if (loginSession) loginSession.child.kill();
  // 로그인 창은 임시 평문 파일에 저장 → 성공하면 메인 프로세스가 암호화해 보관하고 임시 파일은 지운다
  const temp = tempPath('login');
  const existing = openAuth(url);
  if (existing.path) fs.copyFileSync(existing.path, temp); // 이어서 로그인(만료 확인 · 재로그인)
  existing.cleanup();
  const child = spawn(process.execPath, [LOGIN_SCRIPT, url, temp], {
    cwd: WORKSPACE,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0' },
  });
  const session = { child, host: new URL(url).host, url, temp };
  loginSession = session;
  const pipe = (stream) => stream.on('data', (d) => d.toString('utf-8').split(/\r?\n/).forEach(log));
  pipe(child.stdout);
  pipe(child.stderr);
  session.closed = new Promise((resolve) => child.on('close', (code) => {
    if (loginSession === session) loginSession = null;
    try {
      if (code === 0 && fs.existsSync(temp)) {
        const { encrypted } = sealFile(temp, authEncPath(url), authPlainPath(url));
        if (!encrypted) log('[로그인] 경고: 이 환경에서는 암호화를 쓸 수 없어 로그인 상태를 암호화하지 않고 저장했습니다 (개발 모드).');
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    broadcast('login', authInfo(url));
    resolve(code);
  }));
  broadcast('login', authInfo(url));
}

/** URL 이 로그인 화면인지 확인 (헤드리스로 잠깐 열어봄) */
function checkLogin(url) {
  return new Promise((resolve) => {
    let out = '';
    const auth = openAuth(url);
    const child = spawn(process.execPath, [path.join(CODE_ROOT, 'scripts', 'login-check.js'), url, ...(auth.path ? [auth.path] : [])], {
      cwd: WORKSPACE,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stdout.on('data', (d) => (out += d.toString('utf-8')));
    child.on('close', () => {
      auth.cleanup();
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop()));
      } catch {
        resolve({ error: '확인 실패' });
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Playwright JSON 결과 → 화면 표시용 요약
// ─────────────────────────────────────────────────────────────

const STATUS = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };

function summarizeReport(jsonPath) {
  if (!fs.existsSync(jsonPath)) return null;
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const groups = new Map();

  const walk = (suite, parents) => {
    const titles = suite.title ? [...parents, suite.title] : parents;
    (suite.specs || []).forEach((spec) => {
      spec.tests.forEach((t) => {
        const last = t.results[t.results.length - 1] || {};
        // 생성된 테스트의 checks() 기록: "항목|passed/failed/skipped/warning|상세"
        const checks = (last.annotations || t.annotations || [])
          .filter((a) => a.type === 'check')
          .map((a) => {
            const [name, status, ...detail] = (a.description || '').split('|');
            return { name, status, detail: detail.join('|') };
          });
        const group = titles.filter((s) => !s.endsWith('.ts')).join(' › ') || spec.file;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({
          title: spec.title,
          browser: t.projectName,
          status: STATUS[t.status] || t.status,
          duration: last.duration || 0,
          checks,
          error: last.error ? (last.error.message || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n') : '',
        });
      });
    });
    (suite.suites || []).forEach((s) => walk(s, titles));
  };
  (report.suites || []).forEach((s) => walk(s, []));

  const all = [...groups.values()].flat();
  const count = (list, s) => list.filter((t) => t.status === s).length;
  const browsers = [...new Set(all.map((t) => t.browser))];

  // 같은 TC 가 브라우저마다 결과가 다르면 브라우저 호환성 문제 후보
  const browserDiffs = [];
  if (browsers.length > 1) {
    for (const [group, tests] of groups) {
      const byTitle = new Map();
      tests.forEach((t) => byTitle.set(t.title, [...(byTitle.get(t.title) || []), t]));
      for (const [title, runs] of byTitle) {
        const ok = runs.filter((r) => r.status === 'passed').map((r) => r.browser);
        const bad = runs.filter((r) => ['failed', 'flaky'].includes(r.status)).map((r) => r.browser);
        if (ok.length && bad.length) browserDiffs.push({ group, title, passedIn: ok, failedIn: bad });
      }
    }
  }

  return {
    total: all.length,
    passed: count(all, 'passed'),
    failed: count(all, 'failed'),
    flaky: count(all, 'flaky'),
    skipped: count(all, 'skipped'),
    browsers: browsers.map((b) => {
      const list = all.filter((t) => t.browser === b);
      return { name: b, total: list.length, passed: count(list, 'passed'), failed: count(list, 'failed'), flaky: count(list, 'flaky') };
    }),
    browserDiffs,
    groups: [...groups.entries()].map(([title, tests]) => ({ title, tests })),
  };
}

// ─────────────────────────────────────────────────────────────
// 작업 실행: (기획서 → TC) + (URL → 분석 → TC 생성 → 테스트 실행)
// ─────────────────────────────────────────────────────────────

/** 기획서/AI 분석 TC 마다 매핑 상태 + 실행 결과(브라우저별)를 붙인다 */
const SEVERITY = ['passed', 'skipped', 'flaky', 'failed'];
const BROWSER_LABEL = { chromium: 'Chrome', webkit: 'Safari', firefox: 'Firefox' };
// 화면 언어별 시간대 (날짜 · 시간 표시가 언어와 맞도록)
const LOCALE_TZ = { 'ko-KR': 'Asia/Seoul', 'en-US': 'America/New_York', 'ja-JP': 'Asia/Tokyo', 'zh-TW': 'Asia/Taipei', 'th-TH': 'Asia/Bangkok' };

function attachDocResults(doc, mappings, tests, group) {
  const runs = tests ? tests.groups.filter((g) => g.title.startsWith(`[${group}]`)).flatMap((g) => g.tests) : [];
  doc.testCases.forEach((tc) => {
    const m = mappings ? mappings.find((x) => x.tcId === tc.id) : null;
    const mine = runs.filter((t) => t.title.startsWith(`${tc.id} `));
    tc.mapping = m ? { status: m.status, reason: m.reason, conflict: m.observedConflict || '' } : null;
    if (!mine.length) {
      tc.execution = null;
      return;
    }
    // 가장 나쁜 결과를 대표 상태로 (한 브라우저라도 실패하면 실패)
    const worst = mine.reduce((a, b) => (SEVERITY.indexOf(b.status) > SEVERITY.indexOf(a.status) ? b : a));
    tc.execution = {
      status: worst.status,
      error: worst.error,
      byBrowser: Object.fromEntries(mine.map((r) => [r.browser, r.status])),
    };
  });

  const count = (fn) => doc.testCases.filter(fn).length;
  doc.coverage = {
    total: doc.testCases.length,
    automated: count((tc) => tc.mapping && tc.mapping.status === 'automated'),
    passed: count((tc) => tc.execution && tc.execution.status === 'passed'),
    failed: count((tc) => tc.execution && ['failed', 'flaky'].includes(tc.execution.status)),
    notFound: count((tc) => tc.mapping && tc.mapping.status === 'not_found'),
    manual: count((tc) => tc.mapping && tc.mapping.status === 'manual'),
    conflicts: count((tc) => tc.mapping && !!tc.mapping.conflict),
  };
}

async function runJob(config) {
  const url = config.target.url;
  // 범위 'pages' · 'changes' 는 아직 실행기가 없으므로 전체 사이트로 처리
  const scope = config.scope.mode === 'single' ? 'single' : 'all';
  const { mode, useLogin, baselineRun } = config;
  const file = config.spec.file;
  const browsers = config.runtime.browsers;
  const clickAll = config.safety.clickAll;
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(settings.resultsDir, id);
  fs.mkdirSync(runDir, { recursive: true });
  runDirs.set(id, runDir);
  state.logFile = path.join(runDir, 'run.log');
  activeSecrets.clear();
  // 이번 실행 설정 기록 (비밀값은 id 만, 기획서는 파일 이름만) · 사이트별 마지막 설정 저장
  fs.writeFileSync(path.join(runDir, 'run-config.json'), JSON.stringify(storableConfig(config), null, 2), 'utf-8');
  if (url) {
    try {
      projects.save(config);
    } catch (e) {
      log(`[경고] 실행 설정을 저장하지 못했습니다: ${e.message}`);
    }
  }

  state.running = true;
  state.stopRequested = false;
  state.progress = null;
  state.logs = [];
  state.result = null;
  broadcast('start', { id });

  const result = {
    id, url, scope, mode, browsers, runDir,
    fileName: file ? file.name : null,
    startedAt: Date.now(),
    doc: null, ai: null, tests: null, reportUrl: null, errors: [],
  };
  const llm = currentLlm();
  let mappings = null;
  let plan = null; // 생성기 케이스 목록 (cases.json)
  const loginEnv = {};
  let authHandle = null; // 복호화한 로그인 임시 파일 (실행 끝에 삭제)
  let aiMappings = null;

  try {
    // 1) 기획서 → TC
    if (file && looksLikeTcFile(file)) {
      // 사용자 TC 파일(CSV · TSV): AI 로 새로 쓰지 않고 그대로 가져온다 → 화면과 짝지어 '내 TC 대비 자동화 현황'
      try {
        result.doc = importTcFile(file);
        log(`[TC 가져오기] ${file.name}: TC ${result.doc.testCases.length}건 · 섹션 ${result.doc.features.length}개`);
      } catch (e) {
        result.errors.push(`TC 파일 읽기 실패: ${e.message}`);
        log(`[TC 가져오기] 실패: ${e.message}`);
      }
    } else if (file) {
      setPhase('기획서 분석 및 TC 작성 중');
      log(`[기획서] ${file.name} 분석 중 (${llm.label} · ${llm.model})...`);
      try {
        result.doc = await generateDocTestCases(file, { url, llm });
        log(`[기획서] TC ${result.doc.testCases.length}건 작성 완료`);
      } catch (e) {
        result.errors.push(`기획서 분석 실패: ${e.message}`);
        log(`[기획서] 실패: ${e.message}`);
      }
      checkStop();
    }

    if (url) {
      // 2) 사이트 분석 → 기능별 TC 생성.
      //    기획서가 있으면 기획서가 다루는 화면을 찾기 위해 범위와 관계없이 세부 페이지까지 분석한다.
      // 기획서로 TC 를 새로 쓴 경우는 기획서가 다루는 화면을 찾기 위해 세부 페이지까지, 가져온 TC 파일은 고른 범위를 따른다
      const crawlScope = result.doc && !result.doc.imported ? 'all' : scope;
      setPhase(crawlScope === 'all' ? '사이트 및 세부 페이지 분석 중' : '입력한 페이지 분석 중');
      // 저장된 로그인이 있고 사용하기로 했으면 분석·테스트 모두 로그인된 상태로 (데이터가 바뀌는 버튼은 누르지 않는 안전 모드)
      if (useLogin && authInfo(url).saved) {
        // 암호화된 로그인을 이번 실행 동안만 임시 파일로 꺼내 쓰고, 끝나면(중지 · 오류 포함) 지운다
        authHandle = openAuth(url);
        loginEnv.QA_STORAGE_STATE = authHandle.path;
        result.loggedIn = true;
        log(`[로그인] ${new URL(url).host} 저장된 로그인 상태로 테스트합니다 (안전 모드).`);
      }
      // 전체 동작 확인: 저장·등록·제출·삭제 등 데이터가 바뀌는 버튼도 실제로 누른다 (탈퇴·결제·송금·로그아웃 제외)
      if (clickAll) {
        result.clickAll = true;
        log('[동작 확인] 전체 동작 확인: 데이터가 바뀌는 버튼도 실제로 누릅니다 (탈퇴·결제·송금·로그아웃 제외).');
      }
      // 승인된 기준으로 테스트: 분석 없이 기준의 테스트 코드를 그대로 실행 (기대 결과 = 사람이 승인한 동작)
      const baseline = baselines.get(url, crawlScope);
      const useBaseline = !!(baselineRun && baseline && !result.doc && mode !== 'ai');
      if (baselineRun && !useBaseline) log('[기준] 승인된 기준이 없거나(기획서 · AI 테스트는 제외) 사용할 수 없어 새로 분석합니다.');
      if (useBaseline) {
        setPhase('승인된 기준으로 테스트 준비 중');
        fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
        fs.mkdirSync(GENERATED_DIR, { recursive: true });
        fs.cpSync(path.join(baseline.dir, 'specs'), GENERATED_DIR, { recursive: true });
        for (const f of ['analysis.json', 'cases.json']) if (fs.existsSync(path.join(baseline.dir, f))) fs.copyFileSync(path.join(baseline.dir, f), path.join(GENERATED_DIR, f));
        if (fs.existsSync(path.join(baseline.dir, 'screens'))) fs.cpSync(path.join(baseline.dir, 'screens'), path.join(GENERATED_DIR, 'screens'), { recursive: true });
        result.fromBaseline = { runId: baseline.runId, approvedAt: baseline.approvedAt, approvedBy: baseline.approvedBy };
        log(`[기준] ${new Date(baseline.approvedAt).toLocaleString('ko-KR')} 승인된 기준(${baseline.runId})의 테스트를 그대로 실행합니다. 분석은 생략합니다.`);
      } else {
        const genCode = await runNode([GENERATOR, url, `--scope=${crawlScope}`], {
          QA_OUTPUT_DIR: GENERATED_DIR,
          // 화면 구조가 그대로인 페이지는 이전 분석을 재사용 (분석 시간 단축)
          QA_CACHE_DIR: path.join(USER_DIR, 'cache'),
          ...loginEnv,
          ...(clickAll ? { QA_CLICK_ALL: '1' } : {}),
          // 화면 언어: 언어마다 다른 화면이 나오는 서비스가 있으므로 고를 수 있게 (비우면 이 PC 언어)
          ...(config.runtime.locale ? { LOCALE: config.runtime.locale, TIMEZONE: LOCALE_TZ[config.runtime.locale] } : {}),
          ...(config.runtime.xltLocales.length ? { XLT_LOCALES: config.runtime.xltLocales.join(',') } : {}),
        });
        checkStop();
        if (genCode !== 0) throw new Error('사이트 분석에 실패했습니다. 로그를 확인해주세요.');
        // 이 실행의 테스트 코드를 결과 폴더에 보관 → 나중에 "기준으로 승인"할 수 있게
        fs.mkdirSync(path.join(runDir, 'specs'), { recursive: true });
        for (const f of fs.readdirSync(GENERATED_DIR)) if (f.endsWith('.spec.ts')) fs.copyFileSync(path.join(GENERATED_DIR, f), path.join(runDir, 'specs', f));
        result.canApprove = true;
      }

      const analysisPath = path.join(GENERATED_DIR, 'analysis.json');
      const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
      fs.copyFileSync(analysisPath, path.join(runDir, 'analysis.json'));
      // 커버리지: 찾은 클릭 요소 중 동작까지 확인한 비율과 테스트하지 못한 요소
      result.coverage = analysis.coverage || null;
      result.coveragePages = analysis.pages.filter((p) => p.coverage).map((p) => ({ path: p.path, ...p.coverage }));
      result.notices = analysis.notices || [];
      // 규칙 기반 오타 의심 (LLM 없이). 테스트 실패가 아니라 경고로 따로 보여준다
      result.typos = analysis.typos || [];
      // 전체 동작 확인으로 실제로 눌린 데이터 변경 버튼 (정리 · 확인용)
      result.dataActions = analysis.pages.flatMap((p) => (p.dataActions || []).map((a) => ({ page: p.path, ...a })));
      result.cachedPages = analysis.pages.filter((p) => p.cached).map((p) => p.path);

      // 변경 감지: 승인된 기준이 있으면 기준과, 없으면 같은 URL · 범위의 직전 실행과 비교
      if (!useBaseline) {
        let against = null;
        if (baseline) {
          against = { kind: 'baseline', label: `승인된 기준 (${new Date(baseline.approvedAt).toLocaleString('ko-KR')} · ${baseline.runId})`, analysis: JSON.parse(fs.readFileSync(path.join(baseline.dir, 'analysis.json'), 'utf-8')) };
        } else {
          const prevRun = findPreviousRun(settings.resultsDir, id, analysis.meta.startUrl, analysis.meta.scope);
          if (prevRun) against = { kind: 'previous', label: `직전 실행 ${prevRun.id} (기준 미승인)`, analysis: prevRun.analysis };
        }
        if (against) {
          result.changes = { prevId: against.label, against: against.kind, ...compareAnalysis(against.analysis, analysis) };
          fs.writeFileSync(path.join(runDir, 'changes.json'), JSON.stringify(result.changes, null, 2), 'utf-8');
          const s = result.changes.summary;
          log(`[변경 감지] ${against.label} 대비: 페이지 +${s.pagesAdded}/-${s.pagesRemoved} · 요소 +${s.elementsAdded}/-${s.elementsRemoved} · 동작 변경 ${s.actionsChanged} · 문구 +${s.textsAdded}/-${s.textsRemoved}`);
        }
      }

      // 케이스 목록(실행 전) → 결과 폴더의 cases.html. 테스트가 끝나면 같은 파일에 결과를 채운다
      const casesPath = path.join(GENERATED_DIR, 'cases.json');
      if (fs.existsSync(casesPath)) {
        plan = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
        fs.copyFileSync(casesPath, path.join(runDir, 'cases.json'));
        const screens = path.join(GENERATED_DIR, 'screens');
        if (fs.existsSync(screens)) fs.cpSync(screens, path.join(runDir, 'screens'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'cases.html'), buildCasesHtml({ plan, result }), 'utf-8');
        result.casesUrl = `/results/${id}/cases.html`;
        log(`[케이스 목록] ${path.join(runDir, 'cases.html')} (실행 전)`);
      }

      // 3) 기획서 TC ↔ 실제 화면 요소 매핑 → 기획서 기준 테스트 생성
      let docSpecCount = 0;
      if (result.doc) {
        setPhase('기획서 TC와 화면 요소 매핑 중');
        try {
          // AI 키가 없으면(가져온 TC 파일만 해당) 화면 요소 이름 · 문구 기준 규칙 매칭
          if (llm.apiKey) {
            mappings = await mapDocToFeatures(result.doc, analysis, llm, (done, total) => log(`[매핑] ${done}/${total}건`));
          } else {
            mappings = ruleMapTcs(result.doc, analysis);
            log('[매핑] AI 키가 없어 화면 요소 이름 · 문구가 같은 TC 만 규칙으로 짝지었습니다.');
          }
          fs.writeFileSync(path.join(runDir, 'doc-mappings.json'), JSON.stringify(mappings, null, 2), 'utf-8');
          docSpecCount = writeDocSpecs({ doc: result.doc, mappings, analysis, outDir: path.join(GENERATED_DIR, 'doc') });
          const c = (s) => mappings.filter((m) => m.status === s).length;
          log(`[매핑] 자동 실행 ${c('automated')}건 · 화면에서 못 찾음 ${c('not_found')}건 · 수동 확인 ${c('manual')}건`);
        } catch (e) {
          result.errors.push(`기획서 매핑 실패: ${e.message}`);
          log(`[매핑] 실패: ${e.message}`);
        }
        checkStop();
      }

      // 3-1) AI 테스트: 페이지 스크린샷 + 화면 요소 → AI 가 기대 동작 기준 TC 작성 + 화면 이슈 보고
      if (mode === 'ai') {
        setPhase('AI가 화면을 분석하고 TC 작성 중');
        log(`[AI 분석] ${analysis.pages.length}개 페이지 분석 시작 (${llm.label} · ${llm.model})`);
        try {
          const ai = await analyzeSiteWithAi(analysis, GENERATED_DIR, llm, log);
          aiMappings = ai.mappings;
          result.ai = { doc: ai.doc, findings: ai.findings };
          fs.writeFileSync(path.join(runDir, 'ai-mappings.json'), JSON.stringify(aiMappings, null, 2), 'utf-8');
          writeDocSpecs({ doc: ai.doc, mappings: aiMappings, analysis, outDir: path.join(GENERATED_DIR, 'ai'), group: 'AI 분석', fileName: 'ai-testcases.spec.ts' });
        } catch (e) {
          result.errors.push(`AI 분석 실패: ${e.message}`);
          log(`[AI 분석] 실패: ${e.message}`);
        }
        checkStop();
      }

      // 4) 실행. '입력한(첨부한) 사이트(PDF)만' + 기획서면 기획서 기반 테스트만 실행
      const docOnly = scope === 'single' && result.doc && docSpecCount > 0;
      setPhase(`${docOnly ? '기획서 기반 테스트' : '생성된 테스트'} 실행 중 (${browsers.map((b) => BROWSER_LABEL[b]).join(', ')})`);
      const reportDir = path.join(runDir, 'report');
      await runNode([PLAYWRIGHT_CLI, 'test', '--config', PLAYWRIGHT_CONFIG, `--reporter=list,html,json,${PROGRESS_REPORTER}`], {
        QA_TEST_SUBDIR: docOnly ? 'doc' : '',
        QA_BROWSERS: browsers.join(','),
        PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(runDir, 'results.json'),
        PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
        PLAYWRIGHT_HTML_REPORT: reportDir,
        PLAYWRIGHT_HTML_OPEN: 'never',
        ...loginEnv,
      });
      checkStop();
      result.tests = summarizeReport(path.join(runDir, 'results.json'));
      if (!result.tests) throw new Error('테스트 결과를 찾을 수 없습니다.');
      result.reportUrl = `/results/${id}/report/index.html`;
    }
  } catch (e) {
    result.errors.push(e.message);
    if (state.stopRequested) result.stopped = true;
    log(`${state.stopRequested ? '[중지]' : '[오류]'} ${e.message}`);
  } finally {
    if (result.ai) {
      attachDocResults(result.ai.doc, aiMappings, result.tests, 'AI 분석');
      fs.writeFileSync(path.join(runDir, 'ai-testcases.json'), JSON.stringify(result.ai, null, 2), 'utf-8');
      fs.writeFileSync(path.join(runDir, 'ai-testcases.csv'), toCsv(result.ai.doc), 'utf-8');
      result.ai.csvUrl = `/results/${id}/ai-testcases.csv`;
    }
    if (result.doc) {
      attachDocResults(result.doc, mappings, result.tests, '기획서');
      fs.writeFileSync(path.join(runDir, 'doc-testcases.json'), JSON.stringify(result.doc, null, 2), 'utf-8');
      fs.writeFileSync(path.join(runDir, 'doc-testcases.csv'), toCsv(result.doc), 'utf-8');
      result.docCsvUrl = `/results/${id}/doc-testcases.csv`;
    }
    result.finishedAt = Date.now();
    if (plan || result.tests) {
      // 실행 결과를 채운 케이스 보기 페이지 (기획서·AI 테스트 결과도 같은 파일 아래쪽에 포함)
      try {
        fs.writeFileSync(path.join(runDir, 'cases.html'), buildCasesHtml({ plan, result }), 'utf-8');
        result.casesUrl = `/results/${id}/cases.html`;
      } catch (e) {
        log(`[경고] cases.html 생성 실패: ${e.message}`);
      }
    }
    // 지금 이 URL · 범위의 승인된 기준 (결과 화면의 '기준 승인' 상태 표시용)
    if (url) {
      const b = baselines.get(url, result.doc ? 'all' : scope);
      result.baseline = b ? { runId: b.runId, approvedAt: b.approvedAt, approvedBy: b.approvedBy, appVersion: b.appVersion } : null;
    }
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(result, null, 2), 'utf-8');
    state.running = false;
    state.logFile = null;
    if (authHandle) authHandle.cleanup();
    activeSecrets.clear();
    state.result = result;
    setPhase('');
    broadcast('done', result);
    lastSeen = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
};

function sendFile(res, baseDir, relPath) {
  const filePath = path.normalize(path.join(baseDir, decodeURIComponent(relPath)));
  if (!filePath.startsWith(baseDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const headers = { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' };
  if (filePath.endsWith('.csv')) headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('파일이 너무 큽니다 (최대 40MB).'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** API Key 는 settings.json 이 아닌 .env 에만 저장 (공급자별) */
function saveApiKey(envKey, key) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/) : [];
  const rest = lines.filter((l) => l && !l.startsWith(`${envKey}=`));
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, [...rest, `${envKey}=${key}`].join('\n') + '\n', 'utf-8');
  process.env[envKey] = key;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, APP_URL);
  lastSeen = Date.now();

  try {
    if (req.method === 'GET' && pathname === '/') return sendFile(res, PUBLIC_DIR, 'index.html');
    if (req.method === 'GET' && pathname.startsWith('/static/')) return sendFile(res, PUBLIC_DIR, pathname.slice(8));
    if (req.method === 'GET' && pathname.startsWith('/results/')) {
      const { base, rel } = resolveResultFile(pathname.slice(9));
      return sendFile(res, base, rel);
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      return json(res, 200, {
        name: APP_NAME,
        version: VERSION,
        running: state.running,
        phase: state.phase,
        progress: state.progress,
        logs: state.logs.slice(-300),
        result: state.result,
        hasApiKey: !!currentLlm().apiKey,
        llm: llmSettingsView(),
        resultsDir: settings.resultsDir,
      });
    }

    if (req.method === 'POST' && pathname === '/api/results-dir') {
      const body = await readJson(req);
      let dir = body.dir;
      if (body.pick) dir = await hooks.pickFolder(settings.resultsDir);
      if (!dir) return json(res, 200, { resultsDir: settings.resultsDir, changed: false });
      try {
        setResultsDir(dir);
      } catch (e) {
        return json(res, 400, { error: `폴더를 사용할 수 없습니다: ${e.message}` });
      }
      return json(res, 200, { resultsDir: settings.resultsDir, changed: true });
    }

    if (req.method === 'POST' && pathname === '/api/open-folder') {
      const body = await readJson(req);
      const dir = body.id ? runDirs.get(body.id) || path.join(settings.resultsDir, body.id) : settings.resultsDir;
      fs.mkdirSync(dir, { recursive: true });
      hooks.openPath(dir);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/heartbeat') return json(res, 200, { ok: true });

    if (req.method === 'POST' && pathname === '/api/settings') {
      // { provider, apiKey?, model? } - provider 를 선택 공급자로 지정하고 키/모델 저장
      const body = await readJson(req);
      const provider = PROVIDERS[body.provider] ? body.provider : currentLlm().provider;
      settings.llmProvider = provider;
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) saveApiKey(PROVIDERS[provider].envKey, body.apiKey.trim());
      if (typeof body.model === 'string') settings.llmModels[provider] = body.model.trim();
      saveSettings();
      return json(res, 200, { hasApiKey: !!currentLlm().apiKey, llm: llmSettingsView() });
    }

    // 승인된 기준선: 조회 · 승인 · 해제
    if (pathname === '/api/baseline' && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const b = q.get('url') ? baselines.get(q.get('url'), q.get('scope') === 'single' ? 'single' : 'all') : null;
      return json(res, 200, b ? { exists: true, runId: b.runId, approvedAt: b.approvedAt, approvedBy: b.approvedBy, appVersion: b.appVersion, pages: b.pages } : { exists: false });
    }
    if (pathname === '/api/baseline/approve' && req.method === 'POST') {
      const body = await readJson(req);
      const dir = runDirs.get(body.id) || path.join(settings.resultsDir, String(body.id || '').replace(/[^\w-]/g, ''));
      if (!fs.existsSync(path.join(dir, 'analysis.json'))) return json(res, 400, { error: '이 실행 결과에는 분석 결과가 없어 기준으로 승인할 수 없습니다.' });
      try {
        const info = baselines.approve(dir, body.id);
        log(`[기준] ${info.startUrl} (${info.scope === 'all' ? '세부 사이트 모두' : '입력한 페이지만'}) 기준을 ${body.id} 결과로 승인했습니다.`);
        if (state.result && state.result.id === body.id) state.result.baseline = { runId: info.runId, approvedAt: info.approvedAt, approvedBy: info.approvedBy, appVersion: info.appVersion };
        return json(res, 200, { ok: true, runId: info.runId, approvedAt: info.approvedAt, approvedBy: info.approvedBy, previous: info.history.length });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/baseline/clear' && req.method === 'POST') {
      const body = await readJson(req);
      baselines.clear(body.url, body.scope === 'single' ? 'single' : 'all');
      return json(res, 200, { exists: false });
    }

    if (pathname.startsWith('/api/login')) {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const target = body.url || new URL(req.url, 'http://x').searchParams.get('url') || (loginSession && loginSession.url);
      try {
        if (!target || !/^https?:$/.test(new URL(target).protocol)) throw new Error();
      } catch {
        return json(res, 400, { error: '올바른 URL을 먼저 입력해주세요.' });
      }
      if (req.method === 'GET' && pathname === '/api/login') return json(res, 200, authInfo(target));
      if (req.method === 'POST' && pathname === '/api/login/check') return json(res, 200, { ...(await checkLogin(target)), ...authInfo(target) });
      if (req.method === 'POST' && pathname === '/api/login/start') {
        if (state.running) return json(res, 409, { error: '테스트 실행 중에는 로그인 창을 열 수 없습니다.' });
        startLogin(target);
        return json(res, 200, authInfo(target));
      }
      if (req.method === 'POST' && pathname === '/api/login/done') {
        if (!loginSession) return json(res, 400, { error: '열려 있는 로그인 창이 없습니다.' });
        const session = loginSession;
        session.child.stdin.write('save' + String.fromCharCode(10));
        const code = await session.closed;
        if (code !== 0) return json(res, 500, { error: '로그인 상태를 저장하지 못했습니다. 로그를 확인해주세요.' });
        return json(res, 200, authInfo(target));
      }
      if (req.method === 'POST' && pathname === '/api/login/cancel') {
        if (loginSession) loginSession.child.kill();
        return json(res, 200, authInfo(target));
      }
      if (req.method === 'POST' && pathname === '/api/login/clear') {
        clearAuth(target);
        return json(res, 200, authInfo(target));
      }
    }

    if (req.method === 'POST' && pathname === '/api/stop') {
      if (!state.running) return json(res, 400, { error: '실행 중인 테스트가 없습니다.' });
      state.stopRequested = true;
      setPhase('중지하는 중…');
      log('[중지] 사용자가 중지를 요청했습니다. 실행 중인 분석·테스트와 브라우저를 종료합니다.');
      killTree(state.child);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/run') {
      if (state.running) return json(res, 409, { error: '이미 실행 중인 작업이 있습니다.' });
      // 새 구조(runConfig)와 예전 구조(url · scope · browsers …) 모두 받는다
      const config = normalizeRunConfig(await readJson(req));
      const url = config.target.url;
      const { mode } = config;
      const file = config.spec.file;
      if (mode === 'ai' && !url) return json(res, 400, { error: 'AI 테스트는 URL이 필요합니다.' });
      // 사용자 TC 파일(CSV)은 AI 없이도 규칙 매칭으로 실행할 수 있다
      if ((mode === 'ai' || (file && !looksLikeTcFile(file))) && !currentLlm().apiKey) {
        return json(res, 400, { error: `${currentLlm().label} API Key가 필요합니다. 상단 'AI 설정'에서 입력해주세요.` });
      }
      if (!url && !file) return json(res, 400, { error: 'URL 또는 기획서를 입력해주세요.' });
      const missing = secretRefsOf(config).filter((ref) => secrets.readSecret(ref) === null);
      if (missing.length) return json(res, 400, { error: `저장된 비밀값을 찾을 수 없습니다 (${missing.join(', ')}). 다시 입력해주세요.` });
      if (url) {
        try {
          if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
        } catch {
          return json(res, 400, { error: '올바른 URL 형식이 아닙니다. (예: https://example.com)' });
        }
      }
      if (loginSession) return json(res, 409, { error: '로그인 창이 열려 있습니다. 로그인을 끝내고 "로그인 완료"를 누르거나 취소해주세요.' });
      runJob(config);
      return json(res, 202, { ok: true });
    }

    // 비밀값: 값은 받기만 하고 절대 돌려주지 않는다 (목록은 id · 이름 · 저장 시각만)
    if (pathname === '/api/secrets' && req.method === 'GET') {
      return json(res, 200, { encryption: encryptionAvailable(), secrets: secrets.listSecrets() });
    }
    if (pathname === '/api/secrets' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.value === undefined || body.value === null || body.value === '') return json(res, 400, { error: '저장할 값이 없습니다.' });
      try {
        const id = secrets.saveSecret(body.id || null, body.value, body.label);
        return json(res, 200, { id });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (pathname === '/api/secrets/delete' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        secrets.deleteSecret(body.id);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      return json(res, 200, { ok: true });
    }

    // 프로젝트: 이 사이트의 마지막 실행 설정 (입력 화면 자동 채우기)
    if (pathname === '/api/project' && req.method === 'GET') {
      const saved = projects.get(new URL(req.url, 'http://x').searchParams.get('url') || '');
      return json(res, 200, saved || { config: null });
    }
    if (pathname === '/api/project/clear' && req.method === 'POST') {
      projects.remove((await readJson(req)).url || '');
      return json(res, 200, { config: null });
    }

    res.writeHead(404).end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

/**
 * 서버 시작. port 0 이면 빈 포트를 자동 선택한다. 실제 접속 URL 을 반환.
 */
function start({ port = 0, hooks: overrides = {} } = {}) {
  Object.assign(hooks, overrides);
  prepareWorkspace();
  migrateAuthFiles();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      APP_URL = `http://127.0.0.1:${server.address().port}`;
      resolve(APP_URL);
    });
  });
}

module.exports = { start, summarizeReport, APP_NAME, VERSION };

// ─────────────────────────────────────────────────────────────
// 개발 모드 단독 실행: node app/server.js  (Edge/Chrome 앱 모드 창으로 열기)
// ─────────────────────────────────────────────────────────────

function openBrowserWindow() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  const browser = candidates.find((p) => p && fs.existsSync(p));
  const profileDir = path.join(__dirname, '.profile');
  if (browser) {
    spawn(browser, [`--app=${APP_URL}`, '--window-size=1180,900', `--user-data-dir=${profileDir}`, '--no-first-run'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', APP_URL], { detached: true, stdio: 'ignore' }).unref();
  }
}

if (require.main === module) {
  const port = Number(process.env.QA_APP_PORT || 4780);
  start({ port })
    .then((url) => {
      console.log(`${APP_NAME} v${VERSION} 실행 중: ${url}`);
      if (!process.argv.includes('--no-window')) openBrowserWindow();
      setInterval(() => {
        if (!state.running && clients.size === 0 && Date.now() - lastSeen > IDLE_EXIT_MS) process.exit(0);
      }, 10 * 1000);
    })
    .catch((e) => {
      if (e.code !== 'EADDRINUSE') throw e;
      // 이미 실행 중이면 창만 다시 연다
      APP_URL = `http://127.0.0.1:${port}`;
      openBrowserWindow();
      process.exit(0);
    });
}
