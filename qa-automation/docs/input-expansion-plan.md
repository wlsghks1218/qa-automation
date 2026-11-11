# QA_Automation_KC 입력 확장 구현 계획

QA 대행 의뢰서 수준의 입력(URL · 기획서 · 계정 · 실행 환경 · Figma · API 문서 · Jira)을 받을 수 있도록 확장한다.
한 번에 Phase 하나씩 구현하고, Phase 하나 = 버전 하나(0.001 증가)로 배포한다.

## 진행 상황

| 순서 | Phase | 버전 | 상태 |
|---|---|---|---|
| 1 | Phase 0. 공통 기반 (runConfig · 비밀값 보관 · 프로젝트 저장 · 입력 화면 재구성) | 0.016 | 구현 완료 · 자가 검증 · 배포 대기 |
| 2 | Phase 1. 대상 · 실행 환경 · 범위 · 접속 조건 | 0.017 | 예정 |
| 3 | Phase 4. Jira 연동 (입력 + 버그 등록) | | 예정 |
| 4 | Phase 2. 권한별 테스트 계정 | | 예정 |
| 5 | Phase 5. API 문서 → API 테스트 | | 예정 |
| 6 | Phase 3. 기획서 링크 | | 예정 |
| 7 | Phase 6. Figma 시안 비교 | | 예정 |
| 8 | Phase 7. 모바일 앱 | | 나중 (별도 계획) |
| 추가 | 관찰 모드: PC 창 캡처 (Roblox PC 클라이언트 · Windows 프로그램 · PC 게임) | 0.017 | 다음 — 사용자 요청 2026-11-11: PC 버전을 먼저 제대로 |
| 추가 | 관찰 모드 2단계: ADB (Nox · LDPlayer · BlueStacks · 안드로이드 실기기) | | 보류 — 사용자가 PC 버전 우선, 모바일은 나중 |

## 관찰 모드 (게임 · 에뮬레이터 · PC 프로그램)

URL 이 없는 대상(Roblox 클라이언트, Nox · LDPlayer · BlueStacks 안의 게임 · 앱, PC 프로그램)을 위한 모드. 남의 라이브 게임에는 자동 입력(탭 · 클릭)을 보내지 않는다(봇 · 매크로 = 이용약관 위반, 계정 제재 위험). 사람이 플레이하고 도구는 보고 기록 · 검사만 한다.

- 대상: Roblox 에 한정하지 않고 PC 에서 실행 중인 모든 프로그램. 목록에서 고른다 (2026-11-11 합의).
- 캡처 범위 3가지: 창 하나(가려져도 그 창만, 최소화하면 못 찍음) / 프로그램 하나(본 창 + 그 프로그램의 팝업 · 대화상자 창, 기본값) / 모니터 전체(+영역).
- 화면 읽기: 일반 Windows 프로그램(표준 UI · WPF · WinForms · Electron 등)은 Windows UI Automation 으로 버튼 · 문구 · 대화상자를 정확히 읽고(OCR 불필요), 게임(DirectX · OpenGL, Roblox 등)은 캡처 + OCR. 창마다 자동 판별.
- 자동 입력(누르기)은 기본 꺼짐. 내 프로그램 · 의뢰받은 프로그램에 한해 나중에 웹 하네스처럼 추가 가능, 라이브 게임에는 금지.
- 모바일(ADB · 에뮬레이터)은 보류.
- 영역: 미리보기 위에 드래그로 지정, 화면 비율(%)로 저장, 앱별 보관. 종류: 게임 영역(잘라내기) · 검사 영역 · 제외 영역(채팅 · 시계 · FPS · 광고) · 감시 영역(오류 팝업).
- 캡처 시점: 화면이 의미 있게 바뀔 때(픽셀 차이 기준, 제외 영역 무시) + 단축키. 선택: 영상 녹화.
- 검사: OCR(Tesseract.js, 한 · 영 · 일) → 오타 규칙(scripts/lib/typo.js) · {{변수}} · 번역 키 · 오류/접속 끊김 팝업. AI 키가 있으면 AI 화면 검토(잘림 · 겹침, 경고). ADB 면 logcat 오류 · 크래시 · ANR.
- 결과: 시간순 화면 타임라인 + 문제마다 캡처 · 시각, 같은 결과 폴더 · cases.html 형식. TC 파일이 있으면 화면 문구로 TC 제목을 짝지어 "이번 플레이에서 본 TC / 못 본 화면" 표시.
- 한계: 보이는 문제만 찾음(기능 판정은 사람), 게임 폰트 OCR 오차로 오타는 경고, 무인 실행 불가. iOS 미지원.
- 일반 안드로이드 앱(게임 아님)은 Phase 7(Appium) 으로 웹처럼 완전 자동화.

## 공통 규칙 (모든 Phase)

- 기존 동작 유지: 새 입력은 모두 선택 사항. URL만 넣고 실행하는 기존 흐름(규칙 기반 · AI 테스트 · 기획서 모드)은 그대로 동작.
- 비밀값은 전부 암호화: 비밀번호 · API 토큰(Figma · Jira · API 인증) · Basic 인증 정보는 app/secure-store.js(Electron safeStorage)로만 저장. settings.json, .env, 결과 폴더, 리포트, run.log, cases.html 에 평문 금지. 로그에는 **** 로 가림.
- 안전 모드 존중: 안전 모드(기본)에서는 데이터를 바꾸는 동작(POST · PUT · DELETE, 저장 · 제출 버튼, Jira 등록)을 하지 않음. 외부로 쓰는 동작(Jira 등록 등)은 항상 사람이 확인한 뒤에만 실행.
- 실패해도 전체는 계속: Figma · Jira · API 문서를 읽지 못해도 분석 · 실행은 계속하고 결과에 "○○ 연동 실패: 이유"로 남김.
- 버전 · 문서: Phase마다 npm run version:bump, docs/changelog.json 추가, docs/how-it-works.html 갱신 후 npm run doc. 하네스를 고쳤으면 npm run selftest.
- UI 문구는 한국어, 기존 화면 스타일(app/public/index.html)을 따름.

## Phase 0. 공통 기반: 입력 모델과 비밀값 보관

- 실행 설정 객체(runConfig)를 정의하고 /api/run 요청 body를 이 구조로 받는다. 기존 필드(url, scope, mode, browsers, file, useLogin, clickAll)는 그대로 받아 변환(하위 호환).

```
runConfig = {
  target:   { url, envType: 'beta' | 'staging' | 'production' },
  runtime:  { browsers: ['chromium','webkit','firefox'], viewports: ['desktop','mobile'] },
  scope:    { mode: 'all' | 'single' | 'pages' | 'changes', pages: [], exclude: { urlPatterns: [], buttonTexts: [] } },
  access:   { basicAuth: secretRef | null, headers: secretRef | null },
  accounts: [ { role: '일반회원', method: 'manual' | 'credentials', secretRef } ],
  spec:     { file, link },
  figma:    { fileUrl, secretRef } | null,
  api:      { specUrlOrFile, baseUrl, auth: secretRef } | null,
  jira:     { siteUrl, projectKey, epicKeys: [], secretRef, createBugs: false } | null,
  testData: { freeText, knownIssues: [] },
  safety:   { clickAll },
}
```

- app/secure-store.js 확장: saveSecret(id, value), readSecret(id), deleteSecret(id), listSecrets(). 저장 위치 USER_DIR/secrets/<id>.enc. 화면과 runConfig 에는 값이 아니라 secretRef(id)만.
- "프로젝트" 저장: 사이트별 마지막 runConfig(비밀값 제외)를 USER_DIR/projects/<host>.json 에 저장해 다음 실행 때 자동으로 채움.
- 화면 재구성: 입력 영역을 [필수] / [권장] / [선택] 세 묶음으로. [선택]은 접힌 상태가 기본.
- 완료 기준: URL만으로 실행해도 결과가 같다. 비밀값을 저장 · 읽기 · 삭제할 수 있고, 결과 폴더 전체를 검색해도 비밀값 평문이 나오지 않는다.

## Phase 1. 대상 · 실행 환경 · 범위 · 접속 조건

- 환경 종류: 베타 / 스테이징 / 운영. 운영이면 "전체 동작 확인"을 끄고 비활성화, 경고("운영 서버: 데이터가 바뀌는 동작은 하지 않습니다"). 선택하지 않으면 host로 추정(dev, stg, staging, test, qa, beta, localhost → 테스트 환경, 아니면 운영).
- 실행 환경: 브라우저(기존) + 화면 크기 PC(1440×900) / 모바일(390×844, 터치). 모바일을 고르면 분석과 실행을 모바일 화면으로도 수행(Playwright 기기 프리셋).
- 테스트 범위: 전체 사이트 / 입력한 페이지만 / 지정한 페이지 목록 / 변경분(Jira 또는 직전 실행 대비 변경 페이지).
- 접속 조건: Basic 인증 → httpCredentials, 추가 HTTP 헤더 → extraHTTPHeaders. 비밀값으로 저장. 분석 · 로그인 창 · 실행에 모두 적용.
- 제외 영역: URL 패턴(/admin/*)은 크롤링 안 함. 버튼 문구는 누르지 않는 목록에 추가.
- 테스트 데이터 · 알려진 이슈: 테스트 데이터는 검색창 · 입력창 값으로 우선 사용. 알려진 이슈와 같은 실패는 "알려진 이슈"로 표시하고 실패 수에서 따로 센다.
- 완료 기준: Basic 인증 사이트를 분석 · 실행할 수 있다. 운영 환경에서는 전체 동작 확인을 켤 수 없다. 모바일 결과가 PC 결과와 따로 표시된다. 제외한 URL과 버튼은 분석에 나타나지 않는다.

## Phase 2. 권한별 테스트 계정

- 계정 목록 UI: 역할 이름 + 방식(직접 로그인 / 계정 전달).
- 직접 로그인: login-session.js 흐름, 저장 파일만 역할별(auth/<host>__<role>.json.enc).
- 계정 전달: 아이디 · 비밀번호를 비밀값으로 저장, 실행 전 로그인 화면에서 자동 로그인 시도(라벨 · 타입으로 입력창 찾기). 실패(MFA · 캡차)하면 "직접 로그인 필요"로 안내하고 직접 로그인으로 전환.
- "테스트 계정만 입력하세요. 개인 · 관리자 실계정은 입력하지 마세요" 고정 안내, MFA 해제 여부 체크박스.
- 실행: 계정마다 분석 · 실행 반복, 결과 대분류 앞에 [역할]. 역할별 메뉴 차이 표시. 비회원도 기본 역할로 실행(선택 해제 가능).
- 완료 기준: 계정 두 개로 실행하면 역할별 결과가 나뉜다. 비밀번호는 암호화 파일에만.

## Phase 3. 기획서 링크

- 공개 URL(웹 페이지 · PDF 링크)을 내려받아 기존 기획서 처리(app/doc-testcases.js)로. PDF는 파일, HTML은 본문 텍스트.
- 로그인이 필요한 문서(Google Docs · Confluence · Notion)는 "공개 링크나 PDF로 내보내서 첨부" 안내만.
- 첨부와 링크를 동시에 주면 둘 다 합쳐서 사용.
- 완료 기준: 공개 PDF 링크만 넣어도 기획서 모드가 동작한다.

## Phase 4. Jira 연동 (입력 + 버그 등록)

- 연결: Jira 사이트 URL + 이메일 + API 토큰(비밀값) + 프로젝트 키. "연결 확인"으로 /rest/api/3/myself 호출.
- 입력: 에픽 키(여러 개)의 하위 이슈 제목 · 설명 · 인수 조건 → AI 로 TC 생성 → 화면 요소 연결(doc-testcases.js 재사용), TC에 출처 이슈 키. 범위 "변경분"이면 이슈에 나온 화면 · 기능 위주.
- 출력(버그 등록, 기본 꺼짐): 실패 케이스마다 버그 초안(제목, 재현 절차, 기대결과, 실제결과, 브라우저 · 화면, 스크린샷). 사람이 체크한 것만 "Jira에 등록". 스크린샷 첨부, 관련 에픽 · 이슈 링크.
- 중복 방지: 같은 케이스 ID로 열린 버그가 있으면 "이미 등록됨(키)". 라벨 qa-kc + 케이스 ID.
- 저장된 로그인 결과의 스크린샷은 등록 전 "로그인 화면이 포함됩니다" 경고.
- cases.html "이유" 열 옆에 Jira 키 링크.
- 완료 기준: 에픽 키로 TC가 생성 · 실행된다. 체크한 실패 케이스만 한 번씩 등록되고 다시 실행해도 중복 등록되지 않는다.

## Phase 5. API 문서 → API 테스트

- 입력: OpenAPI JSON/YAML 파일 또는 URL, API base URL, 인증(Bearer · API 키 헤더 · 저장된 로그인 쿠키 재사용, 비밀값).
- 생성: 엔드포인트마다 Playwright request 테스트(tests/generated/api/*.spec.ts): 상태 코드 · 응답 스키마(ajv) · 응답 시간(경고, 2초) · 인증 없이 부르면 401/403.
- 안전: 안전 모드에서는 GET만, 쓰기는 "건너뜀(안전 모드)". 전체 동작 확인 + 운영이 아닌 환경일 때만 쓰기 API. 경로 파라미터는 GET 목록 응답이나 테스트 데이터에서.
- 기획서 연결: AI가 TC와 관련 API를 짝지어 화면 TC 실패 시 관련 API 결과를 같이 표시.
- 결과: cases.html 대분류 "API"(중분류 = 엔드포인트, 소분류 = 확인 항목).
- 완료 기준: 공개 예제 OpenAPI(Swagger Petstore)로 GET 테스트가 생성 · 실행된다. 안전 모드에서 쓰기 API는 호출되지 않는다.

## Phase 6. Figma 시안 비교

- 입력: Figma 파일 링크 + 개인 접근 토큰(비밀값).
- 처리: Figma REST API(/v1/files/:key, /v1/images/:key)로 프레임과 이미지. AI가 프레임 ↔ 페이지를 짝짓고 사람이 확인 · 수정, 프로젝트에 저장. 같은 화면 크기로 스크린샷 비교.
- 문구 비교(확정): Figma 텍스트 노드와 화면 문구가 다르면 실패.
- 화면 비교(경고): 시안 이미지와 스크린샷을 AI에 보내 레이아웃 · 색 · 누락 요소 차이를 경고. 픽셀 비교는 쓰지 않음.
- 결과: cases.html 대분류 "디자인 비교", 시안과 실제 화면을 나란히 보는 링크.
- 완료 기준: 연결된 페이지마다 문구 차이가 실패로, 레이아웃 차이가 경고로 나온다. 토큰이 없거나 틀리면 이 단계만 건너뛴다.

## Phase 7 (나중). 모바일 앱

- 입력이 APK(Android) / IPA 또는 시뮬레이터 빌드(iOS). Appium(또는 Maestro) 기반 별도 실행기 필요.
- 웹과 같은 흐름(요소 찾기 → 눌러 보기 → 테스트 생성 → 실행)을 앱 접근성 트리로 구현.
- 웹 기능이 안정된 뒤 별도 계획으로 진행.
