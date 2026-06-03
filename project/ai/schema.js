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

export async function ensureRagSchema(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS rag_sources (
      source_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      fetched_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      UNIQUE (event_id, org_id, content_hash)
    )
  `);
  await run(db, `
    CREATE INDEX IF NOT EXISTS idx_rag_sources_event_org
    ON rag_sources (event_id, org_id)
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS rag_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (source_id, chunk_index)
    )
  `);
  await run(db, `
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_event_org
    ON rag_chunks (event_id, org_id)
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS org_ai_reports (
      report_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      org_name TEXT NOT NULL,
      activity_region TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      activity_summary TEXT NOT NULL,
      ai_message TEXT,
      donation_link TEXT,
      volunteer_link TEXT,
      evidence_note TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      trust_score INTEGER NOT NULL,
      report_summary TEXT NOT NULL,
      finance_summary TEXT NOT NULL,
      risk_notes TEXT,
      evidence_sources TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at TEXT,
      UNIQUE (event_id, org_id)
    )
  `);
  await run(db, `
    CREATE INDEX IF NOT EXISTS idx_org_ai_reports_event_status
    ON org_ai_reports (event_id, review_status, generated_at)
  `);
}
