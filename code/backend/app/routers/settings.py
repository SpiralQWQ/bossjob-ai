"""设置路由。

GET /api/settings → 返回当前生效配置快照。
PUT /api/settings → 合并前端回传的公开配置，持久化到 settings.json 并刷新生效值。
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

import app.config as config
from app import schemas

router = APIRouter(tags=["settings"])


# ---------------------------------------------------------------------------
# PUT /api/settings 的 llm.base_url 允许来源校验（config-tampering 加固）
# ---------------------------------------------------------------------------
# 配置热更新会把 llm.base_url 落盘并供后端 LLM 调用；若不做校验，同主世界 XSS 可把
# base_url 指向攻击者主机，让后端把用户 API key 服务端外带 —— 唯一绕过渲染层 CSP
# connect-src 的通道。Electron 主进程 backend-request 代理已做同口径校验（双保险）。
ALLOWED_LLM_BASE_URL_HOSTS: frozenset[str] = frozenset({
    "api.deepseek.com",        # DeepSeek
    "dashscope.aliyuncs.com",  # 阿里云百炼 DashScope（Qwen）
    "open.bigmodel.cn",        # 智谱 GLM
    "api.openai.com",          # OpenAI
    "api.moonshot.cn",         # Moonshot Kimi
    "api.siliconflow.cn",      # 硅基流动 SiliconFlow
    "api.z.ai",                # Z.ai
    "openrouter.ai",           # OpenRouter
    "api.anthropic.com",       # Anthropic
})
# 本地 LLM 服务（Ollama / llama.cpp / LM Studio 等）：允许 http，但仅限回环地址。
LOCALHOST_LLM_BASE_URL_HOSTS: frozenset[str] = frozenset(
    {"localhost", "127.0.0.1", "::1"}
)


def _validate_llm_base_url(base_url: object) -> str | None:
    """校验 llm.base_url：空串放行（走提供商默认端点）。

    非空时要求：https（本地回环允许 http）+ 宿主命中白名单或为本地回环 + 无 userinfo。
    返回 None（通过）或拒绝原因字符串。
    """
    if base_url is None:
        return None
    if not isinstance(base_url, str):
        return "llm.base_url 必须是字符串"
    url = base_url.strip()
    if url == "":
        return None
    try:
        parsed = urlparse(url)
    except Exception:
        return "llm.base_url 不是合法 URL"
    if parsed.username or parsed.password:
        return "llm.base_url 禁止携带 userinfo"
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if host in LOCALHOST_LLM_BASE_URL_HOSTS:
        return None
    if parsed.scheme != "https":
        return "llm.base_url 仅允许 https"
    if host not in ALLOWED_LLM_BASE_URL_HOSTS:
        return "llm.base_url 宿主不在允许列表中"
    return None


@router.get("/api/settings", response_model=schemas.SettingsResponse)
def get_settings() -> schemas.SettingsResponse:
    """返回当前配置（与 settings.json / env 合并后的生效值），剔除敏感字段。"""
    return schemas.SettingsResponse(**config.public_dump(config.settings))


@router.put("/api/settings", response_model=schemas.SettingsResponse)
def update_settings(payload: dict) -> schemas.SettingsResponse:
    """保存配置：合并公开字段（保留 api_key / port）→ 写入 settings.json → 刷新生效值。

    入参为前端「配置编辑」卡片回传的 JSON（公开快照，不含 api_key / port）。
    非法字段由 Settings 模型校验拦截，返回 422 便于前端展示错误。
    llm.base_url 额外施以「https + 已知提供商宿主白名单 + 禁止 userinfo」校验，
    防止同主世界 XSS 把后端 LLM 调用指向攻击者主机、服务端外带用户 API key。
    """
    llm_payload = payload.get("llm") if isinstance(payload, dict) else None
    if isinstance(llm_payload, dict) and "base_url" in llm_payload:
        reason = _validate_llm_base_url(llm_payload["base_url"])
        if reason is not None:
            raise HTTPException(status_code=400, detail=reason)
    # 对齐 electron/main.js loadUserExternalHostAllowlist 口径校验 external_url_hosts：
    # 拒绝含协议/端口/路径、去首尾点后无点号的裸单标签（如 "com"），与前端表单校验三方一致。
    security_payload = payload.get("security") if isinstance(payload, dict) else None
    if isinstance(security_payload, dict) and "external_url_hosts" in security_payload:
        hosts = security_payload["external_url_hosts"]
        if not isinstance(hosts, list):
            raise HTTPException(status_code=400, detail="security.external_url_hosts 必须是数组")
        for item in hosts:
            if not isinstance(item, str):
                raise HTTPException(status_code=400, detail="security.external_url_hosts 每项必须是字符串")
            h = item.strip()
            if not h:
                continue
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", h) or "/" in h or ":" in h:
                raise HTTPException(status_code=400, detail=f"非法域名后缀：{h}")
            if len(h.strip(".").split(".")) < 2:
                raise HTTPException(status_code=400, detail=f"非法裸域名：{h}")
    try:
        snapshot = config.save_settings(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return schemas.SettingsResponse(**snapshot)
