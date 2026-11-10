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

module.exports = { encryptionAvailable, sealFile, openSealed, tempPath };
