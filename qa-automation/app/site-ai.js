// URL AI 분석: 페이지 스크린샷 + 크롤러가 탐지한 화면 요소 → AI 가 기대 동작 기준 TC 작성 + 화면 이슈 보고
const fs = require('fs');
const path = require('path');
const { generateJson } = require('./llm');
const { validateMappings } = require('./doc-testcases');

const SCHEMA = {
  type: 'object',
  properties: {
    pageSummary: { type: 'string', description: '이 화면의 목적 한 줄 요약' },
    testCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          feature: { type: 'string', description: '대상 기능/영역' },
          type: { type: 'string', enum: ['기능', 'UI', '예외', '경계값', '권한', '연동'] },
          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          steps: { type: 'array', items: { type: 'string' }, description: '사람이 읽는 테스트 절차' },
          expected: { type: 'string', description: '사람이 읽는 기대 결과' },
          status: { type: 'string', enum: ['automated', 'manual'], description: 'manual: 로그인·실데이터·외부 조건이 필요해 자동 실행 불가' },
          reason: { type: 'string', description: 'manual 인 이유' },
          plan: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    featureId: { type: 'string' },
                    action: { type: 'string', enum: ['click', 'fill', 'check'] },
                    value: { type: 'string' },
                  },
                  required: ['featureId', 'action'],
                },
              },
              expectations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['url', 'newTab', 'text', 'visible', 'hidden'] },
                    value: { type: 'string' },
                    featureId: { type: 'string' },
                  },
                  required: ['kind'],
                },
              },
            },
            required: ['steps', 'expectations'],
          },
          observedConflict: {
            type: 'string',
            description: '요소 이름이 의미하는 동작과 크롤러가 관찰한 실제 결과가 다르면 그 차이. 같으면 빈 문자열',
          },
        },
        required: ['title', 'feature', 'type', 'priority', 'steps', 'expected', 'status'],
      },
    },
    findings: {
      type: 'array',
      description: '스크린샷에서 보이는 문제',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['문구', '이미지', '레이아웃', '기능', '접근성'] },
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          description: { type: 'string' },
          location: { type: 'string', description: '화면상 위치나 관련 문구' },
        },
        required: ['category', 'severity', 'description'],
      },
    },
  },
  required: ['pageSummary', 'testCases', 'findings'],
};

const PROMPT = `당신은 시니어 QA 엔지니어입니다. 첨부한 스크린샷은 테스트 대상 웹 페이지 전체 화면이고,
아래 [화면 요소 목록]은 크롤러가 이 페이지의 요소를 실제로 클릭해 보고 기록한 결과입니다.

할 일:
1. 이 페이지의 핵심 기능을 검증하는 TC 를 작성하세요 (최대 12개, 중요한 것부터).
   - 기대 결과는 "요소 이름과 화면 맥락상 당연히 그래야 하는 동작" 기준으로 작성하세요.
     예: "로그인" 버튼 → 로그인 화면으로 이동, "더보기" → 추가 내용 노출, 외부 서비스 링크 → 해당 서비스 도메인.
   - 관찰된 결과를 그대로 베끼지 말고, 상식적 기대와 다르면 observedConflict 에 차이를 적으세요.
   - plan 에는 [화면 요소 목록]의 요소ID 만 사용하세요. 목록에 없는 요소는 만들지 마세요.
     url 은 "/경로", newTab 은 도메인, text 는 화면에 나타나야 할 짧은 문구.
   - 로그인·실제 자산·결제가 있어야 확인 가능한 TC 는 status=manual.
2. 스크린샷에서 보이는 문제를 findings 에 적으세요: 오타·어색한 문구·문구 불일치, 깨지거나 잘린 이미지,
   겹치거나 넘치는 레이아웃, 대비가 낮거나 읽기 어려운 텍스트 등. 확실하지 않은 것은 적지 마세요.
모든 내용은 한국어로 작성하세요.`;

function inventoryFor(analysis, page, includeCommon) {
  const fmt = (f) => {
    const target = f.url ? ` → ${f.url}` : f.text ? ` → "${f.text}"` : f.expanded ? ` → aria-expanded=${f.expanded}` : '';
    return `  - ${f.id} [${f.type}] "${f.label}"${target}`;
  };
  const lines = [`페이지: ${page.path}${page.title ? ` - ${page.title}` : ''}`];
  if (includeCommon && analysis.common.features.length) {
    lines.push(`## 공통 헤더/내비/푸터`, ...analysis.common.features.map(fmt));
  }
  lines.push(`## 이 페이지 고유 요소`, ...(page.features.length ? page.features.map(fmt) : ['  (없음)']));
  return lines.join('\n');
}

async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

/**
 * 반환: { doc, mappings, findings }  - doc/mappings 는 기획서 흐름과 같은 형식이라 같은 생성기로 실행된다
 */
async function analyzeSiteWithAi(analysis, generatedDir, llm, log) {
  const pages = await runPool(analysis.pages, 3, async (page, i) => {
    const parts = [];
    const shot = page.screenshot && path.join(generatedDir, page.screenshot);
    if (shot && fs.existsSync(shot)) {
      parts.push({ kind: 'file', mimeType: 'image/jpeg', data: fs.readFileSync(shot).toString('base64'), name: path.basename(shot) });
    }
    parts.push({ kind: 'text', text: `${PROMPT}\n\n[화면 요소 목록]\n${inventoryFor(analysis, page, i === 0)}` });
    try {
      const r = await generateJson({ ...llm, parts, schema: SCHEMA });
      log(`[AI 분석] ${page.path}: TC ${r.testCases.length}건 · 발견 이슈 ${r.findings.length}건`);
      return { page, ...r };
    } catch (e) {
      log(`[AI 분석] ${page.path}: 실패 - ${e.message}`);
      return { page, pageSummary: '', testCases: [], findings: [], error: e.message };
    }
  });

  const testCases = [];
  const rawMappings = [];
  const findings = [];
  for (const r of pages) {
    r.testCases.forEach((tc, n) => {
      const id = `AI-${r.page.id}-${String(n + 1).padStart(2, '0')}`;
      testCases.push({ id, feature: tc.feature, title: tc.title, type: tc.type, priority: tc.priority, precondition: '', steps: tc.steps, expected: tc.expected, source: r.page.path });
      rawMappings.push({
        tcId: id,
        status: tc.status === 'manual' ? 'manual' : 'automated',
        reason: tc.reason || '',
        startPage: r.page.id,
        steps: (tc.plan && tc.plan.steps) || [],
        expectations: (tc.plan && tc.plan.expectations) || [],
        observedConflict: tc.observedConflict || '',
      });
    });
    r.findings.forEach((f) => findings.push({ ...f, page: r.page.path }));
  }

  const doc = {
    documentTitle: `AI 사이트 분석 (${analysis.meta.startUrl})`,
    features: pages.map((r) => `${r.page.path}: ${r.pageSummary}`).filter((s) => !s.endsWith(': ')),
    testCases,
    openQuestions: pages.filter((r) => r.error).map((r) => `${r.page.path} 분석 실패: ${r.error}`),
  };
  return { doc, mappings: validateMappings(doc, analysis, rawMappings), findings };
}

module.exports = { analyzeSiteWithAi };
