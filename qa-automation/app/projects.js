// 프로젝트: 사이트(host)별 마지막 실행 설정을 기억해 다음 실행 때 입력 화면을 자동으로 채운다.
// 저장 위치: <USER_DIR>/projects/<host>.json
// 비밀값은 runConfig 에 원래 secretRef(id)만 있으므로 평문이 저장되지 않는다. 기획서 파일 내용도 저장하지 않는다.
const fs = require('fs');
const path = require('path');
const { storableConfig } = require('./run-config');

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/[^\w.-]/g, '_');
  } catch {
    return null;
  }
};

function createProjectStore(root) {
  const fileOf = (host) => path.join(root, `${host}.json`);

  function get(url) {
    const host = hostOf(url);
    if (!host || !fs.existsSync(fileOf(host))) return null;
    try {
      return JSON.parse(fs.readFileSync(fileOf(host), 'utf-8'));
    } catch {
      return null;
    }
  }

  function save(config) {
    const host = hostOf(config.target && config.target.url);
    if (!host) return null;
    fs.mkdirSync(root, { recursive: true });
    const saved = { host, savedAt: new Date().toISOString(), config: storableConfig(config) };
    fs.writeFileSync(fileOf(host), JSON.stringify(saved, null, 2), 'utf-8');
    return saved;
  }

  function remove(url) {
    const host = hostOf(url);
    if (host) fs.rmSync(fileOf(host), { force: true });
  }

  return { get, save, remove, hostOf };
}

module.exports = { createProjectStore };
