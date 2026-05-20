const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const loadEnv = require('./loadEnv');

loadEnv();

// 통합 재난 데이터베이스 연결 (disaster.sqlite)
const dbFolder = path.join(__dirname, 'data');
const dbPath = process.env.DATABASE_PATH
    ? path.resolve(__dirname, process.env.DATABASE_PATH)
    : path.join(dbFolder, 'disaster.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('데이터베이스 연결 실패:', err.message);
    } else {
        console.log('홍수 데이터 처리를 위해 disaster.sqlite 데이터베이스에 연결되었습니다.');
    }
});

// 테이블 생성
const createTableQuery = `
CREATE TABLE IF NOT EXISTS flood_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tm TEXT,          -- 침수 발생 일시
    loc TEXT,         -- 침수 지역 상세 주소
    depth REAL,       -- 침수심
    area REAL,        -- 침수 면적
    cause TEXT,       -- 발생 원인
    status TEXT       -- 상태표시
);
`;

db.run(createTableQuery, (err) => {
    if (err) {
        console.error('테이블 생성 실패:', err.message);
    } else {
        console.log('flood_data 테이블이 준비되었습니다!\n');
        getFloodData();
    }
});

// API 설정 정보
const FLOOD_URL = 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00108';
const SERVICE_KEY = process.env.FLOOD_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;

async function getFloodData() {
    try {
        if (!SERVICE_KEY) {
            throw new Error('FLOOD_SERVICE_KEY or PUBLIC_DATA_SERVICE_KEY environment variable is required.');
        }

        const params = {
            serviceKey: SERVICE_KEY,
            returnType: 'json',
            pageNo: 1,
            numOfRows: 10
        };

        console.log(`[API 호출] 홍수 데이터를 가져오는 중...`);
        const response = await axios.get(FLOOD_URL, { params });
        
        const data = response.data;
        
        // 에러 확인 로직
        if (data && data.header && data.header.resultCode !== '00') {
            console.log(`[API 에러] 코드: ${data.header.resultCode}, 메시지: ${data.header.resultMsg}`);
            console.log(`(원인: 발급받으신 서비스키가 아직 사용 승인되지 않았거나, 인코딩 문제가 있을 수 있습니다.)`);
            return;
        }

        // 응답 데이터 구조가 명세서가 없어 불확실하므로, 실제 데이터 형태를 터미널에 출력
        console.log("\n[API 응답 성공] 데이터 형태 분석:");
        console.log(JSON.stringify(data, null, 2));

        // 데이터 파싱 및 INSERT 로직 (실제 필드명에 맞게 수정이 필요할 수 있습니다)
        // 플랫폼에 따라 body.items.item 이나 body[0] 등으로 올 수 있습니다.
        let itemList = [];
        if (data.body && data.body.items && data.body.items.item) {
            itemList = Array.isArray(data.body.items.item) ? data.body.items.item : [data.body.items.item];
        } else if (data.body && Array.isArray(data.body)) {
            itemList = data.body;
        }

        if (itemList.length === 0) {
            console.log("홍수(침수흔적) 데이터가 존재하지 않습니다.");
            return;
        }

        const stmt = db.prepare(`
            INSERT INTO flood_data (tm, loc, depth, area, cause, status) 
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        itemList.forEach((flood, index) => {
            // 아래 필드명(F_BEGIN_DE, INDD 등)은 임시 추정치입니다. 실제 콘솔에 찍힌 JSON을 보고 수정해야 합니다.
            const tm = flood.F_BEGIN_DE || flood.tm || '시간 미상'; 
            const loc = flood.loc || flood.address || '주소 미상';
            const depth = flood.INDD || flood.depth || 0;
            const area = flood.area || 0;
            const cause = flood.F_DSSTR_NM || flood.cause || '원인 미상';
            const status = '침수발생';

            console.log(`[${index + 1}] 일시: ${tm} / 위치: ${loc} / 침수심: ${depth}m`);

            stmt.run(tm, loc, depth, area, cause, status);
        });

        stmt.finalize(() => {
            console.log('\n모든 홍수 데이터가 DB에 저장되었습니다!');
        });

    } catch (error) {
        console.error("\nAPI 호출 중 네트워크/시스템 오류가 발생했습니다:");
        console.error(error.message);
    }
}
