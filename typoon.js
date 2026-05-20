const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const loadEnv = require('./loadEnv');

loadEnv();

// 1. data 폴더가 없으면 자동으로 생성
const dbFolder = path.join(__dirname, 'data');
if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder);
}

// 2. data 폴더 안에 disaster.sqlite 데이터베이스 파일 연결 (없으면 자동 생성)
const dbPath = process.env.DATABASE_PATH
    ? path.resolve(__dirname, process.env.DATABASE_PATH)
    : path.join(dbFolder, 'disaster.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('데이터베이스 연결 실패:', err.message);
    } else {
        console.log('SQLite 데이터베이스에 성공적으로 연결되었습니다.');
    }
});

// 3. 테이블 생성 쿼리 실행
const createTableQuery = `
CREATE TABLE IF NOT EXISTS typhoon_data (
    seq INTEGER,                     -- 태풍번호
    tm TEXT,                         -- 예상 시각
    tmFc TEXT,                       -- 발표 시각
    typ_name TEXT,                   -- 태풍 이름
    typ_loc TEXT,                    -- 현재 위치
    typ_ws REAL,                     -- 최대 풍속
    img TEXT,                        -- 이미지 경로
    lat REAL,                        -- 위도
    lon REAL,                        -- 경도
    dir TEXT,                        -- 진행방향
    sp REAL,                         -- 이동속도
    rad15 REAL,                      -- 강풍 반경
    ws REAL,                         -- 예상 최대 풍속
    status TEXT,                     -- 상태표시
    PRIMARY KEY (seq, tm)            -- 태풍번호와 시각을 조합하여 PK로 사용 (시간대별 중복 방지)
);
`;

// 테이블 생성이 완료된 후 API 조회를 시작하도록 콜백 처리
db.run(createTableQuery, (err) => {
    if (err) {
        console.error('테이블 생성 실패:', err.message);
    } else {
        console.log('typhoon_data 테이블이 준비되었습니다!\n');
        getTyphoonData(); // API 호출 시작
    }
});

// 4. API 설정 정보
const INFO_URL = 'http://apis.data.go.kr/1360000/TyphoonInfoService/getTyphoonInfo'; 
const FCST_URL = 'http://apis.data.go.kr/1360000/TyphoonInfoService/getTyphoonFcst'; 
const SERVICE_KEY = process.env.KMA_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;

async function getTyphoonData() {
    try {
        if (!SERVICE_KEY) {
            throw new Error('KMA_SERVICE_KEY or PUBLIC_DATA_SERVICE_KEY environment variable is required.');
        }

        const today = new Date();
        const threeDaysAgo = new Date(today);
        threeDaysAgo.setDate(today.getDate() - 2); // 2일 전으로 설정하여 안전하게 조회

        const formatDate = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };

        const infoParams = {
            serviceKey: SERVICE_KEY,
            numOfRows: 10,
            pageNo: 1,
            dataType: 'JSON',    
            fromTmFc: formatDate(threeDaysAgo), 
            toTmFc: formatDate(today)    
        };

        const infoResponse = await axios.get(INFO_URL, { params: infoParams });
        const infoResult = infoResponse.data.response;
        
        if (infoResult.header.resultCode === '00') {
            console.log("태풍 API 데이터를 성공적으로 불러왔습니다. DB 저장을 시작합니다...\n");
            
            const items = infoResult.body.items.item;
            const itemList = Array.isArray(items) ? items : [items];

            for (const item of itemList) {
                const tmFc = item.tmFc;
                const typSeq = item.typSeq;
                const typName = item.typName;
                const typLoc = item.typLoc;
                const typWs = item.typWs;
                const img = item.img;

                console.log(`===== [태풍 이름: ${typName} (태풍번호: ${typSeq})] =====`);
                
                const fcstParams = {
                    serviceKey: SERVICE_KEY,
                    numOfRows: 10,
                    pageNo: 1,
                    dataType: 'JSON',
                    tmFc: tmFc,
                    typSeq: typSeq
                };

                try {
                    const fcstResponse = await axios.get(FCST_URL, { params: fcstParams });
                    const fcstResult = fcstResponse.data.response;

                    if (fcstResult.header.resultCode === '00') {
                        const fcstItems = fcstResult.body.items.item;
                        if (!fcstItems) {
                            console.log("상세 예측 정보가 없습니다.");
                        } else {
                            const fcstList = Array.isArray(fcstItems) ? fcstItems : [fcstItems];

                            // SQL INSERT 준비 (중복 데이터가 있으면 덮어쓰도록 INSERT OR REPLACE 사용)
                            const stmt = db.prepare(`
                                INSERT OR REPLACE INTO typhoon_data 
                                (seq, tm, tmFc, typ_name, typ_loc, typ_ws, img, lat, lon, dir, sp, rad15, ws, status) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `);

                            fcstList.forEach((fcst, index) => {
                                const status = '예상'; // API에서 주지 않으므로 임의의 상태값 '예상' 부여

                                console.log(`  (${index + 1}) 태풍 예상 시각: ${fcst.tm}`);
                                console.log(`      위도(lat): ${fcst.lat}`);          
                                console.log(`      경도(lon): ${fcst.lon}`);          
                                console.log(`      진행방향(dir): ${fcst.dir}`);       
                                console.log(`      이동속도(sp): ${fcst.sp} km/h`);       
                                console.log(`      강풍 반경(rad15): ${fcst.rad15} km`);    
                                console.log(`      예상 최대 풍속(ws): ${fcst.ws} m/s`);

                                stmt.run(
                                    typSeq,         // seq
                                    fcst.tm,        // tm
                                    tmFc,           // tmFc
                                    typName,        // typ_name
                                    typLoc,         // typ_loc
                                    typWs,          // typ_ws
                                    img,            // img
                                    fcst.lat,       // lat
                                    fcst.lon,       // lon
                                    fcst.dir,       // dir
                                    fcst.sp,        // sp
                                    fcst.rad15,     // rad15
                                    fcst.ws,        // ws
                                    status          // status
                                );
                                
                                console.log(`  DB 저장 완료: 예상시각 ${fcst.tm}`);
                            });

                            stmt.finalize();
                        }
                    } else {
                        console.log(`상세 예측 정보 에러 발생: ${fcstResult.header.resultMsg}`);
                    }
                } catch (fcstError) {
                    console.error("상세 예측 API 호출 중 오류가 발생했습니다:", fcstError.message);
                }
                console.log('--------------------------------------------------\n');
            }
        } else {
            console.log(`에러 발생: ${infoResult.header.resultMsg}`); 
        }

    } catch (error) {
        console.error("API 호출 중 오류가 발생했습니다:", error.message);
    }
}
