import { spawn } from 'child_process';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import loadEnv from '../../loadEnv.js';

loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');
const configuredDbPath = process.env.DB_PATH || process.env.DATABASE_PATH;
const dbPath = configuredDbPath
  ? path.resolve(backendRoot, configuredDbPath)
  : path.join(backendRoot, 'data', 'disaster.sqlite');
const DEFAULT_POLL_INTERVAL_MS = 300000;

const sources = [
  {
    name: 'wildfire',
    script: 'crawl_wildfire_forest_fd.js',
    table: 'wildfire_data',
    dedupe: 'startyear + startmonth + startday + starttime + location fields'
  },
  {
    name: 'typhoon',
    script: 'typoon.js',
    table: 'typhoon_data',
    dedupe: 'PRIMARY KEY (seq, tm)'
  },
  {
    name: 'earthquake',
    script: 'earthquake.js',
    table: 'earthquake_data',
    dedupe: 'unique index (tmEqk, loc, mt)'
  },
  {
    name: 'naver-news',
    script: 'naver_news.js',
    table: 'naver_news',
    dedupe: 'UNIQUE (disaster_type, disaster_key, link)'
  }
];

let isPolling = false;
let shutdownRequested = false;
let watchTimer = null;

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function openDatabase(mode = sqlite3.OPEN_READONLY) {
  return new sqlite3.Database(dbPath, mode);
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

function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function countRows(tableName) {
  const db = openDatabase();

  try {
    const row = await get(db, `SELECT COUNT(*) AS count FROM ${tableName}`);
    return Number(row?.count ?? 0);
  } finally {
    await closeDatabase(db);
  }
}

function createRunId(startedAt) {
  const compactTime = startedAt.toISOString().replace(/[-:.TZ]/g, '');
  return `poll_${compactTime}_${process.pid}`;
}

function sourceNames(results) {
  return results.map(result => result.source);
}

function statusFromResults(results, fatalError) {
  if (fatalError) {
    return results.some(result => result.ok) ? 'partial_failure' : 'failed';
  }

  const failedCount = results.filter(result => !result.ok).length;
  if (failedCount === 0) return 'success';
  if (failedCount === results.length) return 'failed';
  return 'partial_failure';
}

function errorMessageFromResults(results, fatalError) {
  if (fatalError) {
    return fatalError.message;
  }

  const failed = results.filter(result => !result.ok);
  if (failed.length === 0) {
    return null;
  }

  return failed
    .map(result => `${result.source}: ${result.error ?? `exit code ${result.code}`}`)
    .join('; ');
}

async function ensureIngestionRunsTable(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      status TEXT NOT NULL,
      sources TEXT NOT NULL,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    )
  `);
}

async function recordIngestionRun(record) {
  const db = openDatabase(sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

  try {
    await ensureIngestionRunsTable(db);
    await run(db, `
      INSERT INTO ingestion_runs (
        run_id, started_at, finished_at, status, sources,
        inserted_count, updated_count, skipped_count, error_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.run_id,
      record.started_at,
      record.finished_at,
      record.status,
      JSON.stringify(record.sources),
      record.inserted_count,
      record.updated_count,
      record.skipped_count,
      record.error_message
    ]);
  } finally {
    await closeDatabase(db);
  }
}

function runCollector(source) {
  return new Promise(resolve => {
    const scriptPath = path.join(backendRoot, source.script);
    const child = spawn(process.execPath, [scriptPath, ...(source.args ?? [])], {
      cwd: backendRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', chunk => {
      process.stdout.write(`[${source.name}] ${chunk}`);
    });

    child.stderr.on('data', chunk => {
      process.stderr.write(`[${source.name}] ${chunk}`);
    });

    child.on('error', error => {
      resolve({ ok: false, error: error.message, code: 1 });
    });

    child.on('close', code => {
      resolve({ ok: code === 0, code });
    });
  });
}

async function pollSource(source) {
  log(`source started: ${source.name}`);
  const beforeCount = await countRows(source.table).catch(() => 0);
  const result = await runCollector(source);
  const afterCount = await countRows(source.table).catch(() => beforeCount);
  const inserted = Math.max(afterCount - beforeCount, 0);
  const skippedOrUpdated = result.ok ? 'see collector log' : 'not available';

  if (result.ok) {
    log(`source completed: ${source.name}; table=${source.table}; before=${beforeCount}; after=${afterCount}; inserted=${inserted}; skipped_or_updated=${skippedOrUpdated}; dedupe=${source.dedupe}`);
  } else {
    log(`source failed: ${source.name}; code=${result.code}; error=${result.error ?? 'collector exited with non-zero status'}`);
  }

  return {
    source: source.name,
    table: source.table,
    ok: result.ok,
    before: beforeCount,
    after: afterCount,
    inserted,
    code: result.code ?? 1,
    error: result.ok ? null : result.error ?? 'collector exited with non-zero status'
  };
}

async function runPollingCycle(mode) {
  const startedAt = new Date();
  const cycleStartedAt = startedAt.getTime();
  const runId = createRunId(startedAt);
  log(`polling cycle started; mode=${mode}; database=${dbPath}`);

  isPolling = true;
  const results = [];
  let fatalError = null;

  try {
    for (const source of sources) {
      results.push(await pollSource(source));
    }
  } catch (error) {
    fatalError = error;
    log(`polling cycle fatal error; mode=${mode}; error=${error.message}`);
  }

  try {
    const failed = results.filter(result => !result.ok);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - cycleStartedAt;
    const status = statusFromResults(results, fatalError);
    const insertedCount = results.reduce((total, result) => total + result.inserted, 0);
    const errorMessage = errorMessageFromResults(results, fatalError);

    log(`polling cycle finished; mode=${mode}; sources=${results.length}; failed=${failed.length}; status=${status}; duration_ms=${durationMs}`);

    for (const result of results) {
      log(`summary: ${result.source}; ok=${result.ok}; before=${result.before}; after=${result.after}; inserted=${result.inserted}`);
    }

    if (failed.length > 0) {
      log(`failed sources: ${failed.map(result => result.source).join(', ')}`);
    }

    await recordIngestionRun({
      run_id: runId,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status,
      sources: sourceNames(results),
      inserted_count: insertedCount,
      updated_count: 0,
      skipped_count: 0,
      error_message: errorMessage
    }).catch(error => {
      log(`ingestion run metadata write failed; error=${error.message}`);
    });

    if (fatalError) {
      throw fatalError;
    }

    return { ok: status === 'success', results, run_id: runId, status };
  } finally {
    isPolling = false;
  }
}

function pollIntervalMs() {
  const value = Number(process.env.POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function stopWatch(exitCode = 0) {
  shutdownRequested = true;

  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }

  if (isPolling) {
    log('shutdown requested; waiting for current polling cycle to finish');
    return;
  }

  log('polling shutdown complete');
  process.exit(exitCode);
}

async function runWatchMode() {
  const intervalMs = pollIntervalMs();
  log(`polling started; mode=watch; interval_ms=${intervalMs}; database=${dbPath}`);

  const runScheduledCycle = async () => {
    if (shutdownRequested) {
      return;
    }

    if (isPolling) {
      log('Previous polling cycle still running; skipping this interval');
      return;
    }

    try {
      const result = await runPollingCycle('watch');
      if (shutdownRequested) {
        log('polling shutdown complete');
        process.exit(result.ok ? 0 : 1);
      }
    } catch (error) {
      log(`polling cycle error; mode=watch; error=${error.message}`);
    }
  };

  process.once('SIGINT', () => {
    log('SIGINT received');
    stopWatch(0);
  });

  process.once('SIGTERM', () => {
    log('SIGTERM received');
    stopWatch(0);
  });

  await runScheduledCycle();

  if (!shutdownRequested) {
    watchTimer = setInterval(runScheduledCycle, intervalMs);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const watch = process.argv.includes('--watch');

  if (once) {
    log(`polling started; mode=once; database=${dbPath}`);
    const result = await runPollingCycle('once');
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (watch) {
    await runWatchMode();
    return;
  }

  log('pollDisasters requires --once or --watch.');
  process.exitCode = 1;
}

main().catch(error => {
  console.error(`[${timestamp()}] polling fatal error: ${error.message}`);
  process.exitCode = 1;
});
