"""FastAPI 应用入口。

启动方式：
    python -m uvicorn app.main:app --host 127.0.0.1 --port {port}

- CORS：仅允许 localhost（127.0.0.1 + localhost，任意端口）+ app:// 自定协议，
  严格遵循架构 v0.2 安全基线（本地服务不对外暴露）；allow_credentials=False。
- 鉴权（认证绕过修复）：Electron 主进程注入 BOSS_AUTH_TOKEN（256-bit 随机令牌），
  本应用对全部路由施加全局依赖，要求 `Authorization: Bearer <token>`。令牌未配置
  （开发者直接 `python -m uvicorn`）时放行并打印告警；Electron 正常启动路径始终
  注入令牌，因此真实使用中每个端点都经过鉴权，本地恶意进程/浏览器页面无法匿名调用。
- Host 校验：拒绝 Host 非 127.0.0.1 / localhost / ::1 的请求，缓解 DNS rebinding。
- 启动时初始化数据层（创建 data 目录 + SQLite 表）。
- 端口一律取自配置（settings.json / env），禁止硬编码。
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import logging
import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.constants import (
    APP_NAME,
    APP_VERSION,
    AUTH_TOKEN_ENV,
    AUTH_TOKEN_FILE_ENV,
    CORS_ALLOW_ORIGINS,
    CORS_ALLOW_ORIGIN_REGEX,
)
from app.db import init_db
from app.routers import data, health, settings as settings_router

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 生命周期：启动时初始化数据层
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动：确保 data 目录存在并初始化 SQLite 引擎与表。"""
    init_db()
    yield


# ---------------------------------------------------------------------------
# 鉴权（认证绕过修复：本地后端禁止匿名调用）
# ---------------------------------------------------------------------------


def _dpapi_unprotect(blob: bytes) -> bytes:
    """Windows 同用户 DPAPI 解密（crypt32.CryptUnprotectData，CRYPTPROTECT_UI_FORBIDDEN）。

    用于还原 Electron safeStorage.encryptString 写入的一次性令牌密文（同账户透明、无需口令）。
    非 Windows 或解密失败返回 b''。
    """
    if os.name != "nt":
        return b""

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.c_void_p)]

    blob_in = DATA_BLOB(
        len(blob), ctypes.cast(ctypes.create_string_buffer(blob), ctypes.c_void_p)
    )
    blob_out = DATA_BLOB()
    # dwFlags=0 即 CRYPTPROTECT_UI_FORBIDDEN：静默解密，不弹 UI
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    ):
        return b""
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.c_void_p(blob_out.pbData))


def _load_auth_token() -> str:
    """读取后端鉴权令牌（key-leak 加固：优先一次性令牌文件，回退环境变量）。

    优先级：
      1. BOSS_AUTH_TOKEN_FILE 指向的令牌文件 —— Electron 启动前写入后端数据目录、读后立即删除
         （main.js 的 writeAuthTokenFile）。Windows 下令牌不进入子进程环境块，避免同用户任意进程
         经 toolhelp/NtQueryInformationProcess 窃取进程环境。文件内容为主进程直接写入的明文令牌
         （Electron 43 的 safeStorage 输出 OSCrypt v10 密文，后端裸 CryptUnprotectData 无法解密，
         DPAPI 密文通道不可行，故一次性令牌文件一律明文；见 main.js writeAuthTokenFile）；
         若为历史遗留的 "enc:" + DPAPI 密文（base64），本函数仍用同用户 DPAPI 解密还原，以兼容旧版。
      2. BOSS_AUTH_TOKEN 环境变量 —— 旧版 Electron / 令牌文件不可写时的兜底路径。
    均未配置（开发者直接 `python -m uvicorn`）时返回空串 → require_auth 放行并告警。
    """
    token_file = os.environ.get(AUTH_TOKEN_FILE_ENV, "")
    if token_file:
        try:
            with open(token_file, "r", encoding="utf-8") as fh:
                content = fh.read().strip()
            # 一次性通道：读完立即删除，压缩密钥暴露窗口
            try:
                os.remove(token_file)
            except OSError:
                pass
            if not content:
                logger.warning("[auth] 令牌文件为空（%s），回退环境变量通道", token_file)
            elif content.startswith("enc:"):
                # 解密失败时按未配置处理并告警，绝不把密文当令牌使用（否则全局鉴权全 401）
                try:
                    token = _dpapi_unprotect(base64.b64decode(content[4:])).decode(
                        "utf-8", "replace"
                    )
                except Exception as exc:  # noqa: BLE001 - 解密属防御性路径，任意异常都应收敛
                    token = ""
                    logger.warning("[auth] 解密令牌文件失败（%s）：%s", token_file, exc)
                if token:
                    return token
                logger.warning("[auth] 令牌文件密文无法解密（%s），回退环境变量通道", token_file)
            else:
                # 明文令牌文件（旧版 / 加密不可用兜底）：直接使用
                return content
        except OSError as exc:
            logger.warning("[auth] 读取令牌文件失败（%s），回退环境变量通道", exc)
    return os.environ.get(AUTH_TOKEN_ENV, "")


# 显式开发开关：设置 BOSS_DEV_NO_AUTH=1 时完全跳过本地后端鉴权（仅限开发者本地裸跑 uvicorn 调试）。
# Electron 正常启动路径绝不设置该变量 —— 令牌注入失败时应拒绝启动，而非退化为无鉴权 FAIL-OPEN。
BOSS_DEV_NO_AUTH = os.environ.get("BOSS_DEV_NO_AUTH") == "1"

# 启动时一次性解析并缓存。令牌在本进程生命周期内不变：Electron 每次启动后端前都会注入最新令牌。
AUTH_TOKEN = _load_auth_token()

# 令牌缺失时拒绝启动（认证绕过修复）：无令牌则全局鉴权 FAIL-OPEN（本地任意进程可无令牌调用全部
# /api/*），后端绝不裸奔。开发者本地裸跑 uvicorn 调试需显式设置 BOSS_DEV_NO_AUTH=1。
if not AUTH_TOKEN and not BOSS_DEV_NO_AUTH:
    raise RuntimeError(
        f"缺少后端鉴权令牌（{AUTH_TOKEN_ENV}/{AUTH_TOKEN_FILE_ENV} 均未配置），"
        "拒绝启动以避免鉴权 FAIL-OPEN。开发者调试可显式设置 BOSS_DEV_NO_AUTH=1。"
    )


def require_auth(request: Request) -> None:
    """全局鉴权依赖：校验 `Authorization: Bearer <token>`。

    令牌由 electron/main.js 首启生成并持久化，经一次性令牌文件 / BOSS_AUTH_TOKEN 环境变量注入
    （见 _load_auth_token）。未配置令牌时一律 401 拒绝（认证绕过修复：绝不允许 FAIL-OPEN）；
    模块级启动校验已保证后端启动时令牌必存在，此处空令牌分支为纵深防御，防止运行时令牌被清空后
    匿名放行。仅 BOSS_DEV_NO_AUTH=1 显式开发开关下完全跳过鉴权（裸 uvicorn 本地调试）。
    """
    if BOSS_DEV_NO_AUTH:
        return
    expected = AUTH_TOKEN
    if not expected:
        # 空令牌 → 一律 401 拒绝，绝不静默放行（auth-bypass 修复）
        raise HTTPException(status_code=401, detail="unauthorized: auth token not configured")
    header = request.headers.get("Authorization", "")
    if header != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized: missing or invalid Bearer token")


class HostHeaderCheck(BaseHTTPMiddleware):
    """Host 头校验：拒绝 Host 非本机回环地址的请求，缓解 DNS rebinding。

    仅接受 127.0.0.1 / localhost / ::1（端口不限）。攻击者把域名解析到 127.0.0.1
    后经浏览器访问，请求的 Host 头会携带攻击者域名 → 被 403 拒绝。
    """

    _ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

    async def dispatch(self, request: Request, call_next):
        host = request.headers.get("host", "")
        if host.startswith("["):
            # 带方括号的 IPv6 字面量：Host: [::1]:8675
            hostname = host.split("]", 1)[0][1:] if "]" in host else host
        else:
            hostname = host.split(":", 1)[0]
        hostname = hostname.strip().lower()
        if hostname not in self._ALLOWED_HOSTS:
            # 直接返回响应而非 raise HTTPException：BaseHTTPMiddleware 的 dispatch 内抛出
            # 的 HTTPException 不会被 FastAPI/Starlette 异常处理器转换为响应，只会变成 500。
            return JSONResponse(
                status_code=403,
                content={"detail": "forbidden: unexpected Host header"},
            )
        return await call_next(request)


class OriginHeaderCheck(BaseHTTPMiddleware):
    """Origin 头校验：拒绝带非本地 Origin 的跨源请求（防御纵深，与 CORS 白名单配合）。

    浏览器跨源请求会携带 Origin 头（如 http://evil.com）。CORS 中间件只是不返回
    放行头、让浏览器「读不到」响应，但请求仍会进入业务逻辑；本中间件在入口直接
    403 拒绝这类请求——即使恶意页面意外拿到合法 Bearer 令牌，也无法调用本地 API。

    放行的 Origin（与 constants.CORS_ALLOW_* 口径一致）：
      - "null"：Electron 生产态 loadFile() 加载 file:// 页面 fetch 的 Origin 序列化值；
      - http/https 且主机为 127.0.0.1 / localhost / ::1（开发态 Vite dev server）；
      - app:// 自定协议（预留，如 loadFile 迁移到自定义协议后的渲染源）。
    无 Origin 头的请求（curl / 本地进程 / Electron 主进程直连）不受本闸约束，
    由 require_auth 的 Bearer 令牌校验兜底。
    """

    _LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and not self._is_local_origin(origin):
            # 与 HostHeaderCheck 同策略：直接返回 JSONResponse，
            # 避免 BaseHTTPMiddleware dispatch 内 raise HTTPException 变 500。
            return JSONResponse(
                status_code=403,
                content={"detail": "forbidden: unexpected Origin header"},
            )
        return await call_next(request)

    @classmethod
    def _is_local_origin(cls, origin: str) -> bool:
        if origin == "null":
            return True
        try:
            parsed = urlparse(origin)
        except Exception:
            return False
        if parsed.scheme == "app":
            return True
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").strip().lower()
        # urlparse 的 hostname 对 IPv6 字面量返回不带方括号的 "::1"
        if host.startswith("[") and host.endswith("]"):
            host = host[1:-1]
        return host in cls._LOCAL_HOSTS


# ---------------------------------------------------------------------------
# 应用实例
# ---------------------------------------------------------------------------

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    lifespan=lifespan,
    dependencies=[Depends(require_auth)],
)

# CORS：放行源见 constants.CORS_ALLOW_*（架构 v0.2 H1「Origin 白名单仅 app:// + localhost」）。
#   - 开发态：Vite dev server（http://localhost:5173 → localhost 正则命中）。
#   - 生产态：Electron loadFile() 加载 file:// 页面，fetch 的 Origin 头序列化为 "null"，
#     须显式放行（"app://" 为自定协议预留），否则打包应用 fetch 会被浏览器阻断。
#   - allow_credentials=False：配合全局 Bearer 令牌鉴权，杜绝 file:// 页面跨源读取
#     （认证绕过修复）。
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(CORS_ALLOW_ORIGINS),
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Host 校验置于最外层：先于 CORS 拒绝非本机 Host 请求（DNS rebinding 防护）
app.add_middleware(HostHeaderCheck)
# Origin 校验置于最外层（add_middleware 后添加者最外层，故加在 HostHeaderCheck 之后）：
# 拒绝带非本地 Origin 的跨源请求，与 CORS 白名单构成双层防线（浏览器读不到 + 入口 403）
app.add_middleware(OriginHeaderCheck)

# ---------------------------------------------------------------------------
# 路由注册
# ---------------------------------------------------------------------------

app.include_router(health.router)
app.include_router(settings_router.router)
app.include_router(data.router)
