# CHANGELOG

> BossJobAI 求职投递助手 — 版本变更与修复记录（中文）

> 正式版本段按迭代收敛（本轮 P0 骨架加固的 19 个 fixloop Round 分布到 0.1.1–0.1.4 四个补丁版本）；
> 原始逐轮修复明细保留在下方独立的 `# UpdateLOG` 区块，不覆盖原记录。

## [0.1.1] — 2026-08-05

P0 骨架加固第一批（fixloop Round 1–5）：

- **IPC / preload 安全**：拉取回调退订守卫；同通道 in-flight 拉取复用；`importData` 类型门禁；外部链接 scheme 归一化；scheme 名单改惰性异步拉取（移除模块加载期 sendSync）
- **外部链接白名单**：host 后缀去尾随点归一；trusted 导入路径 60s TTL；条目格式校验（拒绝协议/端口/路径及归一化后无点号的裸单标签如 `com`）
- **设置恢复**：`restoreSettingsSafely` 类型校验后恢复非敏感键；备份恢复不再静默清空外链白名单；恢复的 `cities/apply/browser/blacklist` 加字段级校验
- **导出**：`export-data-offline` 应用 status/keyword/date 筛选（对齐 CSV 导出）
- **后端**：LIKE 通配符（`%`/`_`）转义 + ESCAPE 声明；显式清空 applied_at 语义；导入 `_parse_dt` 宽松解析
- **面试页**：`parseInterviewBlock` 限定到【面试登记】段内解析；CSP 校验脚本断言 `script-src 'self'`

## [0.1.2] — 2026-08-06

投递时间「未设置」语义 + 导入健壮性（Round 6–10）：

- **applied_at NULL 语义**：schema v2 迁移（重建 applications 表、v1 数据无损搬迁、status 索引重建）；PATCH 清空存 NULL；表单 tooltip/placeholder 改「留空=未设置」；`ApplicationItem.applied_at` 放宽为 `datetime | None`
- **导入**：恢复 `updated_at`；移除列 `default=datetime.now`（import NULL 落成今天的根因）；datetime 精度归一（`replace(microsecond=0)`）；`ImportItem` 去掉 max_length 与 url scheme 校验实现逐行容错；保留原 id；`created/updated/skipped` 分离计数
- **更新**：显式 `status: null` 保留原值；url 加 netloc/scheme 校验；仅真实值变化才写 apply_log
- **设置恢复**：`apply/browser/blacklist` 改子键白名单重建

## [0.1.3] — 2026-08-06

导入计数收敛 + 安全加固（Round 11–15）：

- **回归修复**：TDZ `createdCount` ReferenceError；粘贴导入 skipped/created 回退与文件导入收敛一致
- **导入载荷**：`applications`/`apply_logs` 放宽为 `list[object]` + 逐行 `isinstance` 防御性构造（坏行计入 skipped 而非整批 422）
- **设置导入/恢复**：逐子键校验统一；良性键（cities/apply/browser/blacklist）随往返迁移；`external_url_hosts` 逐项校验保留合法 host
- **Schema v3**：`applied_at` 建索引 + sargable datetime 区间过滤；看板近 30 天趋势分桶移 Python 侧
- **备份安全**：`verifyBackupManifest` checksum 键白名单正则（封堵路径穿越）；损坏备份预览识别
- **重构**：STATUS_TEXT/COLOR/OPTIONS 集中到 `lib/applyStatus.ts`；显式声明 `dayjs`；「本周」preset 起点改周一

## [0.1.4] — 2026-08-06

回归收敛 + 最终验收（Round 16–19）：

- **面试页**：无法解析块的保留/重建修复（回填标记拆分）；面试形式 Select 加 `allowClear`；手写时间只读提示 + 移除按钮
- **high 回归**：`cities` 列表被误展开崩溃修复；import-data 成功路径 ReferenceError 修复
- **设置**：`apply.interval_seconds` 非空约束（恢复 + 导入两侧）；LLM 未接入时 onFinish 不再回传 llm 段（解除配置保存死锁）；cities 逐项过滤
- **收尾**：「本周」preset Sunday-safe；无 high 遗留 → P0 骨架加固循环关闭

# UpdateLOG

## [Round 1] — 2026-08-05

P0 骨架加固（fixloop 扫描驱动的本体修复轮）：

- `electron/preload.js`：拉取路径回调加退订守卫（`entry.count > 0`）——不再向已卸载消费者投递
- `electron/preload.js`：同一通道复用 in-flight 拉取 promise —— 并发订阅不再被 `has()` 守卫误吞
- `electron/preload.js`：`importData(path)` 加类型门禁（仅字符串/省略）
- `electron/preload.js`：外部链接 scheme 规范化（小写 + 补尾冒号）后再比对，与主进程权威校验一致
- `electron/preload.js`：null/undefined 载荷也写回缓冲哨兵（`has()` 语义），避免冗余拉取
- `electron/preload.js` + `main.js`：scheme 名单改为惰性异步拉取（首次 openExternal 时 invoke，去掉模块加载期 sendSync 同步阻塞）；新增 `ipcMain.handle('get-external-url-schemes')`
- `frontend/src/pages/InterviewPage.tsx`：仅当确有面试输入或原记录已含面试数据时才重建面试登记段 —— 不再污染空段
- `frontend/src/lib/applyShared.tsx` + `electron/main.js`：域名白名单后缀统一归一化（去尾随点），`example.com.` 这类条目也能放行
- `electron/main.js`：trustedImportPaths 加 60s TTL —— 取消导入确认弹窗后信任路径自动失效
- `frontend/scripts/verify-csp.mjs`：断言源码 `script-src` 必须精确为 `'self'` + 更正过时文件头注释（源码已是严格版）

## [Round 2] — 2026-08-05

- `electron/preload.js`：回放分支跳过 null/undefined 哨兵载荷（保留 `has()` 防重复拉取，不向消费者投递空回调 / 不再触发 Dashboard 解构 TypeError）
- `electron/main.js`：`isExternalHostAllowed` 归一化 host（去尾随点），与后缀侧归一化对称
- `frontend/src/lib/applyShared.tsx` + `frontend/src/pages/DataViews.tsx`：`isHostAllowed` 统一归一化 host 与后缀（去尾随点）——消除重复实现漂移
- `frontend/src/pages/InterviewPage.tsx`：`handleSave` 编辑把记录改离「面试中」筛选时应用分页 clamp（对齐 `handleStatusChange`），避免停在越界空页
- `electron/main.js`：删除 `ipcMain.on('get-external-url-schemes')` 同步死代码（preload 仅走 invoke 路径）

## [Round 3] — 2026-08-05

- `frontend/src/pages/InterviewPage.tsx`：`parseInterviewBlock` 仅解析「【面试登记】」段内的时间/形式 —— 不再误解析普通备注（如「简历形式：PDF」「加班时间：不定」）
- `frontend/src/pages/ApplyPage.tsx`：`handleSave` 编辑把记录改离「待投递」筛选时应用分页 clamp（对齐 `handleStatusChange`）
- `frontend/src/pages/DataViews.tsx`：`handleSave` 状态筛选视图下改状态离开视图时应用分页 clamp（对齐 `handleStatusChange willLeaveView`）
- `electron/main.js`：`loadUserExternalHostAllowlist` 加格式校验（拒绝协议/端口/路径；拒绝归一化后无点号的裸单标签如 "com"），对齐 Settings 表单校验
- `backend/app/routers/data.py`：LIKE 通配符（`%`/`_`）转义 + ESCAPE 声明，搜索字面量（如 "100%"）不再失真
- `frontend/src/pages/DataViews.tsx`：复用 `../lib/applyShared` 的 `parseUrlHost`/`isHostAllowed`（删除本地重复实现）防漂移
- `frontend/src/pages/Dashboard.tsx`：更正引用已移除 `getBackendPort()` API 的过时注释

## [Round 4] — 2026-08-05

- `frontend/src/pages/InterviewPage.tsx`：`parseInterviewBlock` 拆行限定到标签后的结构化行 —— 不再被备注中「时间：/形式：」子串误解析出幻影值
- `frontend/src/pages/InterviewPage.tsx`：`buildInterviewNote` 空值省略对应行；编辑时清空面试字段即删除结构化段（不再粘滞重建占位块）
- `frontend/src/pages/InterviewPage.tsx`：`stripInterviewBlock` 用 `remarkStarted` 标记保留多行备注续行 —— 不再误删文本
- `frontend/src/lib/applyShared.tsx`：`useExternalHosts` 应用与主进程一致的格式校验（拒绝协议/裸 TLD）
- `frontend/src/pages/DataViews.tsx`：复用共享 `useUrlHostWarning`（删除本地复刻）
- `frontend/src/lib/useBackendBase.ts` + `ApplyPage`/`DataViews`：`createApplication` 收敛到共享模块（统一「新增失败」前缀 + status 兜底）
- `electron/main.js`：`restoreSettingsSafely` 类型校验后恢复非敏感配置键（cities/apply/browser/blacklist），不再静默剥离
- `backend/app/routers/settings.py`：校验 `security.external_url_hosts` 条目（拒绝协议/端口/裸 TLD），与主进程口径一致

## [Round 5] — 2026-08-05

- `electron/main.js`：`restoreSettingsSafely` 校验后恢复 `security.external_url_hosts`（不再静默清空外链白名单）
- `electron/main.js`：恢复的 `cities/apply/browser/blacklist` 加字段级校验（拒绝会导致后端配置加载失败的非法值）
- `electron/main.js` + `frontend`：`export-data-offline` 应用 status/keyword/date 筛选（对齐 `export-data-csv`），页面透传当前筛选
- `backend/app/routers/data.py`：显式清空 `applied_at` 时设为当前时间（对齐「留空=当前时间」提示，不再静默空操作）
- `backend/app/routers/data.py`：导入 `applied_at` 经 `_parse_dt` 宽松解析（非法日期降级为当前时间而非中断整批导入）
- `frontend/src/pages/InterviewPage.tsx`：删除未使用的 `hadInterviewDataRef` 死代码（Round 4 重构后已无读取）及 `useRef` import

## [Round 6] — 2026-08-06

- `frontend/src/pages/DataViews.tsx` + `ApplyPage.tsx` + `InterviewPage.tsx`：清空投递时间时显式发送 `applied_at: null`（此前键被丢弃会静默保留旧值）；`ApplicationInput.applied_at` 类型放宽为 `string | null`
- `backend/app/routers/data.py`：导入时恢复 `updated_at`（新增行/更新行均按 `_parse_dt` 宽松解析，非法值降级为当前时间），导入不再丢失原记录修改时间
- `frontend/src/vite-env.d.ts`：`exportCsv` 筛选类型补充 `date_from/date_to`（对齐 `export-data-csv` 实际支持的时间范围筛选）
- `electron/main.js`：`restoreSettingsSafely` 对 `apply/browser/blacklist` 改子键白名单重建——仅恢复已知子键（apply: daily_limit/halt_on_risk/interval_seconds；browser: headless/user_data_dir；blacklist: companies/keywords），未知子键不注入，防篡改备份携带任意键污染配置结构

## [Round 7] — 2026-08-06

- `electron/main.js`：`restoreSettingsSafely` 从当前配置合并回 LLM 密钥/base_url（备份凭据剥离后不静默抹掉用户现存密钥），并修正 stripped 记账——密钥已保留时不再计入被剥离项
- `electron/main.js`：`restoreSettingsSafely` 对 `apply/browser/blacklist` 从「全有或全无」改为**逐子键独立校验**——任一子键非法仅丢弃该子键（单独计入 stripped 含键名），合法子键照常保留
- `electron/main.js`：`get-external-url-schemes` 从裸 `ipcMain.handle` 改为 `guardedHandle`（与其余 IPC 同一应用主窗口发送方白名单）
- `backend/app/routers/data.py`：`ImportItem` 可选字段（city/salary/url/note/job_title/company）放宽为 `str | None`，导入以 `(x or "").strip()` 兜底，null 不再导致整批 422 失败
- `backend/app/routers/data.py`：`create_application` 先 strip 再判空（pydantic min_length 校验原始值会放过纯空格），杜绝空白标题/公司入库
- `backend/app/config.py`：`ApplyConfig` 加边界（daily_limit 1..500、interval_seconds 每项 1..3600），对齐恢复白名单，越界值不再能写入后被整段剥离
- `frontend/src/pages/DataViews.tsx`：JobsPage `handleSave` 的 `willLeaveView` 补 `editingId !== null` 守卫（对齐 ApplyPage/InterviewPage），避免新建记录误退页
- `frontend/src/pages/InterviewPage.tsx`：面试时间排序双无效时显式返回 0，消除 `Infinity-Infinity=NaN` 不一致比较器
- `frontend/src/pages/Settings.tsx`：模块级 `backupCardState` 写入从 render 体移到 `useEffect`，消除渲染纯函数副作用
- **投递时间语义变更（存空值 NULL）**：`backend/app/models.py` `applied_at` 改 `nullable=True`；`backend/app/db.py` schema v2 迁移（重建 applications 表，v1 数据无损搬迁 + status 索引重建）；`backend/app/routers/data.py` PATCH 清空 applied_at 存 NULL（不再落今天）；`electron/main.js` `DB_SCHEMA_VERSION` 同步 2；三处表单 tooltip/placeholder 改为「留空=未设置」；`ApplicationItem.applied_at` 类型放宽 `string | null`

## [Round 8] — 2026-08-06

- `backend/app/routers/data.py`：**修复 Round 7 引入的 high 回归**——`ApplicationItem.applied_at` 响应模型由 `datetime` 放宽为 `datetime | None`（schema v2 下 NULL 记录此前会让 GET /api/applications 整表 500、PATCH 清空时间误报失败且列表打不开）
- `electron/main.js`：恢复备份的 schema 版本守卫从「不等于当前版本即拒绝」改为「仅拒绝高于当前版本」——升级后用户仍可恢复升级前的 v1 备份（复制覆盖后 startBackend 拉起后端，init_db 自动跑 v1→v2 迁移）
- `backend/app/routers/data.py`：`import_data` 插入路径不再把 NULL applied_at 落为今天（`_parse_dt(item.applied_at)` 直接透传 None），保导出→导入往返的「未设置」语义
- `backend/app/routers/data.py`：`update_application` 对 job_title/company 与 create 同口径 strip 后判空（拒绝 PATCH 直传纯空格覆盖为空白）

## [Round 9] — 2026-08-06

- `backend/app/models.py`：**修复 Round 8 import NULL 无效的根因**——移除 `applied_at` 的 `default=datetime.now`（SQLAlchemy 对 INSERT 值为 None 的列自动应用列默认值，导致 `import {applied_at:null}` 仍落成今天）；新建「缺省取当前时间」改由 create_application 显式 `payload.applied_at or datetime.now()` 承担
- `backend/app/routers/data.py`：`import_data` 区分 applied_at 的「显式 NULL → 存 NULL」与「非法字符串 → 降级当前时间」，保导出→导入往返的「未设置」语义
- `backend/app/routers/data.py`：`import_data` 更新分支对 city/salary/url/note 改 preserve-if-empty（对齐 job_title/company），省略字段不再静默清空已有数据
- `backend/app/routers/data.py`：`import_data` 创建分支任一必填字段（job_title/company）为空即跳过，对齐 create_application 非空契约
- `backend/app/routers/data.py`：`import_data` 更新分支用 `item.model_fields_set` 判断 applied_at/updated_at 显式传入——`applied_at:null` 可把目标已有日期清回 NULL，缺失键则不动
- `backend/app/routers/data.py`：`update_application` PATCH 仅在实际值变化时写 apply_log（对比前后值），零变更保存不再污染时间线
- `electron/main.js`：`preview-import-data` 信任路径 TTL 从 60s 延长到 10min，防确认弹窗阅读期间过期形成交互死路
- `backend/app/routers/data.py`：url 字段加 `field_validator` 校验 scheme 仅 http/https（空串放行），create/update/import 三路径共用

## [Round 10] — 2026-08-06

- `backend/app/routers/data.py`：**datetime 精度归一**——create 落库统一 `replace(microsecond=0)`、update 比较前归一微秒，消除「首编辑必误判 applied_at 变化」而误写日志并触发 updated_at 刷新
- `backend/app/routers/data.py`：`ImportItem` 去掉 max_length 与 url scheme 校验（整批 422 会破坏逐行容错契约），改为逐行卫生处理——超长必填行跳过、非法 url 置空，保大批量历史修正/手工合并可部分导入
- `backend/app/routers/data.py`：`import_data` 保留原 id（item.id 为正整数且未命中库时显式传入），同批重复 id 不重复插入，保「导出→清库→导入」id 连续性
- `backend/app/routers/data.py`：`import_data` 返回 `created/updated/skipped` 分离计数（imported 兼容旧算法），前端「新增 X / 更新 Y」不再重复计数；`electron/main.js` 优先用后端 `created` 作为 importedCount
- `electron/main.js`：`writeRendererResume` 先检查 `writeResumeJsonToDataDir` 落盘结果，失败即返回 false——resumeStatus 不再误报 'restored'；`restoreBackupDir` 补落盘 ok 检查
- `backend/app/routers/data.py`：`_validate_url_scheme` 追加 netloc 校验，拒绝 `http://` 等退化链接（对齐前端 new URL 口径）
- `backend/app/routers/data.py`：`update_application` 对 status 显式 null 按「保留原值」处理（不再 400 非法状态，与其它可选字段 None continue 一致）
- `backend/app/routers/data.py`：`import_data` 空必填跳过仅限 create 分支（update 分支保留部分字段更新语义）

## [Round 11] — 2026-08-06

- `electron/main.js`：**修复 Round 10 自引入的 TDZ 回归**——`createdCount` 回退表达式在 `updatedCount` 声明前引用触发 ReferenceError，后端无 created 字段时已落库的导入被误报失败；交换声明顺序
- `frontend/src/pages/DataViews.tsx`：粘贴导入把本地预过滤丢弃数（dropped）并入返回的 skipped（此前这些行没 POST 给后端、后端 skipped 恒 0，「跳过 N 条」提示永不出现）
- `frontend/src/pages/DataViews.tsx`：粘贴导入解析 created/updated/skipped 分离展示，与文件导入（handleImportFile）同口径，「新增 X / 更新 Y」不再把总数当新增
- `backend/app/routers/data.py`：`ImportPayload.applications` 改 `list[object]` + import_data 逐行 `isinstance + ImportItem(**row)` 防御性构造——单条 null/字符串/数字等坏行计入 skipped，不再整批 422（与 apply_logs 跳过口径一致）
- `electron/main.js`：`writeRendererResume` 以磁盘副本为唯一成功信号（磁盘写成功即返回 true，localStorage 仅 best-effort 记警告）——避免磁盘已落盘仍误报 write_failed 提示用户重存

## [Round 12] — 2026-08-06

- `backend/app/routers/data.py`：`ImportPayload.apply_logs` 改 `list[object]`（与 applications 对称），单条非 dict 坏行由 isinstance 跳过，不再整批 422
- `electron/main.js`：`preview-import-data` 的 overwriteIds 预览用 `Number(id)` 归一（数字字符串 id 如 `"5"` 也纳入覆盖统计），与后端 ImportItem.id 强制转 int 对齐，不再误报「全部为新增」
- `frontend/src/pages/DataViews.tsx`：粘贴导入 created 补旧后端回退（`created ?? max(0, imported-updated)`），与文件导入同口径；`isValidImportRecord` 仅对无有效 id 的行要求 job_title/company 非空（有 id 行放行交后端 update 分支 preserve-if-empty），两导入路径对同一数据行为一致
- `frontend/src/pages/DataViews.tsx`：`refreshBackups` 拉取 listBackups 时直接把 checksumOk 并入 checksumOkMap，损坏备份列表首帧即标红/禁用恢复（而非等预览后）；backupList 类型补 hasResume/checksumOk 并移除渲染处 `as` 强转
- `electron/main.js`：`createdCount` 旧后端回退剔除 skipped（`imported - updated - skipped`），坏行不再被误算进「新增」，与后端 imported=created+updated 及粘贴导入路径对齐

## [Round 13] — 2026-08-06

- `backend/app/routers/data.py`：`ImportPayload.apply_logs` 加 `field_validator(mode='before')`——字段本身非数组（对象/字符串）时视为无日志置 None，不再整批 422
- `electron/main.js`：`mergeImportedSettings` 补良性配置键白名单（cities/apply/browser/blacklist），经 `validateImportedBenignKey` 逐子键类型校验后随导入迁移（目标城市/投递合规/浏览器 Profile/黑名单不再被静默丢弃）；status 语义拆分——仅剥离安全敏感凭据（LLM 密钥/提供商地址/外链白名单）才报 `retained_credentials_stripped`，良性键非法丢弃仅记数仍返回 `restored`，消除往返导入「LLM 密钥已剥离」误导文案
- `electron/main.js`：`createdCount` 旧后端回退公式统一为 `imported - updated`（后端 imported 已排除 skipped），与前端 importApplications 完全一致，消除两路径计数自相矛盾
- `electron/preload.js`：`subscribe` 的 get-backend-state 兜底拉取写缓冲前加 `has()` 守卫——invoke 拉取期间已有真实推送时不再用旧快照覆盖缓冲，杜绝陈旧载荷绕过 `!==` 守卫重复分发

## [Round 14] — 2026-08-06

- `electron/main.js`：`mergeImportedSettings` 的 security 分支对 `external_url_hosts` 逐项校验保留合法 host（用户自己的导出可往返迁移白名单），非法条目逐项过滤；且不再把它计入 strippedCredentials（非 LLM 凭据），消除往返误报「LLM 密钥已剥离」
- `backend/app/routers/data.py`：`import_data` 非法/空串 applied_at 降级为 NULL（未设置）而非 `datetime.now()`——大量损坏导入不再批量写「今天」，round-trip 幂等
- `backend/app/routers/data.py`：`update_application` 同批同时变更 status 与其它字段时两条日志都写（status 日志附带字段清单），不再丢失同批审计信息
- `backend/app/routers/data.py` + `db.py` + `models.py` + `main.js`：**schema v3**——`applied_at` 建索引 + 日期过滤/看板趋势/列表排序改 datetime 区间比较（sargable），避免 50 万行全表扫描；迁移前清理 `applications_v1` 残留，全新库跳过历史重建迁移（防崩溃残留死锁）
- `electron/main.js`：`preview-backup` 缺 app.db 时返回 `ok:false`+error、node:sqlite 不可用时返回 `ok:true`（合法头部预览）——损坏备份不再被前端渲染成伪正常预览
- `electron/main.js`：`import-data` 信任路径从 handler 开头删除改到成功分支后一次性消费——导入瞬态失败后可重试，不再死路
- `frontend/src`：STATUS_TEXT/STATUS_COLOR/STATUS_OPTIONS 三处副本集中到 `lib/applyStatus.ts`（DataViews/ApplyPage/InterviewPage 统一 import），消除状态枚举/颜色静默漂移风险

## [Round 15] — 2026-08-06

- `backend/app/routers/data.py`：`import_data` 更新分支仅当 applied_at「显式 null」或「解析成功」才写入——非法字符串保留目标已有日期，不再误清成 NULL
- `electron/main.js`：`validateImportedBenignKey` 改逐子键重建（对齐 restoreSettingsSafely）——非法子键丢弃、合法保留，非对象才整体拒绝；导入与恢复对同一 settings 行为一致
- `backend/app/routers/data.py`：看板近 30 天趋势分桶移到 Python 侧（WHERE applied_at >= start 走索引，拉窗口内原始值分桶），func.date GROUP BY 不再全表扫描
- `frontend/src/pages/InterviewPage.tsx`：编辑无法解析时间的面试块时保留原「【面试登记】」块（仅显式清空或解析成功才重建），不再静默删除结构化数据
- `electron/main.js`：`verifyBackupManifest` 校验 checksums 的 key 白名单正则（拒绝含路径分隔符/.. 的 name）——封堵不可信 zip manifest 的路径穿越读任意文件
- `backend/app/routers/data.py`：`update_application` status 日志去掉重复字段清单（update 日志独占字段变更明细），消除时间线重复
- `frontend/src/vite-env.d.ts` + `ResumePage.tsx`：补 `notifyResumeSaved` 类型声明（参数 `object | null`），移除 4 处 `as` 强转
- `frontend/package.json`：显式声明 `dayjs` 依赖（此前是 antd 的传递依赖）
- `frontend/src/pages/DataViews.tsx`：「本周」preset 起点改周一（dayjs 默认 en locale 是周日），与中文用户习惯一致

## [Round 16] — 2026-08-06

- `frontend/src/pages/InterviewPage.tsx`：**修复 Round 15 引入的回归**——面试块「无法解析保留原块」改为用原块 time/form 重建并合并用户本次备注编辑（不再整体用 originalNote 覆盖而丢弃新备注）；用 `wasInterviewPopulatedRef` 区分「原块时间从未回填（保留块）」与「字段曾被回填、用户显式清空（剥离块）」，显式清空面试字段恢复生效
- `frontend/src/pages/DataViews.tsx`：**修复 Round 15 引入的回归**——「本周」preset Sunday-safe（周日当天 startOf('week') 返回当天、+1 天成明天导致 from>to 倒置、区间过滤恒空）；周日取本周一（周日前 6 天）
- `electron/main.js`：`mergeImportedSettings` 良性配置键改子键合并（`{...current[key], ...benign}`），保留当前配置缺省子键——手改/部分导入文件不再静默丢弃 apply.interval_seconds/halt_on_risk 等

## [Round 17] — 2026-08-06

- `electron/main.js`：**修复 Round 16 引入的 high 回归**——`mergeImportedSettings` 子键合并把 `cities`（list[str]）也当对象展开成数字键对象（`{0:'广州',1:'深圳'}`），后端 pydantic `cities: list[str]` 校验失败、下次启动崩溃；cities 单独处理直接整段替换数组
- `frontend/src/pages/InterviewPage.tsx`：**修复 Round 16 引入的回归**——面试时间/形式回填标记拆分为 `wasInterviewTimeBackfilledRef`/`wasInterviewFormBackfilledRef`：原块时间手写格式无法解析但形式已回填时，仅改备注保存不再静默丢弃原手写时间（时间未回填保留 orig.time）；曾被回填后显式清空仍剥离
- `frontend/src/pages/InterviewPage.tsx`：面试形式 Select 加 `allowClear`——含形式的面试块此前无法从 UI 清空（剥离分支对只有时间的块才可达），现在清空路径可达

## [Round 18] — 2026-08-06

- `electron/main.js`：**修复 Round 17 引入的 high 回归**——import-data 成功分支 `trusted.delete(resolved)` 引用块级变量 `resolved`（越界），每次成功导入都抛 ReferenceError 误报失败；改用 `filePath`（confirmedPath 分支已重赋值为 resolved）
- `electron/main.js`：`validateImportedBenignKey` 与 `restoreSettingsSafely` 的 cities 改为**逐项过滤**（单条空串/纯空白城市丢弃、合法城市保留），不再因一条非法导致全部目标城市静默丢失
- `electron/main.js`：`apply.interval_seconds` 校验加**非空约束**（空数组 `[]` 会通过 every() 的 vacuous truth，导入 `{interval_seconds:[]}` 会静默清空已配置间隔）
- `frontend/src/pages/Settings.tsx`：LLM 引擎未接入（ComingSoonCard 禁用）时 onFinish **不再回传 llm 段**——早期版本持久化的非白名单 base_url 不再阻断 cities/安全/备份等一切可编辑配置的保存（配置保存死锁）
- `frontend/src/pages/InterviewPage.tsx`：原记录含 dayjs 无法解析的手写面试时间（如「下周三」）时，弹窗内提供**只读提示 + 「移除手写时间」按钮**——此前这类时间只能替换无法通过 UI 删除

## [Round 19] — 2026-08-06

- `electron/main.js`：`restoreSettingsSafely` 的 `apply.interval_seconds` 补**非空约束**（与 import 路径 `validateImportedBenignKey` 对齐）——空数组 `[]` 不再通过 every() 的 vacuous truth 被恢复，含 `interval_seconds:[]` 的备份不再静默清空已配置投递间隔
- **本轮无 high 问题**：按收敛规则（low<5 忽略 low）进入 final 验收阶段，P0 骨架硬化循环收尾

## [0.1.5] — 2026-08-06

- **文档**：新增《接口文档 v0.1》（`docs/求职投递项目_接口文档_v0.1.md`）——架构三层总览、鉴权模型、12 个后端 HTTP 接口（含索引表/参数/请求响应/错误码）、26 个 Electron IPC 通道（含索引表/语义）、数据模型与 schema 迁移、配置项、安全基线、修订记录；与 README 接口表交叉验证一致

## [0.1.6] — 2026-08-06

P1a 简历素材库 + RAG 知识库（P1 前置调研交付，内部使用不随仓库分发）：

- **版本号统一**：三处 `APP_VERSION` / `electron/package.json` / `frontend/package.json` 从 0.1.0 同步到 0.1.6
- **简历素材库**：GitHub 扫描 34 关键词 → 200 个简历/文档/求职生态仓库（1k+ star 优先）隔离 clone 至本地调研语料（不随本仓库分发）；《简历知识库_详细内容.md》1194 行——方法论（FAB/STAR/ATS）、JSON Resume Schema、分岗位模板、中英例句/Cover Letter、AI 优化模型（resumePolice/career-ops）
- **RAG 索引**：bge-m3 1024 维，40,367 块 × 200/200 仓全覆盖（GPU CUDA 加速）；`build_rag.py`（文档全量 + 源码每仓抽样）、`check_coverage.py`（覆盖检查）、`test_rag.py`（36 条人工查询 100%）、`test_rag_2000.py`（2000 次压力测试 **99.8% ≥98% 达标**）

