import { hashText, normalizeWhitespace, stripHtml, text } from './text.js';

const USER_AGENT = 'ReliefKoreaRAG/1.0 (+student-project)';

export function sourceFromText({ eventId, orgId, sourceType, title, url = '', rawText, maxChars }) {
  const normalizedFullText = normalizeWhitespace(rawText);
  const limit = Number(maxChars);
  const normalized = Number.isFinite(limit) && limit > 0
    ? normalizedFullText.slice(0, limit)
    : normalizedFullText;
  if (!normalized || normalized.length < 40) return null;

  return {
    source_id: `src_${eventId}_${orgId}_${hashText(`${sourceType}:${url}:${normalized}`).slice(0, 16)}`,
    event_id: eventId,
    org_id: orgId,
    source_type: sourceType,
    title: text(title, sourceType),
    url: text(url),
    fetched_at: new Date().toISOString(),
    content_hash: hashText(normalized),
    raw_text: normalized
  };
}

export async function fetchPlainTextSource({ eventId, orgId, sourceType, title, url, timeoutMs = 12000, maxChars }) {
  if (!url) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    const rawText = contentType.includes('html') ? stripHtml(body) : normalizeWhitespace(body);

    return sourceFromText({
      eventId,
      orgId,
      sourceType,
      title,
      url,
      rawText,
      maxChars
    });
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
