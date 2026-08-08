"""健康检查路由。

GET /api/health → {"status": "ok", "version": "0.1.0", "auth_token_fingerprint": "<sha256前16位>"}
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter

from app import schemas
from app.constants import APP_VERSION

router = APIRouter(tags=["health"])


def _auth_token_fingerprint() -> str | None:
    """返回后端鉴权令牌的 SHA-256 指纹（前 16 位 hex），供 Electron 主进程在 /api/health 就绪后
    校验「后端确已载入与主进程一致的令牌」，检测鉴权 FAIL-OPEN（未载入令牌时返回 None）。"""
    try:
        from app.main import AUTH_TOKEN  # 延迟导入，避免与 app.main 的模块级 import 形成循环
    except ImportError:
        return None
    if not AUTH_TOKEN:
        return None
    return hashlib.sha256(AUTH_TOKEN.encode("utf-8")).hexdigest()[:16]


@router.get("/api/health", response_model=schemas.HealthResponse)
def health() -> schemas.HealthResponse:
    """探活接口：Electron 主进程据此判断后端是否就绪，并校验鉴权令牌指纹。"""
    return schemas.HealthResponse(
        status="ok",
        version=APP_VERSION,
        auth_token_fingerprint=_auth_token_fingerprint(),
    )
