"""投递记录业务逻辑层（瘦身解耦：Route → Service → Model）。

把 routers/data.py 的 CRUD/统计/导入导出逻辑抽离：路由只负责参数校验与响应映射，
核心业务收敛于此，db: Session 显式传入（供路由依赖注入与后续自动化测试复用）。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models
from app.schemas import (
    ApplicationCreate,
    ApplicationItem,
    ApplicationListResponse,
    ApplyLogItem,
    ApplyLogListResponse,
    DailyTrendItem,
    ImportItem,
    ImportPayload,
    StatsResponse,
    _parse_dt,
    _validate_url_scheme,
)

# 合法状态枚举（与 README §6 / 前端 STATUS_TEXT / _ACTIVE_STATUS 口径一致）
_STATUS_VALUES = ("pending", "replied", "interview", "offer", "rejected", "closed")
_ACTIVE_STATUS = ("pending", "replied", "interview")
_OFFER_STATUS = ("offer",)
_REJECTED_STATUS = ("rejected", "closed")


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


def list_applications(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    status: str | None = None,
    keyword: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    date: str | None = None,
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
        items=[_to_item(r) for r in rows],
    )


def list_application_ids(db: Session) -> list[int]:
    """返回库内全部投递记录的 id 列表（轻量端点，仅查单列）。

    Electron 主进程 preview-import-data 用它统计『即将覆盖的 id 数』：
    只取 id 单列（SELECT applications.id），避免为计数而拉取整份 /api/export。
    """
    rows = db.query(models.Application.id).all()
    return [row[0] for row in rows]


def get_stats(db: Session) -> StatsResponse:
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


def export_data(db: Session) -> dict:
    """导出全部业务数据为 JSON（隐私优先，供用户落盘带走）。"""
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


def list_application_logs(db: Session, application_id: int) -> ApplyLogListResponse:
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


def create_application(db: Session, payload: ApplicationCreate) -> ApplicationItem:
    """登记一条投递记录。"""
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
        applied_at=payload.applied_at or datetime.now().replace(microsecond=0),
    )
    db.add(row)
    db.flush()  # 先取主键 id，再写登记日志
    _add_apply_log(db, row.id, "apply", f"登记投递：{row.company} · {row.job_title}")
    db.commit()
    db.refresh(row)
    return _to_item(row)


def update_application(db: Session, application_id: int, payload: ApplicationUpdate) -> ApplicationItem:
    """更新投递记录（status/note/salary 等），仅覆盖传入字段。"""
    row = db.get(models.Application, application_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"投递记录不存在: id={application_id}")
    changes = payload.model_dump(exclude_unset=True)
    if "status" in changes and changes["status"] is not None and changes["status"] not in _STATUS_VALUES:
        raise HTTPException(status_code=400, detail=f"非法状态: {changes['status']}")
    old_status = row.status
    applied_changes = set()  # 实际发生了值变化的字段（零变更保存不写无意义日志）
    for key, value in changes.items():
        if value is None:
            if key == "applied_at":
                if row.applied_at is not None:
                    row.applied_at = None
                    applied_changes.add("applied_at")
            continue
        if key in ("job_title", "company") and isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise HTTPException(status_code=400, detail="职位/公司不能为空")
            if getattr(row, key) != stripped:
                setattr(row, key, stripped)
                applied_changes.add(key)
            continue
        # datetime 字段比较前归一微秒：避免「值未变却因微秒差异」误判变化而误写日志
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


def delete_application(db: Session, application_id: int) -> dict:
    """删除投递记录（级联清理 apply_logs）。"""
    row = db.get(models.Application, application_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"投递记录不存在: id={application_id}")
    db.delete(row)
    db.commit()
    return {"deleted": application_id}


def import_data(db: Session, payload: ImportPayload) -> dict:
    """导入导出 JSON（GET /api/export 格式）：按 id 覆盖已有、新建缺失，返回导入条数。"""
    from pydantic import ValidationError

    imported = 0
    created = 0
    updated = 0
    skipped = 0
    id_map: dict[int, int] = {}  # 旧 applications.id → 当前/新 applications.id
    for raw_item in payload.applications:
        if not isinstance(raw_item, dict):
            skipped += 1
            continue
        try:
            item = ImportItem(**raw_item)
        except (ValidationError, TypeError, ValueError):
            skipped += 1
            continue
        jt = (item.job_title or "").strip()
        co = (item.company or "").strip()
        raw_url = (item.url or "").strip()
        try:
            url = _validate_url_scheme(raw_url) or ""
        except ValueError:
            url = ""
        _applied_raw = item.applied_at
        applied_value = _parse_dt(_applied_raw)
        row = db.get(models.Application, item.id) if item.id else None
        if row is None:
            if not jt or not co:
                skipped += 1
                continue
            row = models.Application(
                **({"id": item.id} if isinstance(item.id, int) and item.id > 0 else {}),
                job_title=jt,
                company=co,
                city=(item.city or "").strip(),
                salary=(item.salary or "").strip(),
                url=url,
                status=item.status if item.status in _STATUS_VALUES else "pending",
                note=(item.note or "").strip(),
                applied_at=applied_value,
                updated_at=_parse_dt(item.updated_at) or datetime.now().replace(microsecond=0),
            )
            db.add(row)
            db.flush()
            created += 1
        else:
            row.job_title = jt or row.job_title
            row.company = co or row.company
            row.city = (item.city or "").strip() or row.city
            row.salary = (item.salary or "").strip() or row.salary
            row.url = url or row.url
            if item.status in _STATUS_VALUES:
                row.status = item.status
            row.note = (item.note or "").strip() or row.note
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
    return {"imported": imported, "created": created, "updated": updated, "skipped": skipped}
