# CHANGELOG

> BossJobAI 求职投递助手 — 版本变更与修复记录（EN）
> Follows Keep a Changelog: **newest version on top, descending order**; every change is folded into its version iteration, with no per-round work-log retained.

## [0.1.17] — 2026-08-14 · Round 2 enhancements: global search / notifications / table / hero / appearance / URL / hooks

Same S1-S4 flow (8 Tasks × 4-round review + exhaustive acceptance, **high=0**); fills the "high-value not-yet-done" items from the patch plan.

**Added**
- **Cmd+K global search**: search companies/jobs, click/Enter drill-down to records (debounce + seq stale-response guard)
- **Event-driven notifications** (`notifyError/Warning/Success` callable from non-component code) + **global error boundary** (native fallback, no white screen)
- **Table column visibility** (settings panel + localStorage persist + at-least-one-column guard) + tabular-nums alignment for salary/time
- **Dashboard hero** (title/description/quick actions)
- **Settings "Appearance" card**: theme tri-state + 5 accent presets (brand blue/cyan/teal/violet/amber)
- **Form polish** (input radius 8 / label secondary color, light-dark aware)
- **Pagination URL state** (refresh/back preserves page, replace-based loop-safe)
- **Generic hooks**: usePrefersDark / useDebouncedValue / useInterval / useCopyToClipboard

**Tests**: unit tests 75 → **91**

**Known edge**: global-search inline debounce to be unified into useDebouncedValue; dark accent follows preset (default brand blue).

---

## [0.1.16] — 2026-08-14 · Visual revamp V1: branded Antd + dark mode + modern dashboard

Landed from 139-repo open-source research (`UI调研报告/08_补丁重构计划报告.md`); 11 Tasks × 4-round review + exhaustive acceptance (**high=0**, 6 endpoint-consistency groups all identical). Theme: escape the stock Antd look → branded + dark + modern dashboard.

**Added (theme)**
- Design-token single source `theme/designTokens.ts` (brand/semantic colors, font stack, radius, shadows) + light/dark `tokenBuilders` (DESIGN §2-5)
- Dark mode: `settingsStore.themeMode` tri-state (system/light/dark) + persist + ConfigProvider injection
- Header theme switch `ThemeSwitch` (tri-state menu)
- Dark UX closure: first-paint anti-flash external script (CSP-compatible) + transition suppression on switch + dark scrollbar + body baseline (`GlobalStyle`)

**Added (dashboard)**
- ECharts 6 on-demand + `BaseChart` wrapper (init/resize/dispose/click, leak-safe)
- Stat cards `StatCard`/`ChartCard` (tabular-nums big numbers + semantic tone + hover lift + drill-down)
- 30-day apply-trend area chart + status donut chart (data from `/api/stats`, **zero backend change**)

**Improved (icons/cleanup/engineering)**
- Unified linear icons (tabler) via `AppIcon` registry (7 menu + 4 dashboard buttons)
- 13 hardcoded colors cleaned (status colors consolidated into `designTokens.STATUS_HEX`; interview badge gold→geekblue per DESIGN §2.3)
- New `verify:colors` hardcoded-color gate + Prettier + CI template

**Tests**
- Unit tests 8 → **55** (tokens/theme/switch/anti-flash/stat cards/charts/icons/gates)

**Known edge**: imperative Modals (logs/import preview) stay Antd-default light in dark mode (static-API limitation); CI activates when synced to `SpiralQWQ/bossjob-ai/.github`.

---

## [0.1.15] — 2026-08-12 · Multi-agent fixloop R1+R2: 13 frontend robustness fixes

Converged via multi-agent serial scan + 4-round review per task (**high=0**). Theme: endpoint consistency — "different paths to the same goal must produce the same result".

**Fixed (reconnect & probe health, R1-⑨ + R2-①②)**
- `useBackendBase.reload` now probes `/api/health` (HTTP ok + body `status==='ok'`) before switching base — backend down no longer flips the "cannot connect" state to a list-level fetch error
- New shared `probeHealth(url)` exported from `useBackendBase.ts`; ApplyPage / InterviewPage "Reconnect" buttons reuse it (previously raw `getBaseUrl().then(setBaseUrl)`) — all 4 entries (reload / ApplyPage / InterviewPage / Dashboard.checkBackend) now share the same readiness semantics

**Fixed (pagination & undo, R1-⑧)**
- ApplyPage / InterviewPage: status change that moved the last record of the final page off-list now records `prevPage`; undo returns to `prevPage` and re-fetches so the record is visible again (was: undo silently left it out of the current page)

**Fixed (form & data-entry consistency, R1-②⑥ + R2-④)**
- ApplyPage / InterviewPage: new-entry modal prefills `applied_at: dayjs()` (matches JobsPage — 3 entries converge)
- InterviewPage: `openCreateModal` symmetrically resets transient state (stale "unparseable handwritten time" warning no longer leaks from edit→cancel→create)
- InterviewPage: save-time `orig` block now snapshotted in `openEditModal` (same source/instant as backfill flags) — handwritten time on records not in the current page is no longer dropped

**Fixed (stats guards, R1-④ + R2-③)**
- TrackerPage stats fields default `?? 0` (incl. `(pass_rate ?? 0) * 100` priority-safe); `daily_trend` renders `?? []` in both chart places (consistent with `maxCount`); missing backend fields never NaN/crash

**Fixed (settings clamps & offline availability, R1-⑤⑦⑩ + R2-⑤)**
- `daily_limit` saved within [1,500] (`Math.min/max` + fallback); typed-overflow no longer persists
- Backup retention `maxBackups` clamps [1,60] rounded, backup interval `intervalMinutes` clamps [1,1440] rounded; clearing an input (`v != null` guard) no longer silently resets to default 7
- Settings error branch renders `BackupSettingsCard` independently (backup relies on main-process IPC only — still editable when backend is offline)

**Verification**: full build chain passes (`tsc` + `vite build` + `verify-csp` + `verify-dist`); per-fix exhaustive tests (path enumeration / strict boundaries / endpoint-consistency grouping); acceptance evidence in `temp/fixloop_evidence/round_1.md` + `round_2.md`

---

## [0.1.14] — 2026-08-12 · P0 wrap-up: starlette pin + frontend code-split

**Fixed (backend dependency compatibility)**
- `backend/requirements.txt` now explicitly pins `starlette>=0.37.2,<0.39` (fastapi 0.115 upper bound) — the env had been upgraded to starlette 1.6.0, causing fastapi startup to raise an HTTP_422 deprecation warning; verified that downgrading to 0.38.6 makes the app import cleanly (16 routes, no starlette warnings)

**Optimized (frontend load performance, leftover-2)**
- Route-level lazy loading: all 6 pages in `router.tsx` now use `React.lazy` + `Suspense` (antd Spin fallback) — first screen loads only the current route chunk
- Vite `manualChunks`: react family split into a `react-vendor` chunk; antd left unsplit (vite5 + antd5 do ESM tree-shaking by default — pinning the whole antd package to one chunk would actually block it)
- Result: single 1.33MB JS → split into multiple chunks, no chunk >500kB; first-screen gzip ≈183kB (index 117kB + vendor 66kB), other pages loaded on demand
- Full build chain passes: `tsc` type-check + `vite build` + `verify-csp` + `verify-dist`

---

## [0.1.13] — 2026-08-11

Cleaning workflow transcript-content protection (P1a_简历素材库/清洗工作流, teaching vs noise classification):

- **Fix transcript mis-deletion root cause**: removed "line repeated ≥3× → delete" (which wrongly dropped repeatedly-played teaching lines / Chinese translations as watermarks); replaced with **compress-keep** `original … [appears N times]` (preserves teaching emphasis signal + saves tokens)
- **Teaching whitelist protection**: recognizes IPA / Chinese translations / word-cards / teaching English (lexicon + fuzzy match), runs before all deletions, never drops teaching short lines
- **OCR garbage detection**: lexicon-zero-match + no-vowel + low-entropy identifies `dnrduork`-class fragments to delete, teaching lines exempt (conservative, no false drops)
- **Line-merge**: no sentence-end punctuation + next line lowercase + time-adjacent → join lines broken by OCR
- **Watermark removal**: fixed UI words (`坚持打卡30天`/`片名：`/`知识点`) deleted, distinguished from teaching lines
- **Rule engine multi-action**: YAML v3→v4, `protect_teaching`/`compress_repeat`/`watermark`/`garbled` sections; `sentencex` sentence-level preprocessing (merge broken lines)
- **Engineering hardening**: empty-output fallback (retention <30% → revert original) + audit fields + teaching-retention gate (30-case benchmark ≥95%)
- **Acceptance**: T1-T12 individually reviewed & passed; real 179-frame validation; teaching retention 100%; original 14 acceptance tests zero regression; see `docs/验收报告_v3.0.md`

## [0.1.12] — 2026-08-11

Cleaning workflow interface adaptation (P1a_简历素材库/清洗工作流, on-boarding M.AIStudy transcription output):

- **ASR json segment-wise cleaning prototype**: new `cleaner/clean_asr_json.py` — cleans ASR json (text+segments+sentences) per-segment/sentence, preserving the JSON structure and emitting `_clean.json` (original json kept for traceability); honors interface red lines (structure not flattened / Chinese explanation never removed / start_ms·confidence·review never modified / srt not cleaned); segment-level dedup (same text + same timestamps = duplicate record, drop-later-keep-first; same text + different timestamps = replay, keep; Chinese segments never dropped)
- **Interface contract**: `docs/接口对接/` on-boards M.AIStudy transcription output spec (format contract / red lines / interface, with sample files); patch-refactor plan bumped to v1.1 (interface contract + open-question resolution: per-segment mapping / GLM watermark kept / word-level errors left to Claude)
- **Fix**: rules fingerprint path bug (`clean_batch.py` referenced nonexistent `config/` → `rules/`), restoring "rule change triggers incremental re-clean"
- **Rule extension**: `cleaning_rules.yaml` gained 8 video watermark regexes (坚持打卡/片名/知识点/高手盲听/初学看字幕/纯英字幕/爱说英语的福安), line-anchored so GLM descriptions are never falsely removed; fixes short-sample watermark miss (F4)
- **Acceptance**: T1-T7 individually reviewed & passed; interface red lines 15/15 honored; `_clean.json` structure-preserving output; original 14 acceptance tests all pass (zero regression); see `docs/验收报告_v2.0.md`

## [0.1.11] — 2026-08-10

Cleaning workflow made independent (P1a_简历素材库/清洗工作流, sibling of _crawl, open-source-ready module):

- **Structure independence**: workflow extracted from inside _crawl into its own project (layered cleaner/cli/rules/tests/docs/output); decoupled from collector deps (tool paths read from `.env`, KB parameterized, output to `output/`)
- **Open-source prep**: `.env.example` tool-path template + `requirements.txt` standalone deps + dedicated workflow CHANGELOG (v0.3.0)
- **Acceptance**: `tests/test_acceptance.py` 14/14 pass, 40 Zhihu files cleaned into the standalone project; original _crawl files removed (standalone project is the single source); see `docs/独立化报告.md`

## [0.1.10] — 2026-08-10

Cleaning workflow upgrade: video-transcript form + engineering hardening (P1a_简历素材库/_crawl, internal use):

- **Video-transcript cleaning**: new `video_ocr` group (frame markers / OCR labels / per-frame repeated watermarks removed, GLM scene descriptions kept) + `video_asr` group (ASR punctuation-noise normalization); engine selects rules by form (`clean_text(form=...)`); Markdown code-block protection (content inside ``` fences never over-deleted); srt untouched (timestamps kept for humans)
- **Engineering hardening**: incremental cleaning + resume (file hash + rules fingerprint: unchanged skipped / rules-changed re-clean / interruption recoverable), parallel batch (`--parallel N`), post-clean dedup check (`--dedup`), structured index (`_clean_results.json`), cleaning log, stats report (`_clean_report.json` history), rules versioning (YAML version + change log), worker retry-on-failure
- **Workflow independence**: dedicated workflow CHANGELOG (`_crawl/清洗工作流/CHANGELOG.md`, v0.2.0) records the workflow's own change path, separate from the BossJobAI project CHANGELOG
- **Acceptance**: acceptance script extended to 14/14 pass (incl. video_ocr/video_asr/MD code-block/rules validation); 40 Zhihu files incremental-skipped, 0 residual, intact body, 0 duplicates

## [0.1.9] — 2026-08-10

Cleaning workflow foundation hardening (A/G/I, reliability improvements independent of new data):

- **Residual detector completion (A)**: `scan_residual` extended to cover watermarks / recommendation question titles / column buttons / isolated author names (aligned with what cleaning removes); fixed duplicate false-report in isolated detection
- **Rule-file schema validation (G)**: `cleaning_rules.yaml` now validated with jsonschema on load, malformed structure raises a clear error (prevents silent failure from bad regex/typo'd group names)
- **Cleaning quality auto-verification (I)**: `check_content_integrity` detects body-text over-deletion (retention rate / Chinese content / empty shell), wired into the clean_kb batch flow
- **Acceptance**: full re-clean at 0 residual + intact body text, acceptance script 10/10; backlog A/G/I done, remaining (C/D/H/J/B/E/F) deferred pending data

## [0.1.8] — 2026-08-10

Cleaning workflow made reusable + Zhihu methodology merged into KB (P1a_简历素材库/_crawl, internal use):

- **Rules data-driven (A)**: 6 categories of noise rules (fixed words/regex/whitelist/column buttons/question verbs) moved out of code into `config/cleaning_rules.yaml` (grouped by common/zhihu site, adding noise = editing config); engine `cleaning.py` loads config (falls back to built-in defaults when YAML missing); new **residual detector** (`scan_residual`) — auto-scans cleaned text for known noise, 40 files at 0 residual, preventing "comment/like leak" recurrence
- **Structural-algorithm reserve (C)**: researched jusText/boilerpipe/dragnet, defined future real-HTML extraction fallback chain (trafilatura→jusText→dragnet); data-shape auto-routing (`is_html_like` plain-text/HTML adaptive) implemented and verified
- **KB merge (D)**: incrementally added 40 Zhihu clean methodology texts into RAG (`add_zhihu_to_rag.py`, 40367→40833 chunks, +466 Zhihu); retrieval accuracy 100% (36/36), Zhihu methodology queries hit top-1; Zhihu methodology complements the 200 GitHub-repo templates
- **Acceptance**: 18 minimal tasks verified one-by-one by the main agent; report at `_scan/清洗调研/100_清洗工作流验收报告.md`

## [0.1.7] — 2026-08-10

Crawled-text data cleaning pipeline (P1a_简历素材库/_crawl, P1 prerequisite research delivery, kept internal / not redistributed):

- **5 patch integrations** (tools installed into AAA.Tool per README naming conventions):
  - **trafilatura 2.2.0** (`T.trafilatura_TextExtract_Env_v2.2.0` isolated venv): HTML → main-text extraction stripping navigation (`favor_precision`), subprocess gateway (`collector/shared/cleaning.py::extract_article`), same pattern as yt-dlp/ffmpeg, no main-env pollution
  - **clean-text 0.7.1** (main env): URL removal / HTML-entity unescape / zero-width & whitespace normalization (`normalize_stage1`), `fix_unicode=False` preserves Chinese full-width punctuation
  - **snownlp 0.12.3** (main env): sentence splitting / POS tagging as watermark-detection aid (`analyze_snownlp`)
  - **jsonschema 4.26.0** (main env): structural validation of cleaned results (`validate_schema`, engine enum + stats shape), wired into clean_text's `valid` flag
  - **presidio 2.2.364** (`T.presidio_PIIScrub_Env_v2.2.364` isolated venv): PII redaction (CN mobile / ID / email → `***`), slim registry excludes NER false positives on Chinese and URL/date noise, `score_threshold=0.5`; `--anonymize` for pre-release, local KB keeps PII
- **Self-built Chinese-noise removal** (`remove_chinese_noise`, borrowing unstructured's approach): strips top navigation / author watermarks (≥2 no-punctuation short lines) / AI markers / comment counts / hot-search / ICP filing / ad lines / recommendation-section buttons / tail truncation at "大家都在搜"; whitelist protects real section headings, column words left intact inside sentences
- **Batch cleaning tool** `tools/clean_kb.py`: scans KB text files → full-chain clean → outputs to `知识库_clean/` (mirrored per-word structure, realpath resolves junction to D drive): 40 Zhihu snapshots, 73–90% retention
- **Borrowed-idea fusion** (`_scan/清洗调研/99_借鉴思路融合报告.md`): unstructured (cleaner-style line filtering) / texthero (Stage pipeline) / pyjanitor (chained API) / dataprep (clean_* function family); dupeguru dedup already landed via crawler deduper and verified zero duplicates
- **Full acceptance** (`_scan/清洗调研/_acceptance.py`): 10/10 passed (HTML extract / normalize / Chinese analysis / validate / redact / self-built rules / 40-file full chain / batch entry / degraded fallback / perf 40 files in 0.12s)

## [0.1.6] — 2026-08-06

P1a resume material library + RAG knowledge base (P1 prerequisite research delivery, kept internal / not redistributed):

- **Version sync**: `APP_VERSION` / `electron/package.json` / `frontend/package.json` unified from 0.1.0 to 0.1.6
- **Resume material library**: scanned 34 GitHub keywords → 200 resume/document/job-ecosystem repos (1k+ stars first) isolated-cloned into the local research corpus (not redistributed with this repo); 《简历知识库_详细内容.md》1194 lines — methodology (FAB/STAR/ATS), JSON Resume Schema, per-role templates, CN/EN example sentences & cover-letter templates, AI optimization models (resumePolice/career-ops)
- **RAG index**: bge-m3 1024-dim, 40,367 chunks × full 200/200 repo coverage (GPU CUDA accelerated); `build_rag.py` (full docs + per-repo source sampling), `check_coverage.py` (coverage check), `test_rag.py` (36 handcrafted queries 100%), `test_rag_2000.py` (2000-query stress test **99.8% ≥98% passed**)

## [0.1.5] — 2026-08-06

- **Docs**: added the interface spec v0.1 (`docs/求职投递项目_接口文档_v0.1.md`) — three-layer architecture overview, auth model, all 12 backend HTTP endpoints (index table / params / request-response / error codes), all 26 Electron IPC channels (index table / semantics), data model & schema migrations, config items, security baseline, revision history; cross-verified against the README endpoint table

## [0.1.4] — 2026-08-06

Regression convergence + final acceptance:

- **Interview page**: unparseable-block preserve/rebuild fix (backfill flags split); interview-form `allowClear`; hand-written time read-only notice + remove button
- **High regressions**: `cities` list spread crash fixed; import-data success-path ReferenceError fixed
- **Settings**: `apply.interval_seconds` non-empty guard (restore + import); LLM disabled `onFinish` no longer submits the llm group (config-save deadlock removed); cities filtered per-item
- **Wrap-up**: "this week" preset Sunday-safe; no high issues remaining → P0 hardening loop closed

## [0.1.3] — 2026-08-06

Import counting convergence + security hardening:

- **Regression fixes**: TDZ `createdCount` ReferenceError; pasted-import skipped/created fallbacks converge with file-import path
- **Import payload**: `applications`/`apply_logs` widened to `list[object]` + per-row `isinstance` defensive construction (bad rows skip instead of whole-batch 422)
- **Settings import/restore**: per-subkey validation unified; benign keys (cities/apply/browser/blacklist) migrate on round-trip; `external_url_hosts` validated per-entry
- **Schema v3**: `applied_at` index + sargable datetime range filters; dashboard 30-day trend bucketed in Python
- **Backup security**: `verifyBackupManifest` checksum-key whitelist regex (path-traversal closed); corrupt-backup preview detection
- **Refactor**: STATUS_TEXT/COLOR/OPTIONS centralized in `lib/applyStatus.ts`; explicit `dayjs` dependency; "this week" preset starts Monday

## [0.1.2] — 2026-08-06

Applied-time "unset" semantics + import robustness:

- **applied_at NULL semantics**: schema v2 migration (applications table rebuild, lossless v1 data move, status index rebuild); PATCH clear stores NULL; form tooltips/placeholders say "empty = unset"; `ApplicationItem.applied_at` widened to `datetime | None`
- **Import**: restores `updated_at`; removes column `default=datetime.now` (root cause of import-NULL storing "today"); datetime precision normalization (`replace(microsecond=0)`); `ImportItem` drops max_length/url-scheme validation for per-row tolerance; preserves original ids; `created/updated/skipped` split counts
- **Update**: explicit `status: null` keeps current value; url gains netloc/scheme validation; apply_logs only written on real value change
- **Settings restore**: subkey-whitelist rebuild for `apply/browser/blacklist`

## [0.1.1] — 2026-08-05

P0 skeleton hardening, batch 1:

- **IPC / preload security**: unsubscribe guard on pull-state callbacks; in-flight pull reuse per channel; `importData` type gate; external-URL scheme normalization; lazy async scheme fetch (removed module-load `sendSync`)
- **External-link allowlist**: host suffix normalization (strip trailing dots); 60s TTL on trusted import paths; entry format validation (reject scheme/port/path and bare single-label like `com`)
- **Settings restore**: `restoreSettingsSafely` restores non-sensitive keys with type checks; backup restore no longer silently clears the host allowlist; field-level validation for restored `cities/apply/browser/blacklist`
- **Export**: `export-data-offline` applies status/keyword/date filters (mirrors CSV export)
- **Backend**: LIKE wildcard escaping (`%`/`_`) with ESCAPE clause; explicit applied_at clear semantics; loose `_parse_dt` on import
- **Interview page**: `parseInterviewBlock` scoped to the 【面试登记】 section; CSP verify script asserts `script-src 'self'`
