# Changelog

All notable changes to **BossJobAI** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.7] — 2026-08-13

### Added
- **Open-source release polish**: bilingual README rewritten to open-source standards (badges, quick start, feature table, API reference, security baseline, contributing & license sections).
- **Contributing guide** ([CONTRIBUTING.md](CONTRIBUTING.md)), **security policy** ([SECURITY.md](SECURITY.md)) and **code of conduct** ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)).
- **CI workflow** (`.github/workflows/ci.yml`) — frontend build + CSP / endpoint-whitelist verification gates on push and pull request.
- **Issue & PR templates** under `.github/`.
- `.gitattributes` (line-ending normalization) and `.editorconfig` (editor consistency).

### Changed
- Consolidated Electron packaging config: `electron/package.json` no longer carries a duplicate `build` field; `npm run pack` / `npm run dist` now explicitly use the single source of truth `packaging/electron-builder.yml` (fixes a path that silently produced an installer without the Python backend).
- `packaging/electron-builder.yml` `files` now includes `backend-default-port.cjs` (required at runtime by `electron/main.js`).
- Version references synced from stale `0.1.0` to the current release version across docs and comments (`health.py` docstring, `electron-builder.yml`, interface & architecture docs).
- README_zh settings reference aligned with the shipped template (empty `cities`).

### Fixed
- Corrupted control characters (backspace / form-feed) in `README_zh.md` paths (`code\backend`, `code\frontend`).

### Security
- Full repository privacy / hardcoded-secret scan passed: no real PII, credentials, API keys, or absolute paths in the source tree (verified for this release).

## [0.1.6] — 2026-08-06

P1a resume material library + RAG knowledge base (P1 prerequisite research delivery, kept internal / not redistributed).

### Changed
- **Version sync**: `APP_VERSION` / `electron/package.json` / `frontend/package.json` unified from 0.1.0 to 0.1.6.

### Added
- **Resume material library**: scanned 34 GitHub keywords → 200 resume/document/job-ecosystem repos (1k+ stars first) isolated-cloned into the local research corpus (not redistributed with this repo); 《简历知识库_详细内容.md》1194 lines — methodology (FAB/STAR/ATS), JSON Resume Schema, per-role templates, CN/EN example sentences & cover-letter templates, AI optimization models (resumePolice/career-ops).
- **RAG index**: bge-m3 1024-dim, 40,367 chunks × full 200/200 repo coverage (GPU CUDA accelerated); `build_rag.py` (full docs + per-repo source sampling), `check_coverage.py` (coverage check), `test_rag.py` (36 handcrafted queries 100%), `test_rag_2000.py` (2000-query stress test **99.8% ≥98% passed**).

## [0.1.5] — 2026-08-06

### Added
- **Docs**: interface spec v0.1 (`docs/求职投递项目_接口文档_v0.1.md`) — three-layer architecture overview, auth model, all 12 backend HTTP endpoints (index table / params / request-response / error codes), all 26 Electron IPC channels (index table / semantics), data model & schema migrations, config items, security baseline, revision history; cross-verified against the README endpoint table.

## [0.1.4] — 2026-08-06

Regression convergence + final acceptance.

### Fixed
- **Interview page**: unparseable-block preserve/rebuild fix (backfill flags split); interview-form `allowClear`; hand-written time read-only notice + remove button.
- **High regressions**: `cities` list spread crash fixed; import-data success-path ReferenceError fixed.
- **Settings**: `apply.interval_seconds` non-empty guard (restore + import); LLM disabled `onFinish` no longer submits the llm group (config-save deadlock removed); cities filtered per-item.
- **Wrap-up**: "this week" preset Sunday-safe; no high issues remaining → P0 hardening loop closed.

## [0.1.3] — 2026-08-06

Import counting convergence + security hardening.

### Fixed
- **Regression fixes**: TDZ `createdCount` ReferenceError; pasted-import skipped/created fallbacks converge with file-import path.
- **Import payload**: `applications`/`apply_logs` widened to `list[object]` + per-row `isinstance` defensive construction (bad rows skip instead of whole-batch 422).
- **Settings import/restore**: per-subkey validation unified; benign keys (cities/apply/browser/blacklist) migrate on round-trip; `external_url_hosts` validated per-entry.
- **Schema v3**: `applied_at` index + sargable datetime range filters; dashboard 30-day trend bucketed in Python.
- **Refactor**: STATUS_TEXT/COLOR/OPTIONS centralized in `lib/applyStatus.ts`; explicit `dayjs` dependency; "this week" preset starts Monday.

### Security
- **Backup security**: `verifyBackupManifest` checksum-key whitelist regex (path-traversal closed); corrupt-backup preview detection.

## [0.1.2] — 2026-08-06

Applied-time "unset" semantics + import robustness.

### Added
- **applied_at NULL semantics**: schema v2 migration (applications table rebuild, lossless v1 data move, status index rebuild); PATCH clear stores NULL; form tooltips/placeholders say "empty = unset"; `ApplicationItem.applied_at` widened to `datetime | None`.

### Fixed
- **Import**: restores `updated_at`; removes column `default=datetime.now` (root cause of import-NULL storing "today"); datetime precision normalization (`replace(microsecond=0)`); `ImportItem` drops max_length/url-scheme validation for per-row tolerance; preserves original ids; `created/updated/skipped` split counts.
- **Update**: explicit `status: null` keeps current value; url gains netloc/scheme validation; apply_logs only written on real value change.
- **Settings restore**: subkey-whitelist rebuild for `apply/browser/blacklist`.

## [0.1.1] — 2026-08-05

P0 skeleton hardening, batch 1.

### Changed
- **IPC / preload security**: unsubscribe guard on pull-state callbacks; in-flight pull reuse per channel; `importData` type gate; external-URL scheme normalization; lazy async scheme fetch (removed module-load `sendSync`).
- **External-link allowlist**: host suffix normalization (strip trailing dots); 60s TTL on trusted import paths; entry format validation (reject scheme/port/path and bare single-label like `com`).
- **Settings restore**: `restoreSettingsSafely` restores non-sensitive keys with type checks; backup restore no longer silently clears the host allowlist; field-level validation for restored `cities/apply/browser/blacklist`.
- **Export**: `export-data-offline` applies status/keyword/date filters (mirrors CSV export).
- **Backend**: LIKE wildcard escaping (`%`/`_`) with ESCAPE clause; explicit applied_at clear semantics; loose `_parse_dt` on import.
- **Interview page**: `parseInterviewBlock` scoped to the 【面试登记】 section; CSP verify script asserts `script-src 'self'`.

## [0.1.0] — 2026-08-05

Initial release.

### Added
- **P0 skeleton**: Electron shell + FastAPI backend + SQLite; 7 pages; full application-record CRUD + filtering + batch status update; export (JSON/CSV/offline) / import (file/paste) / backup-restore (zip bundle + checksum verification); security baseline (contextIsolation, global Bearer auth, Host/Origin checks, strict CSP, DPAPI-encrypted api_key).

---

[Unreleased]: https://github.com/SpiralQWQ/bossjob-ai/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/SpiralQWQ/bossjob-ai/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/SpiralQWQ/bossjob-ai/releases/tag/v0.1.6
[0.1.5]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.4]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.3]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.2]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.1]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.0]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
