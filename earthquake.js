const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const loadEnv = require('./loadEnv');

loadEnv();

// 1. data 폴더 확인 및 생성
const dbFolder = path.join(__dirname, 'data');
if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder);
}

// 2. 통합 재난 데이터베이스 연결 (disaster.sqlite)
const dbPath = process.env.DATABASE_PATH
    ? path.resolve(__dirname, process.env.DATABASE_PATH)
    : path.join(dbFolder, 'disaster.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('데이터베이스 연결 실패:', err.message);
    } else {
        console.log('지진 SQLite 데이터베이스에 성공적으로 연결되었습니다.');
    }
});

// 3. 지진 테이블 생성 쿼리 실행
const createTableQuery = `
CREATE TABLE IF NOT EXISTS earthquake_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- 자동 증가 고유 ID (같은 시각 발생 지진 구분용)
    tmEqk TEXT,                           -- 진원시 (지진 발생 시각)
    tmFc TEXT,                            -- 통보(발표) 시각
    tmSeq INTEGER,                        -- 발표 일련번호
    loc TEXT,                             -- 진앙 위치
    lat REAL,                             -- 위도
    lon REAL,                             -- 경도
    mt REAL,                              -- 지진 규모
    dep REAL,                             -- 지진 발생 깊이
    inT TEXT,                             -- 최대 진도
    img TEXT,                             -- 지진 위치 이미지 경로
    status TEXT                           -- 상태표시
);
`;

db.run(createTableQuery, (err) => {
    if (err) {
        console.error('테이블 생성 실패:', err.message);
    } else {
        console.log('earthquake_data 테이블이 준비되었습니다!\n');
        getEarthquakeData(); // 테이블 생성 후 API 호출
    }
});

// 4. API 설정 정보
const EQK_URL = 'http://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg'; 
const SERVICE_KEY = process.env.KMA_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;

async function getEarthquakeData() {
    try {
        if (!SERVICE_KEY) {
            throw new Error('KMA_SERVICE_KEY or PUBLIC_DATA_SERVICE_KEY environment variable is required.');
        }

        const today = new Date();
        const threeDaysAgo = new Date(today);
        threeDaysAgo.setDate(today.getDate() - 3); // 3일 전으로 설정

        const formatDate = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };

        const params = {
            serviceKey: SERVICE_KEY,
            numOfRows: 100, // 충분히 넉넉하게
            pageNo: 1,
            dataType: 'JSON',    
            fromTmFc: formatDate(threeDaysAgo), 
            toTmFc: formatDate(today)    
        };

        const response = await axios.get(EQK_URL, { params });
        const result = response.data.response;
        
        if (result.header.resultCode === '00') {
            console.log("지진 API 데이터를 성공적으로 불러왔습니다. DB 저장을 시작합니다...\n");
            
            // 데이터가 없을 경우 처리
            if (!result.body.items || !result.body.items.item) {
                console.log("최근 3일간 발표된 지진 정보가 없습니다.");
                return;
            }

            const items = result.body.items.item;
            const itemList = Array.isArray(items) ? items : [items];

            const stmt = db.prepare(`
                INSERT OR IGNORE INTO earthquake_data 
                (tmEqk, tmFc, tmSeq, loc, lat, lon, mt, dep, inT, img, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            itemList.forEach((eqk, index) => {
                const status = '발생'; // 임의의 상태표시

                console.log(`[${index + 1}] 진원시: ${eqk.tmEqk} / 규모: ${eqk.mt} / 위치: ${eqk.loc}`);

                stmt.run(
                    eqk.tmEqk,    // tmEqk
                    eqk.tmFc,     // tmFc
                    eqk.tmSeq,    // tmSeq
                    eqk.loc,      // loc
                    eqk.lat,      // lat
                    eqk.lon,      // lon
                    eqk.mt,       // mt
                    eqk.dep,      // dep
                    eqk.inT,      // inT
                    eqk.img,      // img
                    status        // status
                );
            });

            stmt.finalize(() => {
                console.log('\n모든 지진 데이터가 DB에 저장되었습니다!');
            });

        } else {
            console.log(`에러 발생: ${result.header.resultMsg}`); 
        }

    } catch (error) {
        console.error("API 호출 중 오류가 발생했습니다:", error.message);
    }
}
