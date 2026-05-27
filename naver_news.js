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
const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

const defaultOptions = {
    type: 'all',
    limit: 5,
    display: 5,
    sort: 'date',
    minMagnitude: 0,
    minDamageArea: 0,
    sinceDays: 0,
    query: '',
    images: true
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
    options.display = Number(options.display || defaultOptions.display);
    options.minMagnitude = Number(options.minMagnitude || defaultOptions.minMagnitude);
    options.minDamageArea = Number(options.minDamageArea || defaultOptions.minDamageArea);
    options.sinceDays = Number(options.sinceDays || defaultOptions.sinceDays);
    options.sort = options.sort === 'sim' ? 'sim' : 'date';
    options.images = options.images !== false && options.images !== 'false' && options.images !== '0';

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

async function ensureNewsSchema(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS naver_news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            disaster_type TEXT NOT NULL,
            disaster_key TEXT NOT NULL,
            source_title TEXT,
            source_time TEXT,
            source_location TEXT,
            query TEXT NOT NULL,
            title TEXT NOT NULL,
            originallink TEXT,
            link TEXT NOT NULL,
            image_url TEXT,
            description TEXT,
            pubDate TEXT,
            saved_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE (disaster_type, disaster_key, link)
        );
    `);

    const tableInfo = await all(db, 'PRAGMA table_info(naver_news)');
    const existingColumns = new Set(tableInfo.map((column) => column.name));

    if (!existingColumns.has('image_url')) {
        await run(db, 'ALTER TABLE naver_news ADD COLUMN image_url TEXT');
    }

    await run(db, 'CREATE INDEX IF NOT EXISTS idx_naver_news_type_key ON naver_news (disaster_type, disaster_key)');
    await run(db, 'CREATE INDEX IF NOT EXISTS idx_naver_news_pubDate ON naver_news (pubDate)');
}

function normalizeText(value) {
    return cleanText(value)
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

const regionNameMap = {
    '강원특별자치도': '강원',
    '강원도': '강원',
    '전북특별자치도': '전북',
    '전라북도': '전북',
    '전라남도': '전남',
    '충청북도': '충북',
    '충청남도': '충남',
    '경상북도': '경북',
    '경상남도': '경남',
    '경기도': '경기',
    '서울특별시': '서울',
    '부산광역시': '부산',
    '대구광역시': '대구',
    '인천광역시': '인천',
    '광주광역시': '광주',
    '대전광역시': '대전',
    '울산광역시': '울산',
    '세종특별자치시': '세종',
    '제주특별자치도': '제주'
};

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRegionName(text) {
    const value = normalizeWhitespace(text);
    return regionNameMap[value] || value;
}

function cleanText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim();
}

function formatWildfireDate(item) {
    if (!item.startyear || !item.startmonth || !item.startday) {
        return '';
    }

    return `${Number(item.startyear)}년 ${Number(item.startmonth)}월 ${Number(item.startday)}일`;
}

function makeQuery(parts) {
    return normalizeWhitespace(parts.filter(Boolean).join(' '));
}

function buildWildfireQueries(item = {}) {
    const locsi = normalizeRegionName(item.locsi);
    const locgungu = normalizeWhitespace(item.locgungu);
    const locmenu = normalizeWhitespace(item.locmenu);
    const locdong = normalizeWhitespace(item.locdong);
    const dateText = formatWildfireDate(item);
    const candidates = [
        makeQuery([locsi, locgungu, locmenu, locdong, '산불', dateText]),
        makeQuery([locgungu, locmenu, locdong, '산불']),
        makeQuery([locsi, locgungu, '산불']),
        makeQuery([locgungu, '산불']),
        makeQuery([locmenu, '산불']),
        makeQuery([locdong, '산불'])
    ];
    const seen = new Set();

    return candidates.filter((query) => {
        if (!query || query === '산불' || seen.has(query)) {
            return false;
        }

        seen.add(query);
        return true;
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDisasterDate(value) {
    const raw = normalizeWhitespace(value);
    if (!raw) {
        return null;
    }

    const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
    if (compactMatch) {
        const [, year, month, day] = compactMatch;
        const date = new Date(`${year}-${month}-${day}T00:00:00+09:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const textMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (textMatch) {
        const [, year, month, day] = textMatch;
        const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00+09:00`);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseNewsDate(value) {
    const date = new Date(normalizeWhitespace(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

function filterNewsByDisasterDate(candidate, items) {
    const cutoffDate = parseDisasterDate(candidate.source_time);
    if (!cutoffDate) {
        return items;
    }

    return items.filter((item) => {
        const pubDate = parseNewsDate(item.pubDate);
        return pubDate && pubDate >= cutoffDate;
    });
}

async function deleteNewsBeforeDisasterDate(db, candidate) {
    const cutoffDate = parseDisasterDate(candidate.source_time);
    if (!cutoffDate) {
        return 0;
    }

    const rows = await all(db, `
        SELECT id, pubDate
        FROM naver_news
        WHERE disaster_type = ?
          AND disaster_key = ?
    `, [candidate.disaster_type, candidate.disaster_key]);
    let deletedCount = 0;

    for (const row of rows) {
        const pubDate = parseNewsDate(row.pubDate);
        if (!pubDate || pubDate >= cutoffDate) {
            continue;
        }

        await run(db, 'DELETE FROM naver_news WHERE id = ?', [row.id]);
        deletedCount += 1;
    }

    return deletedCount;
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
    const where = ['(damagearea IS NULL OR damagearea >= ?)'];
    const params = [options.minDamageArea];

    if (cutoff) {
        where.push(`${wildfireDateExpression()} >= ?`);
        params.push(cutoff);
    }

    params.push(options.limit);
    const rows = await all(db, `
        SELECT id, startyear, startmonth, startday, starttime, locsi, locgungu, locmenu, locdong, locbunji, damagearea
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
            source_time: `${row.startyear || ''}-${row.startmonth || ''}-${row.startday || ''}${row.starttime ? ` ${row.starttime}` : ''}`,
            source_location: location,
            query: `${location} 산불`.trim(),
            startyear: row.startyear,
            startmonth: row.startmonth,
            startday: row.startday,
            starttime: row.starttime,
            locsi: row.locsi,
            locgungu: row.locgungu,
            locmenu: row.locmenu,
            locdong: row.locdong,
            locbunji: row.locbunji
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

async function fetchNaverNews(candidate, options) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('NAVER_CLIENT_ID and NAVER_CLIENT_SECRET environment variables are required.');
    }

    const response = await axios.get(NAVER_NEWS_URL, {
        params: {
            query: candidate.query,
            display: Math.min(Math.max(options.display, 1), 100),
            start: 1,
            sort: options.sort
        },
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret
        }
    });

    return Array.isArray(response.data?.items) ? response.data.items : [];
}

async function searchNaverNews(query) {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('NAVER_CLIENT_ID and NAVER_CLIENT_SECRET environment variables are required.');
    }

    try {
        const response = await axios.get(NAVER_NEWS_URL, {
            params: {
                query,
                display: 10,
                start: 1,
                sort: 'date'
            },
            timeout: 5000,
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        });

        return Array.isArray(response.data?.items) ? response.data.items : [];
    } catch (error) {
        console.error('[naver-news] API request failed:', {
            status: error.response?.status,
            data: error.response?.data,
            query,
            message: error.message
        });
        throw error;
    }
}

async function fetchWildfireNewsByLocation(item) {
    const queries = buildWildfireQueries(item);

    if (queries.length === 0) {
        console.log('[wildfire-news] No usable location query was created.');
        return {
            success: false,
            queryUsed: null,
            items: []
        };
    }

    for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];

        try {
            const items = filterNewsByDisasterDate(
                { ...item, query, source_time: item.source_time },
                await searchNaverNews(query)
            );

            if (items.length > 0) {
                return {
                    success: true,
                    queryUsed: query,
                    items: items.map((item) => ({
                        title: cleanText(item.title),
                        description: cleanText(item.description),
                        link: item.originallink || item.link || '',
                        pubDate: item.pubDate || '',
                        queryUsed: query
                    }))
                };
            }

            console.log(`[wildfire-news] No results. query="${query}"`);
        } catch (error) {
            console.error(`[wildfire-news] Search failed. query="${query}", message=${error.message}`);
        }

        if (index < queries.length - 1) {
            await delay(200);
        }
    }

    console.log(`[wildfire-news] No news found for wildfire id=${item.id || item.disaster_key || 'unknown'}.`);
    return {
        success: false,
        queryUsed: null,
        items: []
    };
}

function absolutizeUrl(value, baseUrl) {
    if (!value) {
        return '';
    }

    try {
        return new URL(value, baseUrl).toString();
    } catch (_) {
        return value;
    }
}

function extractMetaImage(html, baseUrl) {
    const patterns = [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);

        if (match?.[1]) {
            return absolutizeUrl(normalizeText(match[1]), baseUrl);
        }
    }

    return '';
}

async function fetchArticleImage(item) {
    const targetUrl = item.originallink || item.link;

    if (!targetUrl) {
        return '';
    }

    try {
        const response = await axios.get(targetUrl, {
            timeout: 5000,
            maxRedirects: 5,
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; disaster-news-collector/1.0)'
            }
        });

        return extractMetaImage(String(response.data || ''), response.request?.res?.responseUrl || targetUrl);
    } catch (_) {
        return '';
    }
}

async function saveNews(db, candidate, items) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO naver_news (
            disaster_type,
            disaster_key,
            source_title,
            source_time,
            source_location,
            query,
            title,
            originallink,
            link,
            image_url,
            description,
            pubDate
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(disaster_type, disaster_key, link) DO UPDATE SET
            image_url = CASE
                WHEN excluded.image_url != '' THEN excluded.image_url
                ELSE naver_news.image_url
            END
    `);

    let savedCount = 0;

    try {
        for (const item of items) {
            savedCount += await runStatement(stmt, [
                candidate.disaster_type,
                candidate.disaster_key,
                candidate.source_title,
                candidate.source_time,
                candidate.source_location,
                item.queryUsed || candidate.query,
                normalizeText(item.title),
                item.originallink || '',
                item.link || item.originallink || '',
                item.image_url || '',
                normalizeText(item.description),
                item.pubDate || ''
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
        await ensureNewsSchema(db);

        const candidates = await loadCandidates(db, options);
        if (candidates.length === 0) {
            console.log('No disaster candidates matched the requested conditions.');
            return;
        }

        let fetchedTotal = 0;
        let savedTotal = 0;

        for (const candidate of candidates) {
            let items;
            let queryUsed = candidate.query;

            if (candidate.disaster_type === 'wildfire') {
                const result = await fetchWildfireNewsByLocation(candidate);
                items = result.items;
                queryUsed = result.queryUsed || buildWildfireQueries(candidate).join(' | ') || candidate.query;
            } else {
                items = filterNewsByDisasterDate(candidate, await fetchNaverNews(candidate, options));
            }

            if (options.images) {
                for (const item of items) {
                    item.image_url = await fetchArticleImage(item);
                }
            }

            const deletedOldCount = await deleteNewsBeforeDisasterDate(db, candidate);
            if (deletedOldCount > 0) {
                console.log(`[${candidate.disaster_type}] deleted_old=${deletedOldCount}; disaster_key=${candidate.disaster_key}`);
            }

            const savedCount = await saveNews(db, { ...candidate, query: queryUsed }, items);

            fetchedTotal += items.length;
            savedTotal += savedCount;
            console.log(`[${candidate.disaster_type}] ${queryUsed} fetched=${items.length}, saved=${savedCount}, unchanged=${items.length - savedCount}`);
        }

        console.log(`Naver news collection complete. candidates=${candidates.length}, fetched=${fetchedTotal}, saved=${savedTotal}, unchanged=${fetchedTotal - savedTotal}`);
    } catch (error) {
        console.error('Naver news collection failed:', error.message);
        process.exitCode = 1;
    } finally {
        await close(db);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeRegionName,
    buildWildfireQueries,
    searchNaverNews,
    cleanText,
    filterNewsByDisasterDate,
    deleteNewsBeforeDisasterDate,
    fetchWildfireNewsByLocation,
    main
};
