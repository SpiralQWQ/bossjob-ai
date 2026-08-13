# BossJobAI — Build & Development Guide

> **Windows 11 x64** build & development guide for the BossJobAI desktop app.
>
> **Build order**: frontend build → backend PyInstaller → electron-builder.
> **Final artifact**: `packaging/release/BossJobAI-Setup-0.1.7.exe` (NSIS installer).

## 📑 Table of Contents

- [Prerequisites](#1-prerequisites)
- [Development (run from source)](#2-development-run-from-source)
- [Frontend build](#3-frontend-build)
- [Backend PyInstaller](#4-backend-pyinstaller)
- [Electron installer](#5-electron-installer)
- [Packaging internals](#6-packaging-internals)
- [Version management](#7-version-management)
- [Smoke testing](#8-smoke-testing)
- [Troubleshooting (FAQ)](#9-troubleshooting-faq)

---

## 1. Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Python** | 3.11 / 3.12 | Backend (FastAPI). Developed with CPython 3.12. |
| **Node.js** | 20+ (incl. npm) | Frontend (Vite) + Electron tooling. |
| **Shell** | PowerShell / Git Bash | Commands below are PowerShell-style. |
| *(optional)* pip mirror | — | `pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple` |
| *(optional)* npm mirror | — | `npm config set registry https://registry.npmmirror.com` |

## 2. Development (run from source)

> Dev-run steps are in the main [README](../../README.md#quick-start). This guide focuses on building the distributable.

## 3. Frontend build

```powershell
cd code\frontend
npm install
npm run build
```

- **Output**: `frontend/dist/` (`vite.config.ts` sets `base: './'` for Electron `loadFile` compatibility).
- **On failure**: `npm run build` = `tsc && vite build`, fix TypeScript errors first, then rebuild.
- **Gates**: `verify-csp.mjs` runs at the end of the build and asserts the strict CSP (see [Packaging internals](#6-packaging-internals)).

## 4. Backend PyInstaller

Create `backend/.venv` first, install runtime deps + PyInstaller:

```powershell
cd code\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller
```

Build (run from `code\packaging`):

```powershell
cd code\packaging
..\backend\.venv\Scripts\pyinstaller --noconfirm --clean `
  --distpath ..\backend\dist --workpath ..\build\backend backend.spec
```

- **Output**: `code/backend/dist/bossjob-backend/bossjob-backend.exe`
- The spec `collect_all`'s `uvicorn/fastapi/sqlalchemy/pydantic` and `collect_submodules('app')` collects all backend modules.
- Build time: typically 1–3 minutes. `code/build/backend` is safe to delete.

### 4.1 Backend smoke test (required)

```powershell
# Terminal A: launch the exe (port from settings.json, default 8675)
cd code\backend\dist\bossjob-backend
.\bossjob-backend.exe

# Terminal B: health check
curl http://127.0.0.1:8675/api/health
# expect: {"status":"ok","version":"0.1.7"}
curl http://127.0.0.1:8675/api/settings
# expect: settings.json content
```

> Pass before proceeding; otherwise a `hiddenimports` module is missing — go back to §4 and update the spec.

## 5. Electron installer

Install Electron dependencies:

```powershell
cd code\electron
npm install
```

Build the NSIS installer:

```powershell
cd code\electron
npm run dist
```

- **Output**: `code/packaging/release/BossJobAI-Setup-0.1.7.exe`
- `npm run dist` = verify gates + `electron-builder --config ../packaging/electron-builder.yml` (single source of truth).
- The `beforePack` hook (`verify-prepack.cjs`) runs `verify-dist.mjs`, `verify-csp.mjs` and `verify-endpoint-whitelist.cjs` **before** packaging — any failure aborts the build, so a loose-CSP or whitelist-regression artifact can never reach the installer.
- **Unsigned** installers trigger a Windows SmartScreen prompt on first run — expected. Configure a code-signing certificate for public release.

## 6. Packaging internals

Installed layout (key paths consumed by `electron/main.js` production branch):

| Resource | Installed path |
|----------|----------------|
| Frontend static | `resources/app.asar/frontend/dist/index.html` |
| Backend executable | `resources/backend/bossjob-backend.exe` |
| Backend run dir | `resources/backend/` (same dir as exe) |
| Runtime config | copied to `%APPDATA%/BossJobAI/settings.json` on first launch |

### 6.1 Electron production branch (implemented)

- `startBackend()` branches on `app.isPackaged`: packaged mode runs `resources/backend/bossjob-backend.exe` directly; dev mode spawns `python -m uvicorn`.
- `FRONTEND_DIST_INDEX` points into asar in packaged mode; `%APPDATA%/BossJobAI/settings.json` is the writable config location.
- The auth token is injected via a one-time token file (never in the child-process env block).

### 6.2 Backend frozen path (implemented)

`backend/app/constants.py` branches on `sys.frozen`: config/data are written to `%APPDATA%/BossJobAI` (read-only `resources/` is avoided).

### 6.3 Version sync

Three places **must** stay in sync (the app cross-checks them at startup and warns on drift):

1. `backend/app/constants.py` → `APP_VERSION`
2. `electron/package.json` → `version`
3. `frontend/package.json` → `version`

## 7. Version management & rebuild

1. Bump version in all three places (§6.3).
2. Frontend changed → redo §3; backend changed → redo §4; Electron-shell-only → go straight to §5.
3. Clean old artifacts:
   ```powershell
   Remove-Item ..\backend\dist, ..\build, ..\packaging\release -Recurse -Force
   ```
4. Full rebuild; the artifact name carries the version automatically (`artifactName` template).

## 8. Smoke testing

1. Install `BossJobAI-Setup-0.1.7.exe`, launch the app, confirm the UI loads.
2. `http://127.0.0.1:8675/api/health` → `{"status":"ok","version":"0.1.7"}` (backend auto-launched).
3. Quit the app and confirm no lingering `bossjob-backend.exe` process.

## 9. Troubleshooting (FAQ)

| Symptom | Cause / fix |
|---------|-------------|
| `bossjob-backend.exe` exits immediately | Port in use / missing `hiddenimports` / constants path drift. Run it in the foreground to see the error; add `collect_all` to the spec if a module is missing. |
| `collect_submodules('app')` can't find `app` | The spec `sys.path.insert(0, backend)` is set; still failing means venv ≠ backend dir — run from `code\packaging` with `..\backend\.venv\Scripts\pyinstaller`. |
| electron-builder: `cannot find ../frontend/dist` | Frontend not built — do §3 first. |
| electron-builder rejects out-of-app `files` patterns | Use `extraResources` with `to: frontend/dist` and update the asar path in §6.1. |
| SmartScreen "protected your PC" | Unsigned. "More info → Run anyway"; configure a code-signing certificate for public release. |
| Large installer size | Backend `_internal` carries a full Python runtime (~100 MB+). Acceptable; future: trim via `excludes` or evaluate a Tauri migration (arch §14). |
| Port conflict `address already in use` | A leftover instance. The single-instance lock exists; confirm the backend is killed on exit (§8). |

---

*Build guide for BossJobAI — see [README](../../README.md) for usage and [docs/](../../docs/) for architecture & API references.*
