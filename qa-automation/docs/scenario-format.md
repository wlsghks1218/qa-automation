# 시나리오(사용자 흐름) 형식

요소 테스트는 요소 하나를 눌러 본 직후만 확인합니다. **시나리오**는 사람이 정한 순서대로 여러 화면을 이어 가며
(글쓰기 → 입력 → 등록 → 목록 → 상세), 단계마다 **사람이 정한 기대 결과**를 확인합니다.
"등록하면 목록 맨 위에 한 건 늘어난다"처럼 앞 단계의 결과를 뒤에서 확인해야 잡히는 버그를 찾습니다.

생성기: `scripts/lib/scenario-specs.js` · 예시: `selftest/scenarios/*.json`

## 1. 어디에 두나

- 앱에서 URL 을 입력하고 **[선택] → 시나리오 폴더 열기**를 누르면 그 사이트의 폴더가 열립니다.
  위치: `<사용자 데이터 폴더>/scenarios/<사이트 host>/` (예: `.../scenarios/test.example.com/`)
- 폴더 안의 `*.json` 파일 하나가 시나리오 하나입니다. **파일 이름순**으로 실행합니다 (`01-…`, `02-…` 처럼 번호를 붙이면 순서를 정할 수 있음).
- URL 을 입력하면 앱이 시나리오 개수 · 형식 오류 · 운영 서버 여부를 바로 보여줍니다.

## 2. 파일 구조

```json
{
  "name": "글 등록 → 목록 → 상세",
  "description": "무엇을 확인하는 흐름인지 (선택)",
  "startUrl": "/board",
  "variables": { "title": "QA 글 {{unique}}" },
  "steps": [ … ],
  "cleanup": [ … ],
  "allowProduction": false,
  "allowIrreversible": false
}
```

| 항목 | 필수 | 설명 |
|---|---|---|
| `name` | ✅ | 시나리오 이름 (결과 화면 · cases.html 에 표시) |
| `description` | | 설명 |
| `startUrl` | | 시작 주소. 입력한 URL 기준 상대 경로(`/board`) 또는 전체 주소. 없으면 `/` |
| `variables` | | `{ 이름: 값 }`. 값 안에서 앞에 정의된 변수와 기본 변수를 쓸 수 있음 |
| `steps` | ✅ | 단계 목록 (1개 이상) |
| `cleanup` | | 정리 단계 목록. 앞 단계가 실패해도 **항상 실행**, 실패하면 경고 |
| `allowProduction` | | `true` 면 운영 서버로 보이는 주소에서도 실행 (기본: 실행 안 함) |
| `allowIrreversible` | | `true` 면 탈퇴 · 결제 등 되돌릴 수 없는 동작이 있어도 실행 (테스트 서버에서만, 운영 서버에서는 항상 실행 안 함) |

## 3. 단계 (`steps` · `cleanup`)

```json
{ "name": "등록", "action": "click", "target": { "role": "button", "name": "등록" }, "expect": [ { "text": "등록되었습니다" } ] }
```

`name` 은 선택입니다 (없으면 동작으로 자동 작성). `expect` 는 하나(객체) 또는 여러 개(배열)를 쓸 수 있고, **정리 단계에는 쓸 수 없습니다.**

| action | 필요한 항목 | 하는 일 |
|---|---|---|
| `goto` | `url` | 주소로 이동 (상대 경로는 입력한 URL 기준) |
| `click` | `target` | 누르기 |
| `fill` | `target`, `value` | 입력란을 비우고 입력 |
| `select` | `target`, `value` | 선택 상자에서 **보이는 문구**가 `value` 인 항목 선택 |
| `check` · `uncheck` | `target` | 체크 · 체크 해제 |
| `hover` | `target` | 마우스 올리기 |
| `press` | `key` (+ `target`) | 키 입력 (`"Enter"`, `"Escape"`, `"Control+A"` …). target 이 있으면 그 요소에서 |
| `read` | `target`, `as` (+ `what`) | 화면의 값을 변수 `as` 에 저장. `what`: `text`(문구, 기본) · `value`(입력값) · `count`(개수) |

## 4. 요소 찾기 (`target`)

아래 중 **하나**로 찾습니다. 보이는 요소만 대상입니다.

| 방법 | 예 | 의미 |
|---|---|---|
| `role` (+ `name`) | `{ "role": "button", "name": "등록" }` | 역할과 접근성 이름 (가장 권장) |
| `label` | `{ "label": "제목" }` | 라벨이 붙은 입력란 |
| `placeholder` | `{ "placeholder": "검색어 입력" }` | 안내 문구가 있는 입력란 |
| `text` | `{ "text": "더 보기" }` | 화면 문구 |
| `testId` | `{ "testId": "submit-btn" }` | `data-testid` 속성 |
| `css` | `{ "css": "#posts li" }` | CSS 선택자 (마지막 수단) |

함께 쓸 수 있는 옵션:

| 옵션 | 설명 |
|---|---|
| `exact` | 기본 `true`(이름이 정확히 같아야 함). `false` 면 포함만 해도 됨 |
| `hasText` | 그 문구를 포함한 것만 (`{ "css": "li", "hasText": "{{title}}" }`) |
| `within` | 다른 target 안에서만 찾기 (`{ "role": "button", "name": "삭제", "within": { "css": "#post-3" } }`) |
| `nth` | 여러 개면 몇 번째(0부터). 기본 0 |

**배열로 쓰면 대체 후보**입니다. 앞의 것으로 못 찾으면 다음 것으로 찾습니다 (이름이 바뀌어도 동작하도록):
`"target": [{ "role": "button", "name": "등록" }, { "text": "저장" }]`

## 5. 확인 (`expect`)

확인 하나에는 아래 중 **정확히 하나**를 씁니다.

| 종류 | 예 | 기대 결과 |
|---|---|---|
| `url` | `{ "url": "/board" }` | 주소의 경로가 같음 (끝 `/` · 추가 쿼리 · `#` 허용. 쿼리를 적으면 쿼리까지 비교) |
| `text` | `{ "text": "등록되었습니다" }` | 화면 어딘가에 그 문구가 보임 |
| `text` + `in` | `{ "text": "{{title}}", "in": { "css": "#posts li" } }` | 그 요소(여러 개면 첫 번째)에 문구가 있음 → **목록 맨 위** 확인에 사용 |
| `notText` | `{ "notText": "{{title}}" }` | 그 문구가 보이지 않음 (삭제 확인) |
| `visible` · `hidden` | `{ "visible": { "label": "제목" } }` | 요소가 보임 / 보이는 것이 하나도 없음 |
| `enabled` · `disabled` | `{ "disabled": { "role": "button", "name": "등록" } }` | 누를 수 있음 / 비활성 |
| `value` | `{ "value": { "target": { "label": "제목" }, "equals": "{{title}}" } }` | 입력값이 같음 |
| `count` | `{ "count": { "target": { "css": "#posts li" }, "equals": 10 } }` | 개수가 정확히 N (`min`: N 이상 · `delta`: 저장한 값보다 by 만큼 많음/적음) |

`delta` 예 — 등록 전 개수를 `read` 로 저장한 뒤:
```json
{ "count": { "target": { "css": "#posts li" }, "delta": { "from": "before", "by": 1 } } }
```

## 6. 변수

`{{이름}}` 으로 값 · 주소 · 문구 · 요소 이름 어디서나 씁니다. **쓰기 전에 정의되어 있어야** 합니다 (아니면 형식 오류).

| 변수 | 값 |
|---|---|
| `{{unique}}` | 실행마다 다른 짧은 값. 만드는 데이터(글 제목 · 아이디)가 이전 실행과 겹치지 않게 |
| `{{today}}` | 오늘 날짜 `YYYY-MM-DD` |
| `{{now}}` | 지금 시각 `HH:mm` |
| `variables` 의 이름 | 시나리오 시작 때 값 |
| `read` 의 `as` | 그 단계 이후 |

**비밀값(`{{secret:…}}`)은 아직 받지 않습니다.** 리포트 · 트레이스에 평문으로 남기 때문입니다. 로그인이 필요하면 앱의 **저장된 로그인**을 쓰세요 (시나리오도 그 로그인 상태로 시작합니다).

## 7. 실행 규칙

- 시나리오는 **한 번에 하나씩, 파일 이름순**으로 실행하고 **재시도하지 않습니다** (데이터를 바꾸는 흐름이라 두 번 실행되면 결과가 꼬임).
- 시작: `startUrl` 을 열어 HTTP 400 미만인지 확인. 실패하면 나머지는 실행하지 않음.
- **동작**(클릭 · 입력 등)이 실패하면 → 그 뒤 단계는 실행하지 않음 ("멈춘 곳"으로 표시).
- **확인**이 실패해도 → 다음 단계는 계속 진행 (한 번 실행으로 여러 문제를 찾도록).
- 흐름 전체에서 JS 런타임 오류 · 같은 사이트 요청 실패(404 · 5xx)도 확인합니다.
- **정리** 단계는 항상 실행하고, 실패하면 "만든 데이터가 남았을 수 있음" 경고로 남깁니다.

## 8. 안전 규칙 (실행 안 함)

| 경우 | 결과 |
|---|---|
| 운영 서버로 보이는 주소 (host 에 dev · stg · staging · test · qa · beta · sandbox · uat · localhost 등이 없음) | **실행 안 함** — 시나리오는 데이터를 바꿉니다. 테스트 서버 주소에서 실행하세요. 꼭 필요하면 `allowProduction: true`. (입력 화면의 환경 종류 선택은 입력 확장 Phase 1 에서 추가 예정이며, 지금은 주소로만 판단합니다) |
| 탈퇴 · 송금 · 출금 · 결제 · 구매 · 로그아웃을 누르는 단계 | **실행 안 함** (`allowIrreversible: true` 면 테스트 서버에서만 실행, 운영 서버에서는 항상 실행 안 함) |
| 형식 오류 (필수 항목 없음 · 정의 안 된 변수 · 비밀값 · 정리 단계의 expect 등) | **형식 오류**로 표시하고 실행 안 함. 앱 입력 화면에 이유가 나옴 |

## 9. 결과

- 앱 결과 화면 **시나리오 (사용자 흐름)**: 시나리오마다 통과 / 실패 / 실행 안 함 / 형식 오류, 실패하면 멈춘 단계와 오류.
- **cases.html**: 대분류 "[시나리오] 사용자 흐름", 중분류 = 시나리오, 소분류 = 단계 · 확인 항목, 과정 · 기대결과 · 결과 · 이유.

## 10. 전체 예시

```json
{
  "name": "글 등록 → 목록 → 상세",
  "startUrl": "/board",
  "variables": { "title": "QA 글 {{unique}}", "body": "자동 시나리오 본문 {{today}}" },
  "steps": [
    { "name": "등록 전 글 수 기억", "action": "read", "target": { "css": "#posts li" }, "what": "count", "as": "before" },
    { "action": "click", "target": { "role": "link", "name": "글쓰기" }, "expect": [{ "url": "/board/new" }] },
    { "action": "fill", "target": { "label": "제목" }, "value": "{{title}}" },
    { "action": "fill", "target": { "label": "내용" }, "value": "{{body}}" },
    {
      "action": "click", "target": { "role": "button", "name": "등록" },
      "expect": [
        { "url": "/board" },
        { "text": "등록되었습니다" },
        { "count": { "target": { "css": "#posts li" }, "delta": { "from": "before", "by": 1 } } },
        { "text": "{{title}}", "in": { "css": "#posts li" } }
      ]
    },
    { "action": "click", "target": { "role": "link", "name": "{{title}}" }, "expect": [{ "text": "{{body}}" }] }
  ],
  "cleanup": [
    { "action": "goto", "url": "/board" },
    { "action": "click", "target": { "role": "link", "name": "{{title}}" } },
    { "action": "click", "target": { "role": "button", "name": "삭제" } }
  ]
}
```
