# BossJobAI — Job Search Assistant for BOSS直聘

[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.7-brightgreen.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d6.svg)](#build-package)
[![CI](https://img.shields.io/github/actions/workflow/status/SpiralQWQ/bossjob-ai/ci.yml?branch=master)](.github/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Privacy-first local desktop app for job seekers.** Track applications, interviews, and offers locally — no cloud, no account, your data stays on your machine.
>
> **Manual tracking edition:** an Electron desktop app for non-technical job seekers. Resumes & application records are maintained locally (resume = local form entry, applications = manual status updates). BOSS直聘 online automation (parsing, matching, auto-apply) is **planned but not yet integrated** — see [Roadmap](#roadmap).

**7 pages delivered** — Dashboard / Resume / All Applications / Apply / Interview / Tracker / Settings — full CRUD + filtering + batch status update, plus a cross-cutting **Data & Backup** toolbox: export (JSON/CSV/offline) / import (file/paste) / backup-restore (zip bundle + checksum verification).

- ✅ **Local-first & privacy-first**: all data lives in a local SQLite database; nothing is uploaded.
- ✅ **Human-in-the-loop**: designed for manual tracking today, AI-assisted applying tomorrow (every action stays human-confirmed).
- ✅ **Compliant by design**: built-in rate limiting (15/day cap, random intervals) for when automation arrives.
- ✅ **Fully offline**: export / import / backup / restore all work without any network dependency.

## ✨ Features

| Area | Capability |
|------|-----------|
| 📊 **Dashboard** | Backend connection status + auth-token fingerprint check, target cities, quick actions |
| 📄 **Resume** | Local form entry (name/phone/email/city + custom fields), Markdown template export, JSON backup/import, dirty-check navigation guard |
| 🗂️ **All Applications** | Full CRUD, status/keyword/date-range filters, batch status update, CSV/JSON/offline export, file + paste import, in-app backup management |
| 📝 **Apply** | Pending queue with manual status advancement, inline undo, pagination with clamp |
| 🎤 **Interview** | Interview-tracking view + structured 【面试登记】 block (time/format/notes), "today / next 7 days" highlighting |
| 📈 **Tracker** | Dashboard stats (total / in-progress / offers / rejected / pass-rate) + last-30-day daily trend bar |
| ⚙️ **Settings** | Cities / apply rate-limit / browser / blacklist / external-link allowlist (LLM engine comes online in a later phase) |
| 💾 **Data & Backup** | JSON export (with preview), CSV export, offline export fallback, `.zip` portable backup archive, checksum-verified restore, auto-backup with retention |

> AI capabilities — resume parsing / optimization → JD matching → greeting generation → human-confirmed auto-apply → mock interview — are **planned for P1–P7** ([Roadmap](#roadmap)), not yet live.

## 📸 Screenshots

> *Screenshots coming soon. The app is a single-window Electron desktop UI with a dark sidebar and light content area.*

## 📚 Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Backend API](#backend-api)
- [Configuration](#configuration)
- [Build & Package](#build-package)
- [Security Baseline](#security-baseline)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)
- [Support](#support)

---

## 🚀 Quick Start

### Prerequisites

| Dependency | Version | Notes |
|------------|---------|-------|
| **Python** | 3.11 / 3.12 | Backend (FastAPI + SQLite) |
| **Node.js** | 20+ | Frontend (Vite) + Electron tooling |
| **Git** | any | Clone the repository |

### 1. Clone

```bash
git clone https://github.com/SpiralQWQ/bossjob-ai.git
cd bossjob-ai
```

### 2. Run the backend (FastAPI)

```powershell
cd code\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8675
```

> Verify: `curl http://127.0.0.1:8675/api/health` → `{"status":"ok","version":"0.1.7", ...}`

### 3. Run the frontend (Vite dev server)

```powershell
cd code\frontend
npm install
npm run dev        # http://127.0.0.1:5173 (strictPort)
```

> Opening the dev server in a plain browser: the `window.api` bridge is unavailable; Dashboard degrades gracefully with "Please launch via Electron".

> **3-step quickest path:** clone → install backend deps → `npm start`. The desktop shell auto-spawns the backend and serves the frontend, so you can skip steps 2 & 3.

### 4. Run the desktop shell (recommended)

```powershell
cd code\electron
npm install
npm start
```

Electron auto-spawns the backend, polls `/api/health` until ready, then loads the UI. The backend restarts automatically on abnormal exit (up to `MAX_BACKEND_RESTARTS` times) and is gracefully shut down when the app quits.

> **Note:** the backend listens on `127.0.0.1` only and is protected by a per-session Bearer token injected by the Electron main process — see [Security Baseline](#security-baseline).

---

## 🏗️ Architecture

Three-layer process model (see [`docs/architecture-design-v0.2.md`](docs/architecture-design-v0.2.md) for the full design):

```
┌──────────────────────────────────────────────────────────┐
│  Renderer  React + TS + Antd (Vite)                      │
│  UI only; talks to main via preload bridge (window.api)  │
└───────────────────────┬──────────────────────────────────┘
                        │ IPC (contextIsolation + sandbox)
┌───────────────────────▼──────────────────────────────────┐
│  Electron main  window mgmt + backend supervision         │
│  spawns & supervises the Python backend (auto-restart)    │
│  injects Bearer token; enforces endpoint whitelist        │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP (Bearer Token, 127.0.0.1 only)
┌───────────────────────▼──────────────────────────────────┐
│  Python backend  FastAPI + SQLAlchemy + SQLite            │
│  AI decisions, data storage, future automation control    │
└──────────────────────────────────────────────────────────┘
```

- **Electron main process**: window management, lifecycle, spawns & supervises the Python backend (auto-restart on crash).
- **Renderer** (React + TS): all UI, talks to the main process via a minimal preload IPC bridge, reaches the backend over HTTP.
- **Python backend** (FastAPI): AI decisions, data storage, future automation control; listens on `127.0.0.1` only.

**Core principles**: local-first privacy (SQLite), human-in-the-loop (every apply needs manual confirmation), compliant rate limiting (daily cap 15, random intervals), modularity (decision layer decoupled from browser execution layer), Chinese-first (DeepSeek/Qwen).

---

## 🔌 Backend API

> Full reference in [`docs/api-docs-v0.1.md`](docs/api-docs-v0.1.md).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | `{"status":"ok","version":"0.1.7","auth_token_fingerprint":"<sha256 first 16>"}` — readiness + token fingerprint |
| `/api/settings` | GET | Current effective config snapshot (sensitive fields like `llm.api_key` stripped) |
| `/api/settings` | PUT | Merge public config from renderer and persist (base_url whitelist + external_url_hosts validation) |
| `/api/applications` | GET | Paginated query (status exact / keyword fuzzy / date range; LIKE wildcard escaping) |
| `/api/applications` | POST | Create an application record (title/company strip-then-nonempty; writes apply log) |
| `/api/applications/{id}` | PATCH | Partial update (only provided fields; `applied_at:null` clears to unset; zero-change skips log) |
| `/api/applications/{id}` | DELETE | Delete record (cascades apply_logs) |
| `/api/applications/ids` | GET | Lightweight list of all ids (for import overwrite estimation) |
| `/api/applications/{id}/logs` | GET | Per-record operation timeline |
| `/api/stats` | GET | Dashboard stats: total / in-progress / offers / rejected / pass-rate + last-30-day daily trend |
| `/api/export` | GET | Full business data as JSON (applications + apply_logs + sanitized config) |
| `/api/import` | POST | Import export-JSON (overwrite-by-id / create-new, per-row tolerant) |

---

## ⚙️ Configuration

Copy `code/settings.template.json` to `code/settings.json` on first setup (a default config is auto-written on first backend start if missing). The template ships with empty cities and no credentials — fill in your own target cities and (optionally) an LLM provider key.

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

**Precedence**: env `BOSS_PORT` (top-level) / `BOSS_LLM__PROVIDER` (nested, `__` separator) > `settings.json` > code defaults.
**Packaged mode**: the config lives at `%APPDATA%\BossJobAI\settings.json` (copied from `resources/settings.json` on first launch).

---

## 🔨 Build & Package

> Full walkthrough in [`code/packaging/BUILD.md`](code/packaging/BUILD.md). Order: **frontend build → backend PyInstaller → electron-builder**.

### Frontend build

```powershell
cd code\frontend
npm install
npm run build        # tsc + vite build → frontend/dist/
```

### Backend PyInstaller (create `backend/.venv` first and install `pyinstaller`)

```powershell
cd code\packaging
..\backend\.venv\Scripts\pyinstaller --noconfirm --clean `
  --distpath ..\backend\dist --workpath ..\build\backend backend.spec
# output: backend/dist/bossjob-backend/bossjob-backend.exe
```

### electron-builder installer (install Electron deps first)

```powershell
cd code\electron
npm install
npm run dist
# output: packaging/release/BossJobAI-Setup-0.1.7.exe (NSIS)
```

> **Packaging-chain essentials**: frontend `base: './'` + HashRouter for `file://` compatibility; backend frozen path reads config/data from `%APPDATA%/BossJobAI`; electron-builder bundles the backend exe + `settings.default.json`; first run copies settings to APPDATA if missing.
>
> **Version sync** (change all three together): `backend/app/constants.py` `APP_VERSION` + `electron/package.json` `version` + `frontend/package.json` `version`. The app cross-checks them at startup and warns on drift.

---

## 🔒 Security Baseline

- **Electron**: `contextIsolation=true` + `nodeIntegration=false` + `sandbox=true`; renderer only talks to main via the minimal API surface exposed by `preload.js`.
- **Backend**: global Bearer-token auth (fail-closed; one-time token file injected then deleted); Host header check (DNS rebinding) + Origin check (cross-origin 403); CORS only localhost + `app://`.
- **Renderer**: strict CSP `script-src 'self'` (build-time + runtime enforced); no inline script execution.
- **LLM api_key**: DPAPI-encrypted at rest (`enc:` prefix), never leaves the backend / never appears in `GET /api/settings` or exports.
- **`llm.base_url` whitelist** (known providers + loopback), blocks XSS exfiltration of the API key.
- **External link opening** gated by main-process host allowlist (scheme/host normalization, scheme-bypass blocked).
- **Backup manifest** checksum-key whitelist regex, blocks zip path traversal; restore is checksum-verified + snapshot-rollback protected.
- **Import**: per-row tolerant, per-window trusted-path TTL, sanitized settings merge.

---

## 🗺️ Roadmap

> Suggested order: **P0–P3 first** (zero-risk pure-tool value), P4–P5 separately gated on compliance review, P6–P7 wrap-up.

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

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first, then open an issue or a pull request.

- Found a bug? Open an [issue](https://github.com/SpiralQWQ/bossjob-ai/issues).
- Have an idea? Open a [discussion](https://github.com/SpiralQWQ/bossjob-ai/discussions) or PR.

---

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

---

## 📄 License

BossJobAI is **dual-licensed**:

- **Open source**: [GNU Affero General Public License v3 (AGPL-3.0)](LICENSE) — any derivative work, including software offered over a network, must be distributed under AGPL-3.0.
- **Commercial**: a separate [commercial license](COMMERCIAL.md) for companies/individuals who want to embed the app in proprietary or closed-source products without the AGPL source-sharing obligations.

Copyright © 2026 **Spiral QWQ**. All rights reserved.

---

## 💛 Support

If this project has helped you in any way, you're welcome to buy me a coffee. It's completely voluntary — the project stays free and open-source regardless. For an independent developer, every small token of appreciation matters.

<p align="center">
  <img src="assets/donate_wechat.jpg" alt="WeChat Pay" width="200">
  <img src="assets/donate_alipay.jpg" alt="Alipay" width="200">
</p>

---

*BossJobAI Job Search Assistant — privacy-first local desktop tool for job seekers.*
