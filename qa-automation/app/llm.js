// LLM 공급자 공통 인터페이스: 파일(PDF/이미지) + 텍스트 → JSON 스키마에 맞는 결과
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;

const PROVIDERS = {
  gemini: { label: 'Gemini (Google)', envKey: 'GEMINI_API_KEY', defaultModel: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey' },
  claude: { label: 'Claude (Anthropic)', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5', keyUrl: 'https://platform.claude.com/settings/keys' },
  openai: { label: 'ChatGPT (OpenAI)', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-5.5', keyUrl: 'https://platform.openai.com/api-keys' },
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

const CALLERS = { gemini, claude, openai };

async function generateJson({ provider, apiKey, model, parts, schema }) {
  const info = PROVIDERS[provider];
  if (!info) throw new Error(`알 수 없는 AI 공급자: ${provider}`);
  if (!apiKey) throw new Error(`${info.label} API Key가 없습니다. 상단 'AI 설정'에서 입력해주세요.`);
  const text = await CALLERS[provider]({ apiKey, model: model || info.defaultModel, parts, schema });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${info.label} 응답을 JSON으로 해석하지 못했습니다.`);
  }
}

module.exports = { PROVIDERS, generateJson };
