import { ensureRagSchema } from './schema.js';
import { buildCandidateSeedSource, buildSearchSources, discoverOrgCandidates, disasterLabel } from './orgDiscovery.js';
import { fetchPlainTextSource } from './sourceFetcher.js';
import { embedTexts } from './openaiClient.js';
import { generateOrgReport } from './reportGenerator.js';
import { chunkText, safeJsonParse, stableSlug } from './text.js';
import { countChunksForSource, replaceSourceChunks, searchChunks, upsertSource } from './vectorStore.js';

const DEFAULT_REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CROSS_EVENT_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function booleanOption(value, envName, fallback = false) {
  const raw = value ?? process.env[envName];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;

  const normalized = String(raw).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function numberOption(value, envName, fallback) {
  const parsed = Number(value ?? process.env[envName]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function reportIsFresh(report, ttlMs) {
  if (!report || ttlMs <= 0) return false;

  const generatedAt = new Date(report.generated_at).getTime();
  if (!Number.isFinite(generatedAt)) return false;

  return Date.now() - generatedAt <= ttlMs;
}

async function findReusableReport(db, eventId, orgId, ttlMs) {
  const report = await get(db, `
    SELECT *
    FROM org_ai_reports
    WHERE event_id = ?
      AND org_id = ?
      AND review_status != 'rejected'
    ORDER BY generated_at DESC
    LIMIT 1
  `, [eventId, orgId]);

  return reportIsFresh(report, ttlMs) ? report : null;
}

async function findReusableSameOrgReport(db, event, candidate, ttlMs) {
  const eventPrefix = `${event.disaster_type}_%`;
  const report = await get(db, `
    SELECT *
    FROM org_ai_reports
    WHERE event_id != ?
      AND event_id LIKE ?
      AND org_name = ?
      AND COALESCE(donation_link, '') = ?
      AND COALESCE(volunteer_link, '') = ?
      AND activity_type = ?
      AND review_status = 'approved'
    ORDER BY generated_at DESC
    LIMIT 1
  `, [
    event.event_id,
    eventPrefix,
    candidate.org_name,
    candidate.donation_link || '',
    candidate.volunteer_link || '',
    candidate.activity_type
  ]);

  return reportIsFresh(report, ttlMs) ? report : null;
}

function reportFromReusableSameOrg(event, candidate, reusableReport) {
  const label = disasterLabel(event);

  return {
    org_id: candidate.org_id,
    event_id: event.event_id,
    org_name: candidate.org_name,
    activity_region: candidate.activity_region || event.region_name,
    activity_type: candidate.activity_type,
    activity_summary: candidate.activity_summary || `${event.region_name} ${label} 대응 구호 활동 단체로 분석됩니다.`,
    ai_message: `${candidate.org_name}의 공개 지원 채널과 기존 RAG 근거를 현재 ${label} 상황에 맞춰 재사용한 AI 분석 카드입니다.`,
    donation_link: candidate.donation_link || reusableReport.donation_link || '',
    volunteer_link: candidate.volunteer_link || reusableReport.volunteer_link || '',
    evidence_note: '동일 단체와 동일 지원 채널의 기존 RAG 분석을 재사용했습니다.',
    trust_level: reusableReport.trust_level,
    trust_score: Number(reusableReport.trust_score) || 0,
    report_summary: `${candidate.org_name}는 ${event.region_name} ${label} 대응에 연결 가능한 구호 활동과 지원 채널을 보유한 단체로 분석됩니다.`,
    finance_summary: reusableReport.finance_summary || '공개 자료 기준으로 후원 채널과 활동 목적을 분석했습니다.',
    risk_notes: 'AI 판단 기준: 동일 단체의 공개 지원 채널, 활동 목적성, 재난 유형 적합성, 근거 접근성을 함께 반영했습니다.',
    evidence_sources: safeJsonParse(reusableReport.evidence_sources, []),
    generated_at: new Date().toISOString()
  };
}

async function setReportReviewStatus(db, report, reviewStatus) {
  if (!report || report.review_status === reviewStatus) return report;

  const reviewedAt = reviewStatus === 'approved' ? new Date().toISOString() : null;
  await run(db, `
    UPDATE org_ai_reports
    SET review_status = ?, reviewed_at = ?
    WHERE report_id = ?
  `, [reviewStatus, reviewedAt, report.report_id]);

  return get(db, 'SELECT * FROM org_ai_reports WHERE report_id = ?', [report.report_id]);
}

async function collectSources(event, candidate, options) {
  const seedSource = buildCandidateSeedSource(event, candidate);
  const fetchedSources = [];
  const maxSourceChars = numberOption(options.maxSourceChars, 'AI_RAG_MAX_SOURCE_CHARS', 6000);
  const officialSourceLimit = numberOption(options.officialSourceLimit, 'AI_RAG_OFFICIAL_SOURCE_LIMIT', 1);
  const fetchTimeoutMs = numberOption(options.fetchTimeoutMs, 'AI_RAG_FETCH_TIMEOUT_MS', 6000);

  for (const url of (candidate.source_urls || []).slice(0, officialSourceLimit)) {
    const source = await fetchPlainTextSource({
      eventId: event.event_id,
      orgId: candidate.org_id,
      sourceType: 'official_site',
      title: `${candidate.org_name} 공식 자료`,
      url,
      timeoutMs: fetchTimeoutMs,
      maxChars: maxSourceChars
    });

    if (source) fetchedSources.push(source);
  }

  const searchSources = booleanOption(options.skipNews, 'AI_RAG_SKIP_NEWS', false)
    ? []
    : await buildSearchSources(event, candidate, { ...options, maxSourceChars });
  return [seedSource, ...fetchedSources, ...searchSources].filter(Boolean);
}

async function embedAndStoreSources(db, sources, options) {
  let sourceCount = 0;
  let chunkCount = 0;
  let embeddedSourceCount = 0;
  let cachedSourceCount = 0;
  const forceRefresh = booleanOption(
    options.forceEmbeddingRefresh ?? options.forceRefresh,
    'AI_RAG_FORCE_REFRESH',
    false
  );

  for (const source of sources) {
    const storedSource = await upsertSource(db, source);
    const chunks = chunkText(storedSource.raw_text);
    if (chunks.length === 0) continue;

    const existingChunkCount = await countChunksForSource(db, storedSource.source_id);
    if (!forceRefresh && existingChunkCount === chunks.length) {
      sourceCount += 1;
      chunkCount += chunks.length;
      cachedSourceCount += 1;
      continue;
    }

    const embeddings = await embedTexts(chunks);
    await replaceSourceChunks(db, storedSource, embeddings);
    sourceCount += 1;
    chunkCount += chunks.length;
    embeddedSourceCount += 1;
  }

  return { sourceCount, chunkCount, embeddedSourceCount, cachedSourceCount };
}

async function upsertReport(db, report, reviewStatus = 'pending') {
  const reportId = `air_${stableSlug(report.event_id)}_${stableSlug(report.org_id)}`.slice(0, 160);
  const reviewedAt = reviewStatus === 'approved' ? report.generated_at : null;

  await run(db, `
    INSERT INTO org_ai_reports (
      report_id, event_id, org_id, org_name, activity_region, activity_type, activity_summary,
      ai_message, donation_link, volunteer_link, evidence_note, trust_level, trust_score,
      report_summary, finance_summary, risk_notes, evidence_sources, generated_at, review_status, reviewed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, org_id) DO UPDATE SET
      org_name = excluded.org_name,
      activity_region = excluded.activity_region,
      activity_type = excluded.activity_type,
      activity_summary = excluded.activity_summary,
      ai_message = excluded.ai_message,
      donation_link = excluded.donation_link,
      volunteer_link = excluded.volunteer_link,
      evidence_note = excluded.evidence_note,
      trust_level = excluded.trust_level,
      trust_score = excluded.trust_score,
      report_summary = excluded.report_summary,
      finance_summary = excluded.finance_summary,
      risk_notes = excluded.risk_notes,
      evidence_sources = excluded.evidence_sources,
      generated_at = excluded.generated_at,
      review_status = excluded.review_status,
      reviewed_at = excluded.reviewed_at
  `, [
    reportId,
    report.event_id,
    report.org_id,
    report.org_name,
    report.activity_region,
    report.activity_type,
    report.activity_summary,
    report.ai_message || '',
    report.donation_link || '',
    report.volunteer_link || '',
    report.evidence_note,
    report.trust_level,
    report.trust_score,
    report.report_summary,
    report.finance_summary,
    report.risk_notes || '',
    JSON.stringify(report.evidence_sources || []),
    report.generated_at,
    reviewStatus,
    reviewedAt
  ]);

  return get(db, 'SELECT * FROM org_ai_reports WHERE event_id = ? AND org_id = ?', [report.event_id, report.org_id]);
}

export async function runOrgRag({ db, event, existingOrganizations = [], options = {} }) {
  await ensureRagSchema(db);

  const candidates = discoverOrgCandidates(event, existingOrganizations, options);
  const defaultLimit = Math.min(candidates.length, numberOption(options.defaultLimit, 'AI_RAG_DEFAULT_LIMIT', 2));
  const limit = Number(options.limit ?? defaultLimit);
  const selectedCandidates = candidates.slice(0, limit);
  const autoPublish = booleanOption(options.autoPublish, 'AI_RAG_AUTO_PUBLISH', true);
  const reviewStatus = autoPublish ? 'approved' : 'pending';
  const reportTtlMs = numberOption(options.reportTtlMs, 'AI_RAG_REPORT_TTL_MS', DEFAULT_REPORT_TTL_MS);
  const reuseSameOrg = booleanOption(options.reuseSameOrg, 'AI_RAG_REUSE_SAME_ORG', true);
  const crossEventReportTtlMs = numberOption(
    options.crossEventReportTtlMs,
    'AI_RAG_CROSS_EVENT_REPORT_TTL_MS',
    DEFAULT_CROSS_EVENT_REPORT_TTL_MS
  );
  const reports = [];
  let totalSources = 0;
  let totalChunks = 0;
  let embeddedSources = 0;
  let cachedSources = 0;
  let reusedReports = 0;
  let reusedSameOrgReports = 0;

  for (const candidate of selectedCandidates) {
    const forceReportRefresh = booleanOption(
      options.forceReportRefresh ?? options.forceRefresh,
      'AI_RAG_FORCE_REFRESH',
      false
    );
    const reusableReport = forceReportRefresh
      ? null
      : await findReusableReport(db, event.event_id, candidate.org_id, reportTtlMs);

    if (reusableReport) {
      const report = autoPublish
        ? await setReportReviewStatus(db, reusableReport, 'approved')
        : reusableReport;
      reports.push(report);
      reusedReports += 1;
      continue;
    }

    const reusableSameOrgReport = !forceReportRefresh && reuseSameOrg
      ? await findReusableSameOrgReport(db, event, candidate, crossEventReportTtlMs)
      : null;

    if (reusableSameOrgReport) {
      const report = reportFromReusableSameOrg(event, candidate, reusableSameOrgReport);
      const storedReport = await upsertReport(db, report, reviewStatus);
      reports.push(storedReport);
      reusedSameOrgReports += 1;
      continue;
    }

    const sources = await collectSources(event, candidate, options);
    const stored = await embedAndStoreSources(db, sources, options);
    totalSources += stored.sourceCount;
    totalChunks += stored.chunkCount;
    embeddedSources += stored.embeddedSourceCount;
    cachedSources += stored.cachedSourceCount;

    const query = [
      event.title,
      event.region_name,
      disasterLabel(event),
      candidate.org_name,
      '재난 구호 활동 후원금 사용 내역 봉사 투명성 공식 근거'
    ].join(' ');
    const [queryEmbedding] = await embedTexts([query]);
    const retrievedChunks = await searchChunks(db, event.event_id, candidate.org_id, queryEmbedding, 8);
    const report = await generateOrgReport(event, candidate, retrievedChunks);
    const storedReport = await upsertReport(db, report, reviewStatus);
    reports.push(storedReport);
  }

  return {
    event_id: event.event_id,
    candidate_count: selectedCandidates.length,
    source_count: totalSources,
    chunk_count: totalChunks,
    embedded_source_count: embeddedSources,
    cached_source_count: cachedSources,
    reused_report_count: reusedReports,
    reused_same_org_report_count: reusedSameOrgReports,
    auto_published: autoPublish,
    reports
  };
}

export async function listAiReportsForEvent(db, eventId) {
  await ensureRagSchema(db);

  return all(db, `
    SELECT *
    FROM org_ai_reports
    WHERE event_id = ?
    ORDER BY
      CASE review_status
        WHEN 'pending' THEN 0
        WHEN 'approved' THEN 1
        ELSE 2
      END,
      generated_at DESC
  `, [eventId]);
}

export async function approveAiReport(db, reportId) {
  await ensureRagSchema(db);
  const report = await get(db, 'SELECT * FROM org_ai_reports WHERE report_id = ?', [reportId]);
  if (!report) return null;

  const now = new Date().toISOString();
  await run(db, `
    INSERT INTO organization_actions (
      org_id, event_id, org_name, activity_region, activity_type, activity_summary,
      ai_message, donation_link, volunteer_link, evidence_note, verified_by_admin, last_checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(org_id) DO UPDATE SET
      event_id = excluded.event_id,
      org_name = excluded.org_name,
      activity_region = excluded.activity_region,
      activity_type = excluded.activity_type,
      activity_summary = excluded.activity_summary,
      ai_message = excluded.ai_message,
      donation_link = excluded.donation_link,
      volunteer_link = excluded.volunteer_link,
      evidence_note = excluded.evidence_note,
      verified_by_admin = 1,
      last_checked_at = excluded.last_checked_at
  `, [
    report.org_id,
    report.event_id,
    report.org_name,
    report.activity_region,
    report.activity_type,
    report.activity_summary,
    report.ai_message || '',
    report.donation_link || '',
    report.volunteer_link || '',
    report.evidence_note,
    now
  ]);
  await run(db, `
    UPDATE org_ai_reports
    SET review_status = 'approved', reviewed_at = ?
    WHERE report_id = ?
  `, [now, reportId]);

  return get(db, 'SELECT * FROM org_ai_reports WHERE report_id = ?', [reportId]);
}

export async function rejectAiReport(db, reportId) {
  await ensureRagSchema(db);
  const now = new Date().toISOString();
  await run(db, `
    UPDATE org_ai_reports
    SET review_status = 'rejected', reviewed_at = ?
    WHERE report_id = ?
  `, [now, reportId]);

  return get(db, 'SELECT * FROM org_ai_reports WHERE report_id = ?', [reportId]);
}
