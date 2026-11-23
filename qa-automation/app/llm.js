// LLM 공급자 공통 인터페이스: 파일(PDF/이미지) + 텍스트 → JSON 스키마에 맞는 결과
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;

const PROVIDERS = {
  gemini: { label: 'Gemini (Google)', envKey: 'GEMINI_API_KEY', defaultModel: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { label: 'Claude (Anthropic)', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5', keyUrl: 'https://platform.claude.com/settings/keys' },
  openai: { label: 'ChatGPT (OpenAI)', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-5.5', keyUrl: 'https://platform.openai.com/api-keys' },
  // 사내 LLM: 회사 안 서버(Ollama · vLLM · LM Studio · llama.cpp 등 OpenAI 호환)에서 도는 모델. 자료가 외부로 나가지 않는다.
  // 키는 서버가 요구할 때만 (대부분 없음). 서버 주소는 settings.json 의 llmBaseUrls.local
  // 화면의 공급자 카드는 이름을 첫 공백에서 나누므로 '사내 LLM' 은 줄바꿈 없는 공백으로 붙인다
  local: { label: '사내 LLM (Gemma 등 · OpenAI 호환 서버)', envKey: 'LOCAL_LLM_API_KEY', defaultModel: 'gemma3:27b', keyUrl: null, local: true, defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
};

/** Claude/OpenAI 구조화 출력은 모든 object 에 additionalProperties:false 가 필요 */
function closeObjects(schema) {
  if (Array.isArray(schema)) return schema.map(closeObjects);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = closeObjects(v);
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// parts: [{ kind: 'file', mimeType, data(base64), name } | { kind: 'text', text }]

async function gemini({ apiKey, model, parts, schema }) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: parts.map((p) => (p.kind === 'file' ? { inlineData: { mimeType: p.mimeType, data: p.data } } : { text: p.text })),
    config: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.2 },
  });
  return response.text;
}

async function claude({ apiKey, model, parts, schema }) {
  const client = new Anthropic({ apiKey });
  const content = parts.map((p) => {
    if (p.kind === 'text') return { type: 'text', text: p.text };
    if (p.mimeType === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };
    }
    return { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } };
  });
  // 긴 기획서는 응답이 길어질 수 있으므로 스트리밍으로 받아 타임아웃을 피한다.
  // 안전 분류기로 거절되면 서버가 같은 요청을 다른 모델로 자동 재시도(fallbacks)
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: closeObjects(schema) } },
    messages: [{ role: 'user', content }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('Claude가 요청을 거절했습니다. 기획서 내용을 확인해주세요.');
  if (message.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 중간에 잘렸습니다. 기획서를 나눠서 첨부해주세요.');
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function openai({ apiKey, model, parts, schema }) {
  const client = new OpenAI({ apiKey });
  const content = parts.map((p) => {
    if (p.kind === 'text') return { type: 'input_text', text: p.text };
    const dataUrl = `data:${p.mimeType};base64,${p.data}`;
    return p.mimeType === 'application/pdf'
      ? { type: 'input_file', filename: p.name || 'document.pdf', file_data: dataUrl }
      : { type: 'input_image', detail: 'auto', image_url: dataUrl };
  });
  const response = await client.responses.create({
    model,
    input: [{ role: 'user', content }],
    // 선택 필드가 있는 스키마라 strict 모드는 쓰지 않는다 (결과는 아래에서 JSON 검증)
    text: { format: { type: 'json_schema', name: 'result', schema: closeObjects(schema), strict: false } },
  });
  return response.output_text;
}

// ─────────────────────────────────────────────────────────────
// 사내 LLM (OpenAI 호환 chat/completions)
//  - 모델이 PDF 파일을 직접 받지 못하므로 글자 + 페이지 그림으로 바꿔 보낸다 (그림을 읽는 모델이면 시안 · 흐름도까지 본다)
//  - 작은 모델은 형식을 깨기도 하므로: JSON 스키마 강제 → 안 되면 JSON 모드 + 프롬프트 안 스키마, 깨지면 한 번 다시 요청
// ─────────────────────────────────────────────────────────────

/** PDF(base64) → 페이지별 글자 */
async function pdfText(base64) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(base64, 'base64')), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
    pages.push(text ? `[${i}쪽]\n${text}` : '');
  }
  const all = pages.filter(Boolean).join('\n\n');
  // 스캔본 · 이미지 PDF 는 글자가 없다 (페이지 그림으로만 전달)
  return all.replace(/\[\d+쪽\]/g, '').trim().length < 20 ? '' : all;
}

// 사내 LLM 에 그림으로 보내는 PDF 페이지 수 (화면 시안 · 흐름도 · 표). 그 뒤 페이지는 글자만
const PDF_IMAGE_PAGES = 12;

/** PDF → 사내 LLM 에 보낼 내용: 글자 + 앞쪽 페이지 그림 */
async function pdfContent(p) {
  const { renderPdfPages } = require('./pdf-pages');
  const [text, shots] = await Promise.all([pdfText(p.data).catch(() => ''), renderPdfPages(p.data, { maxPages: PDF_IMAGE_PAGES }).catch(() => ({ pages: [], total: 0 }))]);
  if (!text && !shots.pages.length) throw new Error(`기획서 PDF(${p.name || 'document.pdf'})를 읽지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.`);
  const note = shots.total > shots.pages.length ? ` (그림은 앞 ${shots.pages.length}쪽만, 전체 ${shots.total}쪽)` : '';
  return [
    { type: 'text', text: `기획서 (${p.name || 'document.pdf'})${note}\n아래는 페이지 그림과, 그림에서 뽑은 글자입니다. 화면 시안 · 흐름도 · 표는 그림을 보고 판단하세요.\n\n${text || '(글자가 없는 PDF — 그림만 있음)'}` },
    ...shots.pages.flatMap((pg) => [
      { type: 'text', text: `[${pg.page}쪽 그림]` },
      { type: 'image_url', image_url: { url: `data:${pg.mimeType};base64,${pg.data}` } },
    ]),
  ];
}

/** 응답에서 JSON 부분만 꺼낸다 (```json 코드 블록 · 앞뒤 설명 제거) */
function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

async function local({ apiKey, model, parts, schema, baseUrl }) {
  // 사내 서버는 큰 문서에서 느릴 수 있어 넉넉히 기다린다
  const client = new OpenAI({ apiKey: apiKey || 'local', baseURL: baseUrl, timeout: 15 * 60 * 1000, maxRetries: 1 });
  const content = [];
  for (const p of parts) {
    if (p.kind === 'text') content.push({ type: 'text', text: p.text });
    else if (p.mimeType === 'application/pdf') content.push(...(await pdfContent(p)));
    else content.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
  }
  const rule = `\n\n[출력 형식] 설명 없이 아래 JSON 스키마에 맞는 JSON 하나만 출력하세요. 문자열 값은 한국어로 쓰세요.\n${JSON.stringify(schema)}`;
  const messages = [{ role: 'user', content: [...content, { type: 'text', text: rule }] }];
  const ask = async (format) => (await client.chat.completions.create({ model, messages, temperature: 0.2, response_format: format })).choices[0].message.content;
  let text;
  try {
    text = await ask({ type: 'json_schema', json_schema: { name: 'result', schema, strict: false } });
  } catch (e) {
    // 스키마 강제를 지원하지 않는 서버 · 모델 → JSON 모드로 다시
    if (!(e && e.status >= 400 && e.status < 500)) throw e;
    text = await ask({ type: 'json_object' });
  }
  try {
    JSON.parse(extractJson(text));
    return extractJson(text);
  } catch {
    // 형식이 깨졌으면 한 번 더 요청
    messages.push({ role: 'assistant', content: String(text).slice(0, 4000) }, { role: 'user', content: '방금 응답은 올바른 JSON 이 아니었습니다. 설명 없이 스키마에 맞는 JSON 하나만 다시 출력하세요.' });
    return extractJson(await ask({ type: 'json_object' }));
  }
}

const CALLERS = { gemini, claude, openai, local };

/** 이 공급자를 지금 쓸 수 있는지 (외부: API Key · 사내: 서버 주소) */
const isReady = ({ provider, apiKey, baseUrl }) => {
  const info = PROVIDERS[provider];
  return !!info && (info.local ? !!baseUrl : !!apiKey);
};

async function generateJson({ provider, apiKey, model, parts, schema, baseUrl }) {
  const info = PROVIDERS[provider];
  if (!info) throw new Error(`알 수 없는 AI 공급자: ${provider}`);
  if (!isReady({ provider, apiKey, baseUrl })) {
    throw new Error(info.local ? `${info.label} 서버 주소가 없습니다. 상단 'AI 설정'에서 입력해주세요.` : `${info.label} API Key가 없습니다. 상단 'AI 설정'에서 입력해주세요.`);
  }
  let text;
  try {
    text = await CALLERS[provider]({ apiKey, model: model || info.defaultModel, parts, schema, baseUrl });
  } catch (e) {
    if (info.local && /ECONNREFUSED|ENOTFOUND|fetch failed|Connection error/i.test(`${e.message} ${e.cause && e.cause.code}`)) {
      throw new Error(`사내 LLM 서버(${baseUrl})에 연결할 수 없습니다. 서버가 켜져 있는지, 주소가 맞는지 확인해주세요.`);
    }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${info.label} 응답을 JSON으로 해석하지 못했습니다.${info.local ? ' 더 큰 모델을 쓰거나 서버의 최대 길이(context) 설정을 늘려 보세요.' : ''}`);
  }
}

/** 사내 LLM 연결 확인: 서버가 응답하는지 · 그 모델이 있는지 */
async function checkLocal({ baseUrl, apiKey, model }) {
  const client = new OpenAI({ apiKey: apiKey || 'local', baseURL: baseUrl, timeout: 10 * 1000, maxRetries: 0 });
  try {
    const list = await client.models.list();
    const ids = list.data.map((m) => m.id);
    const want = model || PROVIDERS.local.defaultModel;
    return { ok: ids.includes(want), models: ids, message: ids.includes(want) ? `연결됨 · 모델 ${want} 있음` : `연결됨 · 모델 ${want} 이(가) 서버에 없습니다 (있는 모델: ${ids.slice(0, 8).join(', ') || '없음'})` };
  } catch (e) {
    return { ok: false, models: [], message: `연결 실패: ${e.message}` };
  }
}

module.exports = { PROVIDERS, generateJson, isReady, checkLocal, extractJson, pdfText };
