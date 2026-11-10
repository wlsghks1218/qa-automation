// 하네스 자가 검증: 버그를 일부러 심은 테스트 사이트로 하네스의 감지율과 오탐을 잰다.
//   1) 테스트 사이트(정상 모드)를 분석해 테스트 생성
//   2) 정상 모드에서 실행 → 실패한 확인 항목 = 오탐 (0개여야 함)
//   3) 버그 모드에서 같은 테스트 실행 → 심은 버그마다 해당 케이스가 실패하면 감지
//   4) selftest/reports/ 에 결과 저장 (latest.json 은 설명서 PDF 에 들어감)
//   node scripts/selftest.js [--keep]      (npm run selftest)
// 하네스(generate-specs.js 등)를 고친 뒤 릴리스 전에 실행해 감지율이 떨어지거나 오탐이 생기지 않았는지 확인한다.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SELFTEST_PORT || 5590);
const BASE = `http://127.0.0.1:${PORT}/`;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-kc-selftest-'));
const REPORTS = path.join(ROOT, 'selftest', 'reports');
const defects = require('../selftest/defects');
const { version } = require('../app/version.json');

const node = (args, env = {}) =>
  execFileSync(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(ROOT, 'node_modules') },
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf-8');

/** 생성된 테스트를 Chrome 으로 실행해 결과 요약(server.js 와 같은 형식)을 돌려준다 */
function runTests(label) {
  const out = path.join(WS, `results-${label}.json`);
  const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  try {
    node([cli, 'test', '--config', path.join(ROOT, 'app', 'playwright.generated.config.js'), '--reporter=json'], {
      QA_WORKSPACE: WS,
      QA_BROWSERS: 'chromium',
      PLAYWRIGHT_JSON_OUTPUT_NAME: out,
    });
  } catch {
    // 실패한 테스트가 있으면 종료 코드가 1 — 결과 파일로 판단한다
  }
  return require('../app/server').summarizeReport(out);
}

const failedChecks = (summary) =>
  summary.groups.flatMap((g) =>
    g.tests.flatMap((t) => {
      const checks = (t.checks || []).filter((c) => c.status === 'failed');
      // 확인 항목 기록 없이 실패한 테스트(예상 밖 오류)도 실패로 센다
      if (!checks.length && t.status === 'failed') return [{ group: g.title, test: t.title, check: '(테스트 오류)', detail: t.error.split('\n')[0] }];
      return checks.map((c) => ({ group: g.title, test: t.title, check: c.name, detail: c.detail.slice(0, 200) }));
    })
  );

const pathOfGroup = (title) => (title.match(/^\[[^\]]+\] (\S+)/) || [])[1] || '';

(async () => {
  const started = Date.now();
  console.log(`[자가 검증] QA_Automation_KC v${version} · 테스트 사이트 ${BASE} · 작업 폴더 ${WS}`);
  const site = spawn(process.execPath, [path.join(ROOT, 'selftest', 'fixture-site.js'), String(PORT)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  await new Promise((resolve, reject) => {
    site.stdout.on('data', (d) => /ready/.test(d) && resolve());
    site.on('exit', (code) => reject(new Error(`테스트 사이트를 시작하지 못했습니다 (code ${code})`)));
  });
  const mode = (m) => fetch(`${BASE}__mode/${m}`).then((r) => r.text());

  try {
    fs.mkdirSync(path.join(WS, 'tests', 'support'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tests', 'support', 'site.ts'), path.join(WS, 'tests', 'support', 'site.ts'));

    console.log('[1/3] 정상 모드 분석 · 테스트 생성');
    await mode('clean');
    node([path.join(ROOT, 'scripts', 'generate-specs.js'), BASE, '--scope=all'], { QA_OUTPUT_DIR: path.join(WS, 'tests', 'generated') });
    const analysis = JSON.parse(fs.readFileSync(path.join(WS, 'tests', 'generated', 'analysis.json'), 'utf-8'));

    console.log('[2/3] 정상 모드 실행 (오탐 측정)');
    const clean = runTests('clean');
    const falsePositives = failedChecks(clean);

    console.log('[3/3] 버그 모드 실행 (감지율 측정)');
    await mode('mutated');
    const bugged = runTests('mutated');
    const bugFails = failedChecks(bugged);
    const results = defects.map((d) => {
      const hit = bugFails.find((f) => pathOfGroup(f.group) === d.page && f.test.includes(d.title) && d.check.test(f.check));
      return { id: d.id, area: d.area, desc: d.desc, detected: !!hit, by: hit ? `${f2(hit.test)} · ${hit.check}` : null };
    });
    function f2(t) {
      return t.length > 60 ? `${t.slice(0, 57)}…` : t;
    }

    const detected = results.filter((r) => r.detected).length;
    const report = {
      appVersion: version,
      ranAt: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      pages: analysis.pages.length,
      cases: clean.total,
      checks: clean.groups.reduce((n, g) => n + g.tests.reduce((m, t) => m + (t.checks || []).length, 0), 0),
      coverageRate: analysis.coverage ? analysis.coverage.rate : null,
      defects: results.length,
      detected,
      detectionRate: Math.round((detected / results.length) * 100),
      falsePositives: falsePositives.length,
      falsePositiveList: falsePositives,
      results,
    };
    fs.mkdirSync(REPORTS, { recursive: true });
    const stamp = report.ranAt.slice(0, 19).replace(/[:T]/g, '-');
    fs.writeFileSync(path.join(REPORTS, `selftest-v${version}-${stamp}.json`), JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(path.join(REPORTS, 'latest.json'), JSON.stringify(report, null, 2), 'utf-8');

    console.log('\n==================================================');
    console.log(`자가 검증 결과 v${version}: 감지 ${detected}/${results.length} (${report.detectionRate}%) · 오탐 ${falsePositives.length}건 · 케이스 ${report.cases}개 · ${report.seconds}초`);
    for (const r of results) console.log(`  ${r.detected ? '✓' : '✗'} ${r.id} [${r.area}] ${r.desc}${r.detected ? '' : '  ← 감지 못함'}`);
    for (const f of falsePositives) console.log(`  ⚠ 오탐: ${pathOfGroup(f.group)} · ${f.test} · ${f.check} — ${f.detail}`);
    console.log('==================================================');
    process.exitCode = report.detectionRate === 100 && report.falsePositives === 0 ? 0 : 1;
  } finally {
    site.kill();
    if (!process.argv.includes('--keep')) fs.rmSync(WS, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(`[자가 검증] 실패: ${e.message}`);
  process.exit(2);
});
