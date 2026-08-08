# BossJobAI 桌面应用 —— Windows 构建指南（BUILD.md）

> 面向 **Windows 11 x64**。构建顺序：**前端构建 → 后端 PyInstaller → electron-builder**。
> 最终产物：`packaging/release/BossJobAI-Setup-0.1.6.exe`（NSIS 安装包）。

---

## 0. 产物与目录约定

```
code/
├── settings.json                    # 运行配置（端口/LLM/投递/浏览器/城市），构建期不修改
├── backend/
│   ├── app/                         # FastAPI 后端源码
│   ├── requirements.txt
│   └── dist/bossjob-backend/        # PyInstaller 产物（bossjob-backend.exe + _internal/）
├── frontend/dist/                   # Vite 构建产物（npm run build 生成）
├── electron/                        # Electron 主进程 + preload（app 目录，含 package.json）
└── packaging/
    ├── backend.spec                 # PyInstaller spec
    ├── backend_entry.py             # 后端 exe 的启动引导（导入 app.main 并以 uvicorn 启动）
    ├── electron-builder.yml         # electron-builder 配置
    ├── BUILD.md                     # 本文件
    └── release/                     # electron-builder 输出目录
```

安装包内部布局（关键路径，供 main.js 生产分支引用）：

| 资源 | 安装后路径 |
|------|-----------|
| 前端静态页 | `resources/app.asar/frontend/dist/index.html` |
| 后端可执行 | `resources/backend/bossjob-backend.exe` |
| 后端运行目录 | `resources/backend/`（exe 同目录） |
| 运行配置 | 首启复制到 `%APPDATA%/BossJobAI/settings.json`（见 §8） |

---

## 1. 前置环境

- **Python 3.11 / 3.12**（当前代码由 CPython 3.12 开发）
- **Node.js 20+**（含 npm）
- **Git Bash / PowerShell** 任选；以下命令为 PowerShell 风格
- 国内网络建议：pip 走清华镜像、npm 走 npmmirror（可选）

```powershell
# 可选：pip 镜像
python -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
# 可选：npm 镜像
npm config set registry https://registry.npmmirror.com
```

---

## 2. 后端依赖（虚拟环境）

在 `code/backend` 下创建并激活虚拟环境，安装运行依赖 + PyInstaller。

```powershell
cd code\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller
```

> 验证依赖：`.venv\Scripts\python.exe -c "import fastapi, uvicorn, sqlalchemy, pydantic_settings; print('ok')"`

---

## 3. 前端构建

```powershell
cd code\frontend
npm install
npm run build
```

- 产物：`frontend/dist/`（`vite.config.ts` 已设 `base: './'`，兼容 Electron `loadFile`）。
- 构建失败多为 TS 类型错误，`npm run build` = `tsc && vite build`，先修类型再打包。

---

## 4. 后端 PyInstaller 打包

在 `code/packaging` 下执行（保持 venv 激活）：

```powershell
cd code\packaging
..\backend\.venv\Scripts\pyinstaller --noconfirm --clean `
  --distpath ..\backend\dist --workpath ..\build\backend backend.spec
```

- 产物：`code/backend/dist/bossjob-backend/bossjob-backend.exe`
- spec 已通过 `collect_all` 收集 `uvicorn / fastapi / sqlalchemy / pydantic`，并 `collect_submodules('app')`
  收集后端全部子模块；名称 `bossjob-backend`，`console=True`。
- 构建时长通常 1~3 分钟；构建目录 `code/build/backend` 可随时删除重建。

### 4.1 后端 exe 冒烟测试（必做）

```powershell
# 终端 A：启动后端 exe（端口取 settings.json，默认 8675）
cd code\backend\dist\bossjob-backend
.\bossjob-backend.exe

# 终端 B：健康检查
curl http://127.0.0.1:8675/api/health
# 期望：{"status":"ok","version":"0.1.6"}
curl http://127.0.0.1:8675/api/settings
# 期望：返回 settings.json 内容
```

冒烟通过后再进入下一步；否则说明 hiddenimports 缺模块，回 §4 补 spec。

---

## 5. Electron 依赖

```powershell
cd code\electron
npm install
```

---

## 6. electron-builder 打 Windows 安装包

app 目录是 `electron/`（含 `package.json` + `main.js` + `preload.js`），
用 `--config` 显式指定 `packaging/electron-builder.yml`：

```powershell
cd code\electron
npx electron-builder --config ..\packaging\electron-builder.yml --win nsis
```

- 产物：`code/packaging/release/BossJobAI-Setup-0.1.6.exe`
- 配置要点：
  - `appId: com.bossjobai.desktop`，`productName: BossJobAI`，版本取 `electron/package.json`
  - `files`：`main.js` + `preload.js` + `../frontend/dist/**`（→ `app.asar/frontend/dist/`）
  - `extraResources`：`../backend/dist/bossjob-backend` → `resources/backend/`
- 未签名安装包首次运行会弹 SmartScreen 提示，属预期现象（正式发布再配置签名证书）。

---

## 7. 安装包冒烟测试（必做）

1. 双击安装 `BossJobAI-Setup-0.1.6.exe`，安装到默认位置。
2. 启动 BossJobAI，确认窗口正常加载前端页面。
3. 浏览器访问 `http://127.0.0.1:8675/api/health`，确认后端已随应用拉起：
   `{"status":"ok","version":"0.1.6"}`。
4. 退出应用后确认后端进程被一并关闭（无残留 `bossjob-backend.exe`）。

---

## 8. 打包链路必要改造（重要，架构 v0.2 H4 spike 验证点）

> 以下三处改造**已在 P0 骨架代码中实现**（`electron/main.js` / `backend/app/constants.py`），
> 打包链路可直接复用。实现概要见 §8.1 / §8.2；如遇打包产物行为异常，先回到本节核对。

### 8.1 electron/main.js —— 生产分支（已实现）

`startBackend()` 已按 `app.isPackaged` 分支（打包模式直接运行 `resources/backend/bossjob-backend.exe`，
开发模式 spawn `python -m uvicorn`）；`FRONTEND_DIST_INDEX` 打包态指向 asar 内 `frontend/dist/index.html`；
首启把 bundled `settings.json`（extraResources）复制到 `%APPDATA%/BossJobAI/settings.json`。
参考实现要点：

```js
// startBackend() 内：
const isPackaged = app.isPackaged;
const backendDir = isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : BACKEND_DIR;
const cmd = isPackaged
  ? path.join(process.resourcesPath, 'backend', 'bossjob-backend.exe')
  : pythonCmd;
const args = isPackaged
  ? []                                   // exe 已内建 uvicorn 引导，见 backend_entry.py
  : ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(backendPort)];

spawn(cmd, args, {
  cwd: backendDir,
  env: { ...process.env, BOSS_PORT: String(backendPort) }, // BOSS_PORT 依旧注入
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
```

同时生产模式加载前端入口改为（asar 内）：

```js
const FRONTEND_DIST_INDEX = app.isPackaged
  ? path.join(__dirname, 'frontend', 'dist', 'index.html') // __dirname = app.asar 根
  : path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html');
```

### 8.2 backend/app/constants.py —— frozen 路径分支（已实现）

`constants.py` 已按 `sys.frozen` 分支把 **settings.json / data** 指向用户可写目录
`%APPDATA%/BossJobAI`（与 `electron/main.js` 首启复制 settings.json 的目标一致）。
参考实现要点：

```python
import sys
if getattr(sys, "frozen", False):
    # 打包后：配置与数据写入用户可写目录（resources/ 内文件只读）
    import os
    USER_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "BossJobAI"
    PROJECT_ROOT = USER_DIR
else:
    PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
DATA_DIR = BACKEND_DIR / "data"
DB_PATH = DATA_DIR / "app.db"
SETTINGS_PATH = PROJECT_ROOT / "settings.json"
```

> Electron 主进程在 `app.whenReady()` 时把 `settings.json` 从 `resources` 复制到该目录
> （首启无则写默认），再交给后端 / 自身解析端口。端口仍以 `BOSS_PORT` 环境变量 + settings.json 双重保证。

### 8.3 为什么必须先做（H4）

架构评审 H4 明确要求 **P0 阶段先做打包 spike**（含 DrissionPage 真浏览器冒烟）验证分发链路。
上述改造已实现；打包后按 §4.1 / §7 复测。

---

## 9. 版本管理与重新打包

1. 改版本：**三处同步** `electron/package.json` 的 `version` + `backend/app/constants.py` 的 `APP_VERSION`
   + `frontend/package.json` 的 `version`。三者不一致会造成「安装包版本 ≠ 健康检查版本」漂移；
   `electron/main.js` 启动时会对 `/api/health` 版本与安装包版本做交叉校验并告警。
2. 前端有改动 → 重跑 §3；后端有改动 → 重跑 §4；仅 Electron 壳改动 → 直接 §6。
3. 清理旧产物：`Remove-Item ..\backend\dist, ..\build, ..\packaging\release -Recurse -Force`
4. 完整重打一次，产物命名自动带版本号（`artifactName` 模板）。

---

## 10. 常见问题（FAQ）

| 现象 | 原因 / 处理 |
|------|------------|
| `bossjob-backend.exe` 启动即退出 | 端口被占 / hiddenimports 缺模块 / constants 路径偏离。先 `.\bossjob-backend.exe` 前台跑看报错；缺模块则回 §4 在 spec 补 `collect_all`。 |
| `collect_submodules('app')` 报找不到 app | spec 顶部已 `sys.path.insert(0, backend)`；仍失败说明 venv 与 backend 目录不符，检查是否在 `code/packaging` 下用 `..\backend\.venv\Scripts\pyinstaller` 执行。 |
| electron-builder 报 `cannot find ../frontend/dist` | 前端未构建，先执行 §3。 |
| electron-builder 拒绝 app 目录外的 files 模式 | `../frontend/dist` 为 monorepo 常见写法；若版本不支持，改为 `extraResources` 落 `to: frontend/dist`，并同步 §8.1 的 asar 内路径。 |
| SmartScreen "已保护你的电脑" | 未签名，点「更多信息 → 仍要运行」；正式发布配置代码签名证书。 |
| 安装包体积偏大 | 后端 `_internal` 含完整 Python 运行时（~100MB+）。可接受则忽略；后续可用 `excludes` 裁减或评估 Tauri 迁移（架构 §14）。 |
| 端口冲突 `address already in use` | 旧实例残留。单实例锁已存在，但仍需确认退出时后端被 kill（§7.4）。 |

---

## 11. 参考

- 架构：`docs/求职投递项目_架构设计_v0.2.md`（§11 工具链与构建 / §16 H4 打包 spike）
- 后端入口：`backend/app/main.py`（`app.main:app`）；配置：`backend/app/config.py` + `constants.py`
- Electron 主进程：`electron/main.js`（端口解析、后端守护、安全基线）
