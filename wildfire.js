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

const WILDFIRE_URL = 'http://apis.data.go.kr/1400000/forestStusService/getfirestatsservice';
const SERVICE_KEY = process.env.WILDFIRE_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;

const createTableQuery = `
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

const createUniqueIndexQuery = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_wildfire_data_event
ON wildfire_data (
    startyear,
    startmonth,
    startday,
    starttime,
    locsi,
    locgungu,
    locmenu,
    locdong,
    locbunji
);
`;

function openDatabase() {
    if (!fs.existsSync(dbFolder)) { // fs로 db풀더 있는지 확인
        fs.mkdirSync(dbFolder, { recursive: true });
    }

    return new sqlite3.Database(dbPath); // 생성자리턴
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

async function ensureWildfireSchema(db) {
    await run(db, createTableQuery); //산불 데이터를 저장할 테이블 만들기
    await run(db, createUniqueIndexQuery); // 2. 중복 데이터를 막기 위한 고유 인덱스(규칙) 만들기
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function normalizeItems(items) {
    if (!items) {
        return [];
    }

    return Array.isArray(items) ? items : [items];
}

async function fetchWildfireData() {
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);

    const params = {
        ServiceKey: SERVICE_KEY,
        numOfRows: 100,
        pageNo: 1,
        _type: 'json',
        searchStDt: formatDate(oneYearAgo),
        searchEdDt: formatDate(today)
    };

    const response = await axios.get(WILDFIRE_URL, { params }); //get방식으로 요청
    const result = response.data?.response; //결과를 받음.

    if (!result) {
        throw new Error('Unexpected API response format');
    }

    if (result.header?.resultCode !== '00') {
        throw new Error(result.header?.resultMsg || 'API returned an error');
    }

    return normalizeItems(result.body?.items?.item);
}

async function saveWildfireData(db, itemList) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO wildfire_data (
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
    `);

    let insertedCount = 0;

    try {
        for (const item of itemList) {
            insertedCount += await runStatement(stmt, [
                item.startyear || '',
                item.startmonth || '',
                item.startday || '',
                item.starttime || '',
                item.startdayofweek || '',
                item.endyear || '',
                item.endmonth || '',
                item.endday || '',
                item.endtime || '',
                item.locsi || '',
                item.locgungu || '',
                item.locmenu || '',
                item.locdong || '',
                item.locbunji || '',
                item.firecause || '',
                Number(item.damagearea || 0)
            ]);
        }
    } finally {
        await finalize(stmt);
    }

    return insertedCount;
}

async function main() {
    if (!SERVICE_KEY) {
        throw new Error('WILDFIRE_SERVICE_KEY or PUBLIC_DATA_SERVICE_KEY environment variable is required.');
    }

    const db = openDatabase(); //db 가져오기

    try {
        await ensureWildfireSchema(db); //중복 방지랑 기본 설정 끝날 때 까지 대기
        console.log(`DB ready: ${dbPath}`);
        console.log('Table ready: wildfire_data');

        const itemList = await fetchWildfireData(); //테이터 오청

        if (itemList.length === 0) {
            console.log('No wildfire data found for the requested period.');
            return;
        }

        const insertedCount = await saveWildfireData(db, itemList); //데이터 저장
        console.log(`Wildfire collection complete. fetched=${itemList.length}, inserted=${insertedCount}, skipped=${itemList.length - insertedCount}`);
    } catch (error) {
        console.error('Wildfire collection failed:', error.message);
        process.exitCode = 1;
    } finally {
        await close(db);
    }
}

main();
