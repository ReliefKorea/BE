import express from 'express';
import cors from 'cors';
import axios from 'axios';
import xml2js from 'xml2js';
import sqlite3 from 'sqlite3';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import loadEnv from '../loadEnv.js';
import { ensureRagSchema } from './ai/schema.js';
import {
  approveAiReport,
  listAiReportsForEvent,
  rejectAiReport,
  runOrgRag
} from './ai/ragPipeline.js';

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const configuredDbPath = process.env.DB_PATH || process.env.DATABASE_PATH;
const DB_PATH = configuredDbPath
  ? path.resolve(BACKEND_ROOT, configuredDbPath)
  : path.resolve(BACKEND_ROOT, 'data', 'disaster.sqlite');
const SCHEMA_PATH = path.resolve(BACKEND_ROOT, 'db', 'schema.sql');
const GDACS_API_URL = process.env.GDACS_API_URL || 'https://www.gdacs.org/xml/rss_7d.xml';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const POLL_ADMIN_TOKEN = process.env.POLL_ADMIN_TOKEN;
const RELIEF_ORG_DATA_PATH = path.join(BACKEND_ROOT, 'data', 'donation', 'korea_relief_organizations.json');
const DONATION_CRAWL_TIMEOUT_MS = 4000;
const DONATION_ORG_CACHE_MS = 60 * 60 * 1000;
const FALLBACK_RELIEF_ORGANIZATIONS = [
  {
    organization_id: 1,
    name_ko: '희망브리지 전국재해구호협회',
    relief_category: 'DIRECT_DISASTER_RELIEF',
    main_focus: '국내 재난·재해 성금 모금, 긴급구호, 임시주거, 심리회복 지원',
    donation_page_url: 'https://donate.hopebridge.or.kr/',
    campaign_page_url: 'https://www.hopebridge.or.kr/',
    source_url: 'https://www.hopebridge.or.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 2,
    name_ko: '사회복지공동모금회 사랑의열매',
    relief_category: 'NATIONAL_FUNDRAISING_AND_ALLOCATION',
    main_focus: '사회복지 모금·배분, 캠페인 모금, 지역 기반 지원',
    donation_page_url: 'https://www.chest.or.kr/',
    campaign_page_url: 'https://www.chest.or.kr/',
    source_url: 'https://www.chest.or.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 3,
    name_ko: '굿네이버스',
    relief_category: 'INTERNATIONAL_HUMANITARIAN_RELIEF',
    main_focus: '국내외 아동·지역사회 지원, 인도적지원, 캠페인후원',
    donation_page_url: 'https://www.goodneighbors.kr/',
    campaign_page_url: 'https://www.goodneighbors.kr/',
    source_url: 'https://www.goodneighbors.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 4,
    name_ko: '월드비전',
    relief_category: 'INTERNATIONAL_HUMANITARIAN_RELIEF',
    main_focus: '긴급구호, 자연재난구호, 해외사업, 국내사업',
    donation_page_url: 'https://my.worldvision.or.kr/',
    campaign_page_url: 'https://www.worldvision.or.kr/',
    source_url: 'https://www.worldvision.or.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 6,
    name_ko: '세이브더칠드런 코리아',
    relief_category: 'CHILD_HUMANITARIAN_RELIEF',
    main_focus: '아동권리, 해외 인도적지원, 기후위기대응, 긴급구호',
    donation_page_url: 'https://www.sc.or.kr/',
    campaign_page_url: 'https://www.sc.or.kr/',
    source_url: 'https://www.sc.or.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 8,
    name_ko: '한국해비타트',
    relief_category: 'DISASTER_HOUSING_REBUILD',
    main_focus: '주거취약계층 지원, 집고치기, 산불피해 주거 재건',
    donation_page_url: 'https://donate.habitat.or.kr/',
    campaign_page_url: 'https://www.habitat.or.kr/',
    source_url: 'https://www.habitat.or.kr/',
    data_confidence: 'HIGH'
  },
  {
    organization_id: 9,
    name_ko: '밀알복지재단',
    relief_category: 'VULNERABLE_GROUP_HUMANITARIAN_RELIEF',
    main_focus: '국내 위기가정·장애인지원, 인도적지원사업',
    donation_page_url: 'https://www.miral.org/',
    campaign_page_url: 'https://www.miral.org/',
    source_url: 'https://www.miral.org/',
    data_confidence: 'HIGH'
  }
];
const onDemandOrgRagRuns = new Map();
const backgroundOrgRagRuns = new Map();
const orgRagRefreshCooldowns = new Map();
let pollingInProgress = false;

const DEFAULT_ORG_RAG_LIMIT = 15;
const DEFAULT_PUBLIC_ORG_DISPLAY_LIMIT = 3;
const DEFAULT_ORG_RAG_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ORG_RAG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ORG_RAG_REFRESH_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ORG_RAG_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_EVENT_MEDIA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MOCK_CATEGORY_RAG_TTL_MS = 72 * 60 * 60 * 1000;
const EVENT_MEDIA_CACHE_VERSION = 'v2';
const EVENT_MEDIA_IMAGE_PARAMS = '?auto=format&fit=crop&w=1800&q=84';
const CATEGORY_MEDIA_FALLBACKS = {
  wildfire: [
    '1615092296061-e2ccfeb2f3d6', '1507680465142-ef2223e23308', '1619461129861-d0c1479c48b4',
    '1634009653379-a97409ee15de', '1511027643875-5cbb0439c8f1', '1692364221415-654b20e6d1d2',
    '1505017791108-7b40f307cdc5', '1473260079709-83c808703435', '1602980085374-7e743fff3cc6',
    '1536245344390-dbf1df63c30a', '1611174797136-5e167ea90d6c'
  ],
  earthquake: [
    '1677233860259-ce1a8e0f8498', '1621077742331-2df96a07cca7', '1603869311144-66b03d340b32',
    '1617252820855-a829ba1babe7', '1641213131995-06e2cf0790d8', '1617585411149-54e9fdf60348',
    '1677233861443-4aac86420db2', '1686620225824-d4120ed3a81e', '1702024249908-3d04f2c22d71',
    '1677233859838-be47b0ab6c4a', '1647125849914-5238985ab21a'
  ],
  typhoon: [
    '1454789476662-53eb23ba5907', '1641648543997-8244afb0eb86', '1600672202669-3521432b6302',
    '1601110958456-0bee398ce406', '1641648542860-4937848433cf', '1641648542375-ed3f5c6dd052',
    '1676900894925-d39174ba74db', '1656495782911-06e6a5f9bef5', '1533922115281-16a28dffcc2e',
    '1641648542179-5fe991ff96e9', '1641648542473-0b4e73fe2e2b'
  ],
  heavy_rain: [
    '1547683905-f686c993aae5', '1600336153113-d66c79de3e91', '1485617359743-4dc5d2e53c89',
    '1604275689235-fdc521556c16', '1558448495-5ef3fce92344', '1657069345471-c54f2432b79c',
    '1612038385745-53cfb4fbd19b', '1541710005980-7ea80ff232d6', '1581059686229-de26e6ae5dc4',
    '1657069342866-2d11c2509b02', '1617494532490-297fc0eb515e'
  ],
  default: ['1469571486292-0ba58a3f068b']
};
const CATEGORY_MEDIA_ALT = {
  wildfire: '산불 피해 현장',
  earthquake: '지진 피해와 안전 점검 현장',
  typhoon: '태풍과 강풍 피해 현장',
  heavy_rain: '집중호우와 침수 피해 현장',
  default: '재난 구호 활동 현장'
};
const ORGANIZATION_MEDIA_FALLBACKS = [
  {
    image_url: 'https://images.unsplash.com/photo-1469571486292-0ba58a3f068b?auto=format&fit=crop&w=1200&q=82',
    image_alt: '지역사회 구호 활동에 참여하는 사람들'
  },
  {
    image_url: 'https://images.unsplash.com/photo-1559027615-cd4628902d4a?auto=format&fit=crop&w=1200&q=82',
    image_alt: '함께 구호 활동을 준비하는 자원봉사자들'
  },
  {
    image_url: 'https://images.unsplash.com/photo-1593113598332-cd288d649433?auto=format&fit=crop&w=1200&q=82',
    image_alt: '도움이 필요한 이웃에게 물품을 전달하는 손길'
  },
  {
    image_url: 'https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?auto=format&fit=crop&w=1200&q=82',
    image_alt: '지역 회복을 위해 힘을 모으는 사람들'
  }
];
const allowedCorsOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

app.set('etag', false);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
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

function requireAdminAuth(req, res, next) {
  const authorization = req.get('Authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/);

  if (!match) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!JWT_SECRET) {
    res.status(503).json({ error: 'Admin authentication is not configured' });
    return;
  }

  try {
    const payload = jwt.verify(match[1], JWT_SECRET, { algorithms: ['HS256'] });

    if (typeof payload !== 'object' || typeof payload.sub !== 'string' || payload.role !== 'admin') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.auth = {
      username: payload.sub,
      role: payload.role
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body ?? {};

  if (
    typeof username !== 'string' ||
    !username.trim() ||
    typeof password !== 'string' ||
    !password
  ) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !JWT_SECRET) {
    res.status(503).json({ error: 'Admin authentication is not configured' });
    return;
  }

  const passwordMatches = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (username !== ADMIN_USERNAME || !passwordMatches) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const token = jwt.sign(
    {
      sub: username,
      role: 'admin'
    },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: JWT_EXPIRES_IN
    }
  );

  res.json({ token });
});

app.get('/api/auth/me', requireAdminAuth, (req, res) => {
  res.json(req.auth);
});

function runPollingOnceProcess() {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCommand, ['run', 'poll:once'], {
      cwd: BACKEND_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', chunk => {
      process.stdout.write(`[poll-once] ${chunk}`);
    });

    child.stderr.on('data', chunk => {
      process.stderr.write(`[poll-once] ${chunk}`);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error('poll:once failed');
      error.code = code;
      reject(error);
    });
  });
}

app.post('/api/admin/poll-once', async (req, res) => {
  if (!POLL_ADMIN_TOKEN) {
    res.status(503).json({
      ok: false,
      error: 'Polling admin token is not configured'
    });
    return;
  }

  if (req.get('x-poll-token') !== POLL_ADMIN_TOKEN) {
    res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
    return;
  }

  if (pollingInProgress) {
    res.status(409).json({
      ok: false,
      error: 'Polling already in progress'
    });
    return;
  }

  pollingInProgress = true;

  try {
    await runPollingOnceProcess();
    res.json({
      ok: true,
      message: 'Polling completed',
      ranAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Manual polling failed:', error.message);
    res.status(500).json({
      ok: false,
      error: 'poll:once failed',
      code: error.code ?? 1
    });
  } finally {
    pollingInProgress = false;
  }
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

function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => {
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

async function ensureDatabaseReady() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });

  const schemaSql = await fs.readFile(SCHEMA_PATH, 'utf8');
  const db = openWritableDatabase();

  try {
    await exec(db, schemaSql);
    await run(db, 'DELETE FROM event_media_cache WHERE cache_key NOT LIKE ?', [`${EVENT_MEDIA_CACHE_VERSION}_%`]);
    console.log(`Database ready: ${DB_PATH}`);
  } finally {
    await closeDatabase(db);
  }
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

function booleanFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;

  const normalized = String(raw).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    help_status: 'donation_available',
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
    help_status: 'donation_available',
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
    help_status: 'donation_available',
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

function disasterTypeLabel(disasterType) {
  return {
    wildfire: '산불',
    earthquake: '지진',
    typhoon: '태풍',
    heavy_rain: '호우·홍수'
  }[disasterType] || '재난';
}

function eventMediaCacheKey({ eventId, category, region, isMock }) {
  const scope = isMock ? 'category' : 'event';
  return `${EVENT_MEDIA_CACHE_VERSION}_${scope}_${stableCacheSlug(eventId || category)}_${stableCacheSlug(region || 'all')}`.slice(0, 180);
}

function mapEventMedia(row) {
  return {
    image_url: text(row.image_url),
    image_alt: text(row.image_alt),
    image_source_name: text(row.image_source_name),
    image_source_url: text(row.image_source_url),
    query: text(row.query),
    is_fallback: booleanFromDb(row.is_fallback),
    fetched_at: isoFromNewsDate(row.fetched_at),
    expires_at: isoFromNewsDate(row.expires_at)
  };
}

function stableMediaIndex(value, length) {
  let hash = 2166136261;
  for (const character of text(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function fallbackEventMedia(event) {
  const category = supportedDisasterType(event.disaster_type) || 'default';
  const options = CATEGORY_MEDIA_FALLBACKS[category] || CATEGORY_MEDIA_FALLBACKS.default;
  const imageId = options[stableMediaIndex(`${event.event_id}:${event.region_name}`, options.length)];
  const imageAlt = CATEGORY_MEDIA_ALT[category] || CATEGORY_MEDIA_ALT.default;

  return {
    image_url: `https://images.unsplash.com/photo-${imageId}${EVENT_MEDIA_IMAGE_PARAMS}`,
    image_source_name: 'Unsplash',
    image_source_url: 'https://unsplash.com',
    image_alt: event.title ? `${event.title} 관련 ${imageAlt}` : imageAlt,
    query: '',
    is_fallback: true
  };
}

function fallbackOrganizationMedia(orgName, mediaIndex) {
  if (Number.isInteger(mediaIndex)) {
    return ORGANIZATION_MEDIA_FALLBACKS[mediaIndex % ORGANIZATION_MEDIA_FALLBACKS.length];
  }

  const normalized = text(orgName);
  const hash = [...normalized].reduce(
    (total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0,
    0
  );
  return ORGANIZATION_MEDIA_FALLBACKS[hash % ORGANIZATION_MEDIA_FALLBACKS.length];
}

async function searchEventImage(event) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret || clientId.startsWith('your_') || clientSecret.startsWith('your_')) {
    return null;
  }

  const occurredOn = text(event.started_at).slice(0, 10);
  const query = [
    event.title,
    event.region_name,
    disasterTypeLabel(event.disaster_type),
    occurredOn,
    '구호 복구 현장'
  ].filter(Boolean).join(' ');
  const url = new URL('https://openapi.naver.com/v1/search/image');
  url.searchParams.set('query', query);
  url.searchParams.set('display', '30');
  url.searchParams.set('sort', 'sim');
  url.searchParams.set('filter', 'large');

  try {
    const response = await axios.get(url.toString(), {
      timeout: numberFromEnv('EVENT_IMAGE_SEARCH_TIMEOUT_MS', 5000),
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      }
    });
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    const candidates = items.filter((item, index, list) => {
      const imageUrl = text(item?.link);
      return /^https?:\/\//.test(imageUrl)
        && !/\.(gif|svg)(\?|$)/i.test(imageUrl)
        && list.findIndex(candidate => text(candidate?.link) === imageUrl) === index;
    });
    const db = openDatabase();
    let usedUrls = [];

    try {
      usedUrls = (await allOrEmpty(
        db,
        'SELECT image_url FROM event_media_cache WHERE event_id <> ?',
        [event.event_id]
      )).map(row => text(row.image_url));
    } finally {
      await closeDatabase(db);
    }

    const unusedCandidates = candidates.filter(item => !usedUrls.includes(text(item.link)));
    const selected = unusedCandidates[0]
      || candidates[stableMediaIndex(`${event.event_id}:${event.region_name}:${event.title}`, candidates.length)];

    if (!selected) return null;

    return {
      image_url: text(selected.link),
      image_alt: `${event.title} 관련 구호 및 복구 현장 이미지`,
      image_source_name: '네이버 이미지 검색',
      image_source_url: `https://search.naver.com/search.naver?where=image&query=${encodeURIComponent(query)}`,
      query,
      is_fallback: false
    };
  } catch (_) {
    return null;
  }
}

async function upsertEventMedia(cacheKey, event, media, ttlMs) {
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const db = openWritableDatabase();

  try {
    await run(db, `
      INSERT INTO event_media_cache (
        cache_key, event_id, category, region, image_url, image_alt, image_source_name,
        image_source_url, query, is_fallback, fetched_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        event_id = excluded.event_id,
        category = excluded.category,
        region = excluded.region,
        image_url = excluded.image_url,
        image_alt = excluded.image_alt,
        image_source_name = excluded.image_source_name,
        image_source_url = excluded.image_source_url,
        query = excluded.query,
        is_fallback = excluded.is_fallback,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `, [
      cacheKey,
      event.event_id || '',
      event.disaster_type,
      event.region_name || '',
      media.image_url,
      media.image_alt,
      media.image_source_name,
      media.image_source_url,
      media.query || '',
      media.is_fallback ? 1 : 0,
      fetchedAt,
      expiresAt
    ]);

    return {
      ...media,
      fetched_at: fetchedAt,
      expires_at: expiresAt
    };
  } finally {
    await closeDatabase(db);
  }
}

async function readEventMedia(request) {
  const events = request.isMock ? [] : await readEvents();
  const storedEvent = events.find(item => item.event_id === request.eventId);
  const event = storedEvent || {
    event_id: text(request.eventId, `mock_${request.category}`),
    title: text(request.title, `${disasterTypeLabel(request.category)} 지원 정보`),
    disaster_type: supportedDisasterType(request.category) || 'wildfire',
    region_name: text(request.region, '전국'),
    started_at: text(request.startedAt)
  };
  const isMock = Boolean(request.isMock || !storedEvent);
  const cacheKey = eventMediaCacheKey({
    eventId: event.event_id,
    category: event.disaster_type,
    region: event.region_name,
    isMock
  });
  const db = openDatabase();
  let cached = null;

  try {
    cached = await get(db, 'SELECT * FROM event_media_cache WHERE cache_key = ?', [cacheKey]);
  } finally {
    await closeDatabase(db);
  }

  const expiresAt = cached ? new Date(cached.expires_at).getTime() : 0;
  if (cached && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    return mapEventMedia(cached);
  }

  const searched = isMock ? null : await searchEventImage(event);
  if (!searched && cached) {
    return mapEventMedia(cached);
  }

  const media = searched || fallbackEventMedia(event);
  return upsertEventMedia(
    cacheKey,
    event,
    media,
    numberFromEnv('EVENT_MEDIA_TTL_MS', DEFAULT_EVENT_MEDIA_TTL_MS)
  );
}

function stableSlug(value) {
  return text(value).replace(/[^A-Za-z0-9_]+/g, '_');
}

function stableCacheSlug(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}_]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'all';
}

function firstEventIdByType(events, disasterType, fallbackEventId) {
  return events.find(event => event.disaster_type === disasterType)?.event_id ?? fallbackEventId;
}

function supportedDisasterType(value) {
  const normalized = text(value);
  return ['wildfire', 'typhoon', 'earthquake', 'heavy_rain'].includes(normalized) ? normalized : undefined;
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
    await ensureRagSchema(db);
    const seedDemoSupportData = booleanFromEnv('SEED_DEMO_SUPPORT_DATA', false);

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

    if (seedDemoSupportData && await countRows(db, 'organization_actions') === 0) {
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

    if (seedDemoSupportData && await countRows(db, 'donation_records') === 0) {
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

function parseEvidenceSources(value) {
  try {
    const parsed = JSON.parse(text(value, '[]'));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(item => ({
        title: text(item?.title),
        url: text(item?.url),
        source_type: text(item?.source_type || item?.sourceType, 'evidence')
      }))
      .filter(item => item.title || item.url);
  } catch (_) {
    return [];
  }
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
      }),
      officialUpdate({
        update_id: `official_${stableSlug(eventId)}_wildfire_local_notice`,
        event_id: eventId,
        source_name: '관할 지자체',
        source_type: '대피·통제 안내',
        issued_at: event.updated_at,
        title: '주민 대피 및 통행 통제 확인',
        summary: `${event.region_name} 인근 주민은 지자체 재난문자와 현장 통제 안내를 우선 확인하고, 산림 인접 도로와 등산로 접근을 피해야 합니다.`,
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
  const trustScore = row.ai_trust_score === null || row.ai_trust_score === undefined
    ? null
    : number(row.ai_trust_score);
  const evidenceSources = parseEvidenceSources(row.ai_evidence_sources);

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
    last_checked_at: isoFromNewsDate(row.last_checked_at),
    ...(optionalText(row.ai_report_id) ? { ai_report_id: optionalText(row.ai_report_id) } : {}),
    ...(optionalText(row.ai_trust_level) ? { trust_level: optionalText(row.ai_trust_level) } : {}),
    ...(trustScore !== null ? { trust_score: trustScore } : {}),
    ...(optionalText(row.ai_report_summary) ? { report_summary: optionalText(row.ai_report_summary) } : {}),
    ...(optionalText(row.ai_finance_summary) ? { finance_summary: optionalText(row.ai_finance_summary) } : {}),
    ...(optionalText(row.ai_risk_notes) ? { risk_notes: optionalText(row.ai_risk_notes) } : {}),
    ...(evidenceSources.length > 0 ? { evidence_sources: evidenceSources } : {}),
    ...(optionalText(row.ai_generated_at) ? { report_generated_at: isoFromNewsDate(row.ai_generated_at) } : {})
  };
}

function mapAiReport(row) {
  return {
    report_id: text(row.report_id),
    event_id: text(row.event_id),
    org_id: text(row.org_id),
    org_name: text(row.org_name),
    activity_region: text(row.activity_region),
    activity_type: text(row.activity_type),
    activity_summary: text(row.activity_summary),
    ...(optionalText(row.ai_message) ? { ai_message: optionalText(row.ai_message) } : {}),
    ...(optionalText(row.donation_link) ? { donation_link: optionalText(row.donation_link) } : {}),
    ...(optionalText(row.volunteer_link) ? { volunteer_link: optionalText(row.volunteer_link) } : {}),
    evidence_note: text(row.evidence_note),
    trust_level: text(row.trust_level, 'needs_review'),
    trust_score: number(row.trust_score) ?? 0,
    report_summary: text(row.report_summary),
    finance_summary: text(row.finance_summary),
    ...(optionalText(row.risk_notes) ? { risk_notes: optionalText(row.risk_notes) } : {}),
    evidence_sources: parseEvidenceSources(row.evidence_sources),
    generated_at: isoFromNewsDate(row.generated_at),
    review_status: text(row.review_status, 'pending'),
    ...(optionalText(row.reviewed_at) ? { reviewed_at: isoFromNewsDate(row.reviewed_at) } : {})
  };
}

let reliefOrganizationsCache = null;
const generatedDonationOrgCache = new Map();

function normalizeReliefOrganization(raw) {
  return {
    organization_id: text(raw.organization_id),
    name_ko: text(raw.name_ko),
    relief_category: text(raw.relief_category),
    main_focus: text(raw.main_focus),
    donation_page_url: text(raw.donation_page_url),
    campaign_page_url: text(raw.campaign_page_url),
    source_url: text(raw.source_url),
    data_confidence: text(raw.data_confidence, 'UNKNOWN')
  };
}

async function readReliefOrganizations() {
  if (reliefOrganizationsCache) {
    return reliefOrganizationsCache;
  }

  try {
    const raw = await fs.readFile(RELIEF_ORG_DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    reliefOrganizationsCache = Array.isArray(parsed)
      ? parsed.map(normalizeReliefOrganization).filter(org => org.name_ko && org.donation_page_url)
      : [];
  } catch (_) {
    reliefOrganizationsCache = FALLBACK_RELIEF_ORGANIZATIONS.map(normalizeReliefOrganization);
  }

  if (reliefOrganizationsCache.length === 0) {
    reliefOrganizationsCache = FALLBACK_RELIEF_ORGANIZATIONS.map(normalizeReliefOrganization);
  }

  return reliefOrganizationsCache;
}

function pageTextFromHtml(html) {
  return text(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ');
}

async function fetchOfficialPageText(url) {
  if (!url) {
    return '';
  }

  try {
    const response = await axios.get(url, {
      timeout: DONATION_CRAWL_TIMEOUT_MS,
      maxRedirects: 3,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 ReliefKoreaDonationMatcher/1.0'
      }
    });

    if (response.status < 200 || response.status >= 300) {
      return '';
    }

    return pageTextFromHtml(response.data).slice(0, 300000);
  } catch (_) {
    return '';
  }
}

function disasterKeywordsForEvent(event) {
  if (event.disaster_type === 'wildfire') {
    return ['산불', '화재'];
  }

  if (event.disaster_type === 'earthquake') {
    return ['지진', '여진'];
  }

  if (event.disaster_type === 'typhoon') {
    return ['태풍', '강풍', '폭풍'];
  }

  if (event.disaster_type === 'heavy_rain') {
    return ['호우', '폭우', '수해', '침수'];
  }

  return ['재난'];
}

function regionKeywordsForEvent(event) {
  const region = text(event.region_name);
  const keywords = new Set();

  for (const name of Object.keys(REGION_COORDS)) {
    if (region.includes(name)) {
      keywords.add(name);
    }
  }

  for (const part of region.split(/[^\p{Script=Hangul}A-Za-z0-9]+/u)) {
    if (part.length >= 2 && /[가-힣]/.test(part)) {
      keywords.add(part);
    }
  }

  return [...keywords];
}

function titleKeywordsForEvent(event) {
  const blocked = new Set(['발생', '지역', '정보', '기준', '위치', '규모', '태풍', '지진', '산불']);
  return text(event.title)
    .split(/[^\p{Script=Hangul}A-Za-z0-9]+/u)
    .filter(part => part.length >= 2 && /[가-힣]/.test(part) && !blocked.has(part))
    .slice(0, 6);
}

function matchedKeywords(pageText, keywords) {
  return keywords.filter(keyword => pageText.includes(keyword));
}

function matchDonationPage(pageText, event) {
  if (!pageText) {
    return null;
  }

  const disasterMatches = matchedKeywords(pageText, disasterKeywordsForEvent(event));
  const regionMatches = matchedKeywords(pageText, regionKeywordsForEvent(event));
  const titleMatches = matchedKeywords(pageText, titleKeywordsForEvent(event));

  if (disasterMatches.length === 0 || (regionMatches.length === 0 && titleMatches.length === 0)) {
    return null;
  }

  return [...new Set([...disasterMatches, ...regionMatches, ...titleMatches])];
}

function officialPageUrls(org) {
  return [...new Set([org.campaign_page_url, org.source_url, org.donation_page_url].filter(Boolean))];
}

async function crawlMatchedDonationOrg(event, org) {
  for (const url of officialPageUrls(org)) {
    const pageText = await fetchOfficialPageText(url);
    const matchedTerms = matchDonationPage(pageText, event);

    if (matchedTerms) {
      return {
        org,
        matchedTerms,
        evidenceUrl: url
      };
    }
  }

  return null;
}

function fallbackOrgNamesForEvent(event) {
  if (event.disaster_type === 'wildfire') {
    return ['희망브리지 전국재해구호협회', '굿네이버스', '사회복지공동모금회 사랑의열매'];
  }

  if (event.disaster_type === 'earthquake') {
    return ['희망브리지 전국재해구호협회', '한국해비타트', '굿네이버스'];
  }

  if (event.disaster_type === 'typhoon' || event.disaster_type === 'heavy_rain') {
    return ['희망브리지 전국재해구호협회', '사회복지공동모금회 사랑의열매', '굿네이버스'];
  }

  return ['희망브리지 전국재해구호협회', '사회복지공동모금회 사랑의열매', '굿네이버스'];
}

function fallbackDonationOrgs(event, orgs) {
  const highConfidenceOrgs = orgs.filter(org => org.data_confidence !== 'MEDIUM');
  const preferredNames = fallbackOrgNamesForEvent(event);
  const preferred = preferredNames
    .map(name => highConfidenceOrgs.find(org => org.name_ko === name))
    .filter(Boolean);

  for (const org of highConfidenceOrgs) {
    if (preferred.length >= 3) {
      break;
    }

    if (!preferred.some(item => item.organization_id === org.organization_id)) {
      preferred.push(org);
    }
  }

  return preferred.slice(0, 3);
}

function generatedDonationOrgId(eventId, orgId) {
  return `autoorg_${eventId}__${orgId}`;
}

function parseGeneratedDonationOrgId(orgId) {
  const match = text(orgId).match(/^autoorg_(.+)__([^_]+)$/);
  return match ? { eventId: match[1], organizationId: match[2] } : null;
}

function buildGeneratedDonationAction(event, org, options = {}) {
  const isCrawled = options.mode === 'crawled';
  const matchedTerms = options.matchedTerms ?? [];
  const donationLink = text(org.donation_page_url, org.campaign_page_url);

  return {
    org_id: generatedDonationOrgId(event.event_id, org.organization_id),
    event_id: event.event_id,
    org_name: org.name_ko,
    activity_region: event.region_name,
    activity_type: isCrawled ? '자동 크롤링 후보' : '임시 후원 연결',
    activity_summary: isCrawled
      ? `공식 페이지에서 ${matchedTerms.slice(0, 4).join(', ')} 키워드를 확인해 자동 후보로 연결했습니다. 후원 전 공식 사이트의 모금 대상과 용도를 확인해 주세요.`
      : '공식 구호단체 후원 페이지로 연결됩니다.',
    donation_link: donationLink,
    evidence_note: isCrawled
      ? `공식 페이지 키워드 매칭: ${matchedTerms.join(', ')} / ${options.evidenceUrl}`
      : '자동 크롤링 후보 없음 - 임시 공식 구호단체 fallback',
    verified_by_admin: false,
    last_checked_at: new Date().toISOString()
  };
}

async function generatedDonationActionsForEvent(event) {
  const cached = generatedDonationOrgCache.get(event.event_id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.organizations;
  }

  const orgs = (await readReliefOrganizations())
    .filter(org => org.donation_page_url && org.data_confidence !== 'MEDIUM');
  const crawlResults = await Promise.all(orgs.map(org => crawlMatchedDonationOrg(event, org)));
  const crawledOrganizations = crawlResults
    .filter(Boolean)
    .slice(0, 3)
    .map(result => buildGeneratedDonationAction(event, result.org, {
      mode: 'crawled',
      matchedTerms: result.matchedTerms,
      evidenceUrl: result.evidenceUrl
    }));

  const organizations = crawledOrganizations.length > 0
    ? crawledOrganizations
    : fallbackDonationOrgs(event, orgs).map(org => buildGeneratedDonationAction(event, org, { mode: 'fallback' }));

  generatedDonationOrgCache.set(event.event_id, {
    expiresAt: Date.now() + DONATION_ORG_CACHE_MS,
    organizations
  });

  return organizations;
}

function isSeedOrganizationAction(org) {
  return org.evidence_note.toLowerCase().includes('seed');
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
    ...(optionalText(row.beneficiaries_label) ? { beneficiaries_label: optionalText(row.beneficiaries_label) } : {}),
    region: text(row.region),
    description: text(row.description),
    ...(disasterType ? { disaster_type: disasterType } : {}),
    ...(optionalText(row.evidence_title) ? { evidence_title: optionalText(row.evidence_title) } : {}),
    ...(optionalText(row.evidence_url) ? { evidence_url: optionalText(row.evidence_url) } : {}),
    ...(optionalText(row.evidence_source) ? { evidence_source: optionalText(row.evidence_source) } : {})
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
      FROM (
        SELECT
          oa.*,
          ai.report_id AS ai_report_id,
          ai.trust_level AS ai_trust_level,
          ai.trust_score AS ai_trust_score,
          ai.report_summary AS ai_report_summary,
          ai.finance_summary AS ai_finance_summary,
          ai.risk_notes AS ai_risk_notes,
          ai.evidence_sources AS ai_evidence_sources,
          ai.generated_at AS ai_generated_at
        FROM organization_actions oa
        LEFT JOIN org_ai_reports ai
          ON ai.report_id = (
            SELECT latest.report_id
            FROM org_ai_reports latest
            WHERE latest.event_id = oa.event_id
              AND latest.org_id = oa.org_id
              AND latest.review_status = 'approved'
            ORDER BY latest.generated_at DESC
            LIMIT 1
          )
        WHERE oa.event_id = ?

        UNION ALL

        SELECT
          ai.org_id,
          ai.event_id,
          ai.org_name,
          ai.activity_region,
          ai.activity_type,
          ai.activity_summary,
          ai.ai_message,
          ai.donation_link,
          ai.volunteer_link,
          ai.evidence_note,
          0 AS verified_by_admin,
          COALESCE(ai.reviewed_at, ai.generated_at) AS last_checked_at,
          ai.report_id AS ai_report_id,
          ai.trust_level AS ai_trust_level,
          ai.trust_score AS ai_trust_score,
          ai.report_summary AS ai_report_summary,
          ai.finance_summary AS ai_finance_summary,
          ai.risk_notes AS ai_risk_notes,
          ai.evidence_sources AS ai_evidence_sources,
          ai.generated_at AS ai_generated_at
        FROM org_ai_reports ai
        WHERE ai.event_id = ?
          AND ai.review_status = 'approved'
          AND NOT EXISTS (
            SELECT 1
            FROM organization_actions oa
            WHERE oa.event_id = ai.event_id
              AND oa.org_id = ai.org_id
          )
      )
      ORDER BY
        CASE WHEN ai_report_id IS NULL THEN 1 ELSE 0 END,
        COALESCE(ai_trust_score, 0) DESC,
        last_checked_at DESC,
        org_name ASC
    `, [eventId, eventId]);
    const storedOrganizations = rows.map(mapOrganizationAction);
    const usableStoredOrganizations = storedOrganizations.filter(org => !isSeedOrganizationAction(org));

    if (usableStoredOrganizations.length > 0) {
      return usableStoredOrganizations;
    }

    const event = (await readEvents()).find(item => item.event_id === eventId);
    if (!event) {
      return storedOrganizations;
    }

    return generatedDonationActionsForEvent(event);
  } finally {
    await closeDatabase(db);
  }
}

function orgRagOnDemandLimit() {
  return numberFromEnv('AI_RAG_ON_DEMAND_LIMIT', DEFAULT_ORG_RAG_LIMIT);
}

function orgRagOnDemandCatalogLimit() {
  return numberFromEnv('AI_RAG_ON_DEMAND_CATALOG_LIMIT', DEFAULT_ORG_RAG_LIMIT);
}

function orgRagRefreshLimit() {
  return numberFromEnv('AI_RAG_REFRESH_LIMIT', orgRagOnDemandLimit());
}

function orgRagRefreshCatalogLimit() {
  return numberFromEnv('AI_RAG_REFRESH_CATALOG_LIMIT', orgRagOnDemandCatalogLimit());
}

function publicOrgDisplayLimit() {
  return numberFromEnv('PUBLIC_ORG_DISPLAY_LIMIT', DEFAULT_PUBLIC_ORG_DISPLAY_LIMIT);
}

function limitPublicOrganizations(organizations, limit = publicOrgDisplayLimit()) {
  const normalizedLimit = Number(limit);
  if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
    return [];
  }

  return organizations.slice(0, normalizedLimit);
}

function donationUseCasesForCategory(category) {
  return {
    wildfire: ['임시 거처와 긴급 생필품', '산불 피해 가정 생활 회복', '지역 복구와 심리 지원'],
    earthquake: ['안전한 임시 대피 공간', '긴급 생활 물품', '주거와 지역 기반시설 복구'],
    typhoon: ['대피소 식수와 위생용품', '침수 피해 가정 긴급 생계', '주거와 지역 복구'],
    heavy_rain: ['대피소 식수와 위생용품', '침수 피해 가정 긴급 생계', '주거와 지역 복구']
  }[category] || ['긴급 생필품', '취약 가정 지원', '지역 회복'];
}

function enrichOrganizationRecommendation(org, event, { isMockCategoryRecommendation = false, ttlMs, mediaIndex } = {}) {
  const category = event.disaster_type;
  const generatedAt = org.report_generated_at || org.last_checked_at || new Date().toISOString();
  const effectiveTtlMs = ttlMs ?? numberFromEnv('AI_RAG_REPORT_TTL_MS', DEFAULT_ORG_RAG_REPORT_TTL_MS);
  const expiresAt = new Date(new Date(generatedAt).getTime() + effectiveTtlMs).toISOString();
  const fallbackMedia = fallbackOrganizationMedia(org.org_name, mediaIndex);
  const sourceUrls = (org.evidence_sources || []).map(source => source.url).filter(Boolean);
  const label = disasterTypeLabel(category);

  return {
    ...org,
    category,
    region: event.region_name,
    summary: org.report_summary || org.ai_message || org.activity_summary,
    activities: [org.activity_type, org.activity_summary].filter(Boolean),
    donation_use_cases: donationUseCasesForCategory(category),
    official_url: org.donation_link || org.volunteer_link,
    image_url: fallbackMedia.image_url,
    image_alt: `${org.org_name} 관련 ${fallbackMedia.image_alt}`,
    image_source_url: 'https://unsplash.com',
    source_urls: sourceUrls,
    last_ragged_at: generatedAt,
    expires_at: expiresAt,
    is_mock_category_recommendation: isMockCategoryRecommendation,
    ...(isMockCategoryRecommendation ? {
      activity_region: event.region_name,
      activity_type: `${label} 구호 활동 카테고리 추천`
    } : {})
  };
}

function mockCategoryEvent(category, region) {
  const normalizedCategory = supportedDisasterType(category) || 'wildfire';
  const normalizedRegion = text(region, '전국');

  return {
    event_id: `mock_category_${normalizedCategory}_${stableCacheSlug(normalizedRegion)}`.slice(0, 150),
    title: `${disasterTypeLabel(normalizedCategory)} 구호 활동 카테고리 추천`,
    disaster_type: normalizedCategory,
    region_name: normalizedRegion,
    center_lat: 36.5,
    center_lng: 127.8,
    severity: 'medium',
    status: 'monitoring',
    started_at: new Date(0).toISOString(),
    updated_at: new Date().toISOString(),
    official_summary: `특정 사건 전용 모금이 아닌 ${disasterTypeLabel(normalizedCategory)} 구호 활동 카테고리 기반 추천입니다.`,
    help_status: 'donation_available',
    source_confidence: 'monitoring'
  };
}

function recommendationsAreFresh(organizations, ttlMs) {
  if (organizations.length === 0) return false;

  return organizations.some(org => {
    const generatedAt = new Date(org.report_generated_at || org.last_checked_at).getTime();
    return Number.isFinite(generatedAt) && Date.now() - generatedAt <= ttlMs;
  });
}

async function fallbackCategoryRecommendations(event) {
  const organizations = await readReliefOrganizations();
  return fallbackDonationOrgs(event, organizations)
    .map(org => buildGeneratedDonationAction(event, org, { mode: 'fallback' }));
}

async function readMockCategoryRecommendations(category, region) {
  const event = mockCategoryEvent(category, region);
  const ttlMs = numberFromEnv('AI_RAG_MOCK_CATEGORY_TTL_MS', DEFAULT_MOCK_CATEGORY_RAG_TTL_MS);
  let organizations = await readOrganizationsForEvent(event.event_id);

  if (!recommendationsAreFresh(organizations, ttlMs)) {
    const db = openWritableDatabase();

    try {
      await runOrgRag({
        db,
        event,
        existingOrganizations: [],
        options: {
          autoPublish: true,
          limit: orgRagOnDemandLimit(),
          catalogLimit: orgRagOnDemandCatalogLimit(),
          reportTtlMs: ttlMs,
          forceReportRefresh: organizations.length > 0,
          forceEmbeddingRefresh: false,
          skipNews: true
        }
      });
      organizations = await readOrganizationsForEvent(event.event_id);
    } catch (error) {
      console.error(`Category organization RAG failed for ${event.event_id}:`, error.message);
    } finally {
      await closeDatabase(db);
    }
  }

  if (organizations.length === 0) {
    organizations = await fallbackCategoryRecommendations(event);
  }

  return limitPublicOrganizations(organizations)
    .map((org, index) => enrichOrganizationRecommendation(org, event, {
      isMockCategoryRecommendation: true,
      ttlMs,
      mediaIndex: index
    }));
}

async function runOnDemandOrgRagForEvent(eventId) {
  if (!booleanFromEnv('AI_RAG_AUTO_RUN_ON_EMPTY', true)) {
    return null;
  }

  if (onDemandOrgRagRuns.has(eventId)) {
    return onDemandOrgRagRuns.get(eventId);
  }

  const runPromise = (async () => {
    await ensureSeedTablesOnce();
    const events = await readEvents();
    const event = events.find(item => item.event_id === eventId);

    if (!event) {
      return null;
    }

    const existingOrganizations = await readOrganizationsForEvent(eventId);
    const db = openWritableDatabase();

    try {
      return await runOrgRag({
        db,
        event,
        existingOrganizations,
        options: {
          autoPublish: true,
          limit: orgRagOnDemandLimit(),
          catalogLimit: orgRagOnDemandCatalogLimit(),
          reportTtlMs: numberFromEnv('AI_RAG_REPORT_TTL_MS', DEFAULT_ORG_RAG_REPORT_TTL_MS)
        }
      });
    } finally {
      await closeDatabase(db);
    }
  })()
    .catch(error => {
      console.error(`On-demand organization RAG failed for ${eventId}:`, error.message);
      return null;
    })
    .finally(() => {
      onDemandOrgRagRuns.delete(eventId);
    });

  onDemandOrgRagRuns.set(eventId, runPromise);
  return runPromise;
}

async function readOrgRagRefreshState(eventId, staleMs) {
  const db = openDatabase();
  const staleBefore = new Date(Date.now() - staleMs).toISOString();

  try {
    const rows = await allOrEmpty(db, `
      SELECT
        COUNT(*) AS approved_count,
        SUM(CASE WHEN generated_at < ? THEN 1 ELSE 0 END) AS stale_count
      FROM org_ai_reports
      WHERE event_id = ?
        AND review_status = 'approved'
    `, [staleBefore, eventId]);
    const row = rows[0] || {};

    return {
      approvedCount: Number(row.approved_count ?? 0),
      staleCount: Number(row.stale_count ?? 0)
    };
  } finally {
    await closeDatabase(db);
  }
}

async function runBackgroundOrgRagForEvent(eventId, { forceReportRefresh = false, reason = 'scheduled' } = {}) {
  if (backgroundOrgRagRuns.has(eventId)) {
    return backgroundOrgRagRuns.get(eventId);
  }

  const runPromise = (async () => {
    await ensureSeedTablesOnce();
    const events = await readEvents();
    const event = events.find(item => item.event_id === eventId);

    if (!event) {
      return null;
    }

    const existingOrganizations = await readOrganizationsForEvent(eventId);
    const db = openWritableDatabase();

    try {
      const result = await runOrgRag({
        db,
        event,
        existingOrganizations,
        options: {
          autoPublish: true,
          limit: orgRagRefreshLimit(),
          catalogLimit: orgRagRefreshCatalogLimit(),
          reportTtlMs: numberFromEnv('AI_RAG_REPORT_TTL_MS', DEFAULT_ORG_RAG_REPORT_TTL_MS),
          forceReportRefresh,
          forceEmbeddingRefresh: false
        }
      });

      console.log(`Organization RAG ${reason} run completed for ${eventId}: ${result.reports.length} reports`);
      return result;
    } finally {
      await closeDatabase(db);
    }
  })()
    .catch(error => {
      console.error(`Organization RAG ${reason} run failed for ${eventId}:`, error.message);
      return null;
    })
    .finally(() => {
      orgRagRefreshCooldowns.set(eventId, Date.now());
      backgroundOrgRagRuns.delete(eventId);
    });

  backgroundOrgRagRuns.set(eventId, runPromise);
  return runPromise;
}

async function maybeScheduleOrgRagRefreshForEvent(eventId, currentOrganizationCount = 0) {
  if (!booleanFromEnv('AI_RAG_REFRESH_ENABLED', true)) {
    return;
  }

  const targetLimit = orgRagRefreshLimit();
  const staleMs = numberFromEnv('AI_RAG_REFRESH_STALE_MS', DEFAULT_ORG_RAG_REFRESH_STALE_MS);
  const cooldownMs = numberFromEnv('AI_RAG_REFRESH_COOLDOWN_MS', DEFAULT_ORG_RAG_REFRESH_COOLDOWN_MS);

  if (targetLimit <= 0 || staleMs <= 0) {
    return;
  }

  const lastRunAt = orgRagRefreshCooldowns.get(eventId) || 0;
  if (Date.now() - lastRunAt < cooldownMs) {
    return;
  }

  const state = await readOrgRagRefreshState(eventId, staleMs);
  const hasStaleReports = state.staleCount > 0;
  const needsMoreAiCards = currentOrganizationCount > 0 && state.approvedCount < targetLimit;

  if (!hasStaleReports && !needsMoreAiCards) {
    return;
  }

  runBackgroundOrgRagForEvent(eventId, {
    forceReportRefresh: hasStaleReports,
    reason: hasStaleReports ? 'stale-refresh' : 'fit-candidate-enrichment'
  });
}

async function readOrganizationsForEventWithAutoRag(eventId) {
  const organizations = await readOrganizationsForEvent(eventId);
  if (organizations.length > 0) {
    const hasApprovedAiReport = organizations.some(org => org.ai_report_id);
    if (!hasApprovedAiReport) {
      await runOnDemandOrgRagForEvent(eventId);
      const generatedOrganizations = await readOrganizationsForEvent(eventId);
      if (generatedOrganizations.some(org => org.ai_report_id)) {
        return limitPublicOrganizations(generatedOrganizations);
      }
    }

    maybeScheduleOrgRagRefreshForEvent(eventId, organizations.length).catch(error => {
      console.error(`Organization RAG refresh check failed for ${eventId}:`, error.message);
    });
    return limitPublicOrganizations(organizations);
  }

  await runOnDemandOrgRagForEvent(eventId);
  return limitPublicOrganizations(await readOrganizationsForEvent(eventId));
}

async function readOrganizationById(orgId) {
  await ensureSeedTablesOnce();
  const db = openDatabase();

  try {
    const row = await get(db, `
      SELECT *
      FROM (
        SELECT
          oa.*,
          ai.report_id AS ai_report_id,
          ai.trust_level AS ai_trust_level,
          ai.trust_score AS ai_trust_score,
          ai.report_summary AS ai_report_summary,
          ai.finance_summary AS ai_finance_summary,
          ai.risk_notes AS ai_risk_notes,
          ai.evidence_sources AS ai_evidence_sources,
          ai.generated_at AS ai_generated_at
        FROM organization_actions oa
        LEFT JOIN org_ai_reports ai
          ON ai.report_id = (
            SELECT latest.report_id
            FROM org_ai_reports latest
            WHERE latest.org_id = oa.org_id
              AND latest.review_status = 'approved'
            ORDER BY latest.generated_at DESC
            LIMIT 1
          )
        WHERE oa.org_id = ?

        UNION ALL

        SELECT
          ai.org_id,
          ai.event_id,
          ai.org_name,
          ai.activity_region,
          ai.activity_type,
          ai.activity_summary,
          ai.ai_message,
          ai.donation_link,
          ai.volunteer_link,
          ai.evidence_note,
          0 AS verified_by_admin,
          COALESCE(ai.reviewed_at, ai.generated_at) AS last_checked_at,
          ai.report_id AS ai_report_id,
          ai.trust_level AS ai_trust_level,
          ai.trust_score AS ai_trust_score,
          ai.report_summary AS ai_report_summary,
          ai.finance_summary AS ai_finance_summary,
          ai.risk_notes AS ai_risk_notes,
          ai.evidence_sources AS ai_evidence_sources,
          ai.generated_at AS ai_generated_at
        FROM org_ai_reports ai
        WHERE ai.org_id = ?
          AND ai.review_status = 'approved'
          AND NOT EXISTS (
            SELECT 1
            FROM organization_actions oa
            WHERE oa.org_id = ai.org_id
          )
      )
      ORDER BY last_checked_at DESC
      LIMIT 1
    `, [orgId, orgId]);
    if (row) {
      return mapOrganizationAction(row);
    }

    const parsedOrgId = parseGeneratedDonationOrgId(orgId);
    if (!parsedOrgId) {
      return null;
    }

    const event = (await readEvents()).find(item => item.event_id === parsedOrgId.eventId);
    if (!event) {
      return null;
    }

    const generatedOrganizations = await generatedDonationActionsForEvent(event);
    return generatedOrganizations.find(org => org.org_id === orgId) ?? null;
  } finally {
    await closeDatabase(db);
  }
}

async function readDonationHistoryForOrg(orgId) {
  await ensureSeedTablesOnce();
  const db = openDatabase();
  let rows = [];

  try {
    rows = await allOrEmpty(db, `
      SELECT *
      FROM donation_records
      WHERE org_id = ?
      ORDER BY date DESC, record_id DESC
    `, [orgId]);
  } finally {
    await closeDatabase(db);
  }

  if (rows.length > 0) {
    return rows.map(mapDonationRecord);
  }

  const organization = await readOrganizationById(orgId);
  return buildPublicEvidenceDonationRecords(organization);
}

function buildPublicEvidenceDonationRecords(organization) {
  if (!organization) return [];

  const orgName = text(organization.org_name).toLowerCase();
  const orgSlug = stableSlug(organization.org_id);

  if (orgName.includes('대한적십자사') || orgName.includes('korean red cross')) {
    return [
      {
        record_id: `public_${orgSlug}_gwangju_2024_campaign`,
        org_id: organization.org_id,
        date: '2025-08-11',
        title: '광주전남 희망풍차 모금액 및 사용계획 공시',
        amount: '₩2,021,555,604',
        region: '광주·전남',
        description: '모금기간 2024.08.01~2025.07.31 기준 모금액 2,021,555,604원입니다. 공시된 사용계획은 국내 재난구호와 위기가정 긴급지원(주거·생계·의료비 등)입니다.',
        evidence_title: '대한적십자사 광주전남지사 2024 기부금품 모집기간 종료 안내',
        evidence_url: 'https://redcross.or.kr/gwangju/news_notice.do?action=detail&brdctsno=296980',
        evidence_source: '대한적십자사 광주전남지사'
      },
      {
        record_id: `public_${orgSlug}_seoul_2024_crisis_households`,
        org_id: organization.org_id,
        date: '2024-06-30',
        title: '서울지사 위기가정 긴급지원 실적',
        amount: '₩162,000,000',
        beneficiaries: 81,
        beneficiaries_label: '지원 세대',
        region: '서울',
        description: '2024년 상반기 위기가정 81세대에 1억 6천2백만 원을 지원한 실적입니다. 갑작스러운 위기 가정의 극복과 자립을 위한 희망풍차 긴급지원 사업 기록입니다.',
        evidence_title: '대한적십자사 서울지사 하반기 위기가정 긴급지원 보도자료',
        evidence_url: 'https://festival.redcross.or.kr/seoul/news_local.do?action=detail&brdctsno=283128&pagenum=24&search_businessdeptcode=&search_jisacode=&search_keyword=&search_option=',
        evidence_source: '대한적십자사 서울지사'
      },
      {
        record_id: `public_${orgSlug}_busan_2024_fee_campaign`,
        org_id: organization.org_id,
        date: '2024-02-01',
        title: '부산지사 2024 적십자회비 집중모금',
        amount: '₩1,880,000,000',
        region: '부산',
        description: '2024년도 1차 집중모금으로 약 18억 8천만 원을 모금했고, 목표금액 약 23억 6천만 원 대비 79.6%를 달성했습니다. 적십자회비는 재난을 당한 이웃과 소외계층 지원에 사용됩니다.',
        evidence_title: '대한적십자사 부산지사 2024년도 2차 집중모금 시작 보도자료',
        evidence_url: 'https://vod.bloodinfo.net/busan/news_local.do?action=detail&brdctsno=278932&pagenum=1&search_businessdeptcode=&search_jisacode=&search_keyword=&search_option=',
        evidence_source: '대한적십자사 부산지사'
      }
    ];
  }

  if (orgName.includes('희망브리지') || orgName.includes('hopebridge') || orgName.includes('전국재해구호협회')) {
    return [
      {
        record_id: `public_${orgSlug}_hopebridge_2025_fire_relief`,
        org_id: organization.org_id,
        date: '2026-01-23',
        title: '2025년 화재 피해 이웃 맞춤형 구호',
        amount: '₩480,000,000',
        beneficiaries: 491,
        beneficiaries_label: '지원 세대',
        region: '전국 화재 피해 지역',
        description: '2025년 한 해 동안 화재 피해 이웃 491세대에 4억 8천만 원 규모의 구호금, 생필품, 구호키트, 주거 연계 지원을 제공한 공개 실적입니다.',
        disaster_type: 'wildfire',
        evidence_title: '희망브리지 2025년 화재 피해 이웃 491세대 맞춤형 구호',
        evidence_url: 'https://hopebridge.or.kr/hope/view.php?b_news_yn=&board_idx=16157&board_type=NTC2&cnt=1236&page=&searchText=&subtitle=',
        evidence_source: '희망브리지 전국재해구호협회'
      },
      {
        record_id: `public_${orgSlug}_hopebridge_cumulative_support`,
        org_id: organization.org_id,
        date: '2026-01-01',
        title: '누적 성금 및 구호물품 지원 지표',
        amount: '₩1,600,000,000,000',
        beneficiaries: 60000000,
        beneficiaries_label: '구호물품 점수',
        region: '전국',
        description: '공식 소개 기준 1961년 이후 1조 6천억 원의 성금과 6천만 점 이상의 구호물품을 지원한 누적 지표입니다.',
        evidence_title: '희망브리지 소개 및 신뢰성 지표',
        evidence_url: 'https://hopebridge.or.kr/hope/intro.php',
        evidence_source: '희망브리지 전국재해구호협회'
      },
      {
        record_id: `public_${orgSlug}_hopebridge_transparency`,
        org_id: organization.org_id,
        date: '2026-01-01',
        title: '감사 및 공익법인 평가 지표',
        beneficiaries: 5,
        beneficiaries_label: '한국가이드스타 최고등급 횟수',
        region: '전국',
        description: '공식 기업 후원 안내에 매년 외부회계감사 2회, 내부감사 1회, 주무부처 감사 실시와 한국가이드스타 최고 등급 5회를 공개하고 있습니다.',
        evidence_title: '희망브리지 기업 후원 안내 투명성 지표',
        evidence_url: 'https://hopebridge.or.kr/support/company.php',
        evidence_source: '희망브리지 전국재해구호협회'
      }
    ];
  }

  if (orgName.includes('사회복지공동모금회') || orgName.includes('사랑의열매') || orgName.includes('chest')) {
    return [
      {
        record_id: `public_${orgSlug}_chest_2024_fundraising`,
        org_id: organization.org_id,
        date: '2025-01-01',
        title: '2024년 모금 실적 공시',
        amount: '₩847,700,000,000',
        beneficiaries: 810338,
        beneficiaries_label: '개인·법인 기부자',
        region: '전국',
        description: '2024년 개인 기부자 773,424명, 법인 기부자 36,914곳을 통해 총 8,477억 원을 모금한 공개 통계입니다.',
        evidence_title: '사랑의열매 2024년 모금실적 통계자료',
        evidence_url: 'https://www.chest.or.kr/lf/ct/initDstbpblanc.do',
        evidence_source: '사회복지공동모금회'
      },
      {
        record_id: `public_${orgSlug}_chest_2024_distribution`,
        org_id: organization.org_id,
        date: '2025-01-01',
        title: '2024년 배분 실적 공시',
        amount: '₩789,600,000,000',
        beneficiaries: 671278,
        beneficiaries_label: '지원 건수',
        region: '전국',
        description: '2024년 배분 실적은 총 7,896억 원이며, 기초생계 4,015억 원, 주거·환경 851억 원, 보건·의료 427억 원 등 분야별 지원 금액과 건수를 공개합니다.',
        evidence_title: '사랑의열매 2024년 배분실적 통계자료',
        evidence_url: 'https://www.chest.or.kr/lf/ct/initDstbpblanc.do',
        evidence_source: '사회복지공동모금회'
      },
      {
        record_id: `public_${orgSlug}_chest_2024_management_cost`,
        org_id: organization.org_id,
        date: '2025-01-01',
        title: '2024년 법정관리운영비 집행비율',
        amount: '₩38,260,000,000',
        beneficiaries: 461,
        beneficiaries_label: '관리운영비 비율 bp',
        region: '전국',
        description: '2024년 법정관리운영비 집행액은 382억 6천만 원이며, 2023년 모금총액 대비 집행비율은 4.61%로 공시되어 있습니다.',
        evidence_title: '사랑의열매 2024년 법정관리운영비 집행액',
        evidence_url: 'https://www.chest.or.kr/lf/ct/initDstbpblanc.do',
        evidence_source: '사회복지공동모금회'
      }
    ];
  }

  if (orgName.includes('굿네이버스') || orgName.includes('goodneighbors') || orgName.includes('good neighbors')) {
    return [
      {
        record_id: `public_${orgSlug}_goodneighbors_2025_domestic_emergency`,
        org_id: organization.org_id,
        date: '2026-01-01',
        title: '2025 국내긴급구호사업 결산 지표',
        amount: '₩5,183,052,624',
        region: '국내 재난 피해 아동·가정',
        description: '2025 재정보고 기준 국내긴급구호사업은 재난 피해 아동과 가정의 안전한 회복을 위한 긴급 생계비, 맞춤형 키트, 심리치료 등으로 집행된 공개 지표입니다.',
        evidence_title: '굿네이버스 2025 재정보고',
        evidence_url: 'https://www.goodneighbors.kr/goodneighbors/management/finance.gn',
        evidence_source: '굿네이버스'
      },
      {
        record_id: `public_${orgSlug}_goodneighbors_2025_global_emergency`,
        org_id: organization.org_id,
        date: '2026-01-01',
        title: '2025 해외 긴급구호사업 결산 지표',
        amount: '₩1,848,971,146',
        region: '해외 자연재난·분쟁 피해 지역',
        description: '2025 재정보고 기준 해외 긴급구호사업은 자연 재난, 전쟁 피해, 식량 기근 등 인도적 지원사업으로 집행된 공개 지표입니다.',
        evidence_title: '굿네이버스 2025 재정보고',
        evidence_url: 'https://www.goodneighbors.kr/goodneighbors/management/finance.gn',
        evidence_source: '굿네이버스'
      },
      {
        record_id: `public_${orgSlug}_goodneighbors_2025_humanitarian_relief`,
        org_id: organization.org_id,
        date: '2026-01-01',
        title: '인도적지원 사업 근거',
        region: '재난 및 분쟁 지역',
        description: '공식 사업 안내에서 긴급구호 및 재건 복구 활동으로 삶의 터전을 잃은 이웃의 생명 보호와 일상 회복을 돕는다고 공개합니다. 자연재해 대응, 주택·기반시설 재건, 생계 지원을 포함합니다.',
        evidence_title: '굿네이버스 인도적지원 사업안내',
        evidence_url: 'https://www.goodneighbors.kr/business/global_relief/emergency.gn',
        evidence_source: '굿네이버스'
      }
    ];
  }

  const sources = Array.isArray(organization.evidence_sources) ? organization.evidence_sources : [];
  return sources.slice(0, 3).map((source, index) => ({
    record_id: `public_${orgSlug}_evidence_${index + 1}`,
    org_id: organization.org_id,
    date: dateOnly(organization.report_generated_at || organization.last_checked_at || new Date().toISOString()),
    title: `${organization.org_name} 공개 근거 확인`,
    region: organization.activity_region,
    description: `${organization.activity_type} 활동과 연결된 공개 근거입니다. 후원금 사용 금액 지표는 원문 공개 자료에서 확인해야 합니다.`,
    evidence_title: source.title || '공개 근거',
    evidence_url: source.url || '',
    evidence_source: source.source_type || 'public_evidence'
  }));
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

app.get('/api/event-media', async (req, res) => {
  try {
    const media = await readEventMedia({
      eventId: req.query.eventId,
      title: req.query.title,
      category: req.query.category,
      region: req.query.region,
      startedAt: req.query.startedAt,
      isMock: booleanFromDb(req.query.isMock)
    });
    res.json(media);
  } catch (error) {
    console.error('Error reading event media:', error.message);
    res.status(500).json({
      error: 'Failed to fetch event media',
      message: error.message
    });
  }
});

app.get('/api/relief-recommendations', async (req, res) => {
  try {
    const organizations = await readMockCategoryRecommendations(req.query.category, req.query.region);
    res.json(organizations);
  } catch (error) {
    console.error('Error reading category relief recommendations:', error.message);
    res.status(500).json({
      error: 'Failed to fetch category relief recommendations',
      message: error.message
    });
  }
});

app.get('/api/events/:eventId/orgs', async (req, res) => {
  try {
    const organizations = await readOrganizationsForEventWithAutoRag(req.params.eventId);
    const events = await readEvents();
    const event = events.find(item => item.event_id === req.params.eventId);
    res.json(event
      ? organizations.map((org, index) => enrichOrganizationRecommendation(org, event, { mediaIndex: index }))
      : organizations);
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

    const events = await readEvents();
    const event = events.find(item => item.event_id === organization.event_id);

    if (event) {
      maybeScheduleOrgRagRefreshForEvent(event.event_id, 1).catch(error => {
        console.error(`Organization page RAG refresh check failed for ${event.event_id}:`, error.message);
      });
    }

    res.json(event
      ? enrichOrganizationRecommendation(organization, event)
      : organization);
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

app.get('/api/admin/events/:eventId/org-reports', requireAdminAuth, async (req, res) => {
  await ensureSeedTablesOnce();
  const db = openWritableDatabase();

  try {
    const reports = await listAiReportsForEvent(db, req.params.eventId);
    res.json(reports.map(mapAiReport));
  } catch (error) {
    console.error('Error reading AI organization reports:', error.message);
    res.status(500).json({
      error: 'Failed to fetch AI organization reports',
      message: error.message
    });
  } finally {
    await closeDatabase(db);
  }
});

app.post('/api/admin/events/:eventId/rag/run', requireAdminAuth, async (req, res) => {
  try {
    await ensureSeedTablesOnce();
    const events = await readEvents();
    const event = events.find(item => item.event_id === req.params.eventId);

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const existingOrganizations = await readOrganizationsForEvent(event.event_id);
    const db = openWritableDatabase();

    try {
      const result = await runOrgRag({
        db,
        event,
        existingOrganizations,
        options: req.body ?? {}
      });
      res.status(201).json({
        ...result,
        reports: result.reports.map(mapAiReport)
      });
    } finally {
      await closeDatabase(db);
    }
  } catch (error) {
    console.error('Error running organization RAG:', error.message);
    const isConfigError = error.message?.includes('OPENAI_API_KEY');
    res.status(isConfigError ? 400 : 500).json({
      error: isConfigError ? 'OpenAI API key is not configured' : 'Failed to run organization RAG',
      message: error.message
    });
  }
});

app.post('/api/admin/org-reports/:reportId/approve', requireAdminAuth, async (req, res) => {
  await ensureSeedTablesOnce();
  const db = openWritableDatabase();

  try {
    const report = await approveAiReport(db, req.params.reportId);

    if (!report) {
      res.status(404).json({ error: 'AI report not found' });
      return;
    }

    res.json(mapAiReport(report));
  } catch (error) {
    console.error('Error approving AI organization report:', error.message);
    res.status(500).json({
      error: 'Failed to approve AI organization report',
      message: error.message
    });
  } finally {
    await closeDatabase(db);
  }
});

app.post('/api/admin/org-reports/:reportId/reject', requireAdminAuth, async (req, res) => {
  await ensureSeedTablesOnce();
  const db = openWritableDatabase();

  try {
    const report = await rejectAiReport(db, req.params.reportId);

    if (!report) {
      res.status(404).json({ error: 'AI report not found' });
      return;
    }

    res.json(mapAiReport(report));
  } catch (error) {
    console.error('Error rejecting AI organization report:', error.message);
    res.status(500).json({
      error: 'Failed to reject AI organization report',
      message: error.message
    });
  } finally {
    await closeDatabase(db);
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

async function refreshStaleOrgRagReportsOnce() {
  if (!booleanFromEnv('AI_RAG_REFRESH_ENABLED', true)) {
    return;
  }

  const eventLimit = numberFromEnv('AI_RAG_REFRESH_EVENT_LIMIT', 10);
  if (eventLimit <= 0) {
    return;
  }

  const events = await readEvents();
  for (const event of events.slice(0, eventLimit)) {
    const organizations = await readOrganizationsForEvent(event.event_id);
    if (organizations.length === 0) {
      continue;
    }

    await maybeScheduleOrgRagRefreshForEvent(event.event_id, organizations.length);
  }
}

function startOrgRagRefreshTimer() {
  if (!booleanFromEnv('AI_RAG_REFRESH_ENABLED', true)) {
    return;
  }

  const intervalMs = numberFromEnv('AI_RAG_REFRESH_INTERVAL_MS', DEFAULT_ORG_RAG_REFRESH_INTERVAL_MS);
  if (intervalMs <= 0) {
    return;
  }

  const timer = setInterval(() => {
    refreshStaleOrgRagReportsOnce().catch(error => {
      console.error('Scheduled organization RAG refresh failed:', error.message);
    });
  }, intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

async function startServer() {
  await ensureDatabaseReady();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend server running on http://0.0.0.0:${PORT}`);
    startOrgRagRefreshTimer();
  });
}

startServer().catch(error => {
  console.error(`Server startup failed: ${error.message}`);
  process.exit(1);
});
