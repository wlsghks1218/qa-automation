# QA_Automation_KC

URL 또는 기획서(PDF)를 넣으면 테스트 케이스(TC)를 자동으로 만들고 실행해서 결과를 보여주는 데스크톱 프로그램입니다. Windows와 macOS(Apple Silicon)에서 동작합니다.

## 사용 방법

1. 프로그램을 실행합니다. 바탕화면 아이콘 `QA_Automation_KC`를 누르면 됩니다.
2. **URL**을 입력하거나 **기획서**를 첨부합니다. 기획서는 창에 끌어다 놓아도 됩니다(PDF, PNG, JPG, WEBP, TXT, MD).
3. **테스트 범위**를 고릅니다.
   - **입력한 사이트에 연결된 세부 사이트 모두**: 같은 도메인으로 연결된 페이지를 모두 찾아 테스트합니다.
   - **입력한(첨부한) 사이트(PDF)만**: 입력한 URL 한 페이지만 테스트합니다. 기획서를 첨부했다면 기획서에 있는 TC만 테스트합니다.
4. **테스트 브라우저**를 고릅니다. Chrome(Chromium), Safari(WebKit 엔진), Firefox 중 여러 개를 고를 수 있습니다. 여러 개를 고르면 브라우저에 따라 결과가 달라지는 TC를 따로 보여줍니다.
5. 실행 버튼을 누릅니다. 실행이 끝나면 결과가 화면에 표시되고, 결과 저장 폴더에도 저장됩니다.
   - **규칙 기반 테스트**: 브라우저가 화면 요소를 직접 눌러보고, 관찰한 동작으로 TC를 만들어 실행합니다. AI를 쓰지 않아 비용이 들지 않습니다.
   - **AI 테스트**: 규칙 기반 분석에 더해, AI가 각 페이지 스크린샷과 요소 목록을 보고 TC를 작성합니다. 기대 동작은 요소 이름과 맥락을 기준으로 정합니다. 문구, 이미지, 레이아웃, 접근성 이슈도 보고합니다. URL과 AI API Key가 필요합니다.

기획서를 분석하려면 AI API Key가 필요합니다. 상단 **AI 설정**에서 Gemini, Claude, ChatGPT 중 하나를 고르고 키를 입력하세요. 키는 이 PC에만 저장됩니다.

## 동작 방식

| 입력 | 처리 | 판단 기준 |
|---|---|---|
| URL + 규칙 기반 | 브라우저가 페이지를 열고 링크, 버튼, 탭, 입력창을 하나씩 직접 눌러봅니다. 그 결과(이동, 새 탭, 모달, 펼침, 콘텐츠 노출)를 기록하고, 기록한 동작을 그대로 확인하는 테스트를 만듭니다. | 지금 사이트의 실제 동작 (회귀·기능 오류) |
| URL + AI | 규칙 기반 분석 결과와 페이지 스크린샷을 AI에 넘깁니다. AI는 요소 이름과 화면 맥락으로 기대 동작을 정해 TC를 만들고, 화면 이슈를 보고합니다. | 요소 이름·맥락상 당연한 동작 |
| 기획서만 | AI가 기획서를 읽고 TC 표를 작성합니다. 표는 CSV로 내려받을 수 있습니다. | — (실행하지 않음) |
| URL + 기획서 | 위 두 과정을 거친 뒤, AI가 기획서 TC를 실제 화면 요소와 짝지어 **기획서 기준**으로 실행합니다. | 기획서의 기대 결과 |

기획서 TC 결과는 다음 넷 중 하나로 표시됩니다.

- **통과 / 실패**: 실제로 실행한 결과입니다.
- **화면에서 못 찾음**: 기획서에 있는 기능을 화면에서 찾지 못했습니다.
- **수동 확인 필요**: 로그인, 실제 자산, 외부 연동이 필요한 TC입니다.

## 결과물 (`결과 저장 폴더/<실행시각>/`)

| 파일 | 내용 |
|---|---|
| `summary.json` | 화면에 표시되는 전체 결과 |
| `report/index.html` | Playwright HTML 리포트. 실패한 테스트의 스크린샷, 영상, 트레이스가 들어 있습니다 |
| `analysis.json` | 크롤러가 찾은 페이지와 기능 목록(기능 ID 포함) |
| `doc-testcases.csv` / `.json` | 기획서 기반 TC와 실행 결과 |
| `doc-mappings.json` | 기획서 TC와 화면 요소의 매핑 |
| `ai-testcases.csv` / `.json` | AI 테스트로 만든 TC, 실행 결과, 발견 이슈 |

## 개발

```bash
npm install
npm run app            # Electron 창으로 실행
npm run app:browser    # Electron 없이 Edge/Chrome 앱 모드로 실행 (node app/server.js)
npm run generate -- https://example.com --scope=all   # 생성기만 실행
npm run test:generated # 생성된 테스트만 실행
```

| 경로 | 역할 |
|---|---|
| `app/main.js` | Electron 진입점. 창을 띄우고 데이터 폴더를 지정합니다 |
| `app/server.js` | 화면에서 받은 요청으로 분석 → 생성 → 실행 → 결과 정리를 수행합니다 |
| `app/llm.js` | Gemini, Claude, ChatGPT를 같은 방식으로 호출하는 공통 인터페이스 |
| `app/doc-testcases.js` | 기획서로 TC 작성, TC와 화면 요소 매핑 |
| `app/site-ai.js` | AI 테스트: 스크린샷과 요소 목록으로 TC 작성, 이슈 보고 |
| `scripts/generate-specs.js` | 크롤러. 페이지 탐색, 기능 분석, 기능별 spec 생성 |
| `scripts/lib/doc-specs.js` | 매핑 결과로 기획서 기준 spec 생성 |
| `tests/support/site.ts` | 생성된 테스트가 공통으로 쓰는 헬퍼(팝업 처리 등) |

## 버전 관리와 빌드

버전은 `app/version.json`에서 관리합니다. 0.001에서 시작해 수정할 때마다 0.001씩 올립니다.

```bash
npm run version:bump   # 0.001 → 0.002
npm run build:win      # dist/QA_Automation_KC_v0.002_Setup.exe
npm run build:mac      # dist/QA_Automation_KC_v0.002_arm64.dmg  (macOS에서만 가능)
```

- 설치 파일에는 실행 환경(Node), 프로그램 코드, 테스트용 브라우저(Chromium, WebKit, Firefox)가 모두 들어 있습니다. 설치할 PC에 다른 것을 미리 설치할 필요가 없습니다.
- **맥용 빌드는 macOS에서만 만들 수 있습니다.** 맥북에서 `npm run build:mac`을 실행하거나, GitHub Actions의 **Build QA_Automation_KC** 워크플로를 실행하세요. 워크플로는 Windows용과 Mac용을 함께 만듭니다.
- 맥 앱은 Apple 서명이 되어 있지 않아 처음 실행할 때 경고가 뜹니다. 앱을 우클릭한 뒤 **열기**를 누르세요. 또는 터미널에서 `xattr -dr com.apple.quarantine /Applications/QA_Automation_KC.app`를 실행하세요.

설치된 앱의 데이터 위치:

| 데이터 | Windows | macOS |
|---|---|---|
| API Key, 설정 | `%APPDATA%\QA_Automation_KC\` | `~/Library/Application Support/QA_Automation_KC/` |
| 결과 (기본값) | `문서\QA_Automation_KC\` | `~/Documents/QA_Automation_KC/` |
