"""Pydantic 响应模型。

统一接口返回结构（见架构 v0.2 8.3：{code, data, message}），
P0 骨架先提供最小可用的 health / settings 响应模型。
"""

from __future__ import annotations

from datetime import datetime
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


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


# ---------------------------------------------------------------------------
# 投递记录（applications）模型 —— 从 routers/data.py 抽离（瘦身解耦：Route → Service → Model）
# ---------------------------------------------------------------------------

def _parse_dt(value: object) -> datetime | None:
    """宽松解析导出/导入中的时间字符串（'YYYY-MM-DD HH:MM:SS'）为 datetime；非法输入返回 None。"""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.replace(" ", "T"))
        except ValueError:
            return None
    return None


def _validate_url_scheme(v: str | None) -> str | None:
    """url 仅接受 http/https（空串/None 放行），对齐前端 useUrlHostWarning 与主进程 open-external 口径。

    javascript:/file:/data: 等非法 scheme 拒绝入库（create/update/import 三路径共用本校验）。
    """
    if not v:
        return v
    try:
        parsed = urlparse(v)
        scheme = parsed.scheme.lower()
    except ValueError:
        raise ValueError("url 格式非法")
    if scheme not in ("http", "https"):
        raise ValueError("url 仅支持 http/https 链接")
    if not parsed.netloc:
        raise ValueError("url 缺少主机名")
    return v


class ApplicationItem(BaseModel):
    """单条投递记录（GET /api/applications）。"""

    id: int
    job_title: str
    company: str
    city: str
    salary: str
    url: str
    status: str
    note: str
    # schema v2：applied_at 可空（清空=未设置），必须声明 Optional 否则 NULL 记录整表 500
    applied_at: datetime | None
    updated_at: datetime


class ApplicationListResponse(BaseModel):
    """投递记录分页响应。"""

    total: int = Field(..., description="符合条件的总条数")
    page: int = Field(..., description="当前页码")
    page_size: int = Field(..., description="每页条数")
    items: list[ApplicationItem] = Field(..., description="当前页记录")


class DailyTrendItem(BaseModel):
    """每日投递趋势单点。"""

    date: str = Field(..., description="日期 YYYY-MM-DD")
    count: int = Field(..., description="当日投递数")


class StatsResponse(BaseModel):
    """求职看板统计（GET /api/stats）。"""

    total: int = Field(..., description="累计投递数")
    applying: int = Field(..., description="进行中（待反馈/已回复/面试中）")
    offer_count: int = Field(..., description="Offer 数")
    rejected: int = Field(..., description="被拒 / 关闭数")
    pass_rate: float = Field(..., description="通过率 = Offer / 累计投递")
    daily_trend: list[DailyTrendItem] = Field(..., description="近 30 天每日投递数")


class ApplicationCreate(BaseModel):
    """新增投递记录（POST /api/applications）。"""

    job_title: str = Field(..., min_length=1, max_length=255, description="职位名称")
    company: str = Field(..., min_length=1, max_length=255, description="公司名称")
    city: str = Field("", max_length=64, description="城市")
    salary: str = Field("", max_length=128, description="薪资")
    url: str = Field("", description="职位链接（仅 http/https）")
    status: str = Field("pending", description="投递状态")
    note: str = Field("", description="备注")
    applied_at: datetime | None = Field(None, description="投递时间，缺省取当前时间")

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str) -> str:
        return _validate_url_scheme(v)


class ApplicationUpdate(BaseModel):
    """更新投递记录（PATCH /api/applications/{id}），仅覆盖传入字段。"""

    job_title: str | None = Field(None, min_length=1, max_length=255)
    company: str | None = Field(None, min_length=1, max_length=255)
    city: str | None = Field(None, max_length=64)
    salary: str | None = Field(None, max_length=128)
    url: str | None = None
    status: str | None = None
    note: str | None = None
    applied_at: datetime | None = None

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str | None) -> str | None:
        return _validate_url_scheme(v)


class ImportItem(BaseModel):
    """导入单条记录（POST /api/import，对齐 GET /api/export 的 applications 段）。"""

    id: int | None = Field(None, description="原 id；已存在则覆盖更新，否则新建")
    job_title: str | None = None
    company: str | None = None
    city: str | None = None
    salary: str | None = None
    url: str | None = None
    status: str | None = None
    note: str | None = None
    applied_at: str | datetime | None = None
    updated_at: str | datetime | None = None


class ImportPayload(BaseModel):
    """导入请求体（即 GET /api/export 返回的顶层结构，多余字段忽略）。"""

    applications: list[object] = Field(..., description="投递记录列表")
    apply_logs: list[object] | None = Field(
        None, description="投递日志（导入时按 application_id 映射落库恢复）"
    )

    @field_validator("apply_logs", mode="before")
    @classmethod
    def _apply_logs_coerce(cls, v: object) -> object:
        return v if isinstance(v, list) or v is None else None


class ApplyLogItem(BaseModel):
    """单条投递操作日志（GET /api/applications/{id}/logs）。"""

    id: int
    action: str
    detail: str
    created_at: datetime


class ApplyLogListResponse(BaseModel):
    """投递操作日志时间线响应。"""

    application_id: int
    items: list[ApplyLogItem]
