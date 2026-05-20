CREATE TABLE IF NOT EXISTS typhoon_data (
  seq INTEGER,
  tm TEXT,
  tmFc TEXT,
  typ_name TEXT,
  typ_loc TEXT,
  typ_ws REAL,
  img TEXT,
  lat REAL,
  lon REAL,
  dir TEXT,
  sp REAL,
  rad15 REAL,
  ws REAL,
  status TEXT,
  PRIMARY KEY (seq, tm)
);

CREATE TABLE IF NOT EXISTS earthquake_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmEqk TEXT,
  tmFc TEXT,
  tmSeq INTEGER,
  loc TEXT,
  lat REAL,
  lon REAL,
  mt REAL,
  dep REAL,
  inT TEXT,
  img TEXT,
  status TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_earthquake_data_event
ON earthquake_data (tmEqk, loc, mt);

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

CREATE TABLE IF NOT EXISTS flood_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tm TEXT,
  loc TEXT,
  depth REAL,
  area REAL,
  cause TEXT,
  status TEXT
);

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

CREATE INDEX IF NOT EXISTS idx_naver_news_type_key
ON naver_news (disaster_type, disaster_key);

CREATE INDEX IF NOT EXISTS idx_naver_news_pubDate
ON naver_news (pubDate);

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

CREATE INDEX IF NOT EXISTS idx_disaster_videos_type_key
ON disaster_videos (disaster_type, disaster_key);

CREATE INDEX IF NOT EXISTS idx_disaster_videos_published_at
ON disaster_videos (published_at);

CREATE TABLE IF NOT EXISTS official_updates (
  update_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  original_link TEXT
);

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
);

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
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  sources TEXT NOT NULL,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
