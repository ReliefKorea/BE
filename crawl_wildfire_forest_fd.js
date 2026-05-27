const axios = require('axios');
const { openDatabase, ensureSchema, saveWildfireData, closeDatabase, dbPath } = require('./db');
const { parseDateTime, parseAddress } = require('./wildfire_parser');

const FOREST_FIRE_PAGE_URL = 'https://fd.forest.go.kr/ffas/pubConn/movePage/sub1.do';
const FOREST_FIRE_LIST_URL = 'https://fd.forest.go.kr/ffas/pubConn/occur/getPublicShowFireInfoList.do';
const USER_AGENT = 'Mozilla/5.0 (compatible; DisasterReliefResearchBot/1.0; +student-project)';
const DEFAULT_PER_PAGE = 30;

function pad2(value) {
    return String(value).padStart(2, '0');
}

function todayCompact() {
    const now = new Date();
    return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function datePartsToEndParts(parts) {
    if (!parts || !parts.startyear) {
        return {
            endyear: null,
            endmonth: null,
            endday: null,
            endtime: null
        };
    }

    return {
        endyear: parts.startyear,
        endmonth: parts.startmonth,
        endday: parts.startday,
        endtime: parts.starttime
    };
}

function parseEndDateTime(text) {
    if (!text || String(text).trim() === '-') {
        return datePartsToEndParts(null);
    }

    return datePartsToEndParts(parseDateTime(text));
}

function parseArgs(argv) {
    const options = {
        startDtm: todayCompact(),
        endDtm: todayCompact(),
        prgrsCode: '',
        useCron: false
    };

    for (const arg of argv) {
        if (arg === '--cron') {
            options.useCron = true;
            continue;
        }

        if (arg.startsWith('--date=')) {
            const value = arg.slice('--date='.length).replaceAll('-', '');
            options.startDtm = value;
            options.endDtm = value;
            continue;
        }

        if (arg.startsWith('--from=')) {
            options.startDtm = arg.slice('--from='.length).replaceAll('-', '');
            continue;
        }

        if (arg.startsWith('--to=')) {
            options.endDtm = arg.slice('--to='.length).replaceAll('-', '');
            continue;
        }

        if (arg.startsWith('--status=')) {
            options.prgrsCode = arg.slice('--status='.length);
        }
    }

    return options;
}

function buildRequestPayload(options, currentPage) {
    return {
        param: {
            startDtm: options.startDtm,
            endDtm: options.endDtm,
            regionCode: '',
            issuCode: '',
            // Empty status is important: it includes both in-progress and completed fires.
            prgrsCode: options.prgrsCode ?? '',
            sttnMapCheckFlag: ''
        },
        pager: {
            perPage: DEFAULT_PER_PAGE,
            perPageList: 10,
            currentPage,
            pageListStart: 0,
            pageListEnd: 0,
            totalCount: 0,
            lastPage: 0
        }
    };
}

async function fetchForestFirePageData(options, currentPage) {
    const response = await axios.post(
        FOREST_FIRE_LIST_URL,
        buildRequestPayload(options, currentPage),
        {
            timeout: 20000,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json',
                'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
                'Content-Type': 'application/json',
                'Referer': FOREST_FIRE_PAGE_URL
            }
        }
    );

    return response.data;
}

async function fetchForestFireItems(options = {}) {
    try {
        const firstPage = await fetchForestFirePageData(options, 1);
        const items = Array.isArray(firstPage?.frfrInfoList) ? [...firstPage.frfrInfoList] : [];
        const lastPage = Number(firstPage?.pager?.last_page || 1);

        for (let page = 2; page <= lastPage; page += 1) {
            const pageData = await fetchForestFirePageData(options, page);
            if (Array.isArray(pageData?.frfrInfoList)) {
                items.push(...pageData.frfrInfoList);
            }
        }

        return items;
    } catch (error) {
        console.error('[network] Forest fire list request failed:', error.message);
        throw error;
    }
}

function normalizeForestFireItem(item) {
    try {
        const startParts = parseDateTime(item.frfr_frng_dtm);
        const endParts = parseEndDateTime(item.potfr_end_dtm);
        const addressParts = parseAddress(item.frfr_sttmn_addr);

        return {
            ...startParts,
            ...endParts,
            ...addressParts,
            firecause: null,
            damagearea: null
        };
    } catch (error) {
        console.error('[parser] Forest fire item normalize failed:', error.message, item);
        return null;
    }
}

async function collectOnce(options = {}) {
    const db = openDatabase();

    try {
        await ensureSchema(db);
        const rows = await fetchForestFireItems(options);
        const items = rows.map(normalizeForestFireItem).filter(Boolean);
        const inserted = await saveWildfireData(db, items);

        console.log(`fetched=${items.length}, inserted=${inserted}`);
        return { fetched: items.length, inserted };
    } catch (error) {
        console.error('[main] Forest fire crawl failed:', error.message);
        throw error;
    } finally {
        await closeDatabase(db).catch((error) => {
            console.error('[db] DB close failed:', error.message);
        });
    }
}

async function runCron(options = {}) {
    let cron;

    try {
        cron = require('node-cron');
    } catch (error) {
        throw new Error('node-cron is not installed. Run npm install first.');
    }

    const schedule = options.schedule || '*/10 * * * *';
    let running = false;

    console.log(`Forest fire crawler started; schedule=${schedule}; db=${dbPath}`);

    const runSafely = async () => {
        if (running) {
            console.log('[cron] Previous run is still active. Skipping this tick.');
            return;
        }

        running = true;
        try {
            await collectOnce(options);
        } catch (error) {
            console.error('[cron] Forest fire crawl failed:', error.message);
        } finally {
            running = false;
        }
    };

    await runSafely();
    cron.schedule(schedule, runSafely);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.useCron) {
        await runCron(options);
        return;
    }

    await collectOnce(options);
}

if (require.main === module) {
    main().catch(() => {
        process.exitCode = 1;
    });
}

module.exports = {
    FOREST_FIRE_PAGE_URL,
    FOREST_FIRE_LIST_URL,
    USER_AGENT,
    fetchForestFireItems,
    normalizeForestFireItem,
    main
};
