# Electron main.js 拆分 · 交接文档

> **状态**: 全部代码完成（E-T1~E-T8 ✅），**待用户打包启动冒烟**（最终门禁）
> **目标**: `code/electron/main.js`（5198 行 → 现 1903）拆分为模块化（utils/constants/state/auth/backend/backup）
> **写于**: 2026-08-13

---

## 一、新会话需要阅读的文件（按顺序）

| # | 文件 | 为什么读 |
|---|------|---------|
| 1 | **本交接文档** | 拆分方案/边界/风险/施工图（一次性掌握全貌）|
| 2 | `code/electron/main.js` | 待拆主体（5198 行，结构见 §三）|
| 3 | `code/electron/modules/utils.js` | ✅ 已拆出的范式（怎么拆：独立模块 + require + 语法验证）|
| 4 | `code/electron/preload.js` | IPC 契约（main.js 的 handler 与 preload 的 window.api 对应）|
| 5 | `code/electron/package.json` | 打包配置（electron-builder，拆分后 files 需含 modules/）|
| 6 | `code/electron/backend-default-port.cjs` | 端口单一事实源（常量依赖）|

## 二、已完成（E-T1 + E-T2）

### E-T1 模块边界分析（main.js 结构）
```
1-23    require（electron/child_process/fs/http/path/crypto/url）
24-93   路径 + 常量 + 共享状态（authToken/authTokenFingerprint）
95+     函数（86 个顶层函数）
```

### E-T2 utils 试点 ✅
- 拆出 `modules/utils.js`：timestamp/getDialogParent/openDialog/saveDialog/errMsg/sleepSync/isPlainObject/isValidPort（8 个纯工具）
- main.js 删除这 8 个函数 + `require('./modules/utils')` 解构注入
- `node --check` 主/main + utils 语法 ✅
- **拆分机制验证可行**：建模块 → 脚本删函数（花括号匹配）→ require 注入 → node --check

### E-T3 constants ✅（2026-08-13）
- 拆出 `modules/constants.js`：56 个跨模块常量（路径/端口/超时/SQLite 偏移/备份前缀/令牌 TTL/代理上限/白名单/DB_SCHEMA_VERSION）
- main.js 删除对应常量块 + `require('./modules/constants')` 解构注入；main.js 5198 → 5035 行
- 验证：`node --check` 三文件 ✅ + **mock-electron require 链测试**（56 导出全部命中解构名，`PROJECT_ROOT`/`FRONTEND_DIST_INDEX`/`DEFAULT_PORT` 等派生值正确）
- ⚠️ **关键经验（后续模块拆分必须注意）**：
  1. **`__dirname` 迁移坑**：modules/ 比 electron/ 深一层，路径常量必须重算（`PROJECT_ROOT = path.join(__dirname, '..', '..')`，`FRONTEND_DIST_INDEX` 打包分支加一级 `..`，`backend-default-port.cjs` 引用加一级 `..`）
  2. **PORT_MIN/PORT_MAX 未进 constants**：main.js 里它们是无引用死代码（端口校验全走 utils.isValidPort），直接删除，避免与 utils.js 重复定义
  3. **MAX_ZIP_* / BACKUP_CHK_CACHE_MAX 留在 main.js**：属备份领域，随 E-T7 backup.js 一并处理
  4. **目录未纳入 git**：整个 M.BossJobAI_求职投递助手_v0.1 未被 CC 仓库跟踪，无 git 撤销网 → 每步验证后手工建还原点于 `备份/electron_split_restorepoint_*`

### E-T4 state ✅（2026-08-13）
- 拆出 `modules/state.js`：27 个共享可变状态字段（authToken/backendProc/backendPort/isShuttingDown/各缓冲 Set/缓存 Map 等），`backendPort` 初值来自 constants.js 的 DEFAULT_PORT
- main.js：删全部模块级 `let/const` 声明 + 注入 `const { state } = require('./modules/state')` + **脚本批量改写 188 处引用 → `state.X`**（跳过注释行、`.属性访问`保护）
- 验证：node --check 四文件 ✅ + state 字段交叉审计（27 字段全被引用，无死字段）✅ + **代码行零裸引用审计** ✅ + mock-electron 顶层装载 main.js ✅（抓顶层加载错误）
- ⚠️ **关键经验**：
  1. **node --check 不查变量解析**（undefined 引用照样过）→ 必须做「代码行裸引用」grep 审计兜底
  2. **脚本改写三保护**：纯注释行跳过（`//`/`*`/`/*`/`*/` 开头）、`.属性访问`不注入、`state.` 前缀去重
  3. 关键恒等式改写后语义不变：`const proc = state.backendProc` + `state.backendProc !== proc`；`++state.backendHealthMonitorGeneration`；`state.pendingBackendReady === payload`（缓冲代际校验）；模板插值 `${state.backendPort}`

### E-T5 auth ✅（2026-08-13，🔴 安全关键）
- 拆出 `modules/auth.js`：7 个令牌函数（newToken/loadOrCreateAuthToken/cleanupAuthTokenFile/armAuthTokenFileTtlCleanup/verifyBackendTokenFingerprint/restrictTokenFileAcl/writeAuthTokenFile），逻辑逐字搬运零改动
- **依赖解耦**：getSettingsPath/getDataDir/getBackupDir 三个路径函数下沉到 constants.js（writeAuthTokenFile 需要 getDataDir）；**reportBackendAuthFailure 推迟到 E-T6 归入 backend.js**（它依赖 notify/dialog，留在 auth.js 会形成 auth↔backend 循环依赖）
- main.js：删除 7 函数 + 注入 require；死导入清理（main.js 只用到 loadOrCreateAuthToken/cleanupAuthTokenFile/verifyBackendTokenFingerprint/writeAuthTokenFile）
- 验证：node --check 五文件 ✅ + mock-electron 装载 auth.js（7 导出齐全、newToken() 64hex、指纹校验空载荷 false）✅ + mock 装载 main.js ✅
- ⚠️ **关键经验**：
  1. **模块边界按依赖图定，不全照搬计划**：计划把 reportBackendAuthFailure 放 auth.js 会制造循环 → 移到 backend 域，计划本身的「循环依赖风险」提示正是这样解的
  2. **路径函数可下沉**：getSettingsPath/getDataDir/getBackupDir 本质是「路径解析」，放 constants.js 最合适（auth/backend/backup 都要用）

### E-T6 backend ✅（2026-08-13）
- 拆出 `modules/backend.js`：18 个后端生命周期函数（httpRequest/Get/PostText 传输 + sendToAppWindows/broadcast 通知 + reportBackendAuthFailure + resolveBackendPort/ensurePackagedSettings + startBackend/stopBackend + notifyBackendError/Ready/showBackendErrorDialog + waitForBackendHealth/clearBackendHealthRetry/waitBackendReadyOrRetry + stopBackendForRestore）
- **循环依赖解除**：backend→auth（writeAuthTokenFile/verifyBackendTokenFingerprint/cleanupAuthTokenFile），auth 无反向依赖（reportBackendAuthFailure 已在 E-T5 从 auth 迁来本模块）——依赖图单向无环
- main.js：删除 18 函数 + 注入 require + 死导入清理（sendToAppWindows/broadcast/notifyBackendError/showBackendErrorDialog/clearBackendHealthRetry/reportBackendAuthFailure 只被 backend 内部用，main 只留实际用到的 12 个）
- 验证：node --check 六文件 ✅ + mock 装载 backend.js（18 导出齐全）✅ + mock 装载 main.js ✅ + 死导入审计（count=1 逐个核对注释 vs 代码）✅

### E-T7 backup ✅（2026-08-13，最大块）
- 拆出 `modules/backup.js`（2208 行）：45 个数据持久化函数（导出载荷构建 fetchExportPayload/buildExportPayload/fetchExistingIds + 简历快照 resume 族 + CSV + 导入合并 mergeImportedSettings + 备份/轮转/快照 snapshot*/autoBackup/rotateAutoBackups + manifest/sha256 校验 + zip 三函数 + 恢复 restoreBackupDir/restoreSettingsSafely + 备份列表缓存 cachedBackupChecksumOk + 外部链接白名单 allowlist 族）+ zlib/MAX_ZIP/BACKUP_CHK_CACHE_MAX 常量
- **提取方式**：自研「正则感知词法器」脚本精确提取（处理字符串/模板/注释/正则；关键修复：JS 单双引号**仅限单行**，避免 `return /[",\r\n]/` 里被误判的 `"` 跨行吞字符）→ 生成 backup.js + 从 main.js 删除 47 块
- main.js：1909 行（净减 ~2100）；注入 require（35 个实际用到的函数）
- 验证：node --check 七文件 ✅ + mock 装载 backup.js（45 导出齐全）✅ + **依赖覆盖审计**（backup.js 用到的每个 constants/backend/utils 导出都有 require 覆盖）✅ + grep 死导入审计（35 导入全部在代码使用）✅ + mock 装载 main.js ✅
- ⚠️ **关键经验**：
  1. **大块搬移用「词法器提取脚本」而非手工 Edit**：花括号匹配必须跳过字符串/模板/注释/正则；**引号按 JS 语义仅限单行**（模板才可跨行），否则正则里被误判的引号会跨行吞掉整个文件
  2. **模块自身声明 vs 提取块重复**：header 里的常量（zlib/MAX_ZIP/BACKUP_CHK_CACHE_MAX）与提取块重复声明 → 提取后需去重
  3. **dead import 审计用 grep 不用 node 正则**：`new RegExp("\\b"+n+"\\b")` 在 node -e 里被 bash 转义干扰失效，grep 可靠

### E-T8 壳化 + IPC + 打包配置 ✅（2026-08-13，代码部分）
- main.js 已是「壳 + IPC 装配」结构：createWindow + 26 个 guardedHandle IPC 处理器 + app 生命周期 + 后端请求校验 + CSP
- **打包配置修复（关键）**：`package.json` 的 `files` 白名单新增 `"modules/**/*.js"` —— 否则拆出的 6 个模块打不进安装包，运行时报 `Cannot find module './modules/xxx'`
- **死导入清理**：main.js 精简 import 块（utils 8→5、constants 59→23、backend 12→10），脚本审计确认 0 死导入
- 验证：node --check 七文件 ✅ + mock-electron 全量装载 main.js（含 6 模块）✅ + 依赖图无环（main→backup→backend→auth→constants/state/utils）✅
- ⚠️ **关键经验**：
  1. **electron-builder 的 files 白名单不会自动包含新增子目录**：拆分后必须手动加 `modules/**/*.js`
  2. **electron-builder 的 files glob 不支持越出 app 目录的 `../`**（`../frontend/dist/**/*` 被静默忽略 → asar 无 UI）
  3. 拆分后 main.js 从 5198 → 1903 行，6 个模块共 3617 行；总行数略增（模块头/导出）但组织清晰

### 打包配置修复（2026-08-13，同 E-T8 一并完成）
- **根因**：electron-builder 26.15.3 的 files glob 不支持 `../`（越出 app 目录）→ 打包态 asar 无 UI（白屏）；且 files 无 `modules/**/*.js` → 拆分模块打不进包
- **修复**（两处配置 + 一个钩子）：
  1. `package.json` build.files 与 `packaging/electron-builder.yml` files 均加 `"modules/**/*.js"`
  2. files 的 `"../frontend/dist/**/*"` → `"frontend/dist/**/*"`（应用内路径）
  3. `scripts/verify-prepack.cjs`（beforePack 钩子）新增 `syncFrontendDist()`：门禁通过后把 `code/frontend/dist` 同步到 `code/electron/frontend/dist`（先清后拷）
- **验证**：`npx electron-builder --config ../packaging/electron-builder.yml --dir` 产物 asar 10/10 关键文件确认（main/preload/endpoint-whitelist + frontend/dist/index.html + 6 modules）
- ⚠️ **注意**：后端 exe（`backend/dist/bossjob-backend/`）尚未产出，完整规范打包需先 PyInstaller 构建后端（packaging/BUILD.md §4）；后端缺失时 extraResources 报错，冒烟可先验证 UI + 主进程 + 模块加载
- ⚠️ **注释坑**：脚本块注释内不能写含 `*/` 序列的字面量（如 glob `**/*` 的 `*/` 会提前闭合块注释 → 语法错误），本次已踩坑
- 🔜 **待用户操作（最终门禁）**：完整打包冒烟（先构建后端 exe）→ 启动安装包验证 UI + 功能正常

## 三、剩余模块边界 + 风险

| 模块 | 函数（main.js 内） | 依赖/风险 |
|------|-------------------|----------|
| `modules/constants.js` | ~40 常量（路径/端口/SQLite 偏移/备份前缀/超时）| 被所有模块 require；**单一事实源**（防漂移）|
| `modules/state.js` | authToken/authTokenFingerprint/appWindowWebContentsIds | 共享可变状态；**getter/setter 或对象** |
| `modules/auth.js` | newToken/loadOrCreateAuthToken/writeAuthTokenFile/cleanupAuthTokenFile/armAuthTokenFileTtlCleanup/verifyBackendTokenFingerprint/reportBackendAuthFailure/restrictTokenFileAcl | 🔴 安全关键；httpRequest 用 authToken |
| `modules/backend.js` | isValidPort/getSettingsPath/resolveBackendPort/ensurePackagedSettings/startBackend/stopBackend/notifyBackend*/waitForBackendHealth/showBackendErrorDialog | 依赖 auth（verifyFingerprint）+ state |
| `modules/backup.js` | backupSortKey/fetchExportPayload/buildExportPayload/writeResume*/applicationsToCsv/readLatestBackupExport/backup*/restore*/zip/manifest/snapshot 等（最大块 ~2800 行）| 依赖 backend（stopBackendForRestore）+ state |
| `main.js` 壳 | createWindow + guardedHandle + 各 IPC handler + app 生命周期 | 装配全部模块 |

### 三大风险（务必优先处理）
1. **共享常量（~40）**：先抽 `constants.js`，各模块 require（避免复制导致漂移）
2. **共享状态（authToken/appWindowWebContentsIds）**：先抽 `state.js`，函数内 `authToken` → `state.authToken`（全局替换）
3. **循环依赖**（backup→backend→auth）：用 `state.js` + 事件解耦（backend 的 stopBackendForRestore 经 state/回调注入）

## 四、剩余施工图（E-T3 → E-T8）

| Task | 内容 | 验证 |
|------|------|------|
| E-T3 | 拆 constants.js（~40 常量）| node --check + require 链 |
| E-T4 | 拆 state.js（共享状态）+ utils 收尾 | node --check |
| E-T5 | 拆 auth.js（安全关键，谨慎）| node --check + 人工复核令牌逻辑 |
| E-T6 | 拆 backend.js | node --check + require 链 |
| E-T7 | 拆 backup.js（最大块）| node --check |
| E-T8 | main.js 壳化 + IPC 装配 | node --check + **用户打包启动冒烟** |

**每步 4 轮审核**（完成度/回归/隐蔽/质量）+ 证据单落盘 `temp/fixloop_evidence/electron_split.md`

## 五、验证方式

- **可自动**：`node --check main.js` + `node --check modules/*.js`（语法）；require 链逻辑检查（mock electron）
- **需用户**：`electron .` 启动 + electron-builder 打包冒烟（拆分是否正确的最可靠验证）

## 六、重要提醒

- 拆分是**纯文件重组**（函数逻辑逐字保留），禁止顺手"优化"逻辑（避免引入回归）
- `authToken`/`appWindowWebContentsIds` 等共享状态迁移是最大易错点
- 打包 `package.json` 的 `files` 需确认含 `modules/`
