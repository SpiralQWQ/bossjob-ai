"""投递记录路由层（瘦身解耦后：只做参数校验与响应映射，业务逻辑在 services/application_service）。

改动说明：把原先混在此文件的 CRUD/统计/导入导出逻辑抽离到 services/application_service.py，
schemas 模型迁至 app/schemas.py。行为保持一致（纯代码移动 + 依赖注入调整）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import (
    ApplicationCreate,
    ApplicationItem,
    ApplicationListResponse,
    ApplicationUpdate,
    ApplyLogListResponse,
    ImportPayload,
    StatsResponse,
)
from app.services import application_service

router = APIRouter(tags=["data"])


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
    """分页查询投递记录。"""
    return application_service.list_applications(
        db, page=page, page_size=page_size, status=status, keyword=keyword,
        date_from=date_from, date_to=date_to, date=date,
    )


@router.get("/api/applications/ids")
def list_application_ids(db: Session = Depends(get_db)) -> list[int]:
    """返回库内全部投递记录的 id 列表（轻量端点，仅查单列）。"""
    return application_service.list_application_ids(db)


@router.get("/api/stats", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)) -> StatsResponse:
    """求职看板统计。"""
    return application_service.get_stats(db)


@router.get("/api/export")
def export_data(db: Session = Depends(get_db)) -> dict:
    """导出全部业务数据为 JSON（隐私优先）。"""
    return application_service.export_data(db)


@router.get("/api/applications/{application_id}/logs", response_model=ApplyLogListResponse)
def list_application_logs(
    application_id: int, db: Session = Depends(get_db)
) -> ApplyLogListResponse:
    """查询单条投递记录的操作日志时间线。"""
    return application_service.list_application_logs(db, application_id)


@router.post("/api/applications", response_model=ApplicationItem, status_code=201)
def create_application(
    payload: ApplicationCreate, db: Session = Depends(get_db)
) -> ApplicationItem:
    """登记一条投递记录。"""
    return application_service.create_application(db, payload)


@router.patch("/api/applications/{application_id}", response_model=ApplicationItem)
def update_application(
    application_id: int, payload: ApplicationUpdate, db: Session = Depends(get_db)
) -> ApplicationItem:
    """更新投递记录（仅覆盖传入字段）。"""
    return application_service.update_application(db, application_id, payload)


@router.delete("/api/applications/{application_id}")
def delete_application(application_id: int, db: Session = Depends(get_db)) -> dict:
    """删除投递记录（级联清理 apply_logs）。"""
    return application_service.delete_application(db, application_id)


@router.post("/api/import")
def import_data(payload: ImportPayload, db: Session = Depends(get_db)) -> dict:
    """导入导出 JSON：按 id 覆盖已有、新建缺失，返回导入条数。"""
    return application_service.import_data(db, payload)
