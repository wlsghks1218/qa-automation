const { generateJson } = require('./llm');

// 기획서(PDF/이미지/텍스트) → 기능 단위 테스트 케이스 생성 (선택한 AI 공급자)

const INLINE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv'];

const SCHEMA = {
  type: 'object',
  properties: {
    documentTitle: { type: 'string', description: '기획서 제목 또는 대상 서비스/화면 이름' },
    features: {
      type: 'array',
      description: '기획서에서 확인된 기능/화면 목록',
      items: { type: 'string' },
    },
    testCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'TC-001 형식' },
          feature: { type: 'string', description: '대상 기능 또는 화면' },
          title: { type: 'string' },
          type: { type: 'string', enum: ['기능', 'UI', '예외', '경계값', '권한', '연동'] },
          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          precondition: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'string' },
          source: { type: 'string', description: '근거가 된 기획서 위치(페이지/섹션)' },
        },
        required: ['id', 'feature', 'title', 'type', 'priority', 'steps', 'expected'],
      },
    },
    openQuestions: {
      type: 'array',
      description: '기획서에 명시되지 않아 확인이 필요한 사항',
      items: { type: 'string' },
    },
  },
  required: ['documentTitle', 'features', 'testCases'],
};

const PROMPT = `당신은 시니어 QA 엔지니어입니다. 첨부된 기획서를 분석해 테스트 케이스를 작성하세요.

규칙:
- 기획서에 근거가 있는 동작만 TC로 작성하고, 각 TC의 source 에 근거 위치(페이지/섹션)를 적으세요.
- 기획서에 없는 동작을 추측해서 만들지 마세요. 모호하거나 누락된 정책은 openQuestions 에 적으세요.
- 기능별로 정상 흐름(기능/UI) TC를 먼저 작성하고, 명시된 제약이 있으면 예외·경계값·권한 TC를 추가하세요.
- steps 는 사용자가 화면에서 수행하는 동작 단위로, expected 는 관찰 가능한 결과로 작성하세요.
- 모든 내용은 한국어로 작성하세요.`;

function toParts(file) {
  const type = (file.type || '').toLowerCase();
  if (INLINE_TYPES.includes(type)) {
    return [{ kind: 'file', mimeType: type, data: file.data, name: file.name }];
  }
  if (TEXT_TYPES.includes(type) || /\.(txt|md|csv)$/i.test(file.name)) {
    return [{ kind: 'text', text: `기획서 (${file.name}):\n\n${Buffer.from(file.data, 'base64').toString('utf-8')}` }];
  }
  throw new Error(`지원하지 않는 파일 형식입니다: ${file.name} (PDF, PNG, JPG, WEBP, TXT, MD 지원)`);
}

/** llm: { provider, apiKey, model } */
async function generateDocTestCases(file, { url, llm }) {
  const context = url ? `\n\n테스트 대상 URL: ${url}` : '';
  const parsed = await generateJson({ ...llm, parts: [...toParts(file), { kind: 'text', text: PROMPT + context }], schema: SCHEMA });
  parsed.testCases = parsed.testCases || [];
  parsed.openQuestions = parsed.openQuestions || [];
  return parsed;
}

// ─────────────────────────────────────────────────────────────
// 기획서 TC ↔ 크롤러가 탐지한 실제 화면 요소 매핑
// ─────────────────────────────────────────────────────────────

const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tcId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['automated', 'not_found', 'manual'],
            description: 'automated: 화면 요소로 자동 실행 가능 / not_found: 대응하는 화면 요소 없음 / manual: 로그인·실데이터·외부 조건 필요',
          },
          reason: { type: 'string', description: 'not_found / manual 인 이유, automated 면 매핑 근거' },
          startPage: { type: 'string', description: '테스트를 시작할 페이지 ID (예: P03)' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                featureId: { type: 'string', description: '화면 요소 ID (예: P03-F02)' },
                action: { type: 'string', enum: ['click', 'fill', 'check'] },
                value: { type: 'string', description: 'fill 일 때 입력값' },
              },
              required: ['featureId', 'action'],
            },
          },
          expectations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['url', 'newTab', 'text', 'visible', 'hidden'],
                  description: 'url: 이동해야 하는 경로 / newTab: 새 탭으로 열려야 하는 도메인 / text: 보여야 하는 문구 / visible·hidden: featureId 요소의 노출 여부',
                },
                value: { type: 'string' },
                featureId: { type: 'string' },
              },
              required: ['kind'],
            },
          },
          observedConflict: {
            type: 'string',
            description: '크롤러가 관찰한 실제 동작이 기획서 기대 결과와 다르면 그 차이를 설명. 같으면 빈 문자열',
          },
        },
        required: ['tcId', 'status', 'reason'],
      },
    },
  },
  required: ['mappings'],
};

const MAPPING_PROMPT = `당신은 QA 자동화 엔지니어입니다. 아래 [기획서 TC]를 [화면 요소 목록]과 매핑해 자동 실행 계획을 만드세요.

[화면 요소 목록]은 크롤러가 실제 사이트를 열어 요소를 직접 클릭해 보고 기록한 것입니다.
형식: 요소ID [관찰된 동작] "요소 이름" → 관찰된 결과
관찰된 동작: navigate=페이지 이동, newTab=새 탭, modal=모달/시트 노출, reveal=콘텐츠 노출, toggle=펼침, tab=탭 전환, input=입력창, check=선택 컨트롤, none=변화 없음

규칙:
- 모든 TC에 대해 정확히 하나의 매핑을 반환하세요.
- expectations 는 반드시 "기획서의 기대 결과" 기준으로 작성하세요. 관찰된 결과로 바꿔 쓰지 마세요.
  관찰된 결과가 기획서와 다르면 observedConflict 에 차이를 적으세요 (테스트는 기획서 기준으로 실패하게 됩니다).
- url 값은 "/경로" 형식, newTab 값은 도메인, text 값은 화면에 실제로 나타날 짧은 문구(기획서 표현 그대로)로 작성하세요.
- 요소 이름이 기획서 표현과 조금 달라도 같은 기능이면 매핑하세요. 대응 요소가 전혀 없으면 status=not_found.
- 로그인 상태, 실제 자산/결제, 외부 시스템 연동이 있어야 검증 가능한 TC는 status=manual.
- P00 요소(공통 헤더/내비/푸터)는 모든 페이지에 있습니다. startPage 는 첫 동작 요소가 있는 페이지 ID 입니다.
- 목록에 없는 요소ID를 만들어내지 마세요.`;

function inventoryText(analysis) {
  const fmt = (f) => {
    const target = f.url ? ` → ${f.url}` : f.text ? ` → "${f.text}"` : f.expanded ? ` → aria-expanded=${f.expanded}` : '';
    return `  - ${f.id} [${f.type}] "${f.label}"${target}`;
  };
  const lines = [`## P00 공통 레이아웃 (${analysis.common.url})`, ...analysis.common.features.map(fmt)];
  for (const p of analysis.pages) {
    lines.push(``, `## ${p.id} ${p.path}${p.title ? ` - ${p.title}` : ''}`);
    if (p.keyTexts.length) lines.push(`  핵심 문구: ${p.keyTexts.map((t) => `"${t}"`).join(', ')}`);
    lines.push(...p.features.map(fmt));
  }
  return lines.join('\n');
}

async function mapDocToFeatures(doc, analysis, llm) {
  const tcText = doc.testCases
    .map((tc) => `- ${tc.id} [${tc.feature}] ${tc.title}\n  절차: ${tc.steps.join(' → ')}\n  기대 결과: ${tc.expected}`)
    .join('\n');
  const prompt = `${MAPPING_PROMPT}\n\n[기획서 TC]\n${tcText}\n\n[화면 요소 목록]\n${inventoryText(analysis)}`;
  const result = await generateJson({ ...llm, parts: [{ kind: 'text', text: prompt }], schema: MAPPING_SCHEMA });
  return validateMappings(doc, analysis, result.mappings || []);
}

/** LLM 결과 검증: 없는 요소 ID, 누락된 TC, 실행 불가능한 계획은 자동화 대상에서 제외 */
function validateMappings(doc, analysis, mappings) {
  const featureIds = new Set([...analysis.common.features, ...analysis.pages.flatMap((p) => p.features)].map((f) => f.id));
  const pageIds = new Set(analysis.pages.map((p) => p.id));
  const byId = new Map(mappings.map((m) => [m.tcId, m]));

  return doc.testCases.map((tc) => {
    const m = byId.get(tc.id);
    if (!m) return { tcId: tc.id, status: 'not_found', reason: '매핑 결과 없음', steps: [], expectations: [] };
    const steps = m.steps || [];
    const expectations = m.expectations || [];
    if (m.status !== 'automated') return { ...m, steps: [], expectations: [] };

    const badIds = [...steps.map((s) => s.featureId), ...expectations.map((e) => e.featureId).filter(Boolean)].filter((id) => !featureIds.has(id));
    if (badIds.length) return { ...m, status: 'not_found', reason: `존재하지 않는 요소 ID: ${badIds.join(', ')}`, steps: [], expectations: [] };

    const usable = expectations.filter((e) => (['visible', 'hidden'].includes(e.kind) ? !!e.featureId : !!(e.value || '').trim()));
    if (!usable.length) return { ...m, status: 'manual', reason: '자동 검증 가능한 기대 결과가 없음', steps: [], expectations: [] };

    return { ...m, startPage: pageIds.has(m.startPage) ? m.startPage : analysis.pages[0].id, steps, expectations: usable };
  });
}

function toCsv(doc) {
  const header = ['ID', '기능', '제목', '유형', '우선순위', '사전조건', '테스트 절차', '기대 결과', '근거'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = doc.testCases.map((tc) =>
    [tc.id, tc.feature, tc.title, tc.type, tc.priority, tc.precondition, tc.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), tc.expected, tc.source]
      .map(esc)
      .join(',')
  );
  // 엑셀에서 한글이 깨지지 않도록 BOM 포함
  return '﻿' + [header.map(esc).join(','), ...rows].join('\r\n');
}

module.exports = { generateDocTestCases, mapDocToFeatures, validateMappings, toCsv };
