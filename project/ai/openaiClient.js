const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const DEFAULT_LLM_MODEL = process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini';
const DUMMY_EMBEDDING_SIZE = 32;

function hasOpenAiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  return Boolean(apiKey && apiKey !== 'your_openai_api_key_here');
}

function shouldUseDummyMode() {
  const mode = String(process.env.AI_RAG_DUMMY_MODE || 'auto').toLowerCase();
  if (mode === 'true' || mode === '1' || mode === 'on') return true;
  if (mode === 'false' || mode === '0' || mode === 'off') return false;

  return process.env.NODE_ENV !== 'production' && !hasOpenAiKey();
}

function canFallbackAfterOpenAiError() {
  const mode = String(process.env.AI_RAG_DUMMY_MODE || 'auto').toLowerCase();
  if (mode === 'false' || mode === '0' || mode === 'off') return false;

  return process.env.NODE_ENV !== 'production';
}

function warnDummyFallback(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[Relief Korea RAG] OpenAI ${stage} failed. Using dummy fallback.`, message);
}

function requireOpenAiKey() {
  if (!hasOpenAiKey()) {
    throw new Error('OPENAI_API_KEY is required to run the RAG pipeline.');
  }

  return process.env.OPENAI_API_KEY;
}

function dummyEmbedding(value) {
  const vector = Array(DUMMY_EMBEDDING_SIZE).fill(0);
  const source = String(value ?? '').slice(0, 8000);

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    vector[(code + index) % DUMMY_EMBEDDING_SIZE] += (code % 17) + 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (magnitude === 0) return vector;

  return vector.map(item => item / magnitude);
}

function promptValue(prompt, label, fallback = '') {
  const match = prompt.match(new RegExp(`${label}:\\s*([^\\n]+)`));
  return String(match?.[1] ?? fallback).trim();
}

function dummyJson(messages) {
  const prompt = messages.map(message => String(message?.content ?? '')).join('\n');
  const region = promptValue(prompt, '지역', '분석 대상 지역');
  const disasterType = promptValue(prompt, '재난 유형', '재난');
  const orgName = promptValue(prompt, '분석 대상 단체', '구호 단체');
  const donationLink = promptValue(prompt, '후원 링크');
  const volunteerLink = promptValue(prompt, '봉사 링크');
  const evidenceUrl = donationLink && donationLink !== '없음'
    ? donationLink
    : volunteerLink && volunteerLink !== '없음'
      ? volunteerLink
      : '';

  return {
    activity_region: region,
    activity_type: `${disasterType} 구호 활동`,
    activity_summary: `${orgName}은(는) ${region} ${disasterType} 상황과 연결 가능한 구호 활동을 진행할 수 있는 단체로 분석됩니다.`,
    ai_message: '공개 활동 정보와 지원 채널을 기반으로 AI가 자동 분석한 카드입니다.',
    donation_link: donationLink === '없음' ? '' : donationLink,
    volunteer_link: volunteerLink === '없음' ? '' : volunteerLink,
    evidence_note: '공개 자료와 연결 가능한 지원 채널을 기반으로 생성된 AI 분석입니다.',
    trust_level: 'limited',
    trust_score: 45,
    report_summary: `${orgName}은(는) ${region} ${disasterType} 대응에 연결 가능한 지원 채널과 활동 정보를 보유한 단체로 분류됩니다.`,
    finance_summary: '공개 자료 기준으로 후원 채널과 활동 목적을 중심으로 분석했습니다.',
    risk_notes: 'AI 판단 기준: 재난 유형 적합성, 지원 채널 존재 여부, 공개 근거 접근성을 함께 반영했습니다.',
    evidence_sources: [
      {
        title: evidenceUrl ? `${orgName} 지원 채널` : `${orgName} AI 분석 근거`,
        url: evidenceUrl,
        source_type: 'ai_fallback'
      }
    ]
  };
}

async function postOpenAi(path, body) {
  const apiKey = requireOpenAiKey();
  const response = await fetch(`${OPENAI_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText.slice(0, 500)}`);
  }

  return response.json();
}

export async function embedTexts(texts, options = {}) {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const cleanTexts = texts.map(value => String(value ?? '').slice(0, 8000));

  if (shouldUseDummyMode()) {
    return cleanTexts.map(dummyEmbedding);
  }

  try {
    const embeddings = [];

    for (let i = 0; i < cleanTexts.length; i += 32) {
      const batch = cleanTexts.slice(i, i + 32);
      const payload = await postOpenAi('/embeddings', {
        model,
        input: batch
      });

      for (const item of payload.data ?? []) {
        embeddings.push(item.embedding);
      }
    }

    return embeddings;
  } catch (error) {
    if (!canFallbackAfterOpenAiError()) {
      throw error;
    }

    warnDummyFallback('embedding', error);
    return cleanTexts.map(dummyEmbedding);
  }
}

export async function generateJson(messages, options = {}) {
  if (shouldUseDummyMode()) {
    return dummyJson(messages);
  }

  try {
    const model = options.model || DEFAULT_LLM_MODEL;
    const payload = await postOpenAi('/chat/completions', {
      model,
      temperature: options.temperature ?? 0.2,
      response_format: { type: 'json_object' },
      messages
    });

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI response did not include message content.');
    }

    return JSON.parse(content);
  } catch (error) {
    if (!canFallbackAfterOpenAiError()) {
      throw error;
    }

    warnDummyFallback('chat completion', error);
    return dummyJson(messages);
  }
}
