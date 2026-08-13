# BossJobAI — BOSS直聘 AI 求职助手

[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.7-brightgreen.svg)](CHANGELOG_zh.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d6.svg)](#构建打包)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **隐私优先的本地求职桌面应用。** 简历、投递、面试、Offer 全程本地管理——无云端、无账号、数据只属于你自己。
>
> **当前为手动记录管理版（v0.1）：** 一个面向非技术背景求职者的 **Electron 桌面应用**，简历 / 投递记录均在本地维护（简历为本地表单录入、投递为人工登记改状态）。BOSS直聘 线上自动化（解析/匹配/自动投递）**规划中、尚未上线**，详见[路线图](#路线图)。

**已落地 7 大页面** —— 工作台 / 简历 / 投递记录 / 投递登记 / 面试登记 / 求职看板 / 设置 —— 全量 CRUD + 筛选 + 批量改状态，导出（JSON/CSV/离线）/ 导入（文件/粘贴）/ 备份恢复（zip 四件套 + checksum 校验）。

- ✅ **本地优先、隐私第一**：数据全存本地 SQLite，不上传任何服务器。
- ✅ **人类把关**：当前人工记录管理，未来 AI 辅助投递时每次动作仍保持人工确认。
- ✅ **合规设计**：内置限速（每日上限 15、随机间隔），为自动化上线预留安全护栏。
- ✅ **完全离线可用**：导出 / 导入 / 备份 / 恢复均不依赖网络。

## ✨ 功能特性

| 模块 | 能力 |
|------|------|
| 📊 **工作台** | 后端连接状态 + 鉴权令牌指纹校验、目标城市、快捷入口 |
| 📄 **简历** | 本地表单录入（姓名/电话/邮箱/城市 + 自定字段）、Markdown 模板导出、JSON 备份/导入、未保存离开守卫 |
| 🗂️ **投递记录（全部）** | 全量 CRUD、状态/关键词/日期区间筛选、批量改状态、CSV/JSON/离线导出、文件 + 粘贴导入、应用内备份管理 |
| 📝 **投递（手动登记）** | 待投递队列、登记/编辑/状态推进、行内一键撤销、越界分页回退 |
| 🎤 **面试** | 面试中记录视图 + 结构化【面试登记】块（时间/形式/备注）、「今天/近7天」高亮 |
| 📈 **看板** | 统计卡片（累计/进行中/Offer/被拒/通过率）+ 近 30 天每日趋势柱图 |
| ⚙️ **设置** | 城市 / 投递合规限速 / 浏览器 / 黑名单 / 外部链接白名单（LLM 引擎后续阶段接入） |
| 💾 **数据与备份** | JSON 导出（可预览）、CSV 导出、离线导出兜底、`.zip` 便携备份归档、校验和恢复、自动备份 + 保留策略 |

> 简历解析 / 优化 → JD 匹配 → 打招呼语生成 → 人类确认后自动投递 → 模拟面试 等 **AI 能力处于 P1–P7 规划阶段、尚未上线**（见[路线图](#路线图)）。

## 📸 截图

> *截图占位，敬请期待。应用为单窗口 Electron 桌面 UI，深色侧边栏 + 浅色内容区。*

## 📚 目录

- [快速开始](#快速开始)
- [架构](#架构)
- [后端接口](#后端接口)
- [配置说明](#配置说明)
- [构建打包](#构建打包)
- [安全基线](#安全基线)
- [路线图](#路线图)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)
- [支持一下](#支持一下)

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Python** | 3.11 / 3.12 | 后端（FastAPI + SQLite） |
| **Node.js** | 20+ | 前端（Vite）+ Electron 工具链 |
| **Git** | 任意 | 克隆仓库 |

### 1. 克隆仓库

```bash
git clone https://github.com/SpiralQWQ/bossjob-ai.git
cd bossjob-ai
```

### 2. 启动后端（FastAPI）

```powershell
cd code\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8675
```

> 验证：`curl http://127.0.0.1:8675/api/health` → `{"status":"ok","version":"0.1.7", ...}`

### 3. 启动前端（Vite dev server）

```powershell
cd code\frontend
npm install
npm run dev        # http://127.0.0.1:5173（strictPort，端口被占会直接报错）
```

> 浏览器直开 dev server 时 `window.api` 桥接不可用，工作台会优雅降级提示「请通过 Electron 启动」。

### 4. 启动桌面壳（推荐）

```powershell
cd code\electron
npm install
npm start
```

Electron 会自动拉起后端、轮询 `/api/health` 就绪后加载 UI。后端异常退出最多自动重启 `MAX_BACKEND_RESTARTS` 次；应用退出时优雅关闭后端子进程。

> **注意：** 后端仅监听 `127.0.0.1`，并由 Electron 主进程注入的一次性 Bearer 令牌保护——详见[安全基线](#安全基线)。

---

## 🏗️ 架构

三层进程模型（完整设计见 [`docs/求职投递项目_架构设计_v0.2.md`](docs/求职投递项目_架构设计_v0.2.md)）：

```
┌──────────────────────────────────────────────────────────┐
│  渲染进程  React + TS + Antd (Vite)                       │
│  全部 UI；经 preload 桥接（window.api）与主进程通信         │
└───────────────────────┬──────────────────────────────────┘
                        │ IPC（contextIsolation + sandbox）
┌───────────────────────▼──────────────────────────────────┐
│  Electron 主进程  窗口管理 + 后端守护                      │
│  spawn 并守护 Python 后端（崩溃自动重启）                  │
│  注入 Bearer 令牌；端点白名单强制校验                       │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP（Bearer Token，仅 127.0.0.1）
┌───────────────────────▼──────────────────────────────────┐
│  Python 后端  FastAPI + SQLAlchemy + SQLite               │
│  AI 决策、数据存储、后续自动化控制                         │
└──────────────────────────────────────────────────────────┘
```

- **Electron 主进程**：窗口管理、生命周期、spawn 并守护 Python 后端（崩溃自动重启）。
- **渲染进程**（React + TS）：全部 UI，经 preload 桥接与主进程 IPC，经 HTTP 访问后端。
- **Python 后端**（FastAPI）：AI 决策、数据存储、后续自动化控制，仅监听 `127.0.0.1`。

**核心原则**：隐私本地化（SQLite）、人类把关（每次投递需人工确认）、合规限速（日限 15、随机间隔）、模块化（决策层与浏览器执行层解耦）、中文优先（DeepSeek/Qwen）。

---

## 🔌 后端接口

> 完整参考见 [`docs/求职投递项目_接口文档_v0.1.md`](docs/求职投递项目_接口文档_v0.1.md)。

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | `{"status":"ok","version":"0.1.7","auth_token_fingerprint":"<sha256前16位>"}` — 探活 + 令牌指纹 |
| `/api/settings` | GET | 当前生效配置快照（敏感字段如 `llm.api_key` 已剔除） |
| `/api/settings` | PUT | 合并前端回传的公开配置并落盘（base_url 白名单 + external_url_hosts 校验） |
| `/api/applications` | GET | 分页查询（状态精确 / 关键词模糊 / 日期区间；LIKE 通配符转义） |
| `/api/applications` | POST | 登记投递记录（职位/公司 strip 后非空；写登记日志） |
| `/api/applications/{id}` | PATCH | 部分更新（仅覆盖传入字段；`applied_at:null` 清空为未设置；零变更不写日志） |
| `/api/applications/{id}` | DELETE | 删除记录（级联清理 apply_logs） |
| `/api/applications/ids` | GET | 轻量返回全部 id 列表（导入覆盖数预估用） |
| `/api/applications/{id}/logs` | GET | 单条记录操作日志时间线 |
| `/api/stats` | GET | 看板统计：累计/进行中/Offer/被拒/通过率 + 近 30 天趋势 |
| `/api/export` | GET | 全量业务数据 JSON（applications + apply_logs + 脱敏配置） |
| `/api/import` | POST | 导入导出 JSON（按 id 覆盖/新建，逐行容错） |

---

## ⚙️ 配置说明

首次设置复制 `code/settings.template.json` 为 `code/settings.json`（缺失时后端首次启动也会自动写入默认配置）。模板自带空城市列表与无凭据——请填入你自己的目标城市与（可选）LLM 提供商密钥。

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
  "security": {
    "external_url_hosts": []             // 外部链接放行域名后缀
  },
  "cities": []                           // 目标城市（模板默认空，请自行添加）
}
```

**优先级**：环境变量 `BOSS_PORT`（顶层）、`BOSS_LLM__PROVIDER`（嵌套，`__` 分隔）> `settings.json` > 代码默认值。
**打包模式**：配置文件运行期位于 `%APPDATA%\BossJobAI\settings.json`（Electron 首启从 `resources/settings.json` 复制写入）。

---

## 🔨 构建打包

> 完整流程见 [`code/packaging/BUILD.md`](code/packaging/BUILD.md)。构建顺序：**前端构建 → 后端 PyInstaller → electron-builder**。

### 前端构建

```powershell
cd code\frontend
npm install
npm run build        # tsc + vite build → frontend/dist/
```

### 后端 PyInstaller（需先建好 `backend/.venv` 并安装 `pyinstaller`）

```powershell
cd code\packaging
..\backend\.venv\Scripts\pyinstaller --noconfirm --clean `
  --distpath ..\backend\dist --workpath ..\build\backend backend.spec
# 产物：backend/dist/bossjob-backend/bossjob-backend.exe
```

### electron-builder 打安装包（需先装 Electron 依赖）

```powershell
cd code\electron
npm install
npm run dist
# 产物：packaging/release/BossJobAI-Setup-0.1.7.exe（NSIS 安装包）
```

> **打包链路要点**：前端 `base: './'` + HashRouter 兼容 `file://`；后端 frozen 分支把配置/数据指向 `%APPDATA%/BossJobAI`；electron-builder 打包后端 exe + `settings.default.json`；首启复制 settings 到 APPDATA。
>
> **版本三处同步**（改版必须一起改）：`backend/app/constants.py` 的 `APP_VERSION` + `electron/package.json` 的 `version` + `frontend/package.json` 的 `version`；启动时交叉校验不一致会告警。

---

## 🔒 安全基线

- **Electron**：`contextIsolation=true` + `nodeIntegration=false` + `sandbox=true`，渲染进程仅经 preload 暴露的最小 API 面与主进程通信。
- **后端**：全局 Bearer 令牌鉴权（fail-closed；一次性令牌文件注入后即删除）；Host 头校验（防 DNS rebinding）+ Origin 校验（跨源 403）；CORS 仅放行 localhost + `app://`。
- **渲染层**：严格 CSP `script-src 'self'`（构建期 + 运行期双重强制）；无内联脚本执行。
- **LLM api_key**：DPAPI 密文落盘（`enc:` 前缀），永不进 `GET /api/settings` 响应 / 导出。
- **`llm.base_url` 白名单**（知名提供商 + 本地回环），防 XSS 把 API key 服务端外带。
- **外部链接打开**经主进程 host 白名单校验（scheme/host 归一化，防 scheme 绕过）。
- **备份 manifest** checksum 键白名单正则封堵 zip 路径穿越；恢复前校验和验证 + 覆盖前自动快照可回滚。
- **导入**：逐行容错、逐窗口信任路径 TTL、脱敏 settings 白名单合并。

---

## 🗺️ 路线图

> 建议 **P0–P3 先交付**（零风险纯工具价值），P4–P5 单独评估风控后再上线，P6–P7 收尾。

| 阶段 | 里程碑 | 交付物 | 风险 |
|------|--------|--------|------|
| **P0 骨架** ✅ | Electron 壳 + FastAPI 联通 + SQLite | 可运行空壳 | 🟢 |
| **P1 简历** ✅ P1a | 简历素材库 + RAG（**P1a 已完成**）；解析 PDF/DOCX + 编辑器 + 模板导出 | 简历模块可用 | 🟢 |
| **P2 匹配** | FastEmbed + 关键词 + LLM 打分 + 匹配面板 | 岗位匹配可用 | 🟢 |
| **P3 优化** | STAR/ATS 优化 + 打招呼语生成 | AI 辅助可用 | 🟢 |
| **P4 抓取** | DrissionPage BOSS 登录 + 岗位采集 | 岗位库可用 | 🟡 风控 |
| **P5 投递** | 待确认队列 + 人类确认投递 + 限速 | 投递可用 | 🔴 封号 |
| **P6 面试** | 模拟面试 + 报告 | 面试模块 | 🟢 |
| **P7 看板** | 求职看板 + 统计 + 复盘 | 完整闭环 | 🟢 |

---

## 🤝 参与贡献

欢迎任何形式的贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，再提交 Issue 或 Pull Request。

- 发现 Bug？提交 [Issue](https://github.com/SpiralQWQ/bossjob-ai/issues)。
- 有想法？发起 [Discussion](https://github.com/SpiralQWQ/bossjob-ai/discussions) 或直接提 PR。

---

## 📄 开源协议

BossJobAI 采用 **双协议授权**：

- **开源**：[GNU Affero General Public License v3（AGPL-3.0）](LICENSE) —— 任何衍生作品（含通过网络提供服务者）必须以 AGPL-3.0 分发。
- **商业**：独立[商业许可](COMMERCIAL.md) —— 面向希望将本应用嵌入闭源/商业产品而无需承担 AGPL 源码共享义务的公司或个人。

Copyright © 2026 **Spiral QWQ**。保留所有权利。

---

## 💛 支持一下

如果这个项目帮到过你，可以请我喝杯咖啡 ☕。打赏全凭心意，不打赏也完全没关系——项目永远免费开源。做开源这么久，每一份小小的支持都能让我高兴很久。

<p align="center">
  <img src="assets/donate_wechat.jpg" alt="微信收款" width="200">
  <img src="assets/donate_alipay.jpg" alt="支付宝收款" width="200">
</p>

---

*BossJobAI 求职投递助手 —— 隐私优先的本地求职桌面工具。*
