# BossJobAI 求职投递助手（BOSS直聘 AI 求职助手）· 手动记录管理版 v0.1

> **当前为手动记录管理版（v0.1）**：一个面向非技术背景求职者的 **Electron 桌面应用**，简历 / 投递记录均在本地维护（简历为本地表单录入、投递为人工登记改状态），尚未接入 BOSS 直聘线上操作。
>
> 已落地：工作台 / 简历 / 投递记录 / 投递登记 / 面试登记 / 求职看板 / 设置 七大页面，投递记录全量 CRUD + 筛选 + 批量改状态，导出（JSON/CSV/离线）/ 导入（文件/粘贴）/ 备份恢复（zip 四件套 + checksum 校验），详见 **§7 已实现功能清单**。
>
> 简历解析 / 优化 → JD 匹配 → 打招呼语生成 → 人类确认后自动投递 → 模拟面试 等 **AI 能力处于 P1–P7 规划阶段、尚未上线**（路线详见 §6）。全流程本地化、隐私优先。
>
> 版本 `0.1.6` ｜ 架构文档：`docs/求职投递项目_架构设计_v0.2.md` ｜ 接口文档：`docs/求职投递项目_接口文档_v0.1.md` ｜ 构建指南：`code/packaging/BUILD.md`

## 💛 支持一下

如果这个项目帮到过你，可以请我喝杯咖啡 ☕。打赏全凭心意，不打赏也完全没关系——项目永远免费开源。做开源这么久，每一份小小的支持都能让我高兴很久。

<p align="center">
  <img src="assets/donate_wechat.jpg" alt="微信收款" width="200">
  <img src="assets/donate_alipay.jpg" alt="支付宝收款" width="200">
</p>

<p align="center"><i>能一路读到这里的你，谢谢。🙏</i></p>

---


## 1. 项目概述

- **架构**：Electron 桌面壳 + Python FastAPI 后端 + SQLite，三层进程模型。
  - **Electron 主进程**：窗口管理、生命周期、**spawn 并守护 Python 后端**（崩溃自动重启）。
  - **渲染进程**（React + TS）：全部 UI，经 preload 桥接与主进程 IPC，经 HTTP 访问后端。
  - **Python 后端**（FastAPI）：AI 决策、数据存储、后续自动化控制，仅监听 `127.0.0.1`。
- **核心原则**：隐私本地化（数据全存本地 SQLite）、人类把关（每次投递需人工确认）、合规限速（日限 15、随机间隔）、模块化（决策层与浏览器执行层解耦）、中文优先（DeepSeek/Qwen）。
- **安全基线（架构 v0.2）**：`contextIsolation=true`、`nodeIntegration=false`，渲染进程仅经 `preload.js` 暴露的最小 API 面与主进程通信；API key 不出后端、不进 `GET /api/settings` 响应。
- **数据导出/备份/迁移**：「数据」页提供『导出数据』（JSON，导出前可『预览导出内容』确认文件实际包含什么）、『导出备份归档(.zip)』（把自动备份最新一份打包为单一 .zip，含 app.db + settings.json + 简历快照 + manifest 四件套）与『导入备份归档(.zip)』（解压后按与应用内恢复同一安全口径落库并重启后端），实现跨机器 / 移动介质的一键数据迁移；恢复前『预览』可查看备份内记录样本与简历摘要（姓名/联系方式），多版简历场景下可据此区分备份。

## 2. P0 骨架结构

```
code/
├── settings.template.json     # 运行配置模板（复制为 settings.json；端口/LLM/投递/浏览器/黑名单/城市）
├── backend/                      # Python FastAPI 后端
│   ├── app/
│   │   ├── main.py               # 应用入口（全局 Bearer 鉴权、Host/Origin 校验、CORS、生命周期、路由注册）
│   │   ├── config.py             # 配置加载（env > settings.json > 默认值，敏感字段屏蔽 / api_key DPAPI 加密）
│   │   ├── constants.py          # 常量：路径/版本/端口区间/CORS 白名单（禁止硬编码）
│   │   ├── db.py                 # SQLAlchemy engine / SessionLocal / init_db + schema v1→v3 迁移
│   │   ├── models.py             # ORM 模型（Application 投递记录 / ApplyLog 操作日志）
│   │   ├── schemas.py            # Pydantic 响应模型（{code,data,message} 规范）
│   │   └── routers/
│   │       ├── health.py         # GET /api/health（含鉴权令牌指纹）
│   │       ├── settings.py       # GET/PUT /api/settings（base_url 白名单 / external_url_hosts 校验）
│   │       └── data.py           # 业务数据路由（投递 CRUD / 看板统计 / 导出 / 导入）
│   ├── data/app.db               # SQLite（自动创建）
│   └── requirements.txt
├── electron/                     # Electron 主进程 + preload
│   ├── main.js                   # 端口解析、后端守护、鉴权令牌注入、窗口、IPC、单实例锁、备份/恢复/导入导出
│   ├── preload.js                # contextBridge 暴露 window.api（最小 API 面）
│   └── package.json
├── frontend/                     # React + TS + Vite + Antd + Zustand
│   ├── vite.config.ts            # base './'，dev 端口 5173（strictPort），CSP 注入
│   └── src/
│       ├── main.tsx / App.tsx    # 入口 + RouterProvider
│       ├── router.tsx            # HashRouter（兼容 file:// 打包态），7 个页面路由
│       ├── pages/                # Dashboard / ResumePage / DataViews(Jobs+Tracker) / ApplyPage / InterviewPage / Settings
│       ├── lib/                  # applyStatus / applyShared / baseUrl / useBackendBase（共享逻辑收敛）
│       └── stores/settingsStore.ts  # Zustand 配置 store（fetch /api/settings）
└── packaging/
    ├── BUILD.md                  # Windows 构建指南
    ├── backend_entry.py          # PyInstaller 后端 exe 启动引导（uvicorn）
    ├── backend.spec              # PyInstaller spec
    └── electron-builder.yml      # electron-builder 配置（NSIS 安装包）
```

**已实现的后端接口**

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | `{"status":"ok","version":"0.1.6","auth_token_fingerprint":"<sha256前16位>"}`，Electron 主进程据此判断后端就绪并校验鉴权令牌指纹 |
| `/api/settings` | GET | 当前生效配置快照（已剔除 `llm.api_key` 等敏感字段） |
| `/api/settings` | PUT | 合并前端回传的公开配置并落盘（`llm.base_url` 施以「https + 已知提供商宿主白名单 + 禁 userinfo」校验；`security.external_url_hosts` 逐项格式校验） |
| `/api/applications` | GET | 投递记录分页查询（status 精确 / keyword 模糊 / date 按日 / date_from..date_to 区间筛选；LIKE 通配符转义） |
| `/api/applications` | POST | 登记一条投递记录（职位/公司 strip 后非空校验，缺省状态 pending，写登记日志） |
| `/api/applications/{id}` | PATCH | 更新投递记录（仅覆盖传入字段；`applied_at:null` 清空为未设置；零变更不写日志） |
| `/api/applications/{id}` | DELETE | 删除投递记录（级联清理 apply_logs） |
| `/api/applications/ids` | GET | 轻量返回全部 id 列表（导入覆盖数预估用） |
| `/api/applications/{id}/logs` | GET | 单条投递记录的操作日志时间线（登记 / 状态变更 / 字段更新） |
| `/api/stats` | GET | 求职看板统计：累计 / 进行中 / Offer / 被拒 / 通过率 + 近 30 天每日趋势 |
| `/api/export` | GET | 导出全部业务数据 JSON（applications + apply_logs + 公开配置快照，敏感字段剔除） |
| `/api/import` | POST | 导入导出 JSON（按 id 覆盖 / 新建，逐行容错，返回 created/updated/skipped 分离计数，apply_logs 按 id 映射恢复） |

## 3. 如何运行（开发模式）

> 端口一律从 `settings.json` / 环境变量 `BOSS_PORT` 读取，代码内禁止硬编码。默认 `8675`。

### 3.1 后端（uvicorn）

```powershell
cd ...\codeackend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8675
```

验证：`curl http://127.0.0.1:8675/api/health` → `{"status":"ok","version":"0.1.6"}`

### 3.2 前端（Vite dev server）

```powershell
cd ...\coderontend
npm install
npm run dev        # http://127.0.0.1:5173（strictPort，端口被占会直接报错）
```

> 浏览器直开 dev server 时 `window.api` 桥接不可用，Dashboard 会优雅降级提示「请通过 Electron 启动」。

### 3.3 Electron 桌面壳（推荐）

```powershell
cd ...\code\electron
npm install
npm start
```

Electron 会自动拉起后端（`python -m uvicorn ...`）、轮询 `/api/health` 就绪后加载 `http://localhost:5173`（开发模式）。后端异常退出最多自动重启 `MAX_BACKEND_RESTARTS` 次；应用退出时优雅关闭后端子进程。

## 4. settings.json 说明

位于 `code/settings.json`；首次设置复制 `code/settings.template.json` 为 `code/settings.json`（缺失时后端首次启动也会自动写入默认配置）。模板自带空城市列表与无凭据——请填入你自己的目标城市与（可选）LLM 提供商密钥。

```jsonc
{
  "port": 8675,                          // 后端 HTTP 监听端口（合法区间 1024~65535）
  "llm": {                               // LLM 接入（OpenAI 兼容接口）
    "provider": "deepseek",
    "api_key": "",                       // 留空；明文 key 仅存本地，严禁入库/外发
    "model": "deepseek-chat",
    "base_url": ""
  },
  "apply": {                             // 投递合规限速
    "daily_limit": 15,                   // 每日投递上限
    "interval_seconds": [45, 120],       // 两次投递的随机间隔区间（秒）
    "halt_on_risk": true                 // 触发风控是否立即暂停
  },
  "browser": {                           // 浏览器执行层（DrissionPage，P4 启用）
    "user_data_dir": "",                 // 独立用户数据目录（留空则用默认）
    "headless": false                    // 非无头模式（真人可视，降低风控）
  },
  "blacklist": {                         // 黑名单：屏蔽公司 / 屏蔽关键词
    "companies": [],
    "keywords": ["外包", "猎头", "培训"]
  },
  "cities": ["广州", "深圳", "远程"]      // 目标城市
}
```

**优先级**：环境变量 `BOSS_PORT`（顶层）、`BOSS_LLM__PROVIDER`（嵌套，`__` 分隔）> `settings.json` > 代码默认值。
**打包模式**：配置文件运行期位于 `%APPDATA%\BossJobAI\settings.json`（Electron 首启从 `resources/settings.json` 复制写入）。

## 5. 构建 / 打包（Windows）

> 完整流程见 `packaging/BUILD.md`。构建顺序：**前端构建 → 后端 PyInstaller → electron-builder**。
> 产物：`code/packaging/release/BossJobAI-Setup-0.1.6.exe`（NSIS 安装包）。

### 5.1 前端构建

```powershell
cd ...\coderontend
npm install
npm run build        # = tsc && vite build → frontend/dist/
```

### 5.2 后端 PyInstaller（需先建好 `backend/.venv` 并安装 `pyinstaller`）

```powershell
cd code\packaging
..\backend\.venv\Scripts\pyinstaller --noconfirm --clean `
  --distpath ..\backend\dist --workpath ..\build\backend backend.spec
```

产物：`code/backend/dist/bossjob-backend/bossjob-backend.exe`（必做冒烟：`curl http://127.0.0.1:8675/api/health`）。

### 5.3 electron-builder 打安装包（需先装 Electron 依赖）

```powershell
cd ...\code\electron
npm install
npx electron-builder --config ..\packaging\electron-builder.yml --win nsis
```

### 5.4 打包链路要点（已在 P0 实现）

- **打包模式**：`electron/main.js` 直接运行 `resources/backend/bossjob-backend.exe`（不 spawn python），加载 asar 内 `frontend/dist/index.html`。
- **可写目录**：`backend/app/constants.py` 按 `sys.frozen` 分支把配置/数据指向 `%APPDATA%/BossJobAI`。
- **版本三处同步**（改版必须一起改）：`backend/app/constants.py` 的 `APP_VERSION` + `electron/package.json` 的 `version` + `frontend/package.json` 的 `version`；启动时交叉校验不一致会告警。

## 6. 下一步（P1–P7 Roadmap）

> 来自架构 v0.2 §13。建议 **P0–P3 先交付**（零风险纯工具价值），P4–P5 单独评估风控后再上线，P6–P7 收尾。

| 阶段 | 里程碑 | 交付物 | 风险 |
|------|--------|--------|------|
| **P0 骨架** ✅ | Electron 壳 + FastAPI 联通 + SQLite | 可运行空壳（前后端 hello） | 🟢 |
| **P1 简历** ✅ P1a | 简历素材库 + RAG（**P1a 已完成**）；解析 PDF/DOCX + 编辑器 + 模板导出 | 简历模块可用 | 🟢 |
| **P2 匹配** | FastEmbed + 关键词 + LLM 打分 + 匹配面板 | 岗位匹配可用 | 🟢 |
| **P3 优化** | STAR/ATS 优化 + 打招呼语生成 | AI 辅助可用 | 🟢 |
| **P4 抓取** | DrissionPage BOSS 登录 + 岗位采集 | 岗位库可用 | 🟡 风控 |
| **P5 投递** | 待确认队列 + 人类确认投递 + 限速 | 投递可用 | 🔴 封号 |
| **P6 面试** | 模拟面试 + 报告 | 面试模块 | 🟢 |
| **P7 看板** | 求职看板 + 统计 + 复盘 | 完整闭环 | 🟢 |

前端路由规划（架构 §4.1）：`/resume` 简历编辑器、`/jobs` 岗位库、`/match/:jobId` 匹配详情、`/apply` 投递控制台、`/interview` 模拟面试、`/tracker` 求职看板、`/settings` 设置。

## 7. 已实现功能清单（手动记录管理版 v0.1）

> 本清单随版本迭代同步（与 CHANGELOG `## [0.1.x]` 版本段对应）。grep 防重复：新增功能仅在确实缺失时补充。

### 7.1 前端模块（7 个页面，侧边栏直达）

| 路由 | 页面 | 已实现能力 |
|------|------|-----------|
| `/` 工作台 | Dashboard | 后端连接状态 + 鉴权令牌指纹校验 + 目标城市 + 快捷入口 |
| `/resume` 简历 | ResumePage | 本地表单录入简历（姓名/电话/邮箱/城市 + 自定字段），保存经主进程落盘 + localStorage 双通道 |
| `/jobs` 投递记录（全部） | JobsPage | 全量 CRUD、状态/关键词/日期区间筛选、批量改状态、导出 CSV/JSON/离线、文件 + 粘贴导入、备份/恢复（checksum + 预览） |
| `/apply` 投递（手动登记） | ApplyPage | 待投递队列、登记/编辑/状态推进、分页（编辑改离筛选时越界 clamp） |
| `/interview` 面试 | InterviewPage | 「面试中」记录视图 + 面试登记（时间/形式/备注），【面试登记】结构化块解析/重建，手写时间只读提示 + 移除 |
| `/tracker` 看板 | TrackerPage | 求职看板统计（累计/进行中/Offer/被拒/通过率）+ 近 30 天每日趋势柱图 |
| `/settings` 设置 | Settings | 城市 / 投递合规限速 / 浏览器 / 黑名单 / 外部链接白名单 编辑与保存；LLM 引擎未接入（ComingSoon 占位，配置可保存） |

### 7.2 数据与备份

- 投递状态枚举：`pending / replied / interview / offer / rejected / closed`（集中定义于 `lib/applyStatus.ts`，三页面统一引用）
- 投递时间支持「留空 = 未设置」语义（NULL），导出→导入往返保真
- 每条记录含操作日志时间线（登记 / 状态变更 / 字段更新，仅真实变化落日志）
- 导出：JSON（导出前可预览实际内容）、CSV、离线导出（应用当前筛选）
- 备份 / 恢复：自动备份 + `.zip` 归档（app.db + settings.json + 简历快照 + manifest 四件套），恢复前校验 manifest checksum + 预览样本，损坏 / 篡改备份可识别
- 导入：文件 + 粘贴双通道，逐行容错（坏行跳过不中断整批），保留原 id 连续性与 apply_logs 追溯历史

### 7.3 安全基线（架构 v0.2）

- Electron：`contextIsolation=true` + `nodeIntegration=false` + `sandbox=true`，渲染进程仅经 preload 桥接最小 API 面
- 后端全局 Bearer 令牌鉴权（fail-closed；一次性令牌文件注入后即删除）；Host 头校验（DNS rebinding 防护）+ Origin 头校验（跨源 403）
- CORS 仅放行 localhost + `app://` 自定协议；渲染层 CSP 严格 `script-src 'self'`
- LLM api_key：后端 DPAPI 密文落盘（`enc:` 前缀），永不进 `GET /api/settings` 响应 / 导出
- `llm.base_url` 白名单（知名提供商 + 本地回环地址），防 XSS 把 API key 服务端外带
- 外部链接打开经主进程 host 白名单校验（scheme/host 归一化，防 scheme 绕过）
- 备份 manifest checksum 键白名单正则，封堵 zip 路径穿越

## 8. P1a 简历素材库 + RAG（已完成，内部使用）

> P1 前置调研交付（2026-08-06，见 CHANGELOG `## [0.1.6]`）。调研语料（200 个第三方仓库 + RAG 索引，约 3.3GB）**不随本仓库分发**——用于内部驱动 P1b 编辑器设计，不在本仓库重新分发。

| 交付物 | 说明 |
|--------|------|
| **调研语料** | GitHub 34 关键词扫描 → 200 个简历/文档/求职生态仓库（1k+ star 优先），本地隔离 clone |
| **详细知识库** | 《简历知识库_详细内容.md》1194 行：方法论（FAB/STAR/ATS）、JSON Resume Schema、分岗位模板、中英例句/Cover Letter、AI 优化模型（resumePolice/career-ops） |
| **RAG 索引** | bge-m3 1024 维，40,367 块，200/200 仓全覆盖（GPU CUDA 加速）；**2000 次查询测试 99.8%**（≥98% 达标） |

> P1b 编辑器开发将直接基于此知识库的 JSON Resume Schema 与模板精华，避免凭空造车。

