// 승인된 기준선(baseline): 사람이 결과를 검토하고 "이 동작이 맞다"고 승인한 분석 결과와 테스트 코드.
// 이후 실행은 직전 실행이 아니라 이 기준과 비교하므로, 한 번 들어간 버그가 정상으로 굳지 않는다.
// 저장 위치: <USER_DIR>/baselines/<시작 URL · 범위 해시>/
//   baseline.json(승인 정보) · analysis.json · cases.json · specs/*.spec.ts · screens/ · history.json(승인 이력)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const normalizeUrl = (url) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};
const keyOf = (startUrl, scope) => crypto.createHash('md5').update(`${normalizeUrl(startUrl)}|${scope}`).digest('hex').slice(0, 16);

function createBaselineStore(root) {
  const dirOf = (startUrl, scope) => path.join(root, keyOf(startUrl, scope));

  function get(startUrl, scope) {
    const dir = dirOf(startUrl, scope);
    const file = path.join(dir, 'baseline.json');
    if (!fs.existsSync(file)) return null;
    try {
      return { dir, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch {
      return null;
    }
  }

  /** 실행 결과 폴더(runDir)의 분석 · 테스트 코드를 기준으로 승인 */
  function approve(runDir, runId) {
    const analysis = JSON.parse(fs.readFileSync(path.join(runDir, 'analysis.json'), 'utf-8'));
    const specsDir = path.join(runDir, 'specs');
    if (!fs.existsSync(specsDir)) throw new Error('이 실행에는 테스트 코드가 저장되어 있지 않아 기준으로 승인할 수 없습니다.');
    const { startUrl, scope, appVersion } = analysis.meta;
    const dir = dirOf(startUrl, scope);
    const history = fs.existsSync(path.join(dir, 'history.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf-8')) : [];
    const prev = get(startUrl, scope);
    if (prev) history.push({ runId: prev.runId, approvedAt: prev.approvedAt, approvedBy: prev.approvedBy, appVersion: prev.appVersion, replacedAt: new Date().toISOString() });

    // 새 기준으로 교체 (이력은 유지)
    for (const f of ['analysis.json', 'cases.json', 'baseline.json']) fs.rmSync(path.join(dir, f), { force: true });
    for (const d of ['specs', 'screens']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(runDir, 'analysis.json'), path.join(dir, 'analysis.json'));
    if (fs.existsSync(path.join(runDir, 'cases.json'))) fs.copyFileSync(path.join(runDir, 'cases.json'), path.join(dir, 'cases.json'));
    fs.cpSync(specsDir, path.join(dir, 'specs'), { recursive: true });
    if (fs.existsSync(path.join(runDir, 'screens'))) fs.cpSync(path.join(runDir, 'screens'), path.join(dir, 'screens'), { recursive: true });
    const info = {
      startUrl,
      scope,
      runId,
      appVersion: appVersion || null,
      approvedAt: new Date().toISOString(),
      approvedBy: (() => {
        try {
          return os.userInfo().username;
        } catch {
          return '';
        }
      })(),
      pages: analysis.pages.length,
    };
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(info, null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history, null, 2), 'utf-8');
    return { dir, ...info, history };
  }

  function clear(startUrl, scope) {
    fs.rmSync(dirOf(startUrl, scope), { recursive: true, force: true });
  }

  function history(startUrl, scope) {
    const file = path.join(dirOf(startUrl, scope), 'history.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return [];
    }
  }

  return { get, approve, clear, history, normalizeUrl };
}

module.exports = { createBaselineStore };
