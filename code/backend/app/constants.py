"""全局常量模块。

所有路径、版本号、默认端口集中在此定义。
业务代码一律禁止硬编码端口/路径/版本，统一从这里引用。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 目录与文件路径（相对项目根，随源码位置自适应，不依赖绝对路径）
# 结构：<code>/backend/app/constants.py  →  项目根 = 上溯三级
#
# 打包（PyInstaller frozen）分支：resources/ 内文件只读，配置与数据改写入
# 用户可写目录 %APPDATA%/BossJobAI（与 electron/main.js 首启复制 settings.json 的目标一致，
# 见 packaging/BUILD.md §8.2）。
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):
    _USER_DIR = Path(os.environ.get("APPDATA") or str(Path.home())) / "BossJobAI"
    PROJECT_ROOT: Path = _USER_DIR
else:
    PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent.parent

BACKEND_DIR: Path = PROJECT_ROOT / "backend"
DATA_DIR: Path = BACKEND_DIR / "data"
DB_PATH: Path = DATA_DIR / "app.db"

# 配置文件（与 settings.json 同级，位于项目根）
SETTINGS_PATH: Path = PROJECT_ROOT / "settings.json"

# ---------------------------------------------------------------------------
# 应用元信息
# ---------------------------------------------------------------------------
APP_NAME: str = "BossJobAI_求职投递助手"
APP_VERSION: str = "0.1.7"
# 版本号三处同步（禁止各自随意修改，改版时必须三处一起改）：
#   1) 本处 APP_VERSION          → 后端 /api/health 返回的 version 字段
#   2) electron/package.json     → 安装包版本（electron-builder 读取，artifactName 模板）
#   3) frontend/package.json     → 前端 npm 包版本（元数据）
# 不一致会造成「安装包版本 ≠ 健康检查版本」漂移；electron/main.js 启动时会做交叉校验并告警。

# ---------------------------------------------------------------------------
# 端口合法区间（与 electron/main.js 的 PORT_MIN/PORT_MAX 对齐，禁止只改一边）
# ---------------------------------------------------------------------------
PORT_MIN: int = 1024
PORT_MAX: int = 65535

# 默认端口：仅作为 settings.json 缺失时的兜底值；
# 实际端口一律以 settings.json 的 port 字段为准（见 app/config.py）。
DEFAULT_PORT: int = 8675

# ---------------------------------------------------------------------------
# CORS 放行源（架构 v0.2 H1「Origin 白名单仅 app:// + localhost」）：
#   - CORS_ALLOW_ORIGINS：Electron 生产态渲染源。loadFile() 加载 file:// 页面时
#     fetch 的 Origin 头序列化为字面字符串 "null"，须显式放行（迁移到 app:// 自定
#     协议后即可移除，见 electron/main.js createWindow）。
#   - CORS_ALLOW_ORIGIN_REGEX：开发态 Vite dev server（localhost / 127.0.0.1 任意端口）
#     + 自定协议 app://（预留，如后续用 loadFile 改走自定义协议，Origin 形如 app://bundle）。
# 安全注记（认证绕过修复，配合 app/main.py）：
#   - allow_credentials 必须为 False；且所有端点必须经全局 Bearer 令牌鉴权
#     （AUTH_TOKEN_ENV），否则 "null" 来源的 file:// 页面可跨源读取本 API。
#   - CORS 只是浏览器侧防线；本地进程/非浏览器客户端不受 Origin 约束，真正的
#     鉴权在 app/main.py 的 require_auth 全局依赖（Bearer 令牌）。
# ---------------------------------------------------------------------------
CORS_ALLOW_ORIGINS: tuple[str, ...] = ("null",)
CORS_ALLOW_ORIGIN_REGEX: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?|app://[^\s/]*"

# ---------------------------------------------------------------------------
# 本地后端鉴权令牌（认证绕过修复）
#   - 环境变量名：electron/main.js 首启用 crypto.randomBytes(32) 生成令牌，经 safeStorage 持久化。
#   - 令牌传递通道（key-leak 加固）：Electron 不再把令牌写入子进程环境块 —— Windows 下同用户
#     任意进程可读取运行中进程的环境变量。改为优先 BOSS_AUTH_TOKEN_FILE 指向的「一次性令牌文件」
#     （写入后端数据目录、后端读后即删），仅把文件路径放入子进程 env；BOSS_AUTH_TOKEN 保留为
#     旧版/令牌文件不可写时的兜底通道。
#   - 后端 app.main.require_auth 对所有路由校验 Authorization: Bearer <token>。
# ---------------------------------------------------------------------------
AUTH_TOKEN_ENV: str = "BOSS_AUTH_TOKEN"
AUTH_TOKEN_FILE_ENV: str = "BOSS_AUTH_TOKEN_FILE"
