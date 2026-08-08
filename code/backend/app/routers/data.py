"""业务数据路由。

GET /api/applications → 投递记录分页查询（支持按状态筛选）。
GET /api/stats       → 求职看板统计（投递数 / 进行中 / Offer / 被拒 / 通过率 / 近 30 天趋势）。

响应模型就近定义在本文档（而非 schemas.py）：本阶段业务数据模型与
投递 / 统计逻辑耦合度较高，先随路由维护，后续沉淀到 schemas.py。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.db import get_db

router = APIRouter(tags=["data"])

# 看板统计口径（与 README §6 / 前端 STATUS_TEXT 保持一致）
_ACTIVE_STATUS = ("pending", "replied", "interview")
_OFFER_STATUS = ("offer",)
_REJECTED_STATUS = ("rejected", "closed")


# ---------------------------------------------------------------------------
# 响应模型
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------


@router.get("/api/applications", response_model=ApplicationListResponse)
def list_applications(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(20, ge=1, le=100, description="每页条数"),
    status: str | None = Query(None, description="按状态筛选（pending/offer 等）"),
    keyword: str | None = Query(None, description="按职位/公司/城市模糊搜索"),
    date_from: str | None = Query(None, description="按投递日期区间筛选起（YYYY-MM-DD，含当日）"),
    date_to: str | None = Query(None, description="按投递日期区间筛选止（YYYY-MM-DD，含当日）"),
    date: str | None = Query(None, description="按投递日期筛选（YYYY-MM-DD，看板趋势柱下钻，兼容单日）"),
    db: Session = Depends(get_db),
) -> ApplicationListResponse:
    """分页查询投递记录，支持按 status 精确筛选、keyword 跨页模糊搜索、date 按日筛选、date_from/date_to 日期区间筛选。"""
    query = db.query(models.Application)
    if status:
        query = query.filter(models.Application.status == status)
    # 日期过滤用 datetime 区间比较（sargable，可走 applied_at 索引）替代 func.date() 包裹：
    # func.date(applied_at) 对每行做函数计算无法用索引，50 万行下每页查询/看板统计全表扫描
    if date:
        d = _parse_dt(date)
        if d:
            query = query.filter(
                models.Application.applied_at >= d.replace(hour=0, minute=0, second=0, microsecond=0),
                models.Application.applied_at < d.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1),
            )
    if date_from:
        d = _parse_dt(date_from)
        if d:
            query = query.filter(models.Application.applied_at >= d.replace(hour=0, minute=0, second=0, microsecond=0))
    if date_to:
        d = _parse_dt(date_to)
        if d:
            query = query.filter(models.Application.applied_at < d.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1))
    if keyword and keyword.strip():
        # 转义 LIKE 通配符（%/_/\\），使搜索字面量（如 "100%" "20_40"）不被当作通配符；ESCAPE 声明保持一致
        kw_raw = keyword.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        kw = f"%{kw_raw}%"
        query = query.filter(
            models.Application.job_title.like(kw, escape="\\")
            | models.Application.company.like(kw, escape="\\")
            | models.Application.city.like(kw, escape="\\")
        )
    total = query.count()
    rows = (
        query.order_by(
            models.Application.applied_at.desc(), models.Application.id.desc()
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return ApplicationListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[
            ApplicationItem(
                id=r.id,
                job_title=r.job_title,
                company=r.company,
                city=r.city,
                salary=r.salary,
                url=r.url,
                status=r.status,
                note=r.note,
                applied_at=r.applied_at,
                updated_at=r.updated_at,
            )
            for r in rows
        ],
    )


@router.get("/api/applications/ids")
def list_application_ids(db: Session = Depends(get_db)) -> list[int]:
    """返回库内全部投递记录的 id 列表（轻量端点，仅查单列）。

    Electron 主进程 preview-import-data 用它统计『即将覆盖的 id 数』：
    只取 id 单列（SELECT applications.id），避免为计数而拉取整份
    /api/export（上限 200MB）。与 GET /api/export 的 applications.id 同源。
    """
    rows = db.query(models.Application.id).all()
    return [row[0] for row in rows]


@router.get("/api/stats", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)) -> StatsResponse:
    """求职看板统计：累计投递 / 进行中 / Offer / 被拒 / 通过率 / 近 30 天每日趋势。"""
    total = db.query(func.count(models.Application.id)).scalar() or 0
    applying = (
        db.query(func.count(models.Application.id))
        .filter(models.Application.status.in_(_ACTIVE_STATUS))
        .scalar()
        or 0
    )
    offer_count = (
        db.query(func.count(models.Application.id))
        .filter(models.Application.status.in_(_OFFER_STATUS))
        .scalar()
        or 0
    )
    rejected = (
        db.query(func.count(models.Application.id))
        .filter(models.Application.status.in_(_REJECTED_STATUS))
        .scalar()
        or 0
    )
    pass_rate = round(offer_count / total, 4) if total else 0.0

    # 近 30 天每日投递趋势；无投递的日期补 0，保证前端柱状图坐标连续。
    # 分桶在 Python 侧完成：WHERE applied_at >= start 走 applied_at 索引（schema v3），
    # 只拉 30 天窗口内的原始 applied_at 值，避免 func.date() 在 SELECT+GROUP BY 里对每行
    # 做函数计算（无法用索引，50 万行等同全表扫描）。
    today = date.today()
    start = today - timedelta(days=29)
    trend_rows = (
        db.query(models.Application.applied_at)
        .filter(
            models.Application.applied_at
            >= datetime.combine(start, datetime.min.time())
        )
        .all()
    )
    counts: dict[str, int] = {}
    for (ts,) in trend_rows:
        if ts is None:
            continue  # NULL applied_at（未设置）不参与趋势
        key = ts.date().isoformat()
        counts[key] = counts.get(key, 0) + 1
    daily_trend: list[DailyTrendItem] = []
    for i in range(30):
        day = start + timedelta(days=i)
        daily_trend.append(
            DailyTrendItem(
                date=day.isoformat(),
                count=counts.get(day.isoformat(), 0),
            )
        )

    return StatsResponse(
        total=total,
        applying=applying,
        offer_count=offer_count,
        rejected=rejected,
        pass_rate=pass_rate,
        daily_trend=daily_trend,
    )


@router.get("/api/export")
def export_data(db: Session = Depends(get_db)) -> dict:
    """导出全部业务数据为 JSON（隐私优先，供用户落盘带走）。

    覆盖 applications / apply_logs 全表 + 公开配置快照；敏感字段（如
    LLM api_key）经 config.public_dump() 剔除，绝不随导出外发。
    前端经 Electron 主进程「另存为」对话框写入用户选择的路径。
    """
    from app import config  # 局部导入：仅导出场景需要，避免模块级依赖

    applications = db.query(models.Application).order_by(models.Application.id).all()
    apply_logs = db.query(models.ApplyLog).order_by(models.ApplyLog.id).all()

    def _dt(value: datetime | None) -> str | None:
        return value.isoformat(sep=" ", timespec="seconds") if value else None

    return {
        "exported_at": datetime.now().isoformat(sep=" ", timespec="seconds"),
        "settings": config.public_dump(config.settings),
        "applications": [
            {
                "id": r.id,
                "job_title": r.job_title,
                "company": r.company,
                "city": r.city,
                "salary": r.salary,
                "url": r.url,
                "status": r.status,
                "note": r.note,
                "applied_at": _dt(r.applied_at),
                "updated_at": _dt(r.updated_at),
            }
            for r in applications
        ],
        "apply_logs": [
            {
                "id": r.id,
                "application_id": r.application_id,
                "action": r.action,
                "detail": r.detail,
                "created_at": _dt(r.created_at),
            }
            for r in apply_logs
        ],
    }


# ---------------------------------------------------------------------------
# 写接口（登记 / 更新 / 删除 / 导入）—— 打通"投递记录只读、无数据入口"的死胡同
# ---------------------------------------------------------------------------

# 合法状态枚举（与 README §6 / 前端 STATUS_TEXT / _ACTIVE_STATUS 口径一致）
_STATUS_VALUES = ("pending", "replied", "interview", "offer", "rejected", "closed")


def _validate_url_scheme(v: str | None) -> str | None:
    """url 仅接受 http/https（空串/None 放行），对齐前端 useUrlHostWarning 与主进程 open-external 口径。

    javascript:/file:/data: 等非法 scheme 拒绝入库（当前无 href 渲染/openExternal 校验兜底，
    属数据卫生防线；create/update/import 三路径共用本校验）。
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
    # 校验 host/netloc 存在：拒绝 http:// 等退化链接（urlparse scheme 为 http 但无主机名），
    # 与前端 useUrlHostWarning/parseUrlHost（new URL 解析失败即视为无效）口径对齐
    if not parsed.netloc:
        raise ValueError("url 缺少主机名")
    return v


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
    """导入单条记录（POST /api/import，对齐 GET /api/export 的 applications 段）。

    逐行容错设计：去掉 max_length 与 url scheme 校验（否则任何一条超长/非法 url 会让
    整批 422 失败，与「空必填逐行跳过」契约不一致）；超长/非法值由 import_data 逐行
    做卫生处理（超长必填行跳过、非法 url 置空），保大批量历史修正/手工合并可部分导入。
    """

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
    """导入请求体（即 GET /api/export 返回的顶层结构，多余字段忽略）。

    applications 声明为 list[dict] 而非 list[ImportItem]：单条非对象行（null/字符串/数字）会
    让 pydantic 整批 422 拒绝，与「逐行容错、大批量历史修正可部分导入」契约相悖；
    改为在 import_data 内逐行 try 构造 ImportItem，坏行计入 skipped（与 apply_logs 的
    isinstance(log, dict) 跳过口径一致）。
    """

    # list[object]（而非 list[dict]/list[ImportItem]）：pydantic v2 对 dict 类型仍会逐元素严格校验，
    # 单条 null/字符串/数字会让整批 422；object 完全宽容，由 import_data 内 isinstance + try 构造逐行跳过
    applications: list[object] = Field(..., description="投递记录列表")
    # 与 applications 同口径：list[object] 宽容单条坏行，由 import_data 内 isinstance(log, dict) 跳过，
    # 避免手改/三方文件里 apply_logs 含非 dict 元素时整批 422
    apply_logs: list[object] | None = Field(
        None, description="投递日志（导入时按 application_id 映射落库恢复，避免迁移丢失追溯历史）"
    )

    @field_validator("apply_logs", mode="before")
    @classmethod
    def _apply_logs_coerce(cls, v: object) -> object:
        # 字段本身非数组（手改/三方文件把 apply_logs 写成对象/字符串）→ 视为无日志，丢弃该段而非整批 422
        return v if isinstance(v, list) or v is None else None


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


def _add_apply_log(
    db: Session,
    application_id: int,
    action: str,
    detail: str = "",
) -> None:
    """写入一条投递操作日志（ApplyLog），供 GET /api/applications/{id}/logs 时间线展示。"""
    db.add(
        models.ApplyLog(
            application_id=application_id,
            action=action,
            detail=detail,
            created_at=datetime.now(),
        )
    )


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


@router.get("/api/applications/{application_id}/logs", response_model=ApplyLogListResponse)
def list_application_logs(
    application_id: int, db: Session = Depends(get_db)
) -> ApplyLogListResponse:
    """查询单条投递记录的操作日志时间线（登记 / 状态变更 / 字段更新），按时间倒序。"""
    if db.get(models.Application, application_id) is None:
        raise HTTPException(status_code=404, detail=f"投递记录不存在: id={application_id}")
    rows = (
        db.query(models.ApplyLog)
        .filter(models.ApplyLog.application_id == application_id)
        .order_by(models.ApplyLog.id.desc())
        .all()
    )
    return ApplyLogListResponse(
        application_id=application_id,
        items=[
            ApplyLogItem(
                id=r.id,
                action=r.action,
                detail=r.detail,
                created_at=r.created_at,
            )
            for r in rows
        ],
    )


def _to_item(r: models.Application) -> ApplicationItem:
    """ORM 记录 → 响应模型。"""
    return ApplicationItem(
        id=r.id,
        job_title=r.job_title,
        company=r.company,
        city=r.city,
        salary=r.salary,
        url=r.url,
        status=r.status,
        note=r.note,
        applied_at=r.applied_at,
        updated_at=r.updated_at,
    )


@router.post("/api/applications", response_model=ApplicationItem, status_code=201)
def create_application(
    payload: ApplicationCreate, db: Session = Depends(get_db)
) -> ApplicationItem:
    """登记一条投递记录（解决 UI 无新增入口的死胡同）。"""
    if payload.status not in _STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"非法状态: {payload.status}")
    # 先 strip 再校验非空：pydantic min_length=1 校验的是原始值，纯空格（'   '）能通过，
    # 存库前若 strip 后为空则直接拒绝，杜绝空白标题/公司入库。
    job_title = payload.job_title.strip()
    company = payload.company.strip()
    if not job_title or not company:
        raise HTTPException(status_code=400, detail="职位/公司不能为空")
    row = models.Application(
        job_title=job_title,
        company=company,
        city=payload.city.strip(),
        salary=payload.salary.strip(),
        url=payload.url.strip(),
        status=payload.status,
        note=payload.note.strip(),
        # 归一微秒：前端编辑恒发秒精度 'YYYY-MM-DDTHH:mm:ss'，若落库带微秒则首编辑必然被
        # update 的零变更检测判定为「applied_at 已变化」→ 误写日志并触发 updated_at 刷新
        applied_at=payload.applied_at or datetime.now().replace(microsecond=0),
    )
    db.add(row)
    db.flush()  # 先取主键 id，再写登记日志（ApplyLog.application_id 依赖它）
    _add_apply_log(db, row.id, "apply", f"登记投递：{row.company} · {row.job_title}")
    db.commit()
    db.refresh(row)
    return _to_item(row)


@router.patch("/api/applications/{application_id}", response_model=ApplicationItem)
def update_application(
    application_id: int, payload: ApplicationUpdate, db: Session = Depends(get_db)
) -> ApplicationItem:
    """更新投递记录（status/note/salary 等），仅覆盖传入字段。"""
    row = db.get(models.Application, application_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"投递记录不存在: id={application_id}")
    changes = payload.model_dump(exclude_unset=True)
    # status 显式 null 视为「保留原值」而非非法：与 city/salary/url/note 等可选字段 None continue 一致
    if "status" in changes and changes["status"] is not None and changes["status"] not in _STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"非法状态: {changes['status']}")
    old_status = row.status
    applied_changes = set()  # 实际发生了值变化的字段（用于日志；零变更保存不写无意义日志）
    for key, value in changes.items():
        if value is None:
            if key == "applied_at":
                # 显式清空 applied_at：存 NULL（schema v2 applied_at 可空），语义为「未设置」——
                # 仅新建记录缺省取当前时间，历史修正清空旧日期不再静默改成今天
                if row.applied_at is not None:
                    row.applied_at = None
                    applied_changes.add("applied_at")
            # status 等其他可选字段 null → 保留原值
            continue
        # job_title/company 与 create_application 同口径：strip 后判空，杜绝 PATCH 直传纯空格覆盖为空白
        if key in ("job_title", "company") and isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise HTTPException(status_code=400, detail="职位/公司不能为空")
            if getattr(row, key) != stripped:
                setattr(row, key, stripped)
                applied_changes.add(key)
            continue
        # datetime 字段（applied_at/updated_at）比较前归一微秒：create 落库为秒精度，
        # 前端编辑回传同为秒精度，避免「值未变却因微秒差异」误判变化而误写日志
        if isinstance(value, datetime):
            cur = getattr(row, key, None)
            norm_v = value.replace(microsecond=0)
            norm_cur = cur.replace(microsecond=0) if isinstance(cur, datetime) else cur
            if norm_cur != norm_v:
                setattr(row, key, norm_v)
                applied_changes.add(key)
            continue
        if getattr(row, key, None) != value:
            setattr(row, key, value)
            applied_changes.add(key)
    # 写投递操作日志：仅当有实际值变化才写（状态变更记 action=status，其余记 action=update），
    # 零变更保存（编辑弹窗全量回传但值未变）不落日志，避免时间线被无意义条目污染。
    # 同批同时变更 status 与其它字段时两条都写：status 日志只记状态变化（不重复字段清单），
    # 字段变更明细由独立 update 日志独占，避免同一字段名在时间线里重复出现。
    if "status" in applied_changes:
        _add_apply_log(db, row.id, "status", f"状态变更：{old_status} → {row.status}")
    if applied_changes - {"status"}:
        _add_apply_log(
            db, row.id, "update",
            "更新字段：" + "、".join(sorted(applied_changes - {"status"})),
        )
    db.commit()
    db.refresh(row)
    return _to_item(row)


@router.delete("/api/applications/{application_id}")
def delete_application(application_id: int, db: Session = Depends(get_db)) -> dict:
    """删除投递记录（级联清理 apply_logs）。"""
    row = db.get(models.Application, application_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"投递记录不存在: id={application_id}")
    db.delete(row)
    db.commit()
    return {"deleted": application_id}


@router.post("/api/import")
def import_data(payload: ImportPayload, db: Session = Depends(get_db)) -> dict:
    """导入导出 JSON（GET /api/export 格式）：按 id 覆盖已有、新建缺失，返回导入条数。

    apply_logs 一并落库：按旧 application_id → 新 id 映射恢复投递操作日志，
    保证「导出→换机→导入」不丢失追溯历史；旧 id 无对应记录的日志跳过。
    """
    imported = 0  # 处理总数（created + updated，兼容旧前端 importedCount=imported-updated 算法）
    created = 0
    updated = 0
    skipped = 0
    id_map: dict[int, int] = {}  # 旧 applications.id → 当前/新 applications.id
    for raw_item in payload.applications:
        # 逐行防御性构造：单条坏行（null/字符串/数字/字段类型错）计入 skipped 而非整批 422，
        # 保大批量历史修正/手工合并文件可部分导入（与 apply_logs 的 isinstance 跳过口径一致）
        if not isinstance(raw_item, dict):
            skipped += 1
            continue
        try:
            item = ImportItem(**raw_item)
        except (ValidationError, TypeError, ValueError):
            skipped += 1
            continue
        # 可选字段允许 null/缺失：以 (x or "").strip() 统一兜底空串（见 ImportItem 可空化注释）
        jt = (item.job_title or "").strip()
        co = (item.company or "").strip()
        # 逐行 url 卫生：scheme 非 http/https（或非法格式）→ 置空而非整批 422，保部分导入能力
        raw_url = (item.url or "").strip()
        try:
            url = _validate_url_scheme(raw_url) or ""
        except ValueError:
            url = ""
        # applied_at 宽松解析：合法 → 用解析值；非法/空串/显式 null（_parse_dt 返回 None）→ 存 NULL
        # （未设置）。不再把非法值降级为「当前时间」——Round 7 起 applied_at 语义为「未设置存 NULL」，
        # 降级 now 会把大量损坏导入批量写进今天，round-trip 非幂等且污染数据；非法行不中断整批
        # （continue 跳过），仅该行 applied_at 保持未设置。
        _applied_raw = item.applied_at
        applied_value = _parse_dt(_applied_raw)
        row = db.get(models.Application, item.id) if item.id else None
        if row is None:
            # 仅「新建」分支强制非空契约（对齐 create_application）：任一必填字段空 → 跳过该行，
            # 防空白标题/公司入库。更新分支不受此限（见下方 preserve-if-empty 部分更新语义）。
            if not jt or not co:
                skipped += 1
                continue
            row = models.Application(
                # 保留原 id：item.id 为正整数且未命中库时显式传入，维持「导出→清库→导入」id 连续性；
                # 同批重复 id 因上一步 db.get 已能查到同批新建行（flush 后），不会重复插入
                **({"id": item.id} if isinstance(item.id, int) and item.id > 0 else {}),
                job_title=jt,
                company=co,
                city=(item.city or "").strip(),
                salary=(item.salary or "").strip(),
                url=url,
                status=item.status if item.status in _STATUS_VALUES else "pending",
                note=(item.note or "").strip(),
                # schema v2：NULL applied_at 保持 NULL（未设置），不落今天，保证导出→导入往返语义一致
                applied_at=applied_value,
                updated_at=_parse_dt(item.updated_at) or datetime.now().replace(microsecond=0),
            )
            db.add(row)
            db.flush()  # 提前取新主键，供下方 apply_logs 映射落库
            created += 1
        else:
            # 更新分支 preserve-if-empty：空/缺失字段不覆盖已有值（与 job_title/company 同口径），
            # 避免部分导入（缺 city/salary/url/note 键）静默清空已有数据
            row.job_title = jt or row.job_title
            row.company = co or row.company
            row.city = (item.city or "").strip() or row.city
            row.salary = (item.salary or "").strip() or row.salary
            row.url = url or row.url
            if item.status in _STATUS_VALUES:
                row.status = item.status
            row.note = (item.note or "").strip() or row.note
            # applied_at/updated_at 用 model_fields_set 判断「显式传入」：导出含 applied_at:null 的
            # 记录可把目标已有日期清回 NULL（round-trip 还原未设置），缺失键则不动。
            # 仅当「显式 null」或「解析成功」才写入：出现于 model_fields_set 但解析失败/为空的非法字符串
            # （如 ''/'garbage'）保留目标已有日期，避免把有效日期误清成 NULL（preserve-if-empty 同口径）。
            if "applied_at" in item.model_fields_set and (item.applied_at is None or applied_value is not None):
                row.applied_at = applied_value
            if "updated_at" in item.model_fields_set:
                row_updated = _parse_dt(item.updated_at)
                if row_updated:
                    row.updated_at = row_updated
            updated += 1
        if item.id:
            id_map[item.id] = row.id
        imported += 1
    # 落库 apply_logs：仅恢复 application_id 能被映射到的日志（导出含日志时不再丢弃）
    for log in payload.apply_logs or []:
        if not isinstance(log, dict):
            continue
        old_app_id = log.get("application_id")
        new_app_id = id_map.get(old_app_id) if isinstance(old_app_id, int) else None
        if new_app_id is None:
            continue
        db.add(
            models.ApplyLog(
                application_id=new_app_id,
                action=str(log.get("action") or "apply")[:32],
                detail=str(log.get("detail") or ""),
                created_at=_parse_dt(log.get("created_at")) or datetime.now(),
            )
        )
    db.commit()
    # imported=处理总数（created+updated），created/updated 分离供前端「新增 X / 更新 Y」展示
    return {"imported": imported, "created": created, "updated": updated, "skipped": skipped}
