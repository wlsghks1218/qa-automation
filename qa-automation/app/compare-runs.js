// 이전 실행 대비 변경 감지: 같은 URL 의 직전 실행 analysis.json 과 비교한다.
// 회귀 확인용으로 "페이지 추가/사라짐 · 요소 추가/사라짐 · 동작 변경 · 문구 추가/사라짐"을 정리한다.
const fs = require('fs');
const path = require('path');

/** 결과 폴더에서 같은 시작 URL · 범위로 분석한 가장 최근 실행 (현재 실행 제외) */
function findPreviousRun(resultsDir, currentId, startUrl, scope) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(resultsDir).filter((d) => d !== currentId).sort().reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(resultsDir, d, 'analysis.json');
    if (!fs.existsSync(file)) continue;
    try {
      const a = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (a.meta && a.meta.startUrl === startUrl && a.meta.scope === scope) return { id: d, analysis: a };
    } catch {
      // 깨진 결과 폴더는 건너뜀
    }
  }
  return null;
}

// 숫자(건수 · 날짜)만 다른 문구는 같은 문구로 본다
const shape = (t) => String(t || '').replace(/\d+(?:[.,:]\d+)*/g, '#');
const featureKey = (f) => `${f.kind}|${shape((f.lines && f.lines.length ? f.lines.join(' ') : f.label) || '')}`;
const actionOf = (f) => {
  if (f.type === 'navigate' || f.type === 'newTab') {
    try {
      const u = new URL(f.url);
      return `${f.type}:${u.host}${u.pathname}`;
    } catch {
      return f.type;
    }
  }
  return f.type;
};
const ACTION_LABEL = {
  navigate: '페이지 이동', newTab: '새 탭', modal: '모달', toggle: '펼침/접힘', tab: '탭 전환', reveal: '콘텐츠 노출', input: '입력',
  check: '선택', none: '변화 없음', brokenLink: '깨진 링크', select: '선택 박스', anchor: '목차 이동', search: '검색', dropdown: '드롭다운',
  sort: '표 정렬', download: '다운로드', paginate: '페이지 이동(목록)', display: '노출만 확인',
};
const describeAction = (a) => {
  const [type, ...rest] = a.split(':');
  return `${ACTION_LABEL[type] || type}${rest.length ? ` → ${rest.join(':')}` : ''}`;
};

/** 페이지 하나의 요소 목록 (시작 페이지는 공통 헤더 · 메뉴 · 푸터 포함) */
function featuresOf(analysis, page, i) {
  return [...(i === 0 ? analysis.common.features : []), ...page.features];
}

/**
 * prev, cur: analysis.json
 * 반환: { prevId, summary: {...}, pages: [{ path, status: added|removed|changed, items: [{ type, text }] }] }
 */
function compareAnalysis(prev, cur) {
  const prevPages = new Map(prev.pages.map((p, i) => [p.path, { p, i }]));
  const curPages = new Map(cur.pages.map((p, i) => [p.path, { p, i }]));
  const pages = [];
  for (const [p] of curPages) if (!prevPages.has(p)) pages.push({ path: p, status: 'added', items: [{ type: '페이지', text: '새로 생긴 페이지' }] });
  for (const [p] of prevPages) if (!curPages.has(p)) pages.push({ path: p, status: 'removed', items: [{ type: '페이지', text: '사라진 페이지 (링크가 없어졌거나 접근 불가)' }] });

  for (const [p, { p: cp, i: ci }] of curPages) {
    const old = prevPages.get(p);
    if (!old) continue;
    const items = [];
    const before = new Map(featuresOf(prev, old.p, old.i).map((f) => [featureKey(f), f]));
    const after = new Map(featuresOf(cur, cp, ci).map((f) => [featureKey(f), f]));
    for (const [k, f] of after) {
      const b = before.get(k);
      const name = `${f.kind} "${k.split('|')[1]}"`;
      if (!b) items.push({ type: '요소 추가', text: name });
      else if (actionOf(b) !== actionOf(f) && b.type !== 'display' && f.type !== 'display') items.push({ type: '동작 변경', text: `${name}: ${describeAction(actionOf(b))} → ${describeAction(actionOf(f))}` });
    }
    for (const [k, f] of before) if (!after.has(k)) items.push({ type: '요소 사라짐', text: `${f.kind} "${k.split('|')[1]}"` });

    const tb = new Set((old.p.texts || []).map((t) => shape(t.text)));
    const ta = new Set((cp.texts || []).map((t) => shape(t.text)));
    for (const t of cp.texts || []) if (!tb.has(shape(t.text))) items.push({ type: '문구 추가', text: t.text });
    for (const t of old.p.texts || []) if (!ta.has(shape(t.text))) items.push({ type: '문구 사라짐', text: t.text });
    if (items.length) pages.push({ path: p, status: 'changed', items: items.slice(0, 60) });
  }

  const count = (type) => pages.reduce((n, p) => n + p.items.filter((i) => i.type === type).length, 0);
  return {
    summary: {
      pagesAdded: pages.filter((p) => p.status === 'added').length,
      pagesRemoved: pages.filter((p) => p.status === 'removed').length,
      elementsAdded: count('요소 추가'),
      elementsRemoved: count('요소 사라짐'),
      actionsChanged: count('동작 변경'),
      textsAdded: count('문구 추가'),
      textsRemoved: count('문구 사라짐'),
    },
    pages,
  };
}

module.exports = { findPreviousRun, compareAnalysis };
