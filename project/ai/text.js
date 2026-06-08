import crypto from 'crypto';

export function text(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function optionalText(value) {
  const normalized = text(value);
  return normalized || undefined;
}

export function stableSlug(value) {
  const raw = text(value);
  const slug = raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return slug || hashText(raw).slice(0, 12);
}

export function hashText(value) {
  return crypto.createHash('sha256').update(text(value)).digest('hex');
}

export function clampNumber(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(text(value));
  } catch (_) {
    return fallback;
  }
}

export function normalizeWhitespace(value) {
  return text(value)
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripHtml(html) {
  return normalizeWhitespace(
    text(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

export function chunkText(value, maxChars = 900, overlapChars = 120) {
  const source = normalizeWhitespace(value);
  if (!source) return [];

  const paragraphs = source.split(/\n{2,}/).flatMap(paragraph => {
    if (paragraph.length <= maxChars) return [paragraph];
    return paragraph.split(/(?<=[.!?。！？다요함음임됨됨니다])\s+/);
  });

  const chunks = [];
  let current = '';

  for (const part of paragraphs) {
    const normalized = text(part);
    if (!normalized) continue;

    if ((current + '\n\n' + normalized).trim().length > maxChars && current) {
      chunks.push(current.trim());
      const overlap = current.slice(Math.max(0, current.length - overlapChars));
      current = `${overlap}\n\n${normalized}`.trim();
      continue;
    }

    current = `${current}\n\n${normalized}`.trim();
  }

  if (current) {
    chunks.push(current.trim());
  }

  return chunks;
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;

  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    leftMag += a * a;
    rightMag += b * b;
  }

  if (leftMag === 0 || rightMag === 0) return 0;
  return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
}
