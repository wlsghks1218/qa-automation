// 사용자가 가진 TC 파일(CSV · TSV, TestRail 등에서 내보낸 것)을 그대로 읽어 기획서 TC 와 같은 구조로 만든다.
// AI 로 TC 를 새로 쓰지 않고 사용자의 TC 를 기준으로 화면 요소와 짝지어 실행한다 (내 TC 대비 자동화 현황).
// 열 이름은 도구마다 달라서 이름 패턴으로 찾는다: 제목 · 섹션(기능) · 사전조건 · 절차 · 기대결과 · ID · 우선순위

const COLUMN = {
  id: /^(id|case\s*id|tc\s*id|번호|tc\s*번호|no\.?)$/i,
  title: /^(title|제목|케이스(명)?|tc\s*명|테스트\s*케이스|summary|name)$/i,
  section: /^(section|섹션|기능|대분류|중분류|구분|화면|feature|module|category)$/i,
  pre: /^(pre-?conditions?|사전\s*조건|전제\s*조건)$/i,
  steps: /^(steps?(\s*\(.*\))?|절차|테스트\s*절차|단계|수행\s*절차|test\s*steps?)$/i,
  expected: /^(expected(\s*result)?s?|기대\s*결과|예상\s*결과|결과\s*기대)$/i,
  priority: /^(priority|우선\s*순위|중요도)$/i,
};

/** RFC 4180 CSV(따옴표 안 줄바꿈 · "" 이스케이프) · TSV 파싱 */
function parseDelimited(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') > 0 ? src.indexOf('\n') : src.length);
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const clean = (t) => String(t || '').replace(/!\[\]\([^)]*\)/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

/**
 * TestRail '분리된 단계' 형식: "Step Description: ... Expected Result: ..." 쌍의 반복 → 단계 · 기대결과 목록
 */
function splitSeparatedSteps(text) {
  const parts = String(text || '').split(/Step Description:/i).slice(1);
  return parts.map((p) => {
    const [desc, exp] = p.split(/Expected Result:/i);
    return { step: clean(desc), expected: clean(exp) };
  });
}

/** 헤더 행이 TC 파일처럼 보이면 열 위치, 아니면 null */
function detectColumns(header) {
  const cols = {};
  header.forEach((h, i) => {
    const name = clean(h);
    for (const [key, re] of Object.entries(COLUMN)) {
      if (!re.test(name)) continue;
      // 같은 이름 열이 여러 개(TestRail 의 Steps · Steps(분리형))면 모두 기억
      (cols[key] = cols[key] || []).push(i);
    }
  });
  return cols.title && (cols.expected || cols.steps) ? cols : null;
}

/** TC 파일인지 (헤더로 판별) */
function looksLikeTcFile(file) {
  if (!/\.(csv|tsv)$/i.test(file.name || '') && !/csv|tab-separated/.test(file.type || '')) return false;
  const rows = parseDelimited(Buffer.from(file.data, 'base64').toString('utf-8').slice(0, 20000));
  return !!(rows.length && detectColumns(rows[0]));
}

/** TC 파일 → { documentTitle, features, testCases, openQuestions, imported } (기획서 TC 와 같은 구조) */
function importTcFile(file) {
  const rows = parseDelimited(Buffer.from(file.data, 'base64').toString('utf-8'));
  const cols = rows.length ? detectColumns(rows[0]) : null;
  if (!cols) throw new Error('TC 파일의 열을 알아볼 수 없습니다. 제목(Title)과 기대결과(Expected) 또는 절차(Steps) 열이 필요합니다.');
  const get = (r, key) => (cols[key] || []).map((i) => r[i] || '');
  const testCases = [];
  rows.slice(1).forEach((r, n) => {
    const title = clean(get(r, 'title')[0]);
    if (!title) return;
    const section = clean(get(r, 'section')[0]);
    const pre = clean(get(r, 'pre')[0]);
    // 절차 열이 여러 개면: 일반 절차 + 'Step Description/Expected Result' 분리형을 함께 쓴다
    const stepCells = get(r, 'steps');
    const separated = stepCells.flatMap(splitSeparatedSteps);
    const plain = stepCells.filter((c) => !/Step Description:/i.test(c)).map(clean).filter(Boolean);
    const steps = [...plain.flatMap((c) => c.split('\n').map((s) => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean)), ...separated.map((s) => s.step).filter(Boolean)];
    const expected = [clean(get(r, 'expected')[0]), ...separated.map((s) => (s.step ? `${s.step} → ${s.expected}` : s.expected))].filter(Boolean).join('\n');
    const id = clean(get(r, 'id')[0]) || `TC-${String(n + 1).padStart(3, '0')}`;
    testCases.push({
      id: /^[\w-]+$/.test(id) ? id : `TC-${String(n + 1).padStart(3, '0')}`,
      feature: section || '(섹션 없음)',
      title,
      type: '기능',
      priority: clean(get(r, 'priority')[0]) || 'Medium',
      precondition: pre,
      steps: steps.length ? steps : [title],
      expected: expected || '(기대결과 없음 — 첨부 이미지로만 표시된 TC)',
      source: `${file.name} ${n + 2}행`,
    });
  });
  // 같은 ID 가 겹치면 뒤에 번호를 붙인다 (TestRail 내보내기는 ID 열이 없는 경우가 많음)
  const seen = new Map();
  for (const tc of testCases) {
    const k = seen.get(tc.id) || 0;
    seen.set(tc.id, k + 1);
    if (k) tc.id = `${tc.id}-${k + 1}`;
  }
  return {
    documentTitle: file.name.replace(/\.(csv|tsv)$/i, ''),
    features: [...new Set(testCases.map((t) => t.feature))],
    testCases,
    openQuestions: [],
    imported: true,
  };
}

// AI 키가 없을 때의 규칙 기반 매칭: TC 의 [버튼명] · "문구" · 제목 속 이름이 화면 요소 이름이나 화면 문구와 같으면 짝짓는다.
// 화면 언어가 TC 와 다르면(영문 화면 · 한글 TC) 거의 짝지어지지 않으므로 결과에 그 이유를 남긴다
// 웹 화면만으로는 만들 수 없는 조건 (앱 · 어드민 · 서버 점검 · OS 기능) → 이름이 같아도 수동 확인
const HARD_CONDITION = /(\bapp\b|\baos\b|\bios\b|디바이스|어드민|admin|점검|캡처|푸시|os 권한|권한창|설정 화면|플레이 스토어|앱 스토어)/i;
// 계정 · 데이터 상태가 필요한 조건 (잔액 · 내역 · 위치 · 선호 설정 등) → 짝지어지지 않으면 '조건 필요'
const NEEDS_CONDITION = /(잔액|보유|거래\s*내역\s*(있|없)|위치\s*(허용|거부|미결정)|선호\s*(통화|코인|토큰)|프로모션|바우처\s*0|로그아웃|다른 계정|비로그인)/i;
const norm = (t) => String(t || '').toLowerCase().replace(/[\s·･,.:!?'"“”‘’()[\]{}<>]/g, '');

// 사이트와 무관한 일반 UI 용어 (한 · 영 · 일). TC 는 한국어, 화면은 다른 언어일 때 이름을 이어 준다
const UI_TERMS = [
  ['뒤로가기', '뒤로', 'back', '戻る'],
  ['알림', 'notification', 'notifications', '通知'],
  ['더보기', 'more', 'see more', 'view more', 'もっと見る'],
  ['전체보기', 'view all', 'see all', 'すべて見る'],
  ['로그인', 'log in', 'login', 'sign in', 'ログイン'],
  ['로그아웃', 'log out', 'logout', 'sign out', 'ログアウト'],
  ['회원가입', 'sign up', 'register', '新規登録'],
  ['검색', 'search', '検索'],
  ['확인', 'ok', 'confirm', '確認'],
  ['닫기', 'close', '閉じる'],
  ['취소', 'cancel', 'キャンセル'],
  ['내역보기', '내역', 'history', 'view history', '履歴'],
  ['거래 내역', 'transaction history', '取引履歴'],
  ['채우기', '충전', 'top up', 'charge', 'チャージ'],
  ['필터', 'filter', 'フィルター'],
  ['설정', 'settings', '設定'],
  ['공유', 'share', '共有'],
  ['다음', 'next', '次へ'],
  ['이전', 'previous', 'prev', '前へ'],
  ['홈', 'home', 'ホーム'],
  ['메뉴', 'menu', 'メニュー'],
  ['다시 시도', 'retry', 'try again', '再試行'],
  ['스캔', 'scan', 'スキャン'],
  ['결제', 'pay', 'payment', '決済', '支払い'],
  ['위치 허용', 'allow location', '位置情報を許可'],
  ['현재 위치', 'current location', '現在地'],
].map((g) => g.map(norm));
/** 문구에 들어 있는 UI 용어 묶음 번호들 */
const termsIn = (text) => {
  const n = norm(text);
  return UI_TERMS.map((g, i) => (g.some((w) => w.length >= 2 && n.includes(w)) ? i : -1)).filter((i) => i >= 0);
};

function ruleMapTcs(doc, analysis) {
  const features = [...analysis.common.features.map((f) => ({ ...f, page: analysis.pages[0].id })), ...analysis.pages.flatMap((p) => p.features.map((f) => ({ ...f, page: p.id })))];
  // 이름 없는 아이콘의 '위치 이름'은 화면 문구가 아니므로 이름 비교에서 뺀다
  const named = features
    .map((f) => ({ f, names: (f.locator && f.locator.unnamed ? [] : [f.label, ...(f.lines || [])]).map(norm).filter((n) => n.length >= 2) }))
    .filter((x) => x.names.length || (x.f.locator && x.f.locator.unnamed));
  const headerLeft = [...analysis.common.features].filter((f) => f.pos && f.pos.y < 150 && f.locator && f.locator.unnamed).sort((x, y) => x.pos.x - y.pos.x)[0] || null;
  const pageTexts = analysis.pages.flatMap((p) => [...(p.keyTexts || []), ...(p.texts || []).map((t) => t.text)]).map((t) => ({ raw: t, n: norm(t) }));
  return doc.testCases.map((tc) => {
    if (HARD_CONDITION.test(`${tc.precondition} ${tc.feature} ${tc.title}`)) {
      return { tcId: tc.id, status: 'manual', reason: '웹 화면만으로 만들 수 없는 조건 (앱 · 어드민 · 점검 · OS 기능) — 규칙 기반 판단', steps: [], expectations: [] };
    }
    const hay = norm(`${tc.title} ${tc.steps.join(' ')} ${tc.expected}`);
    const quoted = [...`${tc.title} ${tc.steps.join(' ')} ${tc.expected}`.matchAll(/\[([^\]]{2,30})\]|["“']([^"”']{2,40})["”']/g)].map((m) => norm(m[1] || m[2]));
    // 1) 이름이 그대로 같음 2) 버튼 이름 · TC 제목이 같은 UI 용어(뒤로가기 = Back 등)
    const titleTerms = termsIn(`${tc.title} ${quoted.join(' ')}`);
    const hit =
      named.find((x) => x.names.some((n) => quoted.includes(n) || (n.length >= 3 && hay.includes(n)))) ||
      (titleTerms.length
        ? named.find((x) => {
            const ft = x.f.locator && x.f.locator.unnamed ? [] : termsIn(x.f.label);
            // 이름 없는 아이콘은 위치로 판단: 머리글의 맨 왼쪽 아이콘 = 뒤로가기 (앱형 화면의 공통 배치)
            if (x.f === headerLeft) ft.push(0);
            return ft.some((t) => titleTerms.includes(t));
          })
        : null);
    const shown = /노출|표시|문구|보임|확인/.test(tc.title);
    if (hit) {
      const f = hit.f;
      const act = !shown || /동작|선택|이동|클릭/.test(tc.title);
      const expectations = act && f.url
        ? [{ kind: f.type === 'newTab' ? 'newTab' : 'url', value: f.type === 'newTab' ? new URL(f.url).host : new URL(f.url).pathname }]
        : [{ kind: 'visible', featureId: f.id }];
      return {
        tcId: tc.id,
        status: 'automated',
        reason: `규칙 기반 매칭: 화면 요소 "${f.label}" (AI 키가 있으면 기대결과 기준으로 더 정확히 매칭)`,
        startPage: f.page,
        steps: act && f.url ? [{ featureId: f.id, action: 'click' }] : [],
        expectations,
      };
    }
    const text = pageTexts.find((t) => t.n.length >= 4 && (quoted.includes(t.n) || norm(tc.expected).includes(t.n)));
    if (text) {
      return { tcId: tc.id, status: 'automated', reason: `규칙 기반 매칭: 화면 문구 "${text.raw}"`, startPage: analysis.pages[0].id, steps: [], expectations: [{ kind: 'text', value: text.raw }] };
    }
    if (NEEDS_CONDITION.test(`${tc.precondition} ${tc.feature} ${tc.title}`)) {
      return { tcId: tc.id, status: 'manual', reason: '조건 필요 (앱 · 어드민 · 계정 상태 · 위치 권한 등) — 규칙 기반 판단', steps: [], expectations: [] };
    }
    return { tcId: tc.id, status: 'not_found', reason: '화면 요소 · 문구와 이름이 일치하지 않음 (화면 언어가 TC 와 다르면 AI 매칭 필요)', steps: [], expectations: [] };
  });
}

module.exports = { importTcFile, looksLikeTcFile, parseDelimited, detectColumns, ruleMapTcs };
