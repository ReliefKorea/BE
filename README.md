# Disaster Backend

Backend REST adapter and data ingestion scripts for the disaster response platform.

The backend reads disaster data from SQLite, normalizes it for the frontend API contract, and exposes Express endpoints under `/api`.

## Requirements

- Node.js 18 or newer
- npm
- SQLite is accessed through the `sqlite3` npm package
- External API keys are optional for starting the server, but required for live polling

## Setup

```bash
PS C:\Users\...\BE> npm install
PS C:\Users\...\BE> cp .env.example .env //또는 카카오톡에 올린 .env파일을 ...\BE풀더 안에 넣으세요
PS C:\Users\...\BE> npm run init:db // DB 파일과 테이블 구조 생성
PS C:\Users\...\BE> npm run seed:db // 테스트용/기본 계약용 데이터 생성
PS C:\Users\...\BE> npm run poll:once // 실제 외부 API에서 지진/태풍/산불 데이터를 가져와 DB에 저장
PS C:\Users\...\BE> npm run poll:watch // (선택사항) regular polling 할 때 실행. 요청주기는 5분
PS C:\Users\...\BE> npm start 
```

On Windows PowerShell, copy the env file with:

```powershell
Copy-Item .env.example .env
```

The server defaults to:

```text
http://localhost:3000/api
```

## Environment Variables

```text
PORT=3000
NODE_ENV=development
DATABASE_PATH=./disaster.sqlite
POLL_INTERVAL_MS=300000
GDACS_API_URL=
PUBLIC_DATA_SERVICE_KEY=
KMA_SERVICE_KEY=
WILDFIRE_SERVICE_KEY=
FLOOD_SERVICE_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
YOUTUBE_API_KEY=
OPENAI_API_KEY=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_LLM_MODEL=gpt-4o-mini
OPENAI_API_BASE_URL=https://api.openai.com/v1
```

Do not commit real `.env` values. Use `.env.example` for placeholders only.

## Database

The SQLite database is local runtime state and should not be committed.

Initialize schema:

```bash
npm run init:db
```

Seed minimal contract data:

```bash
npm run seed:db
```

By default, seed data does not insert support organizations, donation history, or AI RAG reports. Keep `SEED_DEMO_SUPPORT_DATA=false` so frontend mock fallback data stays separate from the SQLite runtime database. Set it to `true` only for explicit demo fixtures.

Schema source:

```text
db/schema.sql
```

Default local database:

```text
disaster.sqlite
```

Railway SQLite database:

```text
DB_PATH=/data/disaster.sqlite
```

Create a Railway Volume on the `BE` service and mount it at `/data`. The server creates the parent directory and applies `db/schema.sql` at startup, so the database file can be created inside the mounted volume before API routes read it.

## Polling

Run one polling cycle:

```bash
npm run poll:once
```

Run polling continuously:

```bash
npm run poll:watch
```

Default interval:

```text
POLL_INTERVAL_MS=300000
```

Polling uses the existing wildfire, typhoon, and earthquake collection scripts. It does not run automatically from the Express server.

## API Endpoints

- `GET /api/health`
- `GET /api/events`
- `GET /api/events/:eventId`
- `GET /api/events/:eventId/articles`
- `GET /api/events/:eventId/updates`
- `GET /api/events/:eventId/orgs`
- `GET /api/orgs/:orgId`
- `GET /api/orgs/:orgId/history`
- `GET /api/admin/events/:eventId/org-reports`
- `POST /api/admin/events/:eventId/rag/run`
- `POST /api/admin/org-reports/:reportId/approve`
- `POST /api/admin/org-reports/:reportId/reject`
- `GET /api/ingestion/status`
- `GET /api/disasters`

`/api/disasters` is the legacy GDACS proxy endpoint and is kept for compatibility.

## Organization RAG

The organization RAG flow is backend-only. Generated reports are auto-published to the public event page when `AI_RAG_AUTO_PUBLISH=true`.

1. Add `OPENAI_API_KEY` to `BE/.env`.
2. Start the backend with `npm start`.
3. Run:

```bash
npm run rag:orgs -- --eventId=<event_id> --limit=3
```

Generated reports are saved with `review_status=approved` when `AI_RAG_AUTO_PUBLISH=true`, then merged into `GET /api/events/:eventId/orgs` and shown on the frontend cards.

When `AI_RAG_AUTO_RUN_ON_EMPTY=true`, `GET /api/events/:eventId/orgs` runs RAG on demand if no approved AI RAG report exists yet. Existing non-AI organization rows do not block RAG generation. Concurrent requests for the same event share one in-flight run.

Candidate selection and cost controls:

- `AI_RAG_DEFAULT_LIMIT=3` limits default organization candidates per run.
- `AI_RAG_ON_DEMAND_LIMIT=3` limits event-detail auto-generation to three fit-ranked organizations.
- `AI_RAG_ON_DEMAND_CATALOG_LIMIT=3` limits auto-generation catalog candidates.
- `AI_RAG_REUSE_SAME_ORG=true` reuses an approved report for the same organization, donation link, volunteer link, activity type, and disaster type across events.
- `AI_RAG_CROSS_EVENT_REPORT_TTL_MS=2592000000` keeps same-organization reuse valid for 30 days.
- `AI_RAG_REPORT_TTL_MS=21600000` reuses reports generated within 6 hours.
- `AI_RAG_REFRESH_ENABLED=true` enables background refresh for stale or under-filled organization cards.
- `AI_RAG_REFRESH_INTERVAL_MS=21600000` checks recent events every 6 hours.
- `AI_RAG_REFRESH_STALE_MS=604800000` regenerates approved AI reports older than 7 days.
- `AI_RAG_REFRESH_LIMIT=3` and `AI_RAG_REFRESH_CATALOG_LIMIT=3` cap refresh runs to three fit-ranked organizations.
- `AI_RAG_REFRESH_EVENT_LIMIT=10` limits each scheduled scan to recent events.
- `AI_RAG_REFRESH_COOLDOWN_MS=1800000` prevents repeated refresh attempts for the same event within 30 minutes.
- `AI_RAG_MAX_SOURCE_CHARS=6000` caps source text before embedding.
- `AI_RAG_OFFICIAL_SOURCE_LIMIT=1`, `AI_RAG_SEARCH_QUERY_LIMIT=2`, and `AI_RAG_NEWS_DISPLAY=3` keep retrieval compact.
- `AI_RAG_FORCE_REFRESH=true` bypasses report and embedding caches only when a fresh full run is needed.
- `SEED_DEMO_SUPPORT_DATA=false` keeps demo support organizations, donation history, and AI reports out of SQLite so they cannot be mistaken for RAG output.

For local API outage demos, keep `AI_RAG_DUMMY_MODE=auto` in `.env`. In development this keeps the RAG route usable with local fallback analysis.

## Frontend Connection

The frontend should use:

```text
VITE_API_BASE_URL=http://localhost:3000/api
```

Do not connect the frontend directly to `/api/disasters` for the PDF event API contract.

## Troubleshooting

### Port Already In Use

Set another port:

```bash
PORT=3010 npm start
```

PowerShell:

```powershell
$env:PORT = "3010"
npm start
```

### Missing `.env`

The server can start without `.env` by using defaults, but polling requires API keys. Create one from `.env.example`.

### Missing DB

Run:

```bash
npm run init:db
npm run seed:db
```

### API Key Missing

Live polling requires API keys in `.env`. Server read-only endpoints can still start without polling keys.

### CORS Issue

The Express server enables CORS. Confirm the frontend is using the same backend base URL shown above.

### Frontend Cannot Connect

Check:

- backend is running
- frontend `VITE_API_BASE_URL` is `http://localhost:3000/api`
- browser is not using stale service worker cache
- `/api/health` returns `{"status":"ok","service":"disaster-be"}`

## Forest Fire Crawler

The current wildfire crawler reads the Korea Forest Service public forest-fire list API:

```text
https://fd.forest.go.kr/ffas/pubConn/movePage/sub1.do
https://fd.forest.go.kr/ffas/pubConn/occur/getPublicShowFireInfoList.do
```

The list API is used because it provides both start time and extinguish time.

### Run

```bash
npm run crawl:wildfire:forest
```

The old command is kept as a compatibility wrapper and uses the same Forest Service crawler now:

```bash
npm run crawl:wildfire:safekorea
```

### Search Conditions

The crawler requests today's date by default.

Important parameters:

- `startDtm`: search start date, `YYYYMMDD`
- `endDtm`: search end date, `YYYYMMDD`
- `prgrsCode`: empty string means all statuses

Keeping `prgrsCode` empty is important. The website's first screen may default to in-progress fires only, but empty status includes completed fires such as `03`.

Optional command examples:

```bash
node crawl_wildfire_forest_fd.js --date=2026-05-26
node crawl_wildfire_forest_fd.js --from=2026-05-01 --to=2026-05-26
node crawl_wildfire_forest_fd.js --status=03
```

### DB Mapping

The crawler saves rows into the existing `wildfire_data` table.

- `frfr_frng_dtm` -> `startyear`, `startmonth`, `startday`, `starttime`, `startdayofweek`
- `potfr_end_dtm` -> `endyear`, `endmonth`, `endday`, `endtime`
- `frfr_sttmn_addr` -> `locsi`, `locgungu`, `locmenu`, `locdong`, `locbunji`
- status text is not stored because the existing table has no status column
- missing cause and damage area are stored as `NULL`

The save logic checks exact duplicates first. It also updates an existing row when date, location, and start time match at minute precision, so a previous row like `13:09:40` can receive an end time from a newer source row like `13:09`.

### Scheduling

Use a 5-10 minute interval or slower. Do not send excessive requests to public institution sites.

```bash
npm run crawl:wildfire:forest:cron
```
