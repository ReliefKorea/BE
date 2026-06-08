import { sourceFromText } from './sourceFetcher.js';
import { stableSlug, stripHtml, text } from './text.js';

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

const DISASTER_LABELS = {
  wildfire: '산불',
  heavy_rain: '호우',
  typhoon: '태풍',
  earthquake: '지진'
};

const ALL_DISASTER_TYPES = Object.keys(DISASTER_LABELS);

const CANDIDATE_CATALOG = [
  {
    org_name: '희망브리지 전국재해구호협회',
    activity_type: '재난 성금 모금 및 피해 이웃 지원',
    donation_link: 'https://hopebridge.or.kr/support/guide.php',
    volunteer_link: 'https://hopebridge.or.kr/business/volunteer.php',
    source_urls: ['https://hopebridge.or.kr/support/guide.php', 'https://hopebridge.or.kr/business/volunteer.php'],
    disaster_types: ALL_DISASTER_TYPES,
    priority: 110,
    priority_by_type: {
      wildfire: 35,
      heavy_rain: 35,
      typhoon: 35,
      earthquake: 25
    },
    fit_reason: '재난 피해 이웃 대상 성금 모금, 긴급구호, 복구 지원 사업과 직접 연결됩니다.'
  },
  {
    org_name: '대한적십자사',
    activity_type: '긴급 구호 및 재난 복구',
    donation_link: 'https://www.redcross.or.kr',
    volunteer_link: 'https://www.redcross.or.kr/m/volunteer/apply/view.do',
    source_urls: ['https://www.redcross.or.kr'],
    disaster_types: ALL_DISASTER_TYPES,
    priority: 105,
    priority_by_type: {
      wildfire: 25,
      heavy_rain: 30,
      typhoon: 30,
      earthquake: 30
    },
    fit_reason: '긴급 구호, 지역 봉사, 재난 복구 참여 채널이 함께 확인되는 전국 단위 구호 단체입니다.'
  },
  {
    org_name: '사회복지공동모금회',
    activity_type: '재난 특별모금 및 배분',
    donation_link: 'https://www.chest.or.kr',
    volunteer_link: '',
    source_urls: ['https://www.chest.or.kr'],
    disaster_types: ALL_DISASTER_TYPES,
    priority: 90,
    priority_by_type: {
      wildfire: 15,
      heavy_rain: 20,
      typhoon: 20,
      earthquake: 15
    },
    fit_reason: '공동모금과 배분 구조를 통해 지역 피해 지원과 복지 안전망 지원으로 연결될 수 있습니다.'
  },
  {
    org_name: '굿네이버스',
    activity_type: '국내외 재난 긴급구호 및 위기가정 지원',
    donation_link: 'https://www.goodneighbors.kr/',
    volunteer_link: '',
    source_urls: [
      'https://www.goodneighbors.kr/goodneighbors/management/finance.gn',
      'https://www.goodneighbors.kr/business/global_relief/emergency.gn',
      'https://www.goodneighbors.kr/goodneighbors/management/transparency.gn'
    ],
    disaster_types: ALL_DISASTER_TYPES,
    priority: 104,
    priority_by_type: {
      wildfire: 30,
      heavy_rain: 30,
      typhoon: 30,
      earthquake: 30
    },
    fit_reason: '인도적지원, 국내 위기가정 지원, 긴급구호 사업과 재정보고/투명경영 자료가 공개되어 있습니다.'
  }
];

function candidateId(eventId, orgName) {
  return `org_ai_${stableSlug(eventId)}_${stableSlug(orgName)}`.slice(0, 120);
}

export function disasterLabel(event) {
  return DISASTER_LABELS[event.disaster_type] || event.disaster_type;
}

function catalogScore(event, catalog) {
  const disasterType = event.disaster_type;
  const typeScore = catalog.disaster_types?.includes(disasterType) ? 100 : 25;
  const priorityScore = Number(catalog.priority ?? 0);
  const disasterPriorityScore = Number(catalog.priority_by_type?.[disasterType] ?? 0);
  const donationScore = catalog.donation_link ? 8 : 0;
  const volunteerScore = catalog.volunteer_link ? 4 : 0;

  return typeScore + priorityScore + disasterPriorityScore + donationScore + volunteerScore;
}

export function discoverOrgCandidates(event, existingOrganizations = [], options = {}) {
  const maxCatalog = Number(options.catalogLimit ?? 3);
  const candidatesByName = new Map();

  for (const org of existingOrganizations) {
    candidatesByName.set(org.org_name, {
      org_id: org.org_id,
      event_id: event.event_id,
      org_name: org.org_name,
      activity_region: org.activity_region || event.region_name,
      activity_type: org.activity_type || `${disasterLabel(event)} 구호 활동`,
      activity_summary: org.activity_summary || `${event.region_name} ${disasterLabel(event)} 대응 구호 활동 단체로 분석됩니다.`,
      ai_message: org.ai_message || '',
      donation_link: org.donation_link || '',
      volunteer_link: org.volunteer_link || '',
      evidence_note: org.evidence_note || '기존 등록 단체',
      source_urls: [org.donation_link, org.volunteer_link].filter(Boolean),
      from_existing_action: true
    });
  }

  const rankedCatalog = [...CANDIDATE_CATALOG]
    .map(catalog => ({
      ...catalog,
      fit_score: catalogScore(event, catalog)
    }))
    .sort((a, b) => b.fit_score - a.fit_score || a.org_name.localeCompare(b.org_name, 'ko'));

  for (const catalog of rankedCatalog.slice(0, maxCatalog)) {
    if (candidatesByName.has(catalog.org_name)) continue;

    candidatesByName.set(catalog.org_name, {
      org_id: candidateId(event.event_id, catalog.org_name),
      event_id: event.event_id,
      org_name: catalog.org_name,
      activity_region: event.region_name,
      activity_type: catalog.activity_type,
      activity_summary: `${event.region_name} ${disasterLabel(event)} 상황과 연결되는 구호 활동 단체로 AI가 분석했습니다.`,
      ai_message: '',
      donation_link: catalog.donation_link,
      volunteer_link: catalog.volunteer_link,
      evidence_note: `AI 적합도 ${catalog.fit_score}점: ${catalog.fit_reason}`,
      source_urls: catalog.source_urls,
      fit_score: catalog.fit_score,
      from_existing_action: false
    });
  }

  return [...candidatesByName.values()];
}

async function searchNaverNews(query, display = 5) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientId.startsWith('your_') || clientSecret.startsWith('your_')) {
    return [];
  }

  const url = new URL(NAVER_NEWS_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  url.searchParams.set('sort', 'date');

  const response = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret
    }
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function buildSearchSources(event, candidate, options = {}) {
  const label = disasterLabel(event);
  const queries = [
    `${candidate.org_name} ${event.region_name} ${label} 구호`,
    `${candidate.org_name} ${label} 후원금 사용 내역`,
    `${event.region_name} ${label} 피해 복구 성금 ${candidate.org_name}`
  ];
  const queryLimit = Number(options.searchQueryLimit ?? process.env.AI_RAG_SEARCH_QUERY_LIMIT ?? 2);
  const display = Number(options.newsDisplay ?? process.env.AI_RAG_NEWS_DISPLAY ?? 3);
  const maxChars = Number(options.maxSourceChars ?? process.env.AI_RAG_MAX_SOURCE_CHARS ?? 6000);
  const sources = [];

  for (const query of queries.slice(0, queryLimit)) {
    const items = await searchNaverNews(query, display);
    if (items.length === 0) continue;

    const rawText = items
      .map(item => [
        `제목: ${stripHtml(item.title)}`,
        `요약: ${stripHtml(item.description)}`,
        `링크: ${item.originallink || item.link || ''}`,
        `발행일: ${item.pubDate || ''}`
      ].join('\n'))
      .join('\n\n');

    const source = sourceFromText({
      eventId: event.event_id,
      orgId: candidate.org_id,
      sourceType: 'news_search',
      title: `네이버 뉴스 검색: ${query}`,
      url: '',
      rawText,
      maxChars
    });

    if (source) sources.push(source);
  }

  return sources;
}

export function buildCandidateSeedSource(event, candidate) {
  return sourceFromText({
    eventId: event.event_id,
    orgId: candidate.org_id,
    sourceType: 'operator_candidate',
    title: `${candidate.org_name} 기본 정보`,
    url: candidate.donation_link || candidate.volunteer_link || '',
    rawText: [
      `재난: ${event.title}`,
      `지역: ${event.region_name}`,
      `재난 유형: ${disasterLabel(event)}`,
      `단체명: ${candidate.org_name}`,
      `활동 지역: ${candidate.activity_region}`,
      `활동 유형: ${candidate.activity_type}`,
      `활동 요약: ${candidate.activity_summary}`,
      `시스템 근거: ${text(candidate.evidence_note)}`,
      `재난 적합도 점수: ${candidate.fit_score ?? '기존 등록 단체'}`,
      `후원 링크: ${candidate.donation_link || '없음'}`,
      `봉사 링크: ${candidate.volunteer_link || '없음'}`
    ].join('\n')
  });
}
