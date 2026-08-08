"""Pydantic 响应模型。

统一接口返回结构（见架构 v0.2 8.3：{code, data, message}），
P0 骨架先提供最小可用的 health / settings 响应模型。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """GET /api/health 响应。"""

    status: str = Field(..., description="服务状态，固定为 ok")
    version: str = Field(..., description="后端版本号")
    auth_token_fingerprint: str | None = Field(
        default=None,
        description="后端鉴权令牌的 SHA-256 指纹（前 16 hex），供 Electron 主进程校验后端确已载入令牌、检测鉴权 FAIL-OPEN",
    )


class LLMInfoResponse(BaseModel):
    """GET /api/settings 中 LLM 配置的对外子集（刻意不含 api_key）。

    与内部 LLMConfig 分离：即使入参混入 api_key，pydantic 默认忽略多余字段，
    实现「响应模型层面」的密钥防护（路由层 public_dump() 再兜底一道）。
    """

    provider: str = Field(..., description="模型服务商")
    model: str = Field(..., description="模型名")
    base_url: str = Field("", description="OpenAI 兼容接口地址")


class SettingsResponse(BaseModel):
    """GET /api/settings 响应：当前生效配置快照（敏感字段已剔除）。"""

    port: int = Field(..., description="后端监听端口")
    llm: LLMInfoResponse = Field(..., description="LLM 接入配置（不含 api_key）")
    apply: dict = Field(..., description="投递合规限速配置")
    browser: dict = Field(..., description="浏览器执行层配置")
    blacklist: dict = Field(..., description="黑名单配置")
    security: dict = Field(..., description="外部链接宿主白名单配置")
    cities: list[str] = Field(..., description="目标城市列表")
