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
npm install
cp .env.example .env
npm run init:db
npm run seed:db
npm start
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

Schema source:

```text
db/schema.sql
```

Default local database:

```text
disaster.sqlite
```

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
- `GET /api/ingestion/status`
- `GET /api/disasters`

`/api/disasters` is the legacy GDACS proxy endpoint and is kept for compatibility.

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
