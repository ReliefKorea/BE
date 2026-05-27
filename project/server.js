import express from 'express';
import cors from 'cors';
import axios from 'axios';
import xml2js from 'xml2js';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import loadEnv from '../loadEnv.js';

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(BACKEND_ROOT, process.env.DATABASE_PATH)
  : path.resolve(BACKEND_ROOT, 'data', 'disaster.sqlite');
const GDACS_API_URL = process.env.GDACS_API_URL || 'https://www.gdacs.org/xml/rss_7d.xml';

app.set('etag', false);
app.use(cors());
app.use(express.json());

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'disaster-be'
  });
});

function openDatabase() {
  return new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
}

function openWritableDatabase() {
  return new sqlite3.Database(DB_PATH);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
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

async function allOrEmpty(db, sql, params = []) {
  try {
    return await all(db, sql, params);
  } catch (error) {
    if (error.message?.includes('no such table')) {
      return [];
    }

    throw error;
  }
}

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function optionalText(value) {
  const normalized = text(value);
  return normalized || undefined;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanFromDb(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = text(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isoFromKoreanDateTime(value) {
  const raw = text(value);
  if (!raw) {
    return new Date(0).toISOString();
  }

  const normalized = raw.replace(' ', 'T');
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized);
  const date = new Date(hasTimezone ? normalized : `${normalized}+09:00`);

  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function isoFromNewsDate(value) {
  const raw = text(value);
  if (!raw) {
    return new Date(0).toISOString();
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? isoFromKoreanDateTime(raw) : date.toISOString();
}

function dateOnly(value) {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString().slice(0, 10);
}

function isoFromCompactDateTime(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/);

  if (!match) {
    return isoFromKoreanDateTime(raw);
  }

  const [, year, month, day, hour, minute, second = '00'] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`).toISOString();
}

function isoFromDateParts(year, month, day, timeValue = '00:00:00') {
  const y = text(year);
  const m = String(month ?? '').padStart(2, '0');
  const d = String(day ?? '').padStart(2, '0');
  const t = text(timeValue, '00:00:00');

  if (!y || !m || !d) {
    return new Date(0).toISOString();
  }

  return isoFromKoreanDateTime(`${y}-${m}-${d}T${t}`);
}

function statusFromDate(isoValue) {
  const eventTime = new Date(isoValue).getTime();
  if (!Number.isFinite(eventTime)) {
    return 'monitoring';
  }

  const ageDays = (Date.now() - eventTime) / 86400000;
  if (ageDays <= 3) return 'active';
  if (ageDays <= 14) return 'monitoring';
  if (ageDays <= 30) return 'recovery';
  return 'closed';
}

function typhoonSeverity(windSpeed) {
  const speed = number(windSpeed) ?? 0;
  if (speed >= 44) return 'critical';
  if (speed >= 33) return 'high';
  if (speed >= 17) return 'medium';
  return 'low';
}

function earthquakeSeverity(magnitude) {
  const mt = number(magnitude) ?? 0;
  if (mt >= 5) return 'critical';
  if (mt >= 4) return 'high';
  if (mt >= 3) return 'medium';
  return 'low';
}

const MIN_DISASTER_INTENSITY = 5;
const INTENSITY_NUMERALS = [
  ['\u216B', 12],
  ['\u216A', 11],
  ['\u2169', 10],
  ['\u2168', 9],
  ['\u2167', 8],
  ['\u2166', 7],
  ['\u2165', 6],
  ['\u2164', 5],
  ['\u2163', 4],
  ['\u2162', 3],
  ['\u2161', 2],
  ['\u2160', 1]
];

function earthquakeIntensity(value) {
  const raw = text(value);
  const numericMatch = raw.match(/\d+/);
  if (numericMatch) return Number(numericMatch[0]);

  const match = INTENSITY_NUMERALS.find(([numeral]) => raw.includes(numeral));
  return match ? match[1] : null;
}

function isDisasterEarthquake(row) {
  const intensity = earthquakeIntensity(row.inT);
  return intensity !== null && intensity >= MIN_DISASTER_INTENSITY;
}

function wildfireSeverity(damageArea) {
  const area = number(damageArea) ?? 0;
  if (area >= 10) return 'critical';
  if (area >= 1) return 'high';
  if (area >= 0.1) return 'medium';
  return 'low';
}

const REGION_COORDS = {
  서울: [37.5665, 126.9780],
  부산: [35.1796, 129.0756],
  대구: [35.8714, 128.6014],
  인천: [37.4563, 126.7052],
  광주: [35.1595, 126.8526],
  대전: [36.3504, 127.3845],
  울산: [35.5384, 129.3114],
  세종: [36.4800, 127.2890],
  경기: [37.4138, 127.5183],
  강원: [37.8228, 128.1555],
  충북: [36.6357, 127.4914],
  충남: [36.5184, 126.8000],
  전북: [35.7175, 127.1530],
  전남: [34.8679, 126.9910],
  경북: [36.4919, 128.8889],
  경남: [35.4606, 128.2132],
  제주: [33.4996, 126.5312]
};

function coordsFromRegion(regionText) {
  const region = text(regionText);
  const key = Object.keys(REGION_COORDS).find(name => region.includes(name));
  return key ? REGION_COORDS[key] : null;
}

function hasUsableCoords(lat, lng) {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

function publisherFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '뉴스';
  }
}

function mapTyphoon(row) {
  const lat = number(row.lat);
  const lng = number(row.lon);
  if (!hasUsableCoords(lat, lng)) return null;

  const startedAt = isoFromCompactDateTime(row.tmFc || row.tm);
  const updatedAt = isoFromCompactDateTime(row.tm || row.tmFc);
  const name = text(row.typ_name, `태풍 ${row.seq}`);
  const location = text(row.typ_loc, '위치 정보 없음');
  const windSpeed = number(row.ws ?? row.typ_ws) ?? 0;

  return {
    event_id: `typhoon_${row.seq}_${row.tmFc}`,
    title: `${name} 태풍`,
    disaster_type: 'typhoon',
    region_name: location,
    center_lat: lat,
    center_lng: lng,
    severity: typhoonSeverity(windSpeed),
    status: statusFromDate(updatedAt),
    started_at: startedAt,
    updated_at: updatedAt,
    official_summary: `${location} 기준 최대 풍속 ${windSpeed}m/s로 관측 또는 예측되었습니다.`,
    help_status: 'none',
    source_confidence: 'verified'
  };
}

function mapEarthquake(row) {
  const lat = number(row.lat);
  const lng = number(row.lon);
  if (!hasUsableCoords(lat, lng)) return null;
  if (!isDisasterEarthquake(row)) return null;

  const startedAt = isoFromCompactDateTime(row.tmEqk || row.tmFc);
  const updatedAt = isoFromCompactDateTime(row.tmFc || row.tmEqk);
  const location = text(row.loc, '위치 정보 없음');
  const magnitude = number(row.mt) ?? 0;
  const intensity = earthquakeIntensity(row.inT);
  const severity = earthquakeSeverity(magnitude);

  return {
    event_id: `earthquake_${row.id}`,
    title: `${location} 규모 ${magnitude} 지진`,
    disaster_type: 'earthquake',
    region_name: location,
    center_lat: lat,
    center_lng: lng,
    severity: intensity >= MIN_DISASTER_INTENSITY && severity === 'low' ? 'medium' : severity,
    status: statusFromDate(startedAt),
    started_at: startedAt,
    updated_at: updatedAt,
    official_summary: `규모 ${magnitude}, 깊이 ${text(row.dep, '미상')}km 지진 정보입니다.`,
    help_status: 'none',
    source_confidence: 'verified'
  };
}

function mapWildfire(row) {
  const regionName = [row.locsi, row.locgungu, row.locmenu, row.locdong].filter(Boolean).join(' ');
  // Wildfire source rows do not contain coordinates, so use a province-level map fallback.
  const coords = coordsFromRegion(regionName);
  if (!coords) return null;

  const startedAt = isoFromDateParts(row.startyear, row.startmonth, row.startday, row.starttime);
  const updatedAt = row.endyear
    ? isoFromDateParts(row.endyear, row.endmonth, row.endday, row.endtime || row.starttime)
    : startedAt;
  const damageArea = number(row.damagearea) ?? 0;

  return {
    event_id: `wildfire_${row.id}`,
    title: `${text(regionName, '산불 발생 지역')} 산불`,
    disaster_type: 'wildfire',
    region_name: text(regionName, '위치 정보 없음'),
    center_lat: coords[0],
    center_lng: coords[1],
    severity: wildfireSeverity(damageArea),
    status: row.endyear ? 'closed' : statusFromDate(startedAt),
    started_at: startedAt,
    updated_at: updatedAt,
    official_summary: `원인: ${text(row.firecause, '미상')}. 피해 면적은 약 ${damageArea}ha입니다.`,
    help_status: 'none',
    source_confidence: 'verified'
  };
}

async function readEvents() {
  const db = openDatabase();

  try {
    const typhoonRows = await allOrEmpty(db, `
      WITH latest_base AS (
        SELECT seq, MAX(tmFc) AS latest_tmFc
        FROM typhoon_data
        GROUP BY seq
      ),
      latest_point AS (
        SELECT t.seq, t.tmFc, MAX(t.tm) AS latest_tm
        FROM typhoon_data t
        JOIN latest_base latest
          ON latest.seq = t.seq
         AND latest.latest_tmFc = t.tmFc
        GROUP BY t.seq, t.tmFc
      )
      SELECT t.*
      FROM typhoon_data t
      JOIN latest_point latest
        ON latest.seq = t.seq
       AND latest.tmFc = t.tmFc
       AND latest.latest_tm = t.tm
      ORDER BY t.tmFc DESC, t.seq DESC
      LIMIT 50
    `);
    const earthquakeRows = await allOrEmpty(db, `
      SELECT *
      FROM earthquake_data
      ORDER BY tmEqk DESC, id DESC
    `);
    const wildfireRows = await allOrEmpty(db, `
      SELECT *
      FROM wildfire_data
      ORDER BY CAST(startyear AS INTEGER) DESC,
               CAST(startmonth AS INTEGER) DESC,
               CAST(startday AS INTEGER) DESC,
               id DESC
      LIMIT 100
    `);
    return [
      ...typhoonRows.map(mapTyphoon),
      ...earthquakeRows.map(mapEarthquake),
      ...wildfireRows.map(mapWildfire)
    ]
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  } finally {
    await closeDatabase(db);
  }
}

function articleQueryForEvent(event) {
  if (event.disaster_type === 'typhoon') {
    const match = event.event_id.match(/^typhoon_(.+)_(\d{12})$/);
    if (!match) return null;

    return {
      sql: `
        SELECT *
        FROM naver_news
        WHERE disaster_type = ?
          AND disaster_key LIKE ?
          AND source_time = ?
        ORDER BY pubDate DESC, id DESC
        LIMIT 20
      `,
      params: ['typhoon', `${match[1]}:%`, match[2]]
    };
  }

  const match = event.event_id.match(/^(earthquake|wildfire)_(.+)$/);
  if (!match) return null;

  return {
    sql: `
      SELECT *
      FROM naver_news
      WHERE disaster_type = ?
        AND disaster_key = ?
      ORDER BY pubDate DESC, id DESC
      LIMIT 20
    `,
    params: [match[1], match[2]]
  };
}

function articleWasPublishedAfterEvent(row, event) {
  const publishedAt = new Date(isoFromNewsDate(row.pubDate || row.saved_at));
  const startedAt = new Date(event.started_at);

  if (Number.isNaN(publishedAt.getTime()) || Number.isNaN(startedAt.getTime())) {
    return false;
  }

  return publishedAt >= startedAt;
}

function mapArticle(row, eventId) {
  const url = text(row.originallink || row.link, '#');

  return {
    article_id: `news_${row.id}`,
    event_id: eventId,
    publisher: publisherFromUrl(url),
    title: text(row.title, '제목 없음'),
    published_at: isoFromNewsDate(row.pubDate || row.saved_at),
    summary: text(row.description, ''),
    url,
    image_url: text(row.image_url, '')
  };
}

async function readArticlesForEvent(eventId) {
  const events = await readEvents();
  const event = events.find(item => item.event_id === eventId);
  if (!event) {
    return [];
  }

  const query = articleQueryForEvent(event);
  if (!query) {
    return [];
  }

  const db = openDatabase();

  try {
    const rows = await allOrEmpty(db, query.sql, query.params);
    return rows
      .filter(row => articleWasPublishedAfterEvent(row, event))
      .map(row => mapArticle(row, eventId));
  } finally {
    await closeDatabase(db);
  }
}

function stableSlug(value) {
  return text(value).replace(/[^A-Za-z0-9_]+/g, '_');
}

function firstEventIdByType(events, disasterType, fallbackEventId) {
  return events.find(event => event.disaster_type === disasterType)?.event_id ?? fallbackEventId;
}

function supportedDisasterType(value) {
  const normalized = text(value);
  return ['wildfire', 'typhoon', 'earthquake'].includes(normalized) ? normalized : undefined;
}

async function countRows(db, tableName) {
  const row = await get(db, `SELECT COUNT(*) AS count FROM ${tableName}`);
  return number(row?.count) ?? 0;
}

function buildContractSeeds(events) {
  const typhoonEventId = firstEventIdByType(events, 'typhoon', 'typhoon_seed_1');
  const earthquakeEventId = firstEventIdByType(events, 'earthquake', 'earthquake_seed_1');
  const wildfireEventId = firstEventIdByType(events, 'wildfire', 'wildfire_seed_1');
  const typhoonOrgId = `org_redcross_${stableSlug(typhoonEventId)}`;
  const earthquakeOrgId = `org_relief_${stableSlug(earthquakeEventId)}`;
  const wildfireOrgId = `org_forest_${stableSlug(wildfireEventId)}`;

  return {
    officialUpdates: [
      {
        update_id: `upd_${stableSlug(typhoonEventId)}_1`,
        event_id: typhoonEventId,
        source_name: '기상청',
        source_type: '태풍정보',
        issued_at: '2026-05-07T01:00:00.000Z',
        title: '태풍 진로 및 강풍 영향 모니터링',
        summary: '기상청 태풍 자료를 기준으로 강풍 영향 가능 지역을 모니터링하고 있습니다.',
        original_link: 'https://www.weather.go.kr'
      },
      {
        update_id: `upd_${stableSlug(earthquakeEventId)}_1`,
        event_id: earthquakeEventId,
        source_name: '기상청',
        source_type: '지진정보',
        issued_at: '2026-05-03T14:59:36.000Z',
        title: '지진 발생 정보 확인',
        summary: '공식 지진 통보를 기준으로 발생 위치와 규모 정보를 확인했습니다.',
        original_link: 'https://www.weather.go.kr'
      },
      {
        update_id: `upd_${stableSlug(wildfireEventId)}_1`,
        event_id: wildfireEventId,
        source_name: '산림청',
        source_type: '산불통계',
        issued_at: '2025-12-10T05:19:00.000Z',
        title: '산불 발생 기록 확인',
        summary: '산림청 산불 발생 자료를 기준으로 위치와 피해 면적을 확인했습니다.',
        original_link: 'https://www.forest.go.kr'
      }
    ],
    organizationActions: [
      {
        org_id: typhoonOrgId,
        event_id: typhoonEventId,
        org_name: '대한적십자사',
        activity_region: '태풍 영향권',
        activity_type: '긴급 구호 준비',
        activity_summary: '태풍 영향 가능 지역의 대피소 운영과 긴급 구호품 배분 준비를 진행 중입니다.',
        ai_message: '안전한 대피와 기본 생필품 지원이 우선입니다.',
        donation_link: 'https://www.redcross.or.kr',
        volunteer_link: 'https://www.redcross.or.kr/volunteer',
        evidence_note: '공식 구호단체 기본 활동 seed 데이터',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      },
      {
        org_id: earthquakeOrgId,
        event_id: earthquakeEventId,
        org_name: '재난구호협회',
        activity_region: '지진 발생 지역',
        activity_type: '임시 대피 지원',
        activity_summary: '지진 발생 지역 주민을 위한 임시 대피 안내와 기본 물품 지원을 준비합니다.',
        ai_message: '여진 가능성에 대비해 안전한 장소 확보가 필요합니다.',
        donation_link: 'https://www.relief.or.kr',
        volunteer_link: '',
        evidence_note: '지진 대응 시나리오 seed 데이터',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      },
      {
        org_id: wildfireOrgId,
        event_id: wildfireEventId,
        org_name: '산림재난지원센터',
        activity_region: '산불 발생 지역',
        activity_type: '복구 지원',
        activity_summary: '산불 피해 지역의 생필품 전달과 복구 자원 연계를 준비합니다.',
        ai_message: '진화 이후에도 생활 복구와 심리 지원이 이어져야 합니다.',
        donation_link: '',
        volunteer_link: 'https://www.forest.go.kr',
        evidence_note: '산불 복구 시나리오 seed 데이터',
        verified_by_admin: 1,
        last_checked_at: '2026-05-20T00:00:00.000Z'
      }
    ],
    donationRecords: [
      {
        record_id: `rec_${stableSlug(typhoonOrgId)}_1`,
        org_id: typhoonOrgId,
        date: '2026-05-20',
        title: '태풍 대비 긴급 구호품 준비',
        amount: '₩12,000,000',
        beneficiaries: 300,
        region: '태풍 영향권',
        description: '대피소 운영에 필요한 식수, 담요, 위생용품을 우선 확보했습니다.',
        disaster_type: 'typhoon'
      },
      {
        record_id: `rec_${stableSlug(earthquakeOrgId)}_1`,
        org_id: earthquakeOrgId,
        date: '2026-05-20',
        title: '지진 피해 임시 대피 물품 지원',
        amount: '₩8,500,000',
        beneficiaries: 180,
        region: '지진 발생 지역',
        description: '임시 대피 주민을 위한 기본 생필품과 안전 안내 물품을 준비했습니다.',
        disaster_type: 'earthquake'
      },
      {
        record_id: `rec_${stableSlug(wildfireOrgId)}_1`,
        org_id: wildfireOrgId,
        date: '2026-05-20',
        title: '산불 피해 복구 물품 지원',
        amount: '₩9,300,000',
        beneficiaries: 150,
        region: '산불 발생 지역',
        description: '피해 가구 복구를 위한 생필품과 임시 주거 지원 물품을 준비했습니다.',
        disaster_type: 'wildfire'
      }
    ]
  };
}

async function ensureSeedTables() {
  const events = await readEvents();
  const seeds = buildContractSeeds(events);
  const db = openWritableDatabase();

  try {
    await run(db, `
      CREATE TABLE IF NOT EXISTS official_updates (
        update_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        original_link TEXT
      )
    `);
    await run(db, `
      CREATE TABLE IF NOT EXISTS organization_actions (
        org_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        org_name TEXT NOT NULL,
        activity_region TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        activity_summary TEXT NOT NULL,
        ai_message TEXT,
        donation_link TEXT,
        volunteer_link TEXT,
        evidence_note TEXT NOT NULL,
        verified_by_admin INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT NOT NULL
      )
    `);
    await run(db, `
      CREATE TABLE IF NOT EXISTS donation_records (
        record_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        amount TEXT,
        beneficiaries INTEGER,
        region TEXT NOT NULL,
        description TEXT NOT NULL,
        disaster_type TEXT
      )
    `);

    if (await countRows(db, 'official_updates') === 0) {
      for (const update of seeds.officialUpdates) {
        await run(db, `
          INSERT INTO official_updates (
            update_id, event_id, source_name, source_type, issued_at, title, summary, original_link
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          update.update_id,
          update.event_id,
          update.source_name,
          update.source_type,
          update.issued_at,
          update.title,
          update.summary,
          update.original_link
        ]);
      }
    }

    if (await countRows(db, 'organization_actions') === 0) {
      for (const org of seeds.organizationActions) {
        await run(db, `
          INSERT INTO organization_actions (
            org_id, event_id, org_name, activity_region, activity_type, activity_summary,
            ai_message, donation_link, volunteer_link, evidence_note, verified_by_admin, last_checked_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          org.org_id,
          org.event_id,
          org.org_name,
          org.activity_region,
          org.activity_type,
          org.activity_summary,
          org.ai_message,
          org.donation_link,
          org.volunteer_link,
          org.evidence_note,
          org.verified_by_admin,
          org.last_checked_at
        ]);
      }
    }

    if (await countRows(db, 'donation_records') === 0) {
      for (const record of seeds.donationRecords) {
        await run(db, `
          INSERT INTO donation_records (
            record_id, org_id, date, title, amount, beneficiaries, region, description, disaster_type
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          record.record_id,
          record.org_id,
          record.date,
          record.title,
          record.amount,
          record.beneficiaries,
          record.region,
          record.description,
          record.disaster_type
        ]);
      }
    }
  } finally {
    await closeDatabase(db);
  }
}

let seedTablesReady = null;

function ensureSeedTablesOnce() {
  if (!seedTablesReady) {
    seedTablesReady = ensureSeedTables().catch(error => {
      seedTablesReady = null;
      throw error;
    });
  }

  return seedTablesReady;
}

function mapOfficialUpdate(row) {
  return {
    update_id: text(row.update_id),
    event_id: text(row.event_id),
    source_name: text(row.source_name),
    source_type: text(row.source_type),
    issued_at: isoFromNewsDate(row.issued_at),
    title: text(row.title, '제목 없음'),
    summary: text(row.summary),
    ...(optionalText(row.original_link) ? { original_link: optionalText(row.original_link) } : {})
  };
}

const FOREST_FIRE_REPORT_URL = 'https://fd.forest.go.kr/ffas/pubConn/movePage/sub3.do';
const KMA_TYPHOON_REPORT_URL = 'https://www.weather.go.kr/w/hazard/typhoon/report.do';
const KMA_EARTHQUAKE_RECENT_URL = 'https://www.weather.go.kr/w/earthquake-volcano/recent.do';
const SAFE_KOREA_ACTION_GUIDE_BASE_URL = 'https://www.safekorea.go.kr/safekorea-kor/acts/nacts/action-guide.do?menuSn=4';

function safeKoreaGuideUrl(category, title) {
  return `${SAFE_KOREA_ACTION_GUIDE_BASE_URL}&category=${category}&actsHeaderTitle=${encodeURIComponent(title)}`;
}

function formatKoreanDateTime(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return '일시 미상';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function officialUpdate(update) {
  return {
    update_id: update.update_id,
    event_id: update.event_id,
    source_name: update.source_name,
    source_type: update.source_type,
    issued_at: isoFromNewsDate(update.issued_at),
    title: update.title,
    summary: update.summary,
    original_link: update.original_link
  };
}

function buildDynamicOfficialUpdates(event) {
  const eventId = event.event_id;
  const startedAt = formatKoreanDateTime(event.started_at);
  const updatedAt = formatKoreanDateTime(event.updated_at);

  if (event.disaster_type === 'wildfire') {
    return [
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_forest_report`,
        event_id: eventId,
        source_name: '산림청 국가산불정보시스템',
        source_type: '공식 상황 리포트',
        issued_at: event.updated_at,
        title: '산불발생정보',
        summary: `${event.region_name} 산불은 ${startedAt} 발생, ${updatedAt} 기준 상황이 갱신되었습니다. 산림청 원문에서 진화일시, 진행상태, 대응단계를 확인할 수 있습니다.`,
        original_link: FOREST_FIRE_REPORT_URL
      }),
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_wildfire_guide`,
        event_id: eventId,
        source_name: '국민재난안전포털',
        source_type: '국민행동요령',
        issued_at: event.updated_at,
        title: '산불 국민행동요령',
        summary: '산불 발생 시 산림과 불길에서 멀리 떨어지고, 재난문자와 지자체 안내를 확인하며, 안전한 장소로 대피해야 합니다.',
        original_link: safeKoreaGuideUrl('forestFires', '산불')
      })
    ];
  }

  if (event.disaster_type === 'earthquake') {
    return [
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_earthquake_report`,
        event_id: eventId,
        source_name: '기상청',
        source_type: '공식 지진 리포트',
        issued_at: event.updated_at,
        title: '최근 지진 발표 정보',
        summary: `${event.region_name} 지진은 ${startedAt} 기준으로 기록되었습니다. 기상청 원문에서 발생 위치, 규모, 깊이, 발표시각을 확인할 수 있습니다.`,
        original_link: KMA_EARTHQUAKE_RECENT_URL
      }),
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_earthquake_guide`,
        event_id: eventId,
        source_name: '국민재난안전포털',
        source_type: '국민행동요령',
        issued_at: event.updated_at,
        title: '지진 국민행동요령',
        summary: '흔들림이 멈출 때까지 몸을 보호하고, 낙하물과 유리창을 피하며, 안내에 따라 넓은 공간으로 대피해야 합니다.',
        original_link: safeKoreaGuideUrl('earthquake', '지진')
      })
    ];
  }

  if (event.disaster_type === 'typhoon') {
    return [
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_typhoon_report`,
        event_id: eventId,
        source_name: '기상청',
        source_type: '공식 태풍 리포트',
        issued_at: event.updated_at,
        title: '태풍통보문',
        summary: `${event.region_name} 태풍 정보는 ${updatedAt} 기준으로 갱신되었습니다. 기상청 원문에서 중심위치, 최대풍속, 이동방향, 예보 경로를 확인할 수 있습니다.`,
        original_link: KMA_TYPHOON_REPORT_URL
      }),
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_typhoon_guide`,
        event_id: eventId,
        source_name: '국민재난안전포털',
        source_type: '국민행동요령',
        issued_at: event.updated_at,
        title: '태풍 국민행동요령',
        summary: '태풍 진로와 도달 시간을 확인하고, 저지대와 해안가 접근을 피하며, 강풍 전 시설물을 고정하고 안전한 곳으로 대피해야 합니다.',
        original_link: safeKoreaGuideUrl('typhoon', '태풍')
      })
    ];
  }

  return [];
}

function mergeOfficialUpdates(dynamicUpdates, storedUpdates) {
  const seen = new Set();
  const merged = [];

  for (const update of [...dynamicUpdates, ...storedUpdates]) {
    const key = `${update.source_name}:${update.source_type}:${update.title}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(update);
  }

  return merged;
}

function mapOrganizationAction(row) {
  return {
    org_id: text(row.org_id),
    event_id: text(row.event_id),
    org_name: text(row.org_name),
    activity_region: text(row.activity_region),
    activity_type: text(row.activity_type),
    activity_summary: text(row.activity_summary),
    ...(optionalText(row.ai_message) ? { ai_message: optionalText(row.ai_message) } : {}),
    ...(optionalText(row.donation_link) ? { donation_link: optionalText(row.donation_link) } : {}),
    ...(optionalText(row.volunteer_link) ? { volunteer_link: optionalText(row.volunteer_link) } : {}),
    evidence_note: text(row.evidence_note),
    verified_by_admin: booleanFromDb(row.verified_by_admin),
    last_checked_at: isoFromNewsDate(row.last_checked_at)
  };
}

function mapDonationRecord(row) {
  const beneficiaries = number(row.beneficiaries);
  const disasterType = supportedDisasterType(row.disaster_type);

  return {
    record_id: text(row.record_id),
    org_id: text(row.org_id),
    date: dateOnly(row.date),
    title: text(row.title, '제목 없음'),
    ...(optionalText(row.amount) ? { amount: optionalText(row.amount) } : {}),
    ...(beneficiaries !== null ? { beneficiaries } : {}),
    region: text(row.region),
    description: text(row.description),
    ...(disasterType ? { disaster_type: disasterType } : {})
  };
}

async function readOfficialUpdatesForEvent(eventId) {
  await ensureSeedTablesOnce();
  const events = await readEvents();
  const event = events.find(item => item.event_id === eventId);
  const dynamicUpdates = event ? buildDynamicOfficialUpdates(event) : [];
  const db = openDatabase();

  try {
    const rows = await allOrEmpty(db, `
      SELECT *
      FROM official_updates
      WHERE event_id = ?
      ORDER BY issued_at DESC, update_id DESC
    `, [eventId]);
    return mergeOfficialUpdates(dynamicUpdates, rows.map(mapOfficialUpdate));
  } finally {
    await closeDatabase(db);
  }
}

async function readOrganizationsForEvent(eventId) {
  await ensureSeedTablesOnce();
  const db = openDatabase();

  try {
    const rows = await allOrEmpty(db, `
      SELECT *
      FROM organization_actions
      WHERE event_id = ?
      ORDER BY last_checked_at DESC, org_name ASC
    `, [eventId]);
    return rows.map(mapOrganizationAction);
  } finally {
    await closeDatabase(db);
  }
}

async function readOrganizationById(orgId) {
  await ensureSeedTablesOnce();
  const db = openDatabase();

  try {
    const row = await get(db, `
      SELECT *
      FROM organization_actions
      WHERE org_id = ?
    `, [orgId]);
    return row ? mapOrganizationAction(row) : null;
  } finally {
    await closeDatabase(db);
  }
}

async function readDonationHistoryForOrg(orgId) {
  await ensureSeedTablesOnce();
  const db = openDatabase();

  try {
    const rows = await allOrEmpty(db, `
      SELECT *
      FROM donation_records
      WHERE org_id = ?
      ORDER BY date DESC, record_id DESC
    `, [orgId]);
    return rows.map(mapDonationRecord);
  } finally {
    await closeDatabase(db);
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(text(value, '[]'));
    return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
  } catch (_) {
    return [];
  }
}

function supportedIngestionStatus(value) {
  const normalized = text(value);
  return ['success', 'partial_failure', 'failed'].includes(normalized) ? normalized : 'failed';
}

function mapIngestionRun(row) {
  return {
    run_id: text(row.run_id),
    started_at: isoFromNewsDate(row.started_at),
    finished_at: isoFromNewsDate(row.finished_at),
    status: supportedIngestionStatus(row.status),
    sources: parseJsonArray(row.sources),
    inserted_count: number(row.inserted_count) ?? 0,
    updated_count: number(row.updated_count) ?? 0,
    skipped_count: number(row.skipped_count) ?? 0,
    error_message: optionalText(row.error_message) ?? null
  };
}

async function readLatestIngestionRun() {
  const db = openDatabase();

  try {
    const row = await get(db, `
      SELECT *
      FROM ingestion_runs
      ORDER BY started_at DESC, run_id DESC
      LIMIT 1
    `);
    return row ? mapIngestionRun(row) : null;
  } catch (error) {
    if (error.message?.includes('no such table')) {
      return null;
    }

    throw error;
  } finally {
    await closeDatabase(db);
  }
}

app.get('/api/events', async (req, res) => {
  try {
    const events = await readEvents();
    res.json(events);
  } catch (error) {
    console.error('Error reading normalized events:', error.message);
    res.status(500).json({
      error: 'Failed to fetch events',
      message: error.message
    });
  }
});

app.get('/api/events/:eventId', async (req, res) => {
  try {
    const events = await readEvents();
    const event = events.find(item => item.event_id === req.params.eventId);

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    res.json(event);
  } catch (error) {
    console.error('Error reading normalized event:', error.message);
    res.status(500).json({
      error: 'Failed to fetch event',
      message: error.message
    });
  }
});

app.get('/api/events/:eventId/articles', async (req, res) => {
  try {
    const articles = await readArticlesForEvent(req.params.eventId);
    res.json(articles);
  } catch (error) {
    console.error('Error reading event articles:', error.message);
    res.status(500).json({
      error: 'Failed to fetch articles',
      message: error.message
    });
  }
});

app.get('/api/events/:eventId/updates', async (req, res) => {
  try {
    const updates = await readOfficialUpdatesForEvent(req.params.eventId);
    res.json(updates);
  } catch (error) {
    console.error('Error reading official updates:', error.message);
    res.status(500).json({
      error: 'Failed to fetch updates',
      message: error.message
    });
  }
});

app.get('/api/events/:eventId/orgs', async (req, res) => {
  try {
    const organizations = await readOrganizationsForEvent(req.params.eventId);
    res.json(organizations);
  } catch (error) {
    console.error('Error reading event organizations:', error.message);
    res.status(500).json({
      error: 'Failed to fetch organizations',
      message: error.message
    });
  }
});

app.get('/api/orgs/:orgId', async (req, res) => {
  try {
    const organization = await readOrganizationById(req.params.orgId);

    if (!organization) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    res.json(organization);
  } catch (error) {
    console.error('Error reading organization:', error.message);
    res.status(500).json({
      error: 'Failed to fetch organization',
      message: error.message
    });
  }
});

app.get('/api/orgs/:orgId/history', async (req, res) => {
  try {
    const history = await readDonationHistoryForOrg(req.params.orgId);
    res.json(history);
  } catch (error) {
    console.error('Error reading organization history:', error.message);
    res.status(500).json({
      error: 'Failed to fetch organization history',
      message: error.message
    });
  }
});

app.get('/api/ingestion/status', async (req, res) => {
  try {
    const lastRun = await readLatestIngestionRun();
    res.json({ last_run: lastRun });
  } catch (error) {
    console.error('Error reading ingestion status:', error.message);
    res.status(500).json({
      error: 'Failed to fetch ingestion status',
      message: error.message
    });
  }
});

// Proxy endpoint to fetch GDACS data and bypass CORS
app.get('/api/disasters', async (req, res) => {
  try {
    const response = await axios.get(GDACS_API_URL);
    
    // Parse the XML
    const result = await xml2js.parseStringPromise(response.data);
    const items = result.rss?.channel[0]?.item || [];

    // Filter and format the data
    const formattedData = items.map(item => {
      // Determine Alert Level & Severity
      const alertLevel = item['gdacs:alertlevel'] ? item['gdacs:alertlevel'][0] : 'Green';
      let severity = 'Low';
      if (alertLevel === 'Red') severity = 'High';
      else if (alertLevel === 'Orange') severity = 'Medium';

      // Determine Lat / Lng
      let lat = 0;
      let lng = 0;
      if (item['geo:Point'] && item['geo:Point'][0]) {
        lat = parseFloat(item['geo:Point'][0]['geo:lat'][0]);
        lng = parseFloat(item['geo:Point'][0]['geo:long'][0]);
      } else if (item['georss:point']) {
        const parts = item['georss:point'][0].split(' ');
        lat = parseFloat(parts[0]);
        lng = parseFloat(parts[1]);
      }

      // Safe access for objects with attributes
      const plainText = (val) => val && val[0] ? (val[0]._ || val[0]) : '';

      return {
        id: plainText(item.guid) || Math.random().toString(),
        title: plainText(item['gdacs:eventname']) || plainText(item.title) || 'Unknown Event',
        eventType: plainText(item['gdacs:eventtype']) || 'Unknown Type',
        severity: severity,
        alertLevel: alertLevel,
        lat: lat,
        lng: lng,
        timestamp: item['gdacs:fromdate'] ? new Date(item['gdacs:fromdate'][0]).toISOString() : new Date(item.pubDate[0]).toISOString(),
        description: plainText(item.description),
        url: plainText(item.link) || '#'
      };
    });

    res.json(formattedData);
  } catch (error) {
    console.error('Error fetching GDACS data:', error.message);
    res.status(500).json({ error: 'Failed to fetch disaster data' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
