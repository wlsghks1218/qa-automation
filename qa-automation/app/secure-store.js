// 저장된 로그인(쿠키 · 저장소) 보호: Electron safeStorage 로 암호화해서 보관한다.
// Windows 는 DPAPI 라 이 PC 의 같은 Windows 사용자만 풀 수 있다. (macOS 는 키체인)
// safeStorage 는 Electron 메인 프로세스(앱 준비 후)에서만 쓸 수 있으므로, 개발 모드(node app/server.js)나
// 암호화를 쓸 수 없는 환경에서는 예전처럼 평문 파일로 두고 경고만 남긴다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let safeStorage = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.safeStorage) safeStorage = electron.safeStorage;
} catch {
  // 일반 node 실행
}

const encryptionAvailable = () => {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

/** 실행 중에만 쓰는 임시 평문 파일 경로 (OS 임시 폴더) */
const tempPath = (prefix) => path.join(os.tmpdir(), `qa-kc-${prefix}-${crypto.randomBytes(8).toString('hex')}.json`);

/** 평문 JSON 파일 → 암호화 파일(.enc)로 저장하고 평문은 지운다. 암호화를 못 쓰면 평문 파일로 둔다 */
function sealFile(plainSrc, encDest, plainDest) {
  const text = fs.readFileSync(plainSrc, 'utf-8');
  fs.mkdirSync(path.dirname(encDest), { recursive: true });
  if (encryptionAvailable()) {
    fs.writeFileSync(encDest, safeStorage.encryptString(text));
    fs.rmSync(plainDest, { force: true });
    if (path.resolve(plainSrc) !== path.resolve(plainDest)) fs.rmSync(plainSrc, { force: true });
    else fs.rmSync(plainSrc, { force: true });
    return { encrypted: true };
  }
  if (path.resolve(plainSrc) !== path.resolve(plainDest)) {
    fs.copyFileSync(plainSrc, plainDest);
    fs.rmSync(plainSrc, { force: true });
  }
  return { encrypted: false };
}

/**
 * 저장된 로그인을 실행에 쓸 수 있는 평문 임시 파일로 꺼낸다.
 * 반환: { path, cleanup } - 실행이 끝나면(성공 · 실패 · 중지 모두) 반드시 cleanup() 호출
 */
function openSealed(encFile, plainFile) {
  if (fs.existsSync(encFile) && encryptionAvailable()) {
    const p = tempPath('auth');
    fs.writeFileSync(p, safeStorage.decryptString(fs.readFileSync(encFile)), { encoding: 'utf-8', mode: 0o600 });
    return { path: p, cleanup: () => fs.rmSync(p, { force: true }) };
  }
  if (fs.existsSync(plainFile)) return { path: plainFile, cleanup: () => {} };
  return { path: null, cleanup: () => {} };
}

// ─────────────────────────────────────────────────────────────
// 비밀값 보관소: 비밀번호 · API 토큰 · Basic 인증 등. <dir>/<id>.enc 에 암호화해서 저장한다.
// 화면 · runConfig · 결과 폴더에는 값이 아니라 id(secretRef)만 오간다. 값은 서버 안에서만 readSecret 으로 꺼낸다.
// 암호화를 쓸 수 없는 환경(개발 모드 node 실행)에서는 평문으로 남기지 않도록 저장 자체를 거부한다.
// ─────────────────────────────────────────────────────────────

const SECRET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function createSecretStore(dir) {
  const fileOf = (id) => {
    if (!SECRET_ID.test(String(id || ''))) throw new Error('비밀값 id 형식이 올바르지 않습니다.');
    return path.join(dir, `${id}.enc`);
  };

  /** value: 문자열 또는 JSON 으로 바꿀 수 있는 값. label 은 목록에 보일 이름(비밀 아님). 반환: id */
  function saveSecret(id, value, label = '') {
    if (!encryptionAvailable()) throw new Error('이 환경에서는 암호화를 쓸 수 없어 비밀값을 저장하지 않습니다. 설치된 앱에서 입력해주세요.');
    const file = fileOf(id || crypto.randomBytes(8).toString('hex'));
    const payload = JSON.stringify({ label: String(label || ''), savedAt: new Date().toISOString(), value });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(payload), { mode: 0o600 });
    return path.basename(file, '.enc');
  }

  function readEntry(id) {
    const file = fileOf(id);
    if (!fs.existsSync(file) || !encryptionAvailable()) return null;
    try {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    } catch {
      return null;
    }
  }

  /** 값 꺼내기 (서버 안에서만 사용, 화면 · 로그로 내보내지 않는다) */
  const readSecret = (id) => {
    const entry = readEntry(id);
    return entry ? entry.value : null;
  };

  function deleteSecret(id) {
    fs.rmSync(fileOf(id), { force: true });
  }

  /** 목록: id · 이름 · 저장 시각만 (값 없음) */
  function listSecrets() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.enc'))
      .map((f) => {
        const id = path.basename(f, '.enc');
        const entry = readEntry(id);
        return { id, label: entry ? entry.label : '', savedAt: entry ? entry.savedAt : null, readable: !!entry };
      });
  }

  return { saveSecret, readSecret, deleteSecret, listSecrets };
}

/** 로그 · 결과물에 쓰기 전에 알려진 비밀값을 **** 로 가린다 (짧은 값은 오탐이 많아 4자 이상만) */
function maskSecrets(text, values) {
  let out = String(text);
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('****');
  }
  return out;
}

module.exports = { encryptionAvailable, sealFile, openSealed, tempPath, createSecretStore, maskSecrets };
