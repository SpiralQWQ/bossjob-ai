# BossJobAI Job Search Assistant (BOSS直聘 AI Job Assistant) · Manual Tracking Edition v0.1

> **Currently the manual-tracking edition (v0.1)**: an **Electron desktop app** for non-technical job seekers. Resume & application records are maintained locally (resume = local form entry, applications = manual status updates); BOSS直聘 online automation is **not yet integrated**.
>
> Delivered: **7 pages** — Dashboard / Resume / All Applications / Apply (manual entry) / Interview / Tracker / Settings — full CRUD + filtering + batch status update, export (JSON/CSV/offline) / import (file/paste) / backup-restore (zip bundle + checksum verification), see **§7 Implemented Features**.
>
> Resume parsing / optimization → JD matching → greeting generation → human-confirmed auto-apply → mock interview: **AI capabilities are planned for P1–P7, not yet live** (roadmap in §6). Fully local-first, privacy-first.
>
> Version `0.1.6` ｜ Architecture doc: `docs/求职投递项目_架构设计_v0.2.md` ｜ API doc: `docs/求职投递项目_接口文档_v0.1.md` ｜ Build guide: `code/packaging/BUILD.md`

## 💛 Support / Tip

If this project has helped you in any way, you're welcome to buy me a coffee. It's completely voluntary — the project stays free and open-source regardless. For an independent developer, every small token of appreciation matters.

<p align="center">
  <img src="assets/donate_wechat.jpg" alt="WeChat Pay" width="200">
  <img src="assets/donate_alipay.jpg" alt="Alipay" width="200">
</p>

<p align="center"><i>Thanks for reading all the way down here. 🙏</i></p>

---

## 1. Project Overview

- **Architecture**: Electron shell + Python FastAPI backend + SQLite, three-layer process model.
  - **Electron main process**: window management, lifecycle, **spawns & supervises the Python backend** (auto-restart on crash).
  - **Renderer** (React + TS): all UI, talks to the main process via preload IPC bridge, reaches the backend over HTTP.
  - **Python backend** (FastAPI): AI decisions, data storage, future automation control; listens on `127.0.0.1` only.
- **Core principles**: local-first privacy (data in local SQLite), human-in-the-loop (every apply needs manual confirmation), compliant rate limiting (daily cap 15, random intervals), modularity (decision layer decoupled from browser execution layer), Chinese-first (DeepSeek/Qwen).
- **Security baseline (arch v0.2)**: `contextIsolation=true`, `nodeIntegration=false`; renderer only talks to main via the minimal API surface exposed by `preload.js`; API keys never leave the backend / never appear in `GET /api/settings`.
- **Data export/backup/migration**: the Data page offers JSON export (with content preview before saving), `.zip` backup archive (latest auto-backup bundled: app.db + settings.json + resume snapshot + manifest), and archive import (restored through the same security checks as in-app restore, backend restarts after); preview shows sample records + resume summary before restoring.

## 2. P0 Skeleton Structure

```
code/
├── settings.template.json     # Runtime config template (copy to settings.json; port/LLM/apply/browser/blacklist/cities)
├── backend/                      # Python FastAPI backend
│   ├── app/
│   │   ├── main.py               # Entry (global Bearer auth, Host/Origin checks, CORS, lifecycle, routes)
│   │   ├── config.py             # Config loading (env > settings.json > defaults; sensitive fields masked / api_key DPAPI-encrypted)
│   │   ├── constants.py          # Constants: paths/version/port range/CORS whitelist (no hardcoding)
│   │   ├── db.py                 # SQLAlchemy engine / SessionLocal / init_db + schema v1→v3 migration
│   │   ├── models.py             # ORM models (Application / ApplyLog)
│   │   ├── schemas.py            # Pydantic response models ({code,data,message} convention)
│   │   └── routers/
│   │       ├── health.py         # GET /api/health (with auth-token fingerprint)
│   │       ├── settings.py       # GET/PUT /api/settings (base_url whitelist / external_url_hosts validation)
│   │       └── data.py           # Business routes (application CRUD / stats / export / import)
│   ├── data/app.db               # SQLite (auto-created)
│   └── requirements.txt
├── electron/                     # Electron main + preload
│   ├── main.js                   # Port resolution, backend supervision, auth-token injection, window, IPC, single-instance lock, backup/restore/import-export
│   ├── preload.js                # contextBridge exposes window.api (minimal API surface)
│   └── package.json
├── frontend/                     # React + TS + Vite + Antd + Zustand
│   ├── vite.config.ts            # base './', dev port 5173 (strictPort), CSP injection
│   └── src/
│       ├── main.tsx / App.tsx    # Entry + RouterProvider
│       ├── router.tsx            # HashRouter (file:// packaged compat), 7 page routes
│       ├── pages/                # Dashboard / ResumePage / DataViews(Jobs+Tracker) / ApplyPage / InterviewPage / Settings
│       ├── lib/                  # applyStatus / applyShared / baseUrl / useBackendBase (shared logic)
│       └── stores/settingsStore.ts  # Zustand settings store (fetch /api/settings)
└── packaging/
    ├── BUILD.md                  # Windows build guide
    ├── backend_entry.py          # PyInstaller backend exe bootstrapper (uvicorn)
    ├── backend.spec              # PyInstaller spec
    └── electron-builder.yml      # electron-builder config (NSIS installer)
```

**Implemented backend endpoints**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | `{"status":"ok","version":"0.1.6","auth_token_fingerprint":"<sha256 first 16>"}` — main process readiness + token fingerprint check |
| `/api/settings` | GET | Current effective config snapshot (sensitive fields like `llm.api_key` stripped) |
| `/api/settings` | PUT | Merge public config from renderer and persist (`llm.base_url` gets "https + known-provider-host whitelist + no-userinfo" validation; `security.external_url_hosts` per-item format check) |
| `/api/applications` | GET | Paginated application query (status exact / keyword fuzzy / date day / date_from..date_to range; LIKE wildcard escaping) |
| `/api/applications` | POST | Create an application record (title/company strip-then-nonempty; default status pending; writes apply log) |
| `/api/applications/{id}` | PATCH | Partial update (only provided fields; `applied_at:null` clears to unset; zero-change skips log) |
| `/api/applications/{id}` | DELETE | Delete record (cascades apply_logs) |
| `/api/applications/ids` | GET | Lightweight list of all ids (for import overwrite estimation) |
| `/api/applications/{id}/logs` | GET | Per-record operation timeline (created / status change / field update) |
| `/api/stats` | GET | Dashboard stats: total / in-progress / offers / rejected / pass-rate + last-30-day daily trend |
| `/api/export` | GET | Full business data as JSON (applications + apply_logs + public config snapshot, sensitive fields stripped) |
| `/api/import` | POST | Import export-JSON (overwrite-by-id / create-new, per-row tolerant, returns created/updated/skipped split counts, apply_logs mapped by id) |

## 3. Running (dev mode)

> Port is always read from `settings.json` / env `BOSS_PORT`, never hardcoded. Default `8675`.

### 3.1 Backend (uvicorn)

```powershell
cd ...\code\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8675
```

Verify: `curl http://127.0.0.1:8675/api/health` → `{"status":"ok","version":"0.1.6"}`

### 3.2 Frontend (Vite dev server)

```powershell
cd ...\code\frontend
npm install
npm run dev        # http://127.0.0.1:5173 (strictPort)
```

> Opening the dev server in a plain browser: `window.api` bridge is unavailable; Dashboard gracefully degrades with "Please launch via Electron".

### 3.3 Electron shell (recommended)

```powershell
cd ...\code\electron
npm install
npm start
```

Electron auto-spawns the backend (`python -m uvicorn ...`), polls `/api/health` until ready, then loads `http://localhost:5173` (dev mode). Backend restarts up to `MAX_BACKEND_RESTARTS` times on abnormal exit; backend subprocess is gracefully shut down on app quit.

## 4. settings.json Reference

Located at `code/settings.json`; copy `code/settings.template.json` to `code/settings.json` on first setup (a default config is auto-written on first backend start if missing). The template ships with empty cities and no credentials — fill in your own target cities and (optionally) LLM provider key.

```jsonc
{
  "port": 8675,                          // backend HTTP port (valid 1024~65535)
  "llm": {                               // LLM (OpenAI-compatible)
    "provider": "deepseek",
    "api_key": "",                       // leave empty; plaintext key stays local only
    "model": "deepseek-chat",
    "base_url": ""
  },
  "apply": {                             // apply compliance rate limiting
    "daily_limit": 15,                   // max applications per day
    "interval_seconds": [45, 120],       // random interval range between applies (sec)
    "halt_on_risk": true                 // pause immediately when risk detected
  },
  "browser": {                           // browser execution layer (DrissionPage, enabled in P4)
    "user_data_dir": "",                 // dedicated user data dir (empty = default)
    "headless": false                    // headed mode (human-visible, lowers risk)
  },
  "blacklist": {                         // blocklist: companies / keywords
    "companies": [],
    "keywords": ["外包", "猎头", "培训"]
  },
  "security": {
    "external_url_hosts": []             // open-external host allowlist suffixes
  },
  "cities": []                           // target cities
}
```

## 5. Build / Package (Windows)

### 5.1 Frontend build

```powershell
cd ...\code\frontend
npm run build    # tsc + vite build + verify-csp.mjs
```

### 5.2 Backend PyInstaller (create `backend/.venv` first and install `pyinstaller`)

```powershell
cd ...\code\backend
pip install pyinstaller
pyinstaller backend.spec
# output: backend/dist/bossjob-backend/bossjob-backend.exe
```

### 5.3 electron-builder installer (install Electron deps first)

```powershell
cd ...\code\electron
npm install
npm run dist
# output: packaging/release/BossJobAI-Setup-0.1.6.exe (NSIS)
```

### 5.4 Packaging-chain essentials (implemented in P0)

- Frontend `base: './'` + HashRouter for file:// compatibility.
- Backend frozen path: reads config/data from `%APPDATA%/BossJobAI` (backend_entry.py handles `sys._MEIPASS` resource extraction).
- electron-builder includes backend exe + settings.default.json; first run copies settings to APPDATA if missing.

## 6. Roadmap (P1–P7)

> From arch v0.2 §13. Suggested order: **P0–P3 first** (zero-risk pure-tool value), P4–P5 separately gated on compliance review, P6–P7 wrap-up.

| Phase | Milestone | Deliverable | Risk |
|-------|-----------|-------------|------|
| **P0 Skeleton** ✅ | Electron shell + FastAPI + SQLite | Runnable shell | 🟢 |
| **P1 Resume** ✅ P1a | Resume material library + RAG (**P1a done**); PDF/DOCX parse + editor + template export | Resume module usable | 🟢 |
| **P2 Matching** | FastEmbed + keywords + LLM scoring + match panel | Job matching usable | 🟢 |
| **P3 Optimization** | STAR/ATS optimization + greeting generation | AI assist usable | 🟢 |
| **P4 Scraping** | DrissionPage BOSS login + job collection | Job library usable | 🟡 compliance |
| **P5 Applying** | Pending-confirm queue + human-confirmed apply + rate limit | Applying usable | 🔴 ban risk |
| **P6 Interview** | Mock interview + report | Interview module | 🟢 |
| **P7 Dashboard** | Job dashboard + stats + review | Full loop | 🟢 |

Frontend route plan (arch §4.1): `/resume`, `/jobs`, `/match/:jobId`, `/apply`, `/interview`, `/tracker`, `/settings`.

## 7. Implemented Features (Manual Tracking Edition v0.1)

> This list tracks releases (matches CHANGELOG `## [0.1.x]` sections). grep-dedup: add only when actually missing.

### 7.1 Frontend modules (7 pages, sidebar navigation)

| Route | Page | Implemented |
|-------|------|-------------|
| `/` Dashboard | Dashboard | Backend connection status + auth-token fingerprint check + target cities + quick links |
| `/resume` Resume | ResumePage | Local resume form (name/phone/email/city + custom fields), saved via main process to disk + localStorage |
| `/jobs` All Applications | JobsPage | Full CRUD, status/keyword/date-range filters, batch status update, export CSV/JSON/offline, file + paste import, backup/restore (checksum + preview) |
| `/apply` Manual Apply | ApplyPage | Pending queue, create/edit/status advance, pagination (clamp when edit leaves filter) |
| `/interview` Interview | InterviewPage | "Interviewing" view + interview entry (time/form/notes), structured 【面试登记】 block parse/rebuild, handwritten-time read-only notice + remove |
| `/tracker` Tracker | TrackerPage | Job dashboard stats (total/in-progress/offer/rejected/pass-rate) + last-30-day trend bar |
| `/settings` Settings | Settings | Cities / apply rate-limit / browser / blacklist / external-link allowlist edit & save; LLM engine not wired (ComingSoon placeholder, config savable) |

### 7.2 Data & Backup

- Application status enum: `pending / replied / interview / offer / rejected / closed` (defined once in `lib/applyStatus.ts`, shared by 3 pages)
- Applied time supports "empty = unset" (NULL), export→import round-trip faithful
- Per-record operation log timeline (created / status change / field update; only real changes logged)
- Export: JSON (previewable), CSV, offline export (applies current filters)
- Backup/restore: auto-backup + `.zip` archive (app.db + settings.json + resume snapshot + manifest), manifest checksum + preview before restore; corrupt/tampered backups detected
- Import: file + paste dual channel, per-row tolerant (bad rows skipped, not whole-batch abort), original-id continuity + apply_logs history preserved

### 7.3 Security Baseline (arch v0.2)

- Electron: `contextIsolation=true` + `nodeIntegration=false` + `sandbox=true`; renderer only via preload minimal API
- Backend global Bearer-token auth (fail-closed; one-time token file deleted after injection); Host header check (DNS rebinding) + Origin check (cross-origin 403)
- CORS only localhost + `app://`; renderer CSP strict `script-src 'self'`
- LLM api_key: backend DPAPI-encrypted (`enc:` prefix), never in `GET /api/settings` / exports
- `llm.base_url` whitelist (known providers + loopback), blocks XSS exfiltrating the API key
- External link opening gated by main-process host allowlist (scheme/host normalization, scheme-bypass blocked)
- Backup manifest checksum key whitelist regex, blocks zip path traversal

## 8. P1a Resume Material Library + RAG (done, internal)

> P1 prerequisite research deliverable (2026-08-06, see CHANGELOG `## [0.1.6]`). The research corpus (200 third-party repos + RAG index, ~3.3 GB) is **kept out of this repository** — it is used internally to drive P1b editor design, not redistributed here.

| Deliverable | Summary |
|-------------|---------|
| **Research corpus** | GitHub 34-keyword scan → 200 resume/document/job-ecosystem repos (1k+ stars first), isolated-cloned locally |
| **Detailed knowledge base** | 《简历知识库_详细内容.md》1194 lines: methodology (FAB/STAR/ATS), JSON Resume Schema, per-role templates, CN/EN example sentences & cover-letter templates, AI optimization models (resumePolice/career-ops) |
| **RAG index** | bge-m3 1024-dim, 40,367 chunks, full 200/200 repo coverage (GPU CUDA accelerated); **2000-query test 99.8%** (≥98% passed) |

> P1b editor development builds on this knowledge base's JSON Resume Schema + template essence — no building from scratch.

---

*BossJobAI Job Search Assistant — privacy-first local desktop tool for job seekers.*
