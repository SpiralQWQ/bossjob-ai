# CHANGELOG

> BossJobAI 求职投递助手 — 版本变更与修复记录（EN）

> 正式版本段按迭代收敛（本轮 P0 骨架加固的 19 个 fixloop Round 分布到 0.1.1–0.1.4 四个补丁版本）；
> 原始逐轮修复明细保留在下方独立的 `# UpdateLOG` 区块，不覆盖原记录。

## [0.1.1] — 2026-08-05

P0 skeleton hardening, batch 1 (fixloop rounds 1–5):

- **IPC / preload security**: unsubscribe guard on pull-state callbacks; in-flight pull reuse per channel; `importData` type gate; external-URL scheme normalization; lazy async scheme fetch (removed module-load `sendSync`)
- **External-link allowlist**: host suffix normalization (strip trailing dots); 60s TTL on trusted import paths; entry format validation (reject scheme/port/path and bare single-label like `com`)
- **Settings restore**: `restoreSettingsSafely` restores non-sensitive keys with type checks; backup restore no longer silently clears the host allowlist; field-level validation for restored `cities/apply/browser/blacklist`
- **Export**: `export-data-offline` applies status/keyword/date filters (mirrors CSV export)
- **Backend**: LIKE wildcard escaping (`%`/`_`) with ESCAPE clause; explicit applied_at clear semantics; loose `_parse_dt` on import
- **Interview page**: `parseInterviewBlock` scoped to the 【面试登记】 section; CSP verify script asserts `script-src 'self'`

## [0.1.2] — 2026-08-06

Applied-time "unset" semantics + import robustness (rounds 6–10):

- **applied_at NULL semantics**: schema v2 migration (applications table rebuild, lossless v1 data move, status index rebuild); PATCH clear stores NULL; form tooltips/placeholders say "empty = unset"; `ApplicationItem.applied_at` widened to `datetime | None`
- **Import**: restores `updated_at`; removes column `default=datetime.now` (root cause of import-NULL storing "today"); datetime precision normalization (`replace(microsecond=0)`); `ImportItem` drops max_length/url-scheme validation for per-row tolerance; preserves original ids; `created/updated/skipped` split counts
- **Update**: explicit `status: null` keeps current value; url gains netloc/scheme validation; apply_logs only written on real value change
- **Settings restore**: subkey-whitelist rebuild for `apply/browser/blacklist`

## [0.1.3] — 2026-08-06

Import counting convergence + security hardening (rounds 11–15):

- **Regression fixes**: TDZ `createdCount` ReferenceError; pasted-import skipped/created fallbacks converge with file-import path
- **Import payload**: `applications`/`apply_logs` widened to `list[object]` + per-row `isinstance` defensive construction (bad rows skip instead of whole-batch 422)
- **Settings import/restore**: per-subkey validation unified; benign keys (cities/apply/browser/blacklist) migrate on round-trip; `external_url_hosts` validated per-entry
- **Schema v3**: `applied_at` index + sargable datetime range filters; dashboard 30-day trend bucketed in Python
- **Backup security**: `verifyBackupManifest` checksum-key whitelist regex (path-traversal closed); corrupt-backup preview detection
- **Refactor**: STATUS_TEXT/COLOR/OPTIONS centralized in `lib/applyStatus.ts`; explicit `dayjs` dependency; "this week" preset starts Monday

## [0.1.4] — 2026-08-06

Regression convergence + final acceptance (rounds 16–19):

- **Interview page**: unparseable-block preserve/rebuild fix (backfill flags split); interview-form `allowClear`; hand-written time read-only notice + remove button
- **High regressions**: `cities` list spread crash fixed; import-data success-path ReferenceError fixed
- **Settings**: `apply.interval_seconds` non-empty guard (restore + import); LLM disabled `onFinish` no longer submits the llm group (config-save deadlock removed); cities filtered per-item
- **Wrap-up**: "this week" preset Sunday-safe; no high issues remaining → P0 hardening loop closed

# UpdateLOG

## [Round 1] — 2026-08-05

P0 skeleton hardening (main-agent fix pass driven by fixloop scan):

- `electron/preload.js`: guard pull-state callback after unsubscribe (`entry.count > 0`) — no delivery to unmounted consumers
- `electron/preload.js`: reuse one in-flight pull promise per channel — concurrent subscribers no longer get swallowed by the `has()` guard
- `electron/preload.js`: add type gate to `importData(path)` (string/undefined/null only)
- `electron/preload.js`: normalize external URL schemes (lowercase + trailing colon) before compare — matches main-process authority
- `electron/preload.js`: cache null/undefined payload as sentinel (`has()` semantics) to avoid redundant pulls
- `electron/preload.js` + `main.js`: lazy async scheme fetch on first `openExternal` (removes sendSync renderer-init block); added `ipcMain.handle('get-external-url-schemes')`
- `frontend/src/pages/InterviewPage.tsx`: only rebuild the interview-note section when interview input exists or prior record already carried interview data — no more empty-section pollution
- `frontend/src/lib/applyShared.tsx` + `electron/main.js`: normalize host allowlist suffixes (strip trailing dots) so entries like `example.com.` are honored
- `electron/main.js`: trustedImportPaths get a 60s TTL — path no longer stays trusted after the import-confirm dialog is canceled
- `frontend/scripts/verify-csp.mjs`: assert source `script-src` is exactly `'self'` + fix stale header comment (source is already strict)

## [Round 2] — 2026-08-05

- `electron/preload.js`: replay guard — skip delivering null/undefined sentinel to consumers (keeps `has()` dedup, no empty callbacks / Dashboard destructure TypeError)
- `electron/main.js`: `isExternalHostAllowed` normalize host (strip trailing dots) to match suffix normalization
- `frontend/src/lib/applyShared.tsx` + `frontend/src/pages/DataViews.tsx`: `isHostAllowed` normalize both host and suffix (strip trailing dots) — eliminate duplicated-implementation drift
- `frontend/src/pages/InterviewPage.tsx`: `handleSave` applies pagination clamp when an edit moves the record out of the interview filter (mirror `handleStatusChange`)
- `electron/main.js`: remove dead `sendSync` handler (`ipcMain.on('get-external-url-schemes')`) — preload only uses the async invoke path

## [Round 3] — 2026-08-05

- `frontend/src/pages/InterviewPage.tsx`: `parseInterviewBlock` only parses time/form inside the interview-registration tag section — no more mis-parsing ordinary remarks like "简历形式：PDF"
- `frontend/src/pages/ApplyPage.tsx`: `handleSave` pagination clamp when an edit moves a record out of the pending filter (mirror `handleStatusChange`)
- `frontend/src/pages/DataViews.tsx`: `handleSave` pagination clamp when a status-filtered edit leaves the view (mirror `handleStatusChange willLeaveView`)
- `electron/main.js`: `loadUserExternalHostAllowlist` validates entries (reject scheme/port/path; reject bare single-label like "com") to match Settings form validation
- `backend/app/routers/data.py`: escape LIKE wildcards (`%`/`_`) with ESCAPE clause so literal searches like "100%" work correctly
- `frontend/src/pages/DataViews.tsx`: reuse `parseUrlHost`/`isHostAllowed` from `../lib/applyShared` (delete local duplicates) to prevent drift
- `frontend/src/pages/Dashboard.tsx`: fix stale comment referencing removed `getBackendPort()` API

## [Round 4] — 2026-08-05

- `frontend/src/pages/InterviewPage.tsx`: `parseInterviewBlock` line-scoped to structured rows after the tag (no more phantom values from remarks containing "时间：/形式：")
- `frontend/src/pages/InterviewPage.tsx`: `buildInterviewNote` omits empty fields; clearing interview fields on edit deletes the structured block (no sticky placeholder)
- `frontend/src/pages/InterviewPage.tsx`: `stripInterviewBlock` keeps multi-line remark continuations (remarkStarted flag) — no more accidental text loss
- `frontend/src/lib/applyShared.tsx`: `useExternalHosts` applies same format validation as main process (reject protocol/bare-TLD)
- `frontend/src/pages/DataViews.tsx`: reuse shared `useUrlHostWarning` (remove local duplicate)
- `frontend/src/lib/useBackendBase.ts` + `ApplyPage`/`DataViews`: consolidate `createApplication` into shared module (unify "新增失败" prefix + status fallback)
- `electron/main.js`: `restoreSettingsSafely` restores non-sensitive keys (cities/apply/browser/blacklist) with type checks instead of stripping them
- `backend/app/routers/settings.py`: validate `security.external_url_hosts` entries (reject scheme/port/bare-TLD), aligned with main process

## [Round 5] — 2026-08-05

- `electron/main.js`: `restoreSettingsSafely` validates-then-restores `security.external_url_hosts` (no silent clearing of allowlist on backup restore)
- `electron/main.js`: field-level validation for restored `cities/apply/browser/blacklist` (reject malformed values that could fail backend settings load)
- `electron/main.js` + `frontend`: `export-data-offline` applies status/keyword/date filters (mirror `export-data-csv`) and pages pass current filter through
- `backend/app/routers/data.py`: explicitly clearing `applied_at` sets current time (matches "empty = now" tooltip, no silent no-op)
- `backend/app/routers/data.py`: import `applied_at` accepts loose strings via `_parse_dt` (invalid date degrades to now instead of aborting whole batch)
- `frontend/src/pages/InterviewPage.tsx`: remove dead `hadInterviewDataRef` (unused after Round 4 refactor) + unused `useRef` import

## [Round 6] — 2026-08-06

- `frontend/src/pages/DataViews.tsx` + `ApplyPage.tsx` + `InterviewPage.tsx`: clearing the applied-time now explicitly sends `applied_at: null` (previously the dropped key silently kept the stale value); `ApplicationInput.applied_at` widened to `string | null`
- `backend/app/routers/data.py`: import now restores `updated_at` (both new and updated rows parse via `_parse_dt`, invalid values degrade to now) so imported records keep their original modified time
- `frontend/src/vite-env.d.ts`: `exportCsv` filter type gains `date_from/date_to` (mirrors the range filtering `export-data-csv` actually supports)
- `electron/main.js`: `restoreSettingsSafely` rebuilds `apply/browser/blacklist` from subkey whitelists — only known keys are restored (apply: daily_limit/halt_on_risk/interval_seconds; browser: headless/user_data_dir; blacklist: companies/keywords), unknown subkeys are not injected, preventing tampered backups from polluting the settings structure

## [Round 7] — 2026-08-06

- `electron/main.js`: `restoreSettingsSafely` now merges the current LLM api_key/base_url back into the restored settings (backup credentials are stripped but the user's live key is no longer silently wiped); stripped bookkeeping corrected — retained keys no longer counted as stripped
- `electron/main.js`: `restoreSettingsSafely` switches `apply/browser/blacklist` from all-or-nothing to **per-subkey validation** — an invalid subkey is dropped individually (recorded in stripped with its key name) while valid subkeys are kept
- `electron/main.js`: `get-external-url-schemes` moved from bare `ipcMain.handle` to `guardedHandle` (same app-window sender allowlist as the rest of IPC)
- `backend/app/routers/data.py`: `ImportItem` optional fields (city/salary/url/note/job_title/company) widened to `str | None`, import coerces via `(x or "").strip()` so a null no longer 422s the whole batch
- `backend/app/routers/data.py`: `create_application` strips before non-empty validation (pydantic min_length checks the raw value, letting whitespace-only through) — no blank title/company can be stored
- `backend/app/config.py`: `ApplyConfig` gets bounds (daily_limit 1..500, each interval_seconds 1..3600) aligned with the restore whitelist so out-of-range values can't be written then silently stripped
- `frontend/src/pages/DataViews.tsx`: JobsPage `handleSave` `willLeaveView` gains `editingId !== null` guard (mirroring ApplyPage/InterviewPage) — creating a record no longer wrongly decrements the page
- `frontend/src/pages/InterviewPage.tsx`: interview-time sorter returns 0 when both times are invalid, eliminating the `Infinity-Infinity=NaN` inconsistent comparator
- `frontend/src/pages/Settings.tsx`: module-level `backupCardState` writes moved from render body into `useEffect` — no render-phase side effects
- **Applied-time semantics change (store NULL)**: `backend/app/models.py` `applied_at` → `nullable=True`; `backend/app/db.py` schema v2 migration (rebuild applications table, lossless v1 data move + status index rebuild); `backend/app/routers/data.py` PATCH clears applied_at to NULL (no longer today); `electron/main.js` `DB_SCHEMA_VERSION` bumped to 2; three form tooltips/placeholders say "empty = unset"; `ApplicationItem.applied_at` widened to `string | null`

## [Round 8] — 2026-08-06

- `backend/app/routers/data.py`: **fixes a high-severity regression introduced in Round 7** — `ApplicationItem.applied_at` response model widened from `datetime` to `datetime | None` (under schema v2, NULL records previously 500'd the whole GET /api/applications list, made PATCH-clear falsely report failure, and bricked the list UI)
- `electron/main.js`: restore version guard changed from "reject unless equal" to "reject only newer-than-current" — post-upgrade users can still restore pre-upgrade v1 backups (after copy, startBackend brings the backend up and init_db runs the v1→v2 migration automatically)
- `backend/app/routers/data.py`: `import_data` insert path no longer coerces a NULL applied_at to today (`_parse_dt(item.applied_at)` passes None through), preserving the "unset" semantics across export→import round-trip
- `backend/app/routers/data.py`: `update_application` strips job_title/company before persisting and rejects empty-after-strip, matching `create_application` (no whitespace-only overwrite via PATCH)

## [Round 9] — 2026-08-06

- `backend/app/models.py`: **fixes the root cause that made the Round 8 import-NULL fix ineffective** — removes `default=datetime.now` from the `applied_at` Column (SQLAlchemy auto-applies the column default on INSERT when the value is None, so `import {applied_at:null}` was still stored as today); new-record "default to now" is now the explicit job of `create_application`'s `payload.applied_at or datetime.now()`
- `backend/app/routers/data.py`: `import_data` distinguishes explicit-NULL applied_at (→ store NULL) from invalid-string (→ degrade to now), preserving the "unset" export→import round-trip
- `backend/app/routers/data.py`: `import_data` update branch applies preserve-if-empty to city/salary/url/note (matching job_title/company) — omitted fields no longer silently wipe stored data
- `backend/app/routers/data.py`: `import_data` create branch skips any row with an empty required field (job_title/company), aligning with `create_application`'s non-empty contract
- `backend/app/routers/data.py`: `import_data` update branch uses `item.model_fields_set` for applied_at/updated_at — an explicit `applied_at:null` can clear an existing date back to NULL, while a missing key leaves it untouched
- `backend/app/routers/data.py`: `update_application` PATCH only writes an apply_log when a value actually changed (compares before/after), zero-change saves no longer pollute the timeline
- `electron/main.js`: `preview-import-data` trusted-path TTL raised from 60s to 10min, preventing an interactive dead-end if the confirm dialog is read past the old expiry
- `backend/app/routers/data.py`: `url` gains a `field_validator` restricting scheme to http/https (empty allowed), shared by create/update/import

## [Round 10] — 2026-08-06

- `backend/app/routers/data.py`: **datetime precision normalization** — create stores `replace(microsecond=0)`, update compares after truncating microseconds, eliminating the false "applied_at changed" first-edit log write plus the spurious updated_at refresh
- `backend/app/routers/data.py`: `ImportItem` drops max_length and the url scheme validator (whole-batch 422 broke the per-row tolerance contract); health is now applied per row — overlong required fields skip, invalid urls blank — so large historical fixes / hand-merged files can import partially
- `backend/app/routers/data.py`: `import_data` preserves the original id when `item.id` is a positive integer not present in the DB; duplicate ids within the same batch no longer double-insert, keeping "export→clear→import" id continuity
- `backend/app/routers/data.py`: `import_data` returns separated `created/updated/skipped` counts (imported kept for legacy math); frontend "new X / updated Y" no longer double-counts; `electron/main.js` prefers backend `created` as importedCount
- `electron/main.js`: `writeRendererResume` checks `writeResumeJsonToDataDir` result first, returning false on disk failure — resumeStatus no longer falsely reports 'restored'; `restoreBackupDir` now checks the disk-write result too
- `backend/app/routers/data.py`: `_validate_url_scheme` requires a non-empty netloc, rejecting degenerate links like `http://` (aligned with the frontend `new URL` check)
- `backend/app/routers/data.py`: `update_application` treats an explicit `status: null` as "keep current value" (no more 400 invalid-status, consistent with other optional fields' None-continue)
- `backend/app/routers/data.py`: `import_data` empty-required skip is limited to the create branch (update branch keeps partial-field update semantics)

## [Round 11] — 2026-08-06

- `electron/main.js`: **fixes a TDZ regression introduced in Round 10** — `createdCount`'s fallback referenced `updatedCount` before its declaration, throwing ReferenceError (backend without a `created` field) and mis-reporting a successfully-imported dataset as failed; declaration order swapped
- `frontend/src/pages/DataViews.tsx`: paste-import now folds the locally pre-filtered dropped rows into the returned `skipped` (those rows never reached the backend, so backend skipped was always 0 and the "skipped N" notice never appeared)
- `frontend/src/pages/DataViews.tsx`: paste-import parses separated created/updated/skipped and presents them like the file-import path — "new X / updated Y" no longer presents the grand total as "new"
- `backend/app/routers/data.py`: `ImportPayload.applications` changed to `list[object]` + per-row defensive `isinstance + ImportItem(**row)` construction — a single bad row (null/string/number) counts as skipped instead of 422ing the whole batch (matching the apply_logs skip convention)
- `electron/main.js`: `writeRendererResume` treats the disk copy as the single success signal (returns true once disk write succeeds; localStorage sync is best-effort with a warning) — no more false 'write_failed' prompting users to re-save a resume that actually persisted

## [Round 12] — 2026-08-06

- `backend/app/routers/data.py`: `ImportPayload.apply_logs` widened to `list[object]` (symmetric with applications) — non-dict bad rows are skipped via isinstance instead of 422ing the whole batch
- `electron/main.js`: `preview-import-data` overwriteIds preview normalizes ids via `Number(id)` (numeric-string ids like `"5"` now count as overwrites), matching the backend `ImportItem.id` coercion — no longer falsely reports "all new" when overwrites will occur
- `frontend/src/pages/DataViews.tsx`: paste-import created gains the legacy-backend fallback (`created ?? max(0, imported-updated)`), same as the file-import path; `isValidImportRecord` only requires job_title/company non-empty for rows without a valid id (rows with an id pass through to the backend update branch's preserve-if-empty) so both import paths behave identically on the same data
- `frontend/src/pages/DataViews.tsx`: `refreshBackups` folds `checksumOk` from listBackups into checksumOkMap on load — corrupt backups are flagged/disabled from the first frame instead of only after preview; backupList type gains hasResume/checksumOk and the render-time `as` casts are removed
- `electron/main.js`: `createdCount` legacy fallback now subtracts skipped (`imported - updated - skipped`) so bad rows aren't miscounted as "new", aligning with backend imported=created+updated and the paste-import path

## [Round 13] — 2026-08-06

- `backend/app/routers/data.py`: `ImportPayload.apply_logs` gains a `field_validator(mode='before')` — when the field itself isn't an array (object/string), it's treated as no-logs (None) instead of 422ing the whole batch
- `electron/main.js`: `mergeImportedSettings` adds the benign config keys to the allowlist (cities/apply/browser/blacklist), validated per-subkey via `validateImportedBenignKey` so they migrate with an import round-trip (target cities / apply limits / browser profile / blacklist are no longer silently dropped); status semantics split — only stripping security-sensitive credentials (LLM key / provider URL / external-host allowlist) reports `retained_credentials_stripped`, while a dropped invalid benign key just counts and still returns `restored`, killing the misleading "LLM key stripped" toast on a normal round-trip
- `electron/main.js`: `createdCount` legacy fallback unified to `imported - updated` (backend `imported` already excludes skipped), identical to frontend `importApplications` — eliminates the self-contradictory counts across the two import paths
- `electron/preload.js`: `subscribe`'s get-backend-state fallback pull now guards the buffer write with `has()` — if a real push arrived during the invoke, the stale snapshot no longer overwrites it, so stale payloads can't bypass the `!==` dedup guard and get re-dispatched

## [Round 14] — 2026-08-06

- `electron/main.js`: `mergeImportedSettings`'s security branch now validates `external_url_hosts` per-entry and keeps legal hosts (a user's own export can round-trip its allowlist), filtering only invalid entries; and it no longer counts toward `strippedCredentials` (not an LLM credential), killing the false "LLM key stripped" report on round-trip
- `backend/app/routers/data.py`: `import_data` degrades invalid/empty applied_at to NULL (unset) instead of `datetime.now()` — a flood of corrupt imports no longer batch-writes "today", keeping round-trips idempotent
- `backend/app/routers/data.py`: `update_application` writes both logs when a single PATCH changes status plus other fields (status log carries the field list) — same-batch audit info no longer lost
- `backend/app/routers/data.py` + `db.py` + `models.py` + `main.js`: **schema v3** — `applied_at` gets an index and date filtering/trend/sort switch to datetime range comparisons (sargable), avoiding full-table scans at 500k rows; migrations clear stale `applications_v1` first and fresh DBs skip the historical rebuild migration (no crash-leftover deadlock)
- `electron/main.js`: `preview-backup` returns `ok:false`+error when app.db is missing and `ok:true` (valid header-only preview) when node:sqlite is unavailable — corrupt backups are no longer rendered as a normal-looking preview by the frontend
- `electron/main.js`: `import-data` consumes the trusted path only on the success branch instead of at handler start — transient import failures can be retried without a dead-end
- `frontend/src`: STATUS_TEXT/STATUS_COLOR/STATUS_OPTIONS centralized into `lib/applyStatus.ts` (DataViews/ApplyPage/InterviewPage import it), eliminating silent drift across the three copies

## [Round 15] — 2026-08-06

- `backend/app/routers/data.py`: `import_data` update branch only writes applied_at when it's an explicit null or parses successfully — an invalid string preserves the existing date instead of wrongly clearing it to NULL
- `electron/main.js`: `validateImportedBenignKey` rebuilt per-subkey (mirroring restoreSettingsSafely) — invalid subkeys drop, valid ones keep, non-objects reject the whole key; import and restore now behave identically on the same settings
- `backend/app/routers/data.py`: the 30-day dashboard trend now buckets in Python (WHERE applied_at >= start uses the index; raw window values are bucketed in code) instead of a `func.date()` GROUP BY that scans every row
- `frontend/src/pages/InterviewPage.tsx`: editing a record whose 【面试登记】 block has an unparseable time keeps the original block (only rebuilt on explicit clear or successful parse) — structured data is no longer silently deleted
- `electron/main.js`: `verifyBackupManifest` whitelists checksum keys with a strict regex (rejects names with path separators / `..`) — closes the path-traversal read of arbitrary files via a crafted zip manifest
- `backend/app/routers/data.py`: `update_application` status log drops the duplicated field list (the standalone update log owns field-change detail), eliminating timeline duplicates
- `frontend/src/vite-env.d.ts` + `ResumePage.tsx`: adds the `notifyResumeSaved` type (param `object | null`) and removes 4 inline `as` casts
- `frontend/package.json`: `dayjs` now declared explicitly (was a transitive dependency of antd)
- `frontend/src/pages/DataViews.tsx`: the "this week" preset now starts on Monday (dayjs default en locale starts Sunday), matching zh-CN convention

## [Round 16] — 2026-08-06

- `frontend/src/pages/InterviewPage.tsx`: **fixes a Round 15 regression** — the "preserve unparseable interview block" branch now rebuilds with the original block's time/form while merging the user's freshly-edited remark (no longer overwrites with the wholesale originalNote, discarding new remark edits); `wasInterviewPopulatedRef` distinguishes "time never backfilled (keep block)" from "fields were backfilled then explicitly cleared (strip block)", so clearing the interview fields works again
- `frontend/src/pages/DataViews.tsx`: **fixes a Round 15 regression** — the "this week" preset is Sunday-safe (on a Sunday, `startOf('week')` returns that same day and +1 day is next Monday, producing a from>to inversion where the range filter matches nothing); Sunday now takes this Monday (6 days before)
- `electron/main.js`: `mergeImportedSettings` merges benign config keys per-subkey (`{...current[key], ...benign}`), preserving current defaulted subkeys — hand-edited / partial import files no longer silently drop apply.interval_seconds/halt_on_risk etc.

## [Round 17] — 2026-08-06

- `electron/main.js`: **fixes a high-severity regression introduced in Round 16** — the subkey merge also spread `cities` (a `list[str]`) into a numeric-key object (`{0:'广州',1:'深圳'}`), which backend pydantic `cities: list[str]` rejects and crashes the next startup; cities is now assigned as a whole array
- `frontend/src/pages/InterviewPage.tsx`: **fixes a Round 16 regression** — interview time/form backfill flags split into `wasInterviewTimeBackfilledRef`/`wasInterviewFormBackfilledRef`: when the block's time is a hand-written format dayjs can't parse but the form was backfilled, saving a remark-only edit no longer silently drops the original hand-written time (un-backfilled time keeps orig.time); explicitly clearing a previously-backfilled field still strips it
- `frontend/src/pages/InterviewPage.tsx`: the interview-form Select gains `allowClear` — blocks containing a form were previously impossible to clear from the UI (the strip path only worked for time-only blocks); the clear path is now reachable

## [Round 18] — 2026-08-06

- `electron/main.js`: **fixes a high-severity regression introduced in Round 17** — import-data's success branch called `trusted.delete(resolved)` with a block-scoped variable (out of scope), throwing ReferenceError on every successful import and falsely reporting failure; now uses `filePath` (already reassigned to the resolved path in the confirmedPath branch)
- `electron/main.js`: `validateImportedBenignKey` and `restoreSettingsSafely` now filter cities **per-item** (blank/whitespace entries dropped, valid cities kept) instead of rejecting the whole array on a single bad entry — target cities no longer silently vanish on one invalid row
- `electron/main.js`: `apply.interval_seconds` validation gains a **non-empty constraint** (an empty `[]` passes `every()` vacuously, so importing `{interval_seconds:[]}` silently wiped the configured interval)
- `frontend/src/pages/Settings.tsx`: with the LLM engine not yet wired (ComingSoonCard disabled), onFinish **no longer submits the llm group** — a stale non-whitelisted base_url from an earlier version no longer blocks saving every other editable setting (config-save deadlock)
- `frontend/src/pages/InterviewPage.tsx`: when a record holds a hand-written interview time dayjs can't parse (e.g. "下周三"), the modal now shows a read-only notice + a "remove handwritten time" button — such times were previously replaceable but never deletable via the UI

## [Round 19] — 2026-08-06

- `electron/main.js`: `restoreSettingsSafely` gains the same non-empty guard on `apply.interval_seconds` (aligned with the import-path `validateImportedBenignKey`) — an empty `[]` no longer passes `every()`'s vacuous truth during restore, so a backup containing `interval_seconds:[]` can't silently wipe the configured apply interval
- **No high issues this round**: per the convergence rule (low<5 ignored), proceeding to final acceptance — the P0 skeleton-hardening loop wraps up

## [0.1.5] — 2026-08-06

- **Docs**: added the interface spec v0.1 (`docs/求职投递项目_接口文档_v0.1.md`) — three-layer architecture overview, auth model, all 12 backend HTTP endpoints (index table / params / request-response / error codes), all 26 Electron IPC channels (index table / semantics), data model & schema migrations, config items, security baseline, revision history; cross-verified against the README endpoint table

## [0.1.6] — 2026-08-06

P1a resume material library + RAG knowledge base (P1 prerequisite research delivery, kept internal):

- **Version sync**: `APP_VERSION` / `electron/package.json` / `frontend/package.json` unified from 0.1.0 to 0.1.6
- **Resume material library**: scanned 34 GitHub keywords → 200 resume/document/job-ecosystem repos (1k+ stars first) isolated-cloned into local research corpus (not redistributed); 《简历知识库_详细内容.md》1194 lines — methodology (FAB/STAR/ATS), JSON Resume Schema, per-role templates, CN/EN example sentences & cover-letter templates, AI optimization models (resumePolice/career-ops)
- **RAG index**: bge-m3 1024-dim, 40,367 chunks × full 200/200 repo coverage (GPU CUDA accelerated); `build_rag.py` (full docs + per-repo source sampling), `check_coverage.py` (coverage check), `test_rag.py` (36 handcrafted queries 100%), `test_rag_2000.py` (2000-query stress test **99.8% ≥98% passed**)
