import { clampNumber, optionalText, text } from './text.js';
import { generateJson } from './openaiClient.js';
import { disasterLabel } from './orgDiscovery.js';

const TRUST_LEVELS = new Set(['strong', 'moderate', 'limited', 'needs_review']);

function levelFromScore(score) {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'moderate';
  if (score >= 35) return 'limited';
  return 'needs_review';
}

function normalizeTrustScore(value) {
  const parsed = Number(value);
  const scaled = Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed * 100
    : value;

  return Math.round(clampNumber(scaled, 0, 100, 30));
}

function readableText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return text(value, fallback);
  }

  if (Array.isArray(value)) {
    return value
      .map(item => readableText(item))
      .filter(Boolean)
      .join(' ');
  }

  if (typeof value === 'object') {
    const preferredKeys = ['summary', 'note', 'notes', 'strengths', 'weaknesses', 'risk_notes', 'riskNotes'];
    const preferred = preferredKeys
      .map(key => readableText(value[key]))
      .filter(Boolean);

    if (preferred.length > 0) {
      return preferred.join(' ');
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const normalized = readableText(item);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join(' ');
  }

  return fallback;
}

function normalizeEvidenceSources(value, retrievedChunks) {
  const sourceMap = new Map();

  if (Array.isArray(value)) {
    for (const item of value) {
      const title = text(item?.title);
      const url = text(item?.url);
      const sourceType = text(item?.source_type || item?.sourceType, 'evidence');
      if (title || url) {
        sourceMap.set(`${title}:${url}`, { title: title || url, url, source_type: sourceType });
      }
    }
  }

  for (const chunk of retrievedChunks) {
    const title = text(chunk.source_title);
    const url = text(chunk.source_url);
    if (title || url) {
      sourceMap.set(`${title}:${url}`, {
        title: title || url,
        url,
        source_type: text(chunk.source_type, 'rag_source')
      });
    }
  }

  return [...sourceMap.values()].slice(0, 5);
}

export function normalizeReport(rawReport, event, candidate, retrievedChunks) {
  const trustScore = normalizeTrustScore(rawReport?.trust_score);
  const trustLevel = TRUST_LEVELS.has(rawReport?.trust_level)
    ? rawReport.trust_level
    : levelFromScore(trustScore);

  return {
    org_id: candidate.org_id,
    event_id: event.event_id,
    org_name: candidate.org_name,
    activity_region: readableText(rawReport?.activity_region, candidate.activity_region || event.region_name),
    activity_type: readableText(rawReport?.activity_type, candidate.activity_type || `${disasterLabel(event)} 구호 활동`),
    activity_summary: readableText(rawReport?.activity_summary, candidate.activity_summary),
    ai_message: optionalText(readableText(rawReport?.ai_message || candidate.ai_message)),
    donation_link: optionalText(readableText(rawReport?.donation_link || candidate.donation_link)),
    volunteer_link: optionalText(readableText(rawReport?.volunteer_link || candidate.volunteer_link)),
    evidence_note: readableText(rawReport?.evidence_note, 'RAG 수집 문서 기반 AI 자동 분석입니다.'),
    trust_level: trustLevel,
    trust_score: trustScore,
    report_summary: readableText(rawReport?.report_summary, '근거 문서가 부족해 활동 내용을 제한적으로 확인했습니다.'),
    finance_summary: readableText(rawReport?.finance_summary, '공개 자료 기준으로 후원 채널과 활동 목적을 분석했습니다.'),
    risk_notes: optionalText(readableText(rawReport?.risk_notes)),
    evidence_sources: normalizeEvidenceSources(rawReport?.evidence_sources, retrievedChunks),
    generated_at: new Date().toISOString()
  };
}

export async function generateOrgReport(event, candidate, retrievedChunks) {
  const evidenceBlock = retrievedChunks.map((chunk, index) => [
    `[${index + 1}] ${chunk.source_title || chunk.source_type}`,
    chunk.source_url ? `URL: ${chunk.source_url}` : '',
    `유사도: ${chunk.score.toFixed(3)}`,
    chunk.chunk_text
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');

  const messages = [
    {
      role: 'system',
      content: [
        '너는 재난 구호 단체의 공개 근거를 검토하는 한국어 RAG 분석가다.',
        '근거 문서에 없는 내용을 추정하거나 단정하지 않는다.',
        '단체를 순위화하지 않는다.',
        'trust_score는 단체의 선악 평가가 아니라 공개 근거의 충실도와 재난 대응 적합성이다.',
        '별도 사람 검토를 요구하는 문구를 쓰지 않는다.',
        '근거가 부족한 항목은 AI 판단 메모와 trust_score에 반영하되 사용자에게 행동 가능한 요약으로 쓴다.',
        '"보인다", "예정", "것으로 보이며" 같은 추정 표현을 피하고, 근거 기반으로 분석된 사실과 판단만 쓴다.',
        '후원금 사용이 투명하다고 단정하지 말고, 공개 자료로 확인되는 모금액·지원 실적·사용 목적만 쓴다.',
        'report_summary 첫 문장은 사용자가 후원 판단을 바로 할 수 있도록 "사용처 판단:"으로 시작한다.',
        'finance_summary에는 "공개 수치:", "사용처:", "투명성 근거:"를 포함해 돈이 어디로 쓰이는지 직관적으로 쓴다.',
        'risk_notes에는 확인된 강점과 공개 자료상 비어 있는 지표를 짧게 구분해 쓴다.',
        '반드시 JSON 객체만 반환한다.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `재난: ${event.title}`,
        `지역: ${event.region_name}`,
        `재난 유형: ${disasterLabel(event)}`,
        `분석 대상 단체: ${candidate.org_name}`,
        `후원 링크: ${candidate.donation_link || '없음'}`,
        `봉사 링크: ${candidate.volunteer_link || '없음'}`,
        '',
        '아래 근거만 사용해 사용자 공개용 리포트 JSON을 만들어라.',
        'JSON 필드: activity_region, activity_type, activity_summary, ai_message, donation_link, volunteer_link, evidence_note, trust_level, trust_score, report_summary, finance_summary, risk_notes, evidence_sources.',
        'trust_level은 strong, moderate, limited, needs_review 중 하나다.',
        'trust_score는 0부터 100까지의 정수다. 0~1 소수로 쓰지 않는다.',
        'evidence_sources는 [{title,url,source_type}] 배열이다.',
        'report_summary는 1문장으로 쓰고, 이 단체 후원 시 돈 사용처 판단이 쉬운지 먼저 말한다.',
        'finance_summary는 공개 수치, 돈의 사용처, 투명성 근거를 한눈에 볼 수 있게 2~3문장으로 쓴다.',
        'risk_notes에는 AI가 판단한 근거 강점과 공개 자료상 빈칸만 쓴다.',
        '',
        evidenceBlock || '근거 문서 없음'
      ].join('\n')
    }
  ];

  const rawReport = await generateJson(messages);
  return normalizeReport(rawReport, event, candidate, retrievedChunks);
}
