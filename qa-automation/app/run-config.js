// 실행 설정(runConfig): 한 번의 실행에 필요한 입력 전체를 한 객체로 묶는다.
// 비밀값(비밀번호 · 토큰 · Basic 인증 등)은 값이 아니라 secretRef(비밀값 보관소의 id)만 담는다.
// 예전 요청(url · scope · mode · browsers · file · useLogin · clickAll · baselineRun)도 그대로 받아 변환한다(하위 호환).
//
// runConfig = {
//   target:   { url, envType: 'beta' | 'staging' | 'production' | null },
//   runtime:  { browsers: ['chromium','webkit','firefox'], viewports: ['desktop','mobile'] },
//   scope:    { mode: 'all' | 'single' | 'pages' | 'changes', pages: [], exclude: { urlPatterns: [], buttonTexts: [] } },
//   access:   { basicAuth: secretRef | null, headers: secretRef | null },
//   accounts: [ { role, method: 'manual' | 'credentials', secretRef } ],
//   spec:     { file, link },
//   figma:    { fileUrl, secretRef } | null,
//   api:      { specUrlOrFile, baseUrl, auth: secretRef } | null,
//   jira:     { siteUrl, projectKey, epicKeys: [], secretRef, createBugs: false } | null,
//   testData: { freeText, knownIssues: [] },
//   safety:   { clickAll },
//   mode:     'basic' | 'ai',
//   useLogin, baselineRun,
// }

const BROWSERS = ['chromium', 'webkit', 'firefox'];
const VIEWPORTS = ['desktop', 'mobile'];
const ENV_TYPES = ['beta', 'staging', 'production'];
const LOCALES = ['ko-KR', 'en-US', 'ja-JP', 'zh-TW', 'th-TH'];
const SCOPE_MODES = ['all', 'single', 'pages', 'changes'];
const SECRET_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n|,/) : []).map(str).filter(Boolean);
const ref = (v) => (typeof v === 'string' && SECRET_REF.test(v) ? v : null);
const pick = (list, allowed, fallback) => {
  const out = strList(list).filter((v) => allowed.includes(v));
  return out.length ? [...new Set(out)] : fallback;
};

/** 요청 body(새 구조 또는 예전 구조) → 정규화된 runConfig */
function normalizeRunConfig(body = {}) {
  const b = obj(body);
  const target = obj(b.target);
  const runtime = obj(b.runtime);
  const scope = obj(b.scope);
  const exclude = obj(scope.exclude);
  const access = obj(b.access);
  const spec = obj(b.spec);
  const testData = obj(b.testData);
  const safety = obj(b.safety);

  // 예전 구조: scope 가 문자열, url · browsers · file · clickAll 이 최상위
  const legacyScope = typeof b.scope === 'string' ? b.scope : null;
  const scopeMode = SCOPE_MODES.includes(scope.mode) ? scope.mode : legacyScope === 'single' ? 'single' : 'all';
  const envType = ENV_TYPES.includes(target.envType) ? target.envType : null;

  const section = (v, build) => (v && typeof v === 'object' ? build(obj(v)) : null);

  return {
    target: { url: str(target.url || b.url), envType },
    runtime: {
      browsers: pick(runtime.browsers || b.browsers, BROWSERS, ['chromium']),
      viewports: pick(runtime.viewports, VIEWPORTS, ['desktop']),
      // 화면 언어(비우면 이 PC 언어) · 다국어(XLT)로 함께 확인할 언어
      locale: LOCALES.includes(runtime.locale) ? runtime.locale : null,
      xltLocales: pick(runtime.xltLocales, LOCALES, []),
    },
    scope: {
      mode: scopeMode,
      pages: strList(scope.pages),
      exclude: { urlPatterns: strList(exclude.urlPatterns), buttonTexts: strList(exclude.buttonTexts) },
    },
    access: { basicAuth: ref(access.basicAuth), headers: ref(access.headers) },
    accounts: (Array.isArray(b.accounts) ? b.accounts : [])
      .map(obj)
      .map((a) => ({ role: str(a.role), method: a.method === 'credentials' ? 'credentials' : 'manual', secretRef: ref(a.secretRef) }))
      .filter((a) => a.role),
    spec: { file: spec.file || b.file || null, link: str(spec.link) },
    figma: section(b.figma, (f) => ({ fileUrl: str(f.fileUrl), secretRef: ref(f.secretRef) })),
    api: section(b.api, (a) => ({ specUrlOrFile: str(a.specUrlOrFile), baseUrl: str(a.baseUrl), auth: ref(a.auth) })),
    jira: section(b.jira, (j) => ({
      siteUrl: str(j.siteUrl), projectKey: str(j.projectKey), epicKeys: strList(j.epicKeys), secretRef: ref(j.secretRef), createBugs: j.createBugs === true,
    })),
    testData: { freeText: str(testData.freeText), knownIssues: strList(testData.knownIssues) },
    safety: { clickAll: (safety.clickAll ?? b.clickAll) === true },
    mode: b.mode === 'ai' ? 'ai' : 'basic',
    useLogin: b.useLogin !== false,
    baselineRun: b.baselineRun === true,
  };
}

/** 저장 · 기록용 사본: 기획서 파일 내용은 빼고 이름만 남긴다 (비밀값은 원래 ref 만 있음) */
function storableConfig(config) {
  const file = config.spec && config.spec.file;
  return { ...config, spec: { ...config.spec, file: file ? { name: file.name || null } : null } };
}

/** 설정에 들어 있는 모든 비밀값 id */
function secretRefsOf(config) {
  return [
    config.access.basicAuth,
    config.access.headers,
    ...config.accounts.map((a) => a.secretRef),
    config.figma && config.figma.secretRef,
    config.api && config.api.auth,
    config.jira && config.jira.secretRef,
  ].filter(Boolean);
}

module.exports = { normalizeRunConfig, storableConfig, secretRefsOf };
