"""application_service 层测试（覆盖 data.py 拆 Service 后的 CRUD/统计/导入导出）。

用内存 SQLite（conftest.db_session fixture），隔离真实 backend/data/app.db。
"""
from __future__ import annotations

from app.schemas import ApplicationCreate, ApplicationUpdate, ImportPayload
from app.services import application_service as svc


def test_create_application(db_session):
    """创建记录：字段落库 + 写登记日志。"""
    item = svc.create_application(
        db_session,
        ApplicationCreate(job_title="测试职位", company="测试公司", city="北京", status="pending"),
    )
    assert item.id > 0
    assert item.job_title == "测试职位"
    assert item.company == "测试公司"
    logs = svc.list_application_logs(db_session, item.id)
    assert len(logs.items) == 1
    assert logs.items[0].action == "apply"


def test_create_reject_blank_title(db_session):
    """空白职位/公司拒绝（strip 后判空）。"""
    try:
        svc.create_application(
            db_session, ApplicationCreate(job_title="   ", company="公司")
        )
        assert False, "空白职位应拒绝"
    except Exception as e:
        assert "不能为空" in str(e)


def test_create_reject_bad_status(db_session):
    """非法状态拒绝。"""
    try:
        svc.create_application(
            db_session, ApplicationCreate(job_title="t", company="c", status="bogus")
        )
        assert False, "非法状态应拒绝"
    except Exception as e:
        assert "非法状态" in str(e)


def test_list_applications_filter(db_session):
    """分页 + 状态筛选 + 关键词搜索。"""
    svc.create_application(db_session, ApplicationCreate(job_title="前端开发", company="A公司", status="pending"))
    svc.create_application(db_session, ApplicationCreate(job_title="后端开发", company="B公司", status="offer"))
    svc.create_application(db_session, ApplicationCreate(job_title="全栈开发", company="A公司", status="pending"))

    page = svc.list_applications(db_session, page=1, page_size=10)
    assert page.total == 3
    assert len(page.items) == 3

    offer = svc.list_applications(db_session, status="offer")
    assert offer.total == 1

    search = svc.list_applications(db_session, keyword="A公司")
    assert search.total == 2


def test_update_application_status_and_log(db_session):
    """更新状态：字段生效 + 状态变更日志。"""
    item = svc.create_application(db_session, ApplicationCreate(job_title="t", company="c", status="pending"))
    updated = svc.update_application(
        db_session, item.id, ApplicationUpdate(status="offer")
    )
    assert updated.status == "offer"
    logs = svc.list_application_logs(db_session, item.id)
    actions = [l.action for l in logs.items]
    assert "apply" in actions and "status" in actions


def test_update_preserve_empty_fields(db_session):
    """更新时空字段保留原值（exclude_unset 语义）。"""
    item = svc.create_application(db_session, ApplicationCreate(job_title="t", company="c", city="北京"))
    updated = svc.update_application(db_session, item.id, ApplicationUpdate(note="新备注"))
    assert updated.city == "北京"  # 未传 city → 保留原值
    assert updated.note == "新备注"


def test_delete_application(db_session):
    """删除记录 + 404（不存在时）。"""
    item = svc.create_application(db_session, ApplicationCreate(job_title="t", company="c"))
    assert svc.delete_application(db_session, item.id) == {"deleted": item.id}
    try:
        svc.delete_application(db_session, item.id)
        assert False, "已删除应 404"
    except Exception as e:
        assert "不存在" in str(e)


def test_get_stats(db_session):
    """统计口径：total/offer/rejected/进行中 + 30 天趋势补 0。"""
    svc.create_application(db_session, ApplicationCreate(job_title="a", company="x", status="pending"))
    svc.create_application(db_session, ApplicationCreate(job_title="b", company="x", status="offer"))
    svc.create_application(db_session, ApplicationCreate(job_title="c", company="x", status="rejected"))
    stats = svc.get_stats(db_session)
    assert stats.total == 3
    assert stats.applying == 1  # pending 在 _ACTIVE_STATUS
    assert stats.offer_count == 1
    assert stats.rejected == 1
    assert len(stats.daily_trend) == 30  # 30 天补 0 连续


def test_import_data_create_and_update(db_session):
    """导入：新建缺失 + 覆盖已有 + 坏行跳过。"""
    # 先建一条 id=1 的记录，导入时覆盖
    created = svc.create_application(db_session, ApplicationCreate(job_title="旧", company="c"))
    payload = ImportPayload(applications=[
        {"id": created.id, "job_title": "更新后", "company": "c"},
        {"job_title": "新导入", "company": "新公司"},  # 无 id → 新建
        "坏行",  # 非 dict → 跳过
    ])
    result = svc.import_data(db_session, payload)
    assert result["updated"] == 1
    assert result["created"] == 1
    assert result["skipped"] == 1
    assert result["imported"] == 2
    # 覆盖生效
    item = svc.list_application_ids(db_session)
    assert created.id in item


def test_export_data_structure(db_session):
    """导出：结构完整（applications/apply_logs/settings）。"""
    svc.create_application(db_session, ApplicationCreate(job_title="t", company="c"))
    data = svc.export_data(db_session)
    assert "applications" in data and "apply_logs" in data and "settings" in data
    assert len(data["applications"]) == 1
