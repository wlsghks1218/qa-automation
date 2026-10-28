// LLM 없이 하는 규칙 기반 오타 의심 검사
// 확정 판정이 아니라 "의심" 경고만 만든다 (테스트를 실패시키지 않음).
//  1) 표기 형식: 같은 단어 연속 반복, 문장부호 중복, 부호 앞 공백, 괄호 짝 불일치, 낱자모 섞임
//  2) 사이트 내 표기 일관성: 자주 쓰인 단어와 자모 1개만 다른 드문 단어 (예: 결제 30회 vs 결재 1회)

const HANGUL_BASE = 0xac00;
const isSyllable = (ch) => ch >= '가' && ch <= '힣';

/** 한글 음절 → [초성, 중성, 종성] 인덱스 */
function jamo(ch) {
  const c = ch.charCodeAt(0) - HANGUL_BASE;
  return [Math.floor(c / 588), Math.floor((c % 588) / 28), c % 28];
}

// 한국어 맞춤법에서 실제로 자주 헷갈리는 자모 쌍만 오타 후보로 본다
// (아무 모음이나 다른 경우는 '지급/지갑'처럼 서로 다른 정상 단어일 가능성이 높다)
const CONFUSABLE = [
  // 초성: 예사소리/된소리 (ㄱㄲ ㄷㄸ ㅂㅃ ㅅㅆ ㅈㅉ)
  [[0, 1], [3, 4], [7, 8], [9, 10], [12, 13]],
  // 중성: ㅐㅔ ㅒㅖ ㅙㅚㅞ ㅢㅣ
  [[1, 5], [3, 7], [10, 11, 15], [19, 20]],
  // 종성: ㄷㅅㅆㅈㅊㅌㅎ(받침 ㄷ 소리) ㄱㄲㅋ ㅂㅍ
  [[7, 19, 20, 22, 23, 25, 27], [1, 2, 24], [17, 26]],
];
const confusable = (part, x, y) => CONFUSABLE[part].some((set) => set.includes(x) && set.includes(y));

/**
 * 같은 길이 두 단어의 차이.
 * 한글: 헷갈리는 자모 1개만 다르면 1, 그 외 차이는 Infinity. 영문: 글자 단위.
 */
function distance(a, b) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (isSyllable(a[i]) && isSyllable(b[i])) {
      const [x, y] = [jamo(a[i]), jamo(b[i])];
      const diff = [0, 1, 2].filter((k) => x[k] !== y[k]);
      if (diff.length !== 1 || !confusable(diff[0], x[diff[0]], y[diff[0]])) return Infinity;
      d += 1;
    } else if (isSyllable(a[i]) || isSyllable(b[i])) {
      return Infinity;
    } else {
      d += 1;
    }
    if (d > 1) return d;
  }
  return d;
}

const FORMAT_RULES = [
  { re: /(^|[\s(])([가-힣A-Za-z]{2,})\s+\2(?=$|[\s.,!?)])/, reason: (m) => `같은 단어 반복: "${m[2]} ${m[2]}"` },
  { re: /(?<!\.)\.\.(?!\.)|,,|;;/, reason: (m) => `문장부호 중복: "${m[0]}"` },
  { re: /[가-힣A-Za-z]\s+[,.](?=\s|$)/, reason: (m) => `문장부호 앞 공백: "${m[0]}"` },
  { re: /[가-힣][ㄱ-ㅎㅏ-ㅣ]|[ㄱ-ㅎㅏ-ㅣ][가-힣]/, reason: (m) => `완성되지 않은 글자(낱자모): "${m[0]}"` },
];

const PAIRS = [['(', ')'], ['[', ']'], ['{', '}'], ['「', '」'], ['『', '』'], ['“', '”']];

function formatIssues(text) {
  const out = [];
  for (const { re, reason } of FORMAT_RULES) {
    const m = text.match(re);
    if (m) out.push(reason(m));
  }
  for (const [open, close] of PAIRS) {
    const o = text.split(open).length - 1;
    const c = text.split(close).length - 1;
    if (o !== c) out.push(`괄호 짝 불일치: "${open}" ${o}개 / "${close}" ${c}개`);
  }
  return out;
}

// 영어는 짧은 단어끼리 한 글자 차이인 정상 단어가 많아(Home/Some, content/consent) 8글자 이상만 비교
const tokensOf = (text) => text.match(/[가-힣]{2,}|[A-Za-z]{8,}/g) || [];

// 코드 예시처럼 보이는 문구는 맞춤법 검사 대상이 아니다 (괄호 짝·기호가 정상적으로 안 맞음)
const looksLikeCode = (t) =>
  /[{};=<>`$]|=>|\w\(|\)\s*;|[a-z][A-Z][a-z]/.test(t) ||
  /^[^가-힣A-Za-z]*$/.test(t) ||
  // 공백·한글 없이 괄호가 붙은 한 덩어리 (코드 조각: addresses[, (msg)
  /^[^\s가-힣]*[()[\]{}][^\s가-힣]*$/.test(t);

// 조사만 다른 경우(응답이/응답의, 건이/건의)는 오타가 아니다
const PARTICLES = new Set('이의가를을은는에도로와과만'.split(''));

// 사이트 안 빈도와 관계없이 거의 항상 틀린 표기
const MISSPELLINGS = [
  ['되요', '돼요'], ['됬', '됐'], ['몇일', '며칠'], ['할께', '할게'], ['갈께', '갈게'], ['볼께', '볼게'],
  ['오랫만', '오랜만'], ['역활', '역할'], ['희안', '희한'], ['어떻해', '어떡해/어떻게'], ['왠만', '웬만'],
  ['일일히', '일일이'], ['깨끗히', '깨끗이'], ['설겆이', '설거지'], ['뵈요', '봬요'], ['어의없', '어이없'],
  ['문안하', '무난하'], ['내노라', '내로라'], ['않되', '안 되'], ['안되요', '안 돼요'],
];

/**
 * texts: 사이트 전체에서 수집한 문구 목록
 * 반환: Map<문구, string[]> - 오타 의심 사유 (의심 없는 문구는 없음)
 */
function findTypos(texts) {
  const unique = [...new Set(texts)].filter((t) => !looksLikeCode(t));
  const freq = new Map();
  for (const t of unique) for (const w of tokensOf(t)) freq.set(w, (freq.get(w) || 0) + 1);

  // 사이트에서 3번 이상 쓰인 단어를 "기준 표기"로 본다
  const frequent = [...freq.entries()].filter(([, n]) => n >= 3).map(([w]) => w);
  const suspectOf = new Map();
  for (const [word, n] of freq) {
    if (n > 1 || suspectOf.has(word)) continue;
    for (const f of frequent) {
      const latin = /^[A-Za-z]/.test(f);
      if (word.length < f.length || /^[A-Za-z]/.test(word) !== latin) continue;
      // 한글은 조사가 붙으므로 앞부분(어간)끼리, 영어는 단어 전체끼리 비교
      if (latin && word.length !== f.length) continue;
      // 한글 두 글자 단어는 한 자모 차이의 정상 단어가 많다 (메일/매일, 가지/까지) → 세 글자 이상만 비교
      if (!latin && f.length < 3) continue;
      const head = word.slice(0, f.length);
      // 마지막 글자가 조사끼리만 다르면 정상 (응답이/응답의)
      if (!latin && head.slice(0, -1) === f.slice(0, -1) && PARTICLES.has(head.slice(-1)) && PARTICLES.has(f.slice(-1))) continue;
      // 한 글자짜리 차이로 다른 흔한 단어가 되는 경우는 정상 단어일 가능성이 높다
      if (head === f || (freq.get(head) || 0) > 1) continue;
      const cmp = /^[A-Za-z]/.test(f) ? head.toLowerCase() : head;
      const base = /^[A-Za-z]/.test(f) ? f.toLowerCase() : f;
      if (cmp !== base && distance(cmp, base) === 1) {
        suspectOf.set(word, `사이트 내 표기 불일치: "${head}" (1회) ↔ "${f}" (${freq.get(f)}회)`);
        break;
      }
    }
  }

  const result = new Map();
  for (const t of unique) {
    const reasons = formatIssues(t);
    for (const w of tokensOf(t)) if (suspectOf.has(w)) reasons.push(suspectOf.get(w));
    for (const [wrong, right] of MISSPELLINGS) if (t.includes(wrong)) reasons.push(`자주 틀리는 표기: "${wrong}" → "${right}"`);
    if (reasons.length) result.set(t, [...new Set(reasons)]);
  }
  return result;
}

module.exports = { findTypos };
