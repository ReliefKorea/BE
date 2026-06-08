import { chunkText, cosineSimilarity, safeJsonParse, stableSlug } from './text.js';

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

export async function upsertSource(db, source) {
  await run(db, `
    INSERT INTO rag_sources (
      source_id, event_id, org_id, source_type, title, url, fetched_at, content_hash, raw_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, org_id, content_hash) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      title = excluded.title,
      url = excluded.url,
      raw_text = excluded.raw_text
  `, [
    source.source_id,
    source.event_id,
    source.org_id,
    source.source_type,
    source.title,
    source.url,
    source.fetched_at,
    source.content_hash,
    source.raw_text
  ]);

  return get(db, `
    SELECT *
    FROM rag_sources
    WHERE event_id = ? AND org_id = ? AND content_hash = ?
  `, [source.event_id, source.org_id, source.content_hash]);
}

export async function replaceSourceChunks(db, source, embeddings) {
  const chunks = chunkText(source.raw_text);
  await run(db, 'DELETE FROM rag_chunks WHERE source_id = ?', [source.source_id]);

  for (let index = 0; index < chunks.length; index += 1) {
    await run(db, `
      INSERT INTO rag_chunks (
        chunk_id, source_id, event_id, org_id, chunk_index, chunk_text, embedding_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `chk_${stableSlug(source.source_id)}_${index}`,
      source.source_id,
      source.event_id,
      source.org_id,
      index,
      chunks[index],
      JSON.stringify(embeddings[index] || []),
      new Date().toISOString()
    ]);
  }

  return chunks.length;
}

export async function countChunksForSource(db, sourceId) {
  const row = await get(db, `
    SELECT COUNT(*) AS count
    FROM rag_chunks
    WHERE source_id = ?
  `, [sourceId]);

  return Number(row?.count ?? 0);
}

export async function listChunks(db, eventId, orgId) {
  return all(db, `
    SELECT c.*, s.title AS source_title, s.url AS source_url, s.source_type
    FROM rag_chunks c
    JOIN rag_sources s ON s.source_id = c.source_id
    WHERE c.event_id = ? AND c.org_id = ?
    ORDER BY c.created_at DESC, c.chunk_index ASC
  `, [eventId, orgId]);
}

export async function searchChunks(db, eventId, orgId, queryEmbedding, limit = 8) {
  const rows = await listChunks(db, eventId, orgId);

  return rows
    .map(row => ({
      chunk_id: row.chunk_id,
      chunk_text: row.chunk_text,
      source_id: row.source_id,
      source_title: row.source_title,
      source_url: row.source_url,
      source_type: row.source_type,
      score: cosineSimilarity(queryEmbedding, safeJsonParse(row.embedding_json, []))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
