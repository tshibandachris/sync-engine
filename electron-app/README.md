# Eden Gestion — Electron walking skeleton

## Requirements

- Windows 10/11 x64 (initial target)
- Node.js 20+ and npm
- A reachable Sync Engine API URL and a valid device JWT issued by the backend

## Run locally

From this directory:

```powershell
npm install
$env:EDEN_SYNC_URL = "https://your-api-host"
$env:EDEN_SYNC_TOKEN = "YOUR_DEVICE_JWT"
npm run check
npm start
```

Use `http://localhost:3000` only for local development. Do not commit tokens or place them in source files. The initial skeleton reads the token from the process environment; packaged builds must use secure OS-backed storage and an enrollment/refresh flow.

## Current scope

- Initializes SQLite at `%APPDATA%/EdenGestion/data.db`
- Creates the first local tables and schema version record
- Calls the real `POST /sync/pull` contract with cursor 0
- Persists returned product changes and displays the local active-product count
- Keeps the renderer isolated from Node.js

This is not yet a production cashier: staff PIN enrollment, durable push/outbox, complete multi-entity cursor persistence, cash sessions, sales UI, packaging, automatic retry, and printer support are future milestones.
