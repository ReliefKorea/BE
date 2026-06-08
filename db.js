const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const loadEnv = require('./loadEnv');

loadEnv();

const dbFolder = path.join(__dirname, 'data');
const configuredDbPath = process.env.DB_PATH || process.env.DATABASE_PATH;
const dbPath = configuredDbPath
  ? path.resolve(__dirname, configuredDbPath)
  : path.join(dbFolder, 'disaster.sqlite');

const createWildfireTableSql = `
CREATE TABLE IF NOT EXISTS wildfire_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    startyear TEXT,
    startmonth TEXT,
    startday TEXT,
    starttime TEXT,
    startdayofweek TEXT,
    endyear TEXT,
    endmonth TEXT,
    endday TEXT,
    endtime TEXT,
    locsi TEXT,
    locgungu TEXT,
    locmenu TEXT,
    locdong TEXT,
    locbunji TEXT,
    firecause TEXT,
    damagearea REAL
);
`;

const duplicateCheckSql = `
SELECT id
FROM wildfire_data
WHERE COALESCE(startyear, '') = COALESCE(?, '')
  AND COALESCE(startmonth, '') = COALESCE(?, '')
  AND COALESCE(startday, '') = COALESCE(?, '')
  AND COALESCE(starttime, '') = COALESCE(?, '')
  AND COALESCE(locsi, '') = COALESCE(?, '')
  AND COALESCE(locgungu, '') = COALESCE(?, '')
  AND COALESCE(locmenu, '') = COALESCE(?, '')
  AND COALESCE(locdong, '') = COALESCE(?, '')
  AND COALESCE(locbunji, '') = COALESCE(?, '')
LIMIT 1
`;

const nearDuplicateCheckSql = `
SELECT id
FROM wildfire_data
WHERE COALESCE(startyear, '') = COALESCE(?, '')
  AND COALESCE(startmonth, '') = COALESCE(?, '')
  AND COALESCE(startday, '') = COALESCE(?, '')
  AND substr(COALESCE(starttime, ''), 1, 5) = substr(COALESCE(?, ''), 1, 5)
  AND COALESCE(locsi, '') = COALESCE(?, '')
  AND COALESCE(locgungu, '') = COALESCE(?, '')
  AND COALESCE(locmenu, '') = COALESCE(?, '')
  AND COALESCE(locdong, '') = COALESCE(?, '')
LIMIT 1
`;

const updateWildfireEndSql = `
UPDATE wildfire_data
SET
    endyear = COALESCE(?, endyear),
    endmonth = COALESCE(?, endmonth),
    endday = COALESCE(?, endday),
    endtime = COALESCE(?, endtime),
    locbunji = COALESCE(locbunji, ?)
WHERE id = ?
`;

const insertWildfireSql = `
INSERT INTO wildfire_data (
    startyear,
    startmonth,
    startday,
    starttime,
    startdayofweek,
    endyear,
    endmonth,
    endday,
    endtime,
    locsi,
    locgungu,
    locmenu,
    locdong,
    locbunji,
    firecause,
    damagearea
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function emptyToNull(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

function wildfireKeyValues(item) {
    return [
        emptyToNull(item.startyear),
        emptyToNull(item.startmonth),
        emptyToNull(item.startday),
        emptyToNull(item.starttime),
        emptyToNull(item.locsi),
        emptyToNull(item.locgungu),
        emptyToNull(item.locmenu),
        emptyToNull(item.locdong),
        emptyToNull(item.locbunji)
    ];
}

function wildfireNearKeyValues(item) {
    return [
        emptyToNull(item.startyear),
        emptyToNull(item.startmonth),
        emptyToNull(item.startday),
        emptyToNull(item.starttime),
        emptyToNull(item.locsi),
        emptyToNull(item.locgungu),
        emptyToNull(item.locmenu),
        emptyToNull(item.locdong)
    ];
}

function wildfireInsertValues(item) {
    return [
        emptyToNull(item.startyear),
        emptyToNull(item.startmonth),
        emptyToNull(item.startday),
        emptyToNull(item.starttime),
        emptyToNull(item.startdayofweek),
        emptyToNull(item.endyear),
        emptyToNull(item.endmonth),
        emptyToNull(item.endday),
        emptyToNull(item.endtime),
        emptyToNull(item.locsi),
        emptyToNull(item.locgungu),
        emptyToNull(item.locmenu),
        emptyToNull(item.locdong),
        emptyToNull(item.locbunji),
        emptyToNull(item.firecause),
        item.damagearea === undefined || item.damagearea === null || item.damagearea === ''
            ? null
            : Number(item.damagearea)
    ];
}

function wildfireEndUpdateValues(id, item) {
    return [
        emptyToNull(item.endyear),
        emptyToNull(item.endmonth),
        emptyToNull(item.endday),
        emptyToNull(item.endtime),
        emptyToNull(item.locbunji),
        id
    ];
}

function openDatabase() {
    if (!fs.existsSync(dbFolder)) {
        fs.mkdirSync(dbFolder, { recursive: true });
    }

    return new sqlite3.Database(dbPath);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function callback(error) {
            if (error) {
                reject(error);
                return;
            }

            resolve(this);
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

function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

async function ensureSchema(db) {
    try {
        await run(db, createWildfireTableSql);
    } catch (error) {
        console.error('[db] wildfire_data 테이블 준비 실패:', error.message);
        throw error;
    }
}

async function saveWildfireData(db, items) {
    let insertedCount = 0;

    for (const item of items) {
        if (!item) {
            continue;
        }

        const hasDate = item.startyear && item.startmonth && item.startday;
        const hasLocation = item.locsi || item.locgungu || item.locmenu || item.locdong || item.locbunji;

        if (!hasDate && !hasLocation) {
            console.error('[db] 날짜와 주소가 모두 비어 있어 저장을 건너뜁니다:', item);
            continue;
        }

        try {
            const duplicated = await get(db, duplicateCheckSql, wildfireKeyValues(item));
            if (duplicated) {
                await run(db, updateWildfireEndSql, wildfireEndUpdateValues(duplicated.id, item));
                continue;
            }

            const nearDuplicated = await get(db, nearDuplicateCheckSql, wildfireNearKeyValues(item));
            if (nearDuplicated) {
                await run(db, updateWildfireEndSql, wildfireEndUpdateValues(nearDuplicated.id, item));
                continue;
            }

            const result = await run(db, insertWildfireSql, wildfireInsertValues(item));
            insertedCount += result.changes || 0;
        } catch (error) {
            console.error('[db] 산불 데이터 저장 실패:', error.message, item);
        }
    }

    return insertedCount;
}

module.exports = {
    dbPath,
    openDatabase,
    ensureSchema,
    saveWildfireData,
    closeDatabase
};
