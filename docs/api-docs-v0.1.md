# BossJobAI 求职投递助手 — 接口文档 v0.1

> 版本：v0.1.2（覆盖 CHANGELOG 0.1.1–0.1.7，含离线导出 / 备份归档等后续能力）
> 适用：所有依赖本系统接口的模块（前端页面、Electron 主进程、后续 P1–P7 功能）
> 维护：每次接口变更必须同步本文件并 bump 版本；禁止凭记忆改动后不更新文档

---

## 📑 目录

- [1. 架构总览](#1-架构总览)
  - [1.1 三层架构](#11-三层架构)
  - [1.2 请求链路](#12-请求链路)
  - [1.3 端口与常量](#13-端口与常量)
- [2. 鉴权模型](#2-鉴权模型)
  - [2.1 全局 Bearer 令牌](#21-全局-bearer-令牌)
  - [2.2 令牌传递通道](#22-令牌传递通道)
  - [2.3 Host / Origin 校验](#23-host--origin-校验)
- [3. 后端 HTTP API](#3-后端-http-api)
  - [3.0 接口索引表](#30-接口索引表)
  - [3.1 GET /api/health](#31-get-apihealth)
  - [3.2 GET /api/settings](#32-get-apisettings)
  - [3.3 PUT /api/settings](#33-put-apisettings)
  - [3.4 GET /api/applications](#34-get-apiapplications)
  - [3.5 GET /api/applications/ids](#35-get-apiapplicationsids)
  - [3.6 POST /api/applications](#36-post-apiapplications)
  - [3.7 PATCH /api/applications/{id}](#37-patch-apiapplicationsid)
  - [3.8 DELETE /api/applications/{id}](#38-delete-apiapplicationsid)
  - [3.9 GET /api/applications/{id}/logs](#39-get-apiapplicationsidlogs)
  - [3.10 GET /api/stats](#310-get-apistats)
  - [3.11 GET /api/export](#311-get-apiexport)
  - [3.12 POST /api/import](#312-post-apiimport)
  - [3.13 通用错误响应](#313-通用错误响应)
- [4. Electron IPC 接口](#4-electron-ipc-接口)
  - [4.0 IPC 索引表](#40-ipc-索引表)
  - [4.1 引导与状态](#41-引导与状态)
  - [4.2 后端代理](#42-后端代理)
  - [4.3 外部链接](#43-外部链接)
  - [4.4 数据导出](#44-数据导出)
  - [4.5 数据导入](#45-数据导入)
  - [4.6 备份与恢复](#46-备份与恢复)
  - [4.7 简历](#47-简历)
- [5. 数据模型](#5-数据模型)
  - [5.1 applications 表](#51-applications-表)
  - [5.2 apply_logs 表](#52-apply_logs-表)
  - [5.3 schema 版本迁移](#53-schema-版本迁移)
- [6. 配置项](#6-配置项)
- [7. 安全基线](#7-安全基线)
- [8. 修订记录](#8-修订记录)

---

## 1. 架构总览

### 1.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│  前端层  React + TS + Antd (Vite)                       │
│  src/pages/  工作台/简历/投递记录/投递登记/面试登记/看板/设置 │
│  仅通过 window.api (preload) 与主进程通信                 │
└──────────────────────┬──────────────────────────────────┘
                       │ IPC (contextIsolation + sandbox)
┌──────────────────────▼──────────────────────────────────┐
│  Electron 主进程层  main.js + preload.js                 │
│  26 个 guardedHandle IPC 通道                           │
│  职责：后端进程管理 / Bearer 附加 / 文件对话框 / 备份快照   │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (Bearer Token)
┌──────────────────────▼──────────────────────────────────┐
│  后端层  FastAPI + SQLAlchemy + SQLite                  │
│  12 个 REST 接口 / 全局 require_auth / Host+Origin 校验   │
└─────────────────────────────────────────────────────────┘
```

### 1.2 请求链路

- **渲染进程** → 不直接访问后端 HTTP，一律经 `window.api.backendRequest` 走主进程代理（主进程附加 Bearer 令牌）。
- **主进程** → `http://127.0.0.1:{port}/api/*`，令牌从 `safeStorage` 持久化的 `AUTH_TOKEN` 读取。
- **后端** → 全局 `require_auth` 依赖校验 `Authorization: Bearer <token>`；`Host` 校验拒绝非本机请求（防 DNS rebinding）；CORS 白名单仅 `app://` + `localhost`。

### 1.3 端口与常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_PORT` | 8675 | settings.json 缺失时的兜底端口 |
| `PORT_MIN` / `PORT_MAX` | 1024 / 65535 | 端口合法区间 |
| `APP_VERSION` | 0.1.7 | 与 electron/frontend package.json 三处同步 |
| 前端 Vite dev | 127.0.0.1:5173 | 开发模式 electron 加载地址 |

---

## 2. 鉴权模型

### 2.1 全局 Bearer 令牌

- 所有 `/api/*` 端点强制 `Authorization: Bearer <token>`，缺失/错误返回 **401**。
- 令牌由 Electron 主进程首启 `crypto.randomBytes(32)` 生成，经 `safeStorage` 持久化，重启复用。
- **FAIL-OPEN 熔断**：后端未载入令牌时 `require_auth` 放行并打印告警（仅限开发者裸跑 uvicorn 场景）；Electron 正常启动路径令牌必注入。

### 2.2 令牌传递通道

- **首选**：`BOSS_AUTH_TOKEN_FILE` 指向一次性令牌文件（写入数据目录、后端读后即删）——令牌不进子进程环境块，防同用户进程读取。
- **兜底**：`BOSS_AUTH_TOKEN` 环境变量（旧版/令牌文件不可写时）。

### 2.3 Host / Origin 校验

- **Host 校验**（最外层中间件）：拒绝非 `127.0.0.1` / `localhost` Host 头请求（防 DNS rebinding）。
- **Origin 校验**：拒绝带非本地 Origin 的跨源请求（`app://` + `localhost` 白名单），与 CORS 双层防线。

---

## 3. 后端 HTTP API

### 3.0 接口索引表

| # | 方法 | 路径 | 说明 | 分页 | 鉴权 |
|---|------|------|------|------|------|
| 1 | GET | `/api/health` | 探活 + 版本 + 令牌指纹 | - | 否（探测用） |
| 2 | GET | `/api/settings` | 读取配置快照（脱敏） | - | ✅ |
| 3 | PUT | `/api/settings` | 保存配置（合并公开字段） | - | ✅ |
| 4 | GET | `/api/applications` | 投递记录分页查询 | ✅ | ✅ |
| 5 | GET | `/api/applications/ids` | 全部记录 id（导入覆盖预览用） | - | ✅ |
| 6 | POST | `/api/applications` | 新增投递记录 | - | ✅ |
| 7 | PATCH | `/api/applications/{id}` | 更新投递记录（部分字段） | - | ✅ |
| 8 | DELETE | `/api/applications/{id}` | 删除投递记录（级联日志） | - | ✅ |
| 9 | GET | `/api/applications/{id}/logs` | 单条记录操作日志时间线 | - | ✅ |
| 10 | GET | `/api/stats` | 看板统计 | - | ✅ |
| 11 | GET | `/api/export` | 全量导出 JSON（隐私剔除） | - | ✅ |
| 12 | POST | `/api/import` | 全量导入 JSON（id 覆盖/新建） | - | ✅ |

**公共请求头**：`Authorization: Bearer <token>`；`Content-Type: application/json`（写操作）。

### 3.1 GET /api/health

探活接口：Electron 主进程据此判断后端就绪，并校验鉴权令牌指纹（检测 FAIL-OPEN）。

**响应 200**：

```json
{
  "status": "ok",
  "version": "0.1.7",
  "auth_token_fingerprint": "a1b2c3d4e5f60718"   // 令牌 SHA-256 前 16 hex；未载入为 null
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | 固定 `ok` |
| version | string | 后端版本（APP_VERSION） |
| auth_token_fingerprint | string \| null | 令牌指纹；null = 后端未载入令牌（FAIL-OPEN 风险） |

### 3.2 GET /api/settings

读取当前生效配置快照（与 settings.json / env 合并后），**剔除敏感字段**（api_key 绝不返回）。

**响应 200**：

```json
{
  "port": 8675,
  "llm": { "provider": "deepseek", "model": "deepseek-chat", "base_url": "" },
  "apply": { "daily_limit": 15, "interval_seconds": [45, 120], "halt_on_risk": true },
  "browser": { "user_data_dir": "", "headless": false },
  "blacklist": { "companies": [], "keywords": ["外包", "猎头", "培训"] },
  "security": { "external_url_hosts": [] },
  "cities": ["北京", "上海"]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| port | int | 后端监听端口（1024–65535） |
| llm.provider | string | 模型服务商 |
| llm.model | string | 模型名 |
| llm.base_url | string | OpenAI 兼容接口地址（空 = 默认端点） |
| apply.daily_limit | int | 每日投递上限（1–500） |
| apply.interval_seconds | int[] | 投递间隔区间（每项 1–3600，非空） |
| apply.halt_on_risk | bool | 风险触发时暂停投递 |
| browser.user_data_dir | string | 浏览器用户数据目录 |
| browser.headless | bool | 无头模式 |
| blacklist.companies | string[] | 屏蔽公司 |
| blacklist.keywords | string[] | 屏蔽关键词 |
| security.external_url_hosts | string[] | 外链宿主白名单 |
| cities | string[] | 目标城市列表 |

### 3.3 PUT /api/settings

保存配置：合并公开字段（保留 api_key / port）→ 写入 settings.json → 刷新生效值。

**请求体**：与 GET 响应同构的公开快照（不含 api_key / port，多余字段 pydantic 忽略）。

**校验**：
- 非法字段 → **422**（Settings 模型 ValidationError）
- `llm.base_url`：非空须 https（本地回环允许 http）+ 宿主命中白名单 + 无 userinfo → 违反 **400**
- `security.external_url_hosts`：每项须合法域名后缀（无协议/端口/路径，去首尾点后 ≥2 段）→ 违反 **400**

**响应 200**：与 GET /api/settings 同构（保存后最新快照）。

### 3.4 GET /api/applications

投递记录分页查询，支持状态/关键词/日期筛选。

**Query 参数**：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| page | int | 1 | 页码（≥1） |
| page_size | int | 20 | 每页条数（1–100） |
| status | string | - | 状态筛选（pending/replied/interview/offer/rejected/closed） |
| keyword | string | - | 职位/公司/城市模糊搜索（LIKE，通配符转义） |
| date | string | - | 按日筛选 `YYYY-MM-DD`（看板趋势柱下钻） |
| date_from | string | - | 日期区间起 `YYYY-MM-DD`（含当日） |
| date_to | string | - | 日期区间止 `YYYY-MM-DD`（含当日） |

**响应 200**：

```json
{
  "total": 42,
  "page": 1,
  "page_size": 20,
  "items": [
    {
      "id": 1,
      "job_title": "前端工程师",
      "company": "示例公司",
      "city": "北京",
      "salary": "20-30K",
      "url": "https://www.zhipin.com/job/xxx.html",
      "status": "pending",
      "note": "备注",
      "applied_at": "2024-05-01 10:00:00",
      "updated_at": "2024-05-01 10:00:00"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| applied_at | string \| null | 投递时间（NULL = 未设置） |
| updated_at | string | 修改时间 |
| status | string | 状态枚举，见下表 |

**状态枚举**：`pending`(待反馈) / `replied`(已回复) / `interview`(面试中) / `offer`(Offer) / `rejected`(被拒) / `closed`(已关闭)

### 3.5 GET /api/applications/ids

返回全部投递记录 id 列表（供导入前覆盖预览统计，避免拉整份大导出）。

**响应 200**：`[1, 2, 3, 4, 5]`（int 数组）

### 3.6 POST /api/applications

新增投递记录。

**请求体**：

```json
{
  "job_title": "前端工程师",
  "company": "示例公司",
  "city": "北京",
  "salary": "20-30K",
  "url": "https://www.zhipin.com/job/xxx.html",
  "status": "pending",
  "note": "备注",
  "applied_at": "2024-05-01T10:00:00"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| job_title | string | ✅ | 职位（strip 后非空，1–255） |
| company | string | ✅ | 公司（strip 后非空，1–255） |
| city / salary / url / note | string | - | 可选；url 仅 http/https 且含主机名 |
| status | string | - | 默认 `pending`，须在枚举内 |
| applied_at | datetime | - | 缺省取当前时间（秒精度）；显式 null 不适用（POST 无清空语义） |

**校验失败**：**400**（职位/公司空、非法状态、url scheme 非法）；**422**（pydantic 类型/长度）。

**响应 201**：完整 ApplicationItem（含自增 id）。

### 3.7 PATCH /api/applications/{id}

更新投递记录，仅覆盖传入字段（`exclude_unset`）。

**请求体**：与 POST 同构，全部字段可选。

**特殊语义**：
- `applied_at: null` → **存 NULL**（清空 = 未设置），非落今天。
- `status: null` → 保留原值（不报错）。
- `job_title` / `company` → strip 后判空（拒绝纯空格）。
- 零变更（所有字段值与现值相同）→ 不写 apply_log。

**响应 200**：完整 ApplicationItem。
**404**：id 不存在。

### 3.8 DELETE /api/applications/{id}

删除投递记录，级联清理其 apply_logs。

**响应 200**：`{"deleted": <id>}`。
**404**：id 不存在。

### 3.9 GET /api/applications/{id}/logs

单条投递记录的操作日志时间线（登记 / 状态变更 / 字段更新），按 id 倒序。

**响应 200**：

```json
{
  "application_id": 1,
  "items": [
    { "id": 3, "action": "status", "detail": "状态变更：pending → interview", "created_at": "2024-05-02 09:00:00" },
    { "id": 1, "action": "apply", "detail": "登记投递：示例公司 · 前端工程师", "created_at": "2024-05-01 10:00:00" }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| action | string | `apply`(登记) / `status`(状态变更) / `update`(字段更新) |
| detail | string | 变更明细 |
| created_at | datetime | 日志时间 |

**404**：id 不存在。

### 3.10 GET /api/stats

看板统计：累计投递 / 进行中 / Offer / 被拒 / 通过率 / 近 30 天趋势。

**响应 200**：

```json
{
  "total": 42,
  "applying": 15,
  "offer_count": 3,
  "rejected": 8,
  "pass_rate": 0.0714,
  "daily_trend": [
    { "date": "2024-04-02", "count": 0 },
    { "date": "2024-04-03", "count": 2 }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| total | int | 累计投递 |
| applying | int | 进行中（pending/replied/interview） |
| offer_count | int | Offer 数 |
| rejected | int | 被拒 + 关闭数 |
| pass_rate | float | Offer / 累计投递 |
| daily_trend | DailyTrendItem[] | 近 30 天每日投递数（无投递补 0） |

### 3.11 GET /api/export

全量导出业务数据为 JSON（隐私优先，敏感字段剔除）。前端经 Electron「另存为」落盘。

**响应 200**：

```json
{
  "exported_at": "2024-05-01 10:00:00",
  "settings": { "...": "public_dump 脱敏快照，同 GET /api/settings" },
  "applications": [ { "...": "同 ApplicationItem" } ],
  "apply_logs": [ { "id": 1, "application_id": 1, "action": "apply", "detail": "...", "created_at": "..." } ]
}
```

### 3.12 POST /api/import

全量导入导出 JSON（按 id 覆盖已有、新建缺失，apply_logs 一并恢复）。

**请求体**：与 GET /api/export 响应同构（`applications` + `apply_logs` + 可选 `settings`/`resume`）。

**容错设计**（逐行）：
- `applications` / `apply_logs` 为 `list[object]`：单条非对象/坏行计入 skipped，不整批 422。
- job_title/company：仅**新建**分支强制非空（空行跳过）；**更新**分支 preserve-if-empty（缺省保留已有）。
- `applied_at`：合法日期用解析值；显式 null / 非法值存 NULL（未设置）；更新分支仅显式 null 或解析成功才写。
- `url`：非法 scheme 置空。
- 保留原 id；同批重复 id 不重复插入。
- settings 段经 `mergeImportedSettings` 白名单合并（良性键 cities/apply/browser/blacklist 逐子键迁移）。

**响应 200**：

```json
{ "imported": 42, "created": 30, "updated": 12, "skipped": 2 }
```

| 字段 | 类型 | 说明 |
|------|------|------|
| imported | int | 处理总数（created + updated） |
| created | int | 新增条数 |
| updated | int | 覆盖更新条数 |
| skipped | int | 跳过条数（空行/坏行/非法） |

### 3.13 通用错误响应

FastAPI 默认错误结构：

```json
{ "detail": "错误信息" }
```

| 状态码 | 场景 |
|--------|------|
| 400 | 业务校验失败（非法状态/空标题/url scheme 非法/llm.base_url 越界） |
| 401 | 缺失或错误 Bearer 令牌 |
| 404 | 记录/资源不存在 |
| 422 | pydantic 校验失败（类型/长度/字段非法） |
| 500 | 未捕获异常 |

---

## 4. Electron IPC 接口

### 4.0 IPC 索引表

所有通道经 `guardedHandle` 注册，**校验发送方为应用主窗口**（非白名单发送方返回 `{ok:false, error:'forbidden'}`）。渲染层经 preload `window.api` 调用。

**引导 / 状态**：

| 通道 | 说明 |
|------|------|
| get-bootstrap-info | 一次性获取后端端口（引导唯一通道） |
| get-backend-state | 后端状态快照（reload 后兜底拉取） |
| resume-saved | 保存简历通知主进程写磁盘 |
| get-resume-snapshot | 读取 resume.json 权威快照 |

**后端代理**：

| 通道 | 说明 |
|------|------|
| backend-request | 渲染层访问 /api/* 的唯一鉴权通道（主进程附加 Bearer） |

**外部链接**：

| 通道 | 说明 |
|------|------|
| get-external-url-schemes | scheme 白名单（http/https） |
| open-external | 系统浏览器打开链接（仅白名单 scheme + 宿主） |
| reload-external-allowlist | 刷新外链宿主白名单缓存 |

**数据导出**：

| 通道 | 说明 |
|------|------|
| export-data | 全量导出 JSON（另存为） |
| preview-export-data | 导出内容预览（不落盘） |
| export-data-csv | 导出 CSV（支持筛选） |
| export-data-offline | 离线导出（读备份库，后端不可达降级） |
| preview-export-data-offline | 离线导出预览 |

**数据导入**：

| 通道 | 说明 |
|------|------|
| preview-import-data | 选择文件 + 校验 + 覆盖预览（信任路径 10min TTL） |
| import-data | 真正落库（信任路径成功后才消费） |

**备份 / 恢复**：

| 通道 | 说明 |
|------|------|
| backup-data | 手动备份（另存为目录） |
| backup-now | 立即备份（应用内可见） |
| open-backup-dir | 打开备份目录 |
| list-backups | 枚举备份（含 checksumOk/hasResume） |
| preview-backup | 预览单个备份内容 |
| delete-backup | 删除备份 |
| restore-data | 恢复备份（破坏性覆盖 + 前置快照） |
| get-backup-info | 备份健康状态 + 配置 |
| update-backup-settings | 修改自动备份配置 |
| export-backup-archive | 导出便携备份 zip |
| import-backup-archive | 导入便携备份 zip |

### 4.1 引导与状态

**`get-bootstrap-info`** → `{ port: number }`
**`get-backend-state`** → `{ status: 'ok' | 'error' | 'restarting', version?: string }`
**`resume-saved(resume: object | null)`** → `{ ok: boolean, error?: string }`
**`get-resume-snapshot`** → `{ ok: boolean, resume?: Record<string,unknown>, error?: string }`

### 4.2 后端代理

**`backend-request(req: { method: string; path: string; body?: string })`** → `{ ok: boolean, status: number, body: string | null }`

- `path` 须命中主进程端点白名单（见 `endpoint-whitelist.cjs`）。
- 主进程附加 `Authorization: Bearer`；`status 0` = 后端不可达。
- 渲染层访问 `/api/*` 的**唯一**鉴权通道。

### 4.3 外部链接

**`get-external-url-schemes`** → `["http:", "https:"]`
**`open-external(url: string)`** → `{ ok: boolean, error?: string }`（拒绝非 http/https 及白名单外宿主）
**`reload-external-allowlist`** → `{ ok: boolean }`

### 4.4 数据导出

**`export-data()`** → `{ canceled, ok, path?, error? }`
**`preview-export-data()`** → `{ ok, payload?, error? }`（payload = 脱敏全量载荷）
**`export-data-csv(filter?: { status?, keyword?, date?, date_from?, date_to? })`** → `{ canceled, ok, path?, error? }`
**`export-data-offline(opts?: { format?, status?, keyword?, date?, date_from?, date_to? })`** → `{ canceled, ok, path?, backupName?, error? }`
**`preview-export-data-offline()`** → `{ ok, payload?, backupName?, error? }`

### 4.5 数据导入

**`preview-import-data()`** → `{ canceled, ok, path?, preview?, error? }`

```json
preview = { "applications": 42, "applyLogs": 10, "hasSettings": true, "overwriteIds": 3 }
```

**`import-data(path?: string)`** → `{ canceled, ok, path?, importedCount, updatedCount, skippedCount, settingsStatus?, resumeStatus?, error? }`

- `settingsStatus`：`restored` / `retained_credentials_stripped` / `parse_failed` / `missing`
- `resumeStatus`：`restored` / `missing` / `write_failed`

### 4.6 备份与恢复

**`backup-data()`** → `{ canceled, ok, path?, error? }`（另存为目录）
**`backup-now()`** → `{ ok, name, path?, error? }`（自动备份目录）
**`open-backup-dir()`** → `{ ok, error? }`
**`list-backups()`** → `Array<{ name, path, createdAt, sizeBytes, fileCount, hasResume, checksumOk }>`
**`preview-backup(name)`** → `{ ok, appCount, latestRecordAt, schemaVersion, hasSettings, settingsStatus, hasResume, resumeSummary?, checksumOk?, samples?, error? }`
**`delete-backup(name)`** → `{ ok, error? }`
**`restore-data(opts?: { includeSettings?, dir? })`** → `{ canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, error? }`

> `restore-data` 会停后端 → 覆盖 app.db → 重启；`preRestoreSnapshot` 为覆盖前自动快照（可回滚点）。

**`get-backup-info()`** → `{ backupDir, lastBackupAt, totalBackups, maxBackups, autoBackupEnabled, intervalMinutes }`
**`update-backup-settings(cfg: { maxBackups?, autoBackupEnabled?, intervalMinutes? })`** → `{ ok, settings?, error? }`
**`export-backup-archive(opts?: { dir? })`** → `{ canceled, ok, path?, name?, error? }`
**`import-backup-archive()`** → `{ canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, importedBackupName?, error? }`

### 4.7 简历

| 通道 | 说明 |
|------|------|
| `get-resume-snapshot` | 读取数据目录 resume.json 权威快照（恢复/导入后回灌） |
| `resume-saved` | ResumePage 保存时通知主进程写磁盘副本 |

---

## 5. 数据模型

### 5.1 applications 表

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | INTEGER | PK AUTOINCREMENT | 主键 |
| job_title | VARCHAR(255) | NOT NULL | 职位 |
| company | VARCHAR(255) | NOT NULL | 公司 |
| city | VARCHAR(64) | NOT NULL 默认 '' | 城市 |
| salary | VARCHAR(128) | NOT NULL 默认 '' | 薪资 |
| url | TEXT | NOT NULL 默认 '' | 职位链接 |
| status | VARCHAR(32) | NOT NULL 默认 'pending' **索引** | 状态枚举 |
| note | TEXT | NOT NULL 默认 '' | 备注 |
| applied_at | DATETIME | **NULL 允许** **索引** | 投递时间（NULL=未设置） |
| updated_at | DATETIME | NOT NULL | 修改时间 |

### 5.2 apply_logs 表

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| id | INTEGER | PK AUTOINCREMENT | 主键 |
| application_id | INTEGER | FK → applications.id **索引** | 所属投递 |
| action | VARCHAR(32) | NOT NULL 默认 'apply' | 动作类型 |
| detail | TEXT | NOT NULL 默认 '' | 明细 |
| created_at | DATETIME | NOT NULL | 日志时间 |

### 5.3 schema 版本迁移

`user_version` PRAGMA 管理，`backend/app/db.py` `DB_SCHEMA_VERSION` = **3**：

| 版本 | 变更 | 迁移方式 |
|------|------|---------|
| 1 | 初始 schema | - |
| 2 | applied_at NOT NULL → NULL（未设置语义） | 重建表（RENAME→CREATE→COPY→DROP） |
| 3 | applied_at 建索引 + status 索引 | 增量 CREATE INDEX |

> 主进程 `electron/main.js` `DB_SCHEMA_VERSION` 必须与后端同步；恢复备份时仅拒绝**高于**当前版本的备份（旧版备份复制后 init_db 自动迁移）。

---

## 6. 配置项

配置文件 `settings.json`（项目根）。结构见 §3.2 GET /api/settings 响应。环境变量覆盖：`BOSS_` 前缀 + `__` 嵌套分隔符（如 `BOSS_LLM__PROVIDER`）。

| 顶层键 | 说明 | 来源 |
|--------|------|------|
| port | 监听端口 | settings.json 必读（env `BOSS_PORT` 覆盖） |
| llm | LLM 配置（api_key 落盘为 DPAPI 密文） | ComingSoon（P3-P5 启用） |
| apply | 投递合规限速 | P4 自动投递使用 |
| browser | 浏览器 Profile | P4 自动投递使用 |
| blacklist | 屏蔽公司/关键词 | 自动投递过滤 |
| security | 外链宿主白名单 | 防钓鱼域名 |
| cities | 目标城市 | 自动投递定位 |
| backup | 自动备份配置（maxBackups/autoBackupEnabled/intervalMinutes） | Electron 管理 |

---

## 7. 安全基线

| 项 | 措施 |
|----|------|
| 全局鉴权 | 所有 /api/* 强制 Bearer 令牌（fail-closed） |
| 令牌传递 | 一次性令牌文件（不进环境块）；safeStorage 持久化 |
| DNS rebinding | Host 校验拒绝非本机 |
| 跨源 | CORS 白名单仅 app:// + localhost；Origin 校验 403 |
| CSP | script-src 'self'（verify-csp.mjs 断言） |
| 渲染进程 | contextIsolation + sandbox + nodeIntegration=false |
| 外链 | open-external 仅 http/https + 宿主白名单 |
| LLM 凭据 | api_key DPAPI 加密；base_url 提供商白名单 |
| 导入 | 文件路径信任 TTL；逐行容错；settings 白名单合并 |
| 备份恢复 | checksum 校验 + 路径穿越封堵 + 破坏性覆盖前置快照 |
| 密钥 | 禁止硬编码（扫描验证通过） |

---

## 8. 修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.1.2 | 2026-08-13 | 版本同步至 0.1.7（APP_VERSION / 健康检查示例）；覆盖范围扩展至 CHANGELOG 0.1.7 |
| v0.1.1 | 2026-08-13 | 版本同步至 0.1.6（APP_VERSION / 健康检查示例）；覆盖范围扩展至 CHANGELOG 0.1.6（离线导出、备份归档、自动备份配置等能力说明） |
| v0.1.0 | 2026-08-06 | 初始版：12 个 HTTP 接口 + 26 个 IPC 通道 + 数据模型 + 鉴权/安全基线（对齐 P0 骨架加固 0.1.1–0.1.4） |
