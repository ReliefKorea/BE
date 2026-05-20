const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const loadEnv = require('./loadEnv');

loadEnv();

const dbFolder = path.join(__dirname, 'data');
const dbPath = process.env.DATABASE_PATH
    ? path.resolve(__dirname, process.env.DATABASE_PATH)
    : path.join(dbFolder, 'disaster.sqlite');
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

const defaultOptions = {
    type: 'all',
    limit: 5,
    display: 5,
    sort: 'date',
    minMagnitude: 0,
    minDamageArea: 0,
    sinceDays: 0,
    query: ''
};

function parseArgs(argv) {
    const options = { ...defaultOptions };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (!arg.startsWith('--')) {
            continue;
        }

        const key = arg.slice(2);
        const next = argv[i + 1];

        if (!next || next.startsWith('--')) {
            options[key] = true;
            continue;
        }

        options[key] = next;
        i += 1;
    }

    options.limit = Number(options.limit || defaultOptions.limit);
    options.display = Math.min(Math.max(Number(options.display || defaultOptions.display), 1), 50);
    options.minMagnitude = Number(options.minMagnitude || defaultOptions.minMagnitude);
    options.minDamageArea = Number(options.minDamageArea || defaultOptions.minDamageArea);
    options.sinceDays = Number(options.sinceDays || defaultOptions.sinceDays);
    options.sort = options.sort === 'relevance' ? 'relevance' : 'date';

    return options;
}

function openDatabase() {
    if (!fs.existsSync(dbFolder)) {
        fs.mkdirSync(dbFolder, { recursive: true });
    }

    return new sqlite3.Database(dbPath);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function callback(err) {
            if (err) {
                reject(err);
                return;
            }

            resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(rows);
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

function runStatement(stmt, params = []) {
    return new Promise((resolve, reject) => {
        stmt.run(params, function callback(err) {
            if (err) {
                reject(err);
                return;
            }

            resolve(this.changes || 0);
        });
    });
}

function finalize(stmt) {
    return new Promise((resolve, reject) => {
        stmt.finalize((err) => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

async function ensureVideoSchema(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS disaster_videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            disaster_type TEXT NOT NULL,
            disaster_key TEXT NOT NULL,
            source_title TEXT,
            source_time TEXT,
            source_location TEXT,
            query TEXT NOT NULL,
            provider TEXT NOT NULL,
            video_id TEXT NOT NULL,
            title TEXT NOT NULL,
            video_url TEXT NOT NULL,
            thumbnail_url TEXT,
            channel_title TEXT,
            channel_id TEXT,
            description TEXT,
            published_at TEXT,
            saved_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE (provider, video_id, disaster_type, disaster_key)
        );
    `);

    await run(db, 'CREATE INDEX IF NOT EXISTS idx_disaster_videos_type_key ON disaster_videos (disaster_type, disaster_key)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_disaster_videos_published_at ON disaster_videos (published_at)');
}

function normalizeText(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .trim();
}

function dateCutoffYmd(sinceDays) {
    if (!sinceDays || sinceDays <= 0) {
        return '';
    }

    const date = new Date();
    date.setDate(date.getDate() - sinceDays);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function wildfireDateExpression() {
    return "printf('%04d%02d%02d', CAST(startyear AS INTEGER), CAST(startmonth AS INTEGER), CAST(startday AS INTEGER))";
}

async function tableExists(db, tableName) {
    const rows = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [tableName]);
    return rows.length > 0;
}

async function loadCustomCandidate(options) {
    if (!options.query) {
        return [];
    }

    return [{
        disaster_type: 'custom',
        disaster_key: options.query,
        source_title: 'custom query',
        source_time: '',
        source_location: '',
        query: options.query
    }];
}

async function loadEarthquakeCandidates(db, options) {
    if (!(await tableExists(db, 'earthquake_data'))) {
        return [];
    }

    const cutoff = dateCutoffYmd(options.sinceDays);
    const where = ['mt >= ?'];
    const params = [options.minMagnitude];

    if (cutoff) {
        where.push("substr(replace(replace(replace(tmEqk, '-', ''), ':', ''), ' ', ''), 1, 8) >= ?");
        params.push(cutoff);
    }

    params.push(options.limit);
    const rows = await all(db, `
        SELECT id, tmEqk, loc, mt
        FROM earthquake_data
        WHERE ${where.join(' AND ')}
        ORDER BY tmEqk DESC, id DESC
        LIMIT ?
    `, params);

    return rows.map((row) => ({
        disaster_type: 'earthquake',
        disaster_key: String(row.id),
        source_title: `earthquake mt ${row.mt || ''}`.trim(),
        source_time: row.tmEqk || '',
        source_location: row.loc || '',
        query: `${row.loc || ''} 지진`.trim()
    })).filter((candidate) => candidate.query);
}

async function loadTyphoonCandidates(db, options) {
    if (!(await tableExists(db, 'typhoon_data'))) {
        return [];
    }

    const cutoff = dateCutoffYmd(options.sinceDays);
    const where = [];
    const params = [];

    if (cutoff) {
        where.push('substr(tmFc, 1, 8) >= ?');
        params.push(cutoff);
    }

    params.push(options.limit);
    const rows = await all(db, `
        SELECT seq, typ_name, typ_loc, MAX(tmFc) AS latest_tmFc, MAX(tm) AS latest_tm
        FROM typhoon_data
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY seq, typ_name
        ORDER BY latest_tmFc DESC, seq DESC
        LIMIT ?
    `, params);

    return rows.map((row) => ({
        disaster_type: 'typhoon',
        disaster_key: `${row.seq}:${row.typ_name || ''}`,
        source_title: `typhoon ${row.typ_name || row.seq}`,
        source_time: row.latest_tmFc || row.latest_tm || '',
        source_location: row.typ_loc || '',
        query: `태풍 ${row.typ_name || ''}`.trim()
    })).filter((candidate) => candidate.query !== '태풍');
}

async function loadWildfireCandidates(db, options) {
    if (!(await tableExists(db, 'wildfire_data'))) {
        return [];
    }

    const cutoff = dateCutoffYmd(options.sinceDays);
    const where = ['damagearea >= ?'];
    const params = [options.minDamageArea];

    if (cutoff) {
        where.push(`${wildfireDateExpression()} >= ?`);
        params.push(cutoff);
    }

    params.push(options.limit);
    const rows = await all(db, `
        SELECT id, startyear, startmonth, startday, locsi, locgungu, locmenu, locdong, damagearea
        FROM wildfire_data
        WHERE ${where.join(' AND ')}
        ORDER BY ${wildfireDateExpression()} DESC, damagearea DESC, id DESC
        LIMIT ?
    `, params);

    return rows.map((row) => {
        const location = [row.locsi, row.locgungu, row.locmenu, row.locdong].filter(Boolean).join(' ');

        return {
            disaster_type: 'wildfire',
            disaster_key: String(row.id),
            source_title: `wildfire damagearea ${row.damagearea || 0}`,
            source_time: `${row.startyear || ''}-${row.startmonth || ''}-${row.startday || ''}`,
            source_location: location,
            query: `${location} 산불`.trim()
        };
    }).filter((candidate) => candidate.query);
}

async function loadFloodCandidates(db, options) {
    if (!(await tableExists(db, 'flood_data'))) {
        return [];
    }

    const cutoff = dateCutoffYmd(options.sinceDays);
    const where = [];
    const params = [];

    if (cutoff) {
        where.push("substr(replace(replace(replace(tm, '-', ''), ':', ''), ' ', ''), 1, 8) >= ?");
        params.push(cutoff);
    }

    params.push(options.limit);
    const rows = await all(db, `
        SELECT id, tm, loc, depth, cause
        FROM flood_data
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY tm DESC, id DESC
        LIMIT ?
    `, params);

    return rows.map((row) => ({
        disaster_type: 'flood',
        disaster_key: String(row.id),
        source_title: `flood depth ${row.depth || 0}`,
        source_time: row.tm || '',
        source_location: row.loc || '',
        query: `${row.loc || ''} 침수`.trim()
    })).filter((candidate) => candidate.query);
}

async function loadCandidates(db, options) {
    const customCandidates = await loadCustomCandidate(options);
    if (customCandidates.length) {
        return customCandidates;
    }

    const loaders = {
        earthquake: loadEarthquakeCandidates,
        typhoon: loadTyphoonCandidates,
        wildfire: loadWildfireCandidates,
        flood: loadFloodCandidates
    };

    if (options.type !== 'all') {
        const loader = loaders[options.type];

        if (!loader) {
            throw new Error(`Unknown type: ${options.type}. Use all, earthquake, typhoon, wildfire, flood, or --query.`);
        }

        return loader(db, options);
    }

    const result = [];
    for (const loader of Object.values(loaders)) {
        result.push(...await loader(db, options));
    }

    return result;
}

async function fetchYoutubeVideos(candidate, options) {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
        throw new Error('YOUTUBE_API_KEY environment variable is required.');
    }

    const response = await axios.get(YOUTUBE_SEARCH_URL, {
        params: {
            key: apiKey,
            part: 'snippet',
            q: candidate.query,
            type: 'video',
            maxResults: options.display,
            order: options.sort,
            regionCode: 'KR',
            relevanceLanguage: 'ko',
            safeSearch: 'none'
        }
    });

    return Array.isArray(response.data?.items) ? response.data.items : [];
}

function bestThumbnail(thumbnails = {}) {
    return thumbnails.maxres?.url
        || thumbnails.high?.url
        || thumbnails.medium?.url
        || thumbnails.default?.url
        || '';
}

async function saveVideos(db, candidate, items) {
    const stmt = db.prepare(`
        INSERT INTO disaster_videos (
            disaster_type,
            disaster_key,
            source_title,
            source_time,
            source_location,
            query,
            provider,
            video_id,
            title,
            video_url,
            thumbnail_url,
            channel_title,
            channel_id,
            description,
            published_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, video_id, disaster_type, disaster_key) DO UPDATE SET
            title = excluded.title,
            video_url = excluded.video_url,
            thumbnail_url = excluded.thumbnail_url,
            channel_title = excluded.channel_title,
            channel_id = excluded.channel_id,
            description = excluded.description,
            published_at = excluded.published_at
    `);

    let savedCount = 0;

    try {
        for (const item of items) {
            const videoId = item.id?.videoId;
            const snippet = item.snippet || {};

            if (!videoId) {
                continue;
            }

            savedCount += await runStatement(stmt, [
                candidate.disaster_type,
                candidate.disaster_key,
                candidate.source_title,
                candidate.source_time,
                candidate.source_location,
                candidate.query,
                'youtube',
                videoId,
                normalizeText(snippet.title),
                `https://www.youtube.com/watch?v=${videoId}`,
                bestThumbnail(snippet.thumbnails),
                snippet.channelTitle || '',
                snippet.channelId || '',
                normalizeText(snippet.description),
                snippet.publishedAt || ''
            ]);
        }
    } finally {
        await finalize(stmt);
    }

    return savedCount;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const db = openDatabase();

    try {
        await ensureVideoSchema(db);

        const candidates = await loadCandidates(db, options);
        if (candidates.length === 0) {
            console.log('No disaster candidates matched the requested conditions.');
            return;
        }

        let fetchedTotal = 0;
        let savedTotal = 0;

        for (const candidate of candidates) {
            const items = await fetchYoutubeVideos(candidate, options);
            const savedCount = await saveVideos(db, candidate, items);

            fetchedTotal += items.length;
            savedTotal += savedCount;
            console.log(`[${candidate.disaster_type}] ${candidate.query} fetched=${items.length}, saved=${savedCount}, unchanged=${items.length - savedCount}`);
        }

        console.log(`YouTube video collection complete. candidates=${candidates.length}, fetched=${fetchedTotal}, saved=${savedTotal}, unchanged=${fetchedTotal - savedTotal}`);
    } catch (error) {
        console.error('YouTube video collection failed:', error.response?.data?.error?.message || error.message);
        process.exitCode = 1;
    } finally {
        await close(db);
    }
}

main();
