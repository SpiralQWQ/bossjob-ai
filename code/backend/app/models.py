"""ORM 模型。

业务表：Application（投递记录）/ ApplyLog（投递操作日志，P5 规划落地）。
后续里程碑在此扩展：
- P1 简历：Resume
- P2 岗位：Job / MatchReport
- P6 面试：InterviewSession / Conversation
"""

from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.db import Base

__all__ = ["Base", "Application", "ApplyLog"]


class Application(Base):
    """投递记录：一次对某个岗位的求职投递。

    status 使用受控枚举字符串（pending/replied/interview/offer/rejected/closed），
    与前端状态映射、GET /api/stats 看板统计口径保持一致。
    """

    __tablename__ = "applications"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_title = Column(String(255), nullable=False)
    company = Column(String(255), nullable=False)
    city = Column(String(64), nullable=False, default="")
    salary = Column(String(128), nullable=False, default="")
    url = Column(Text, nullable=False, default="")
    status = Column(String(32), nullable=False, default="pending", index=True)
    note = Column(Text, nullable=False, default="")
    # applied_at 允许 NULL（清空=未设置）：仅新建缺省取当前时间，历史修正清空旧日期不落今天。
    # 注意：不能再挂 default=datetime.now —— SQLAlchemy 对 INSERT 时值为 None 的列会自动应用列默认值，
    # 会让 import {applied_at:null} 落成今天（破坏导出→导入往返）；新建「缺省取当前时间」已由
    # create_application 显式 `payload.applied_at or datetime.now()` 承担，此处无需列默认。
    # index=True：日期过滤/看板趋势/列表排序走 datetime 区间比较，索引避免 50 万行全表扫描
    applied_at = Column(DateTime, nullable=True, index=True)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    logs = relationship(
        "ApplyLog",
        back_populates="application",
        cascade="all, delete-orphan",
    )


class ApplyLog(Base):
    """投递操作日志：记录每次投递尝试（用于追溯重复投递 / 超限拦截等行为）。"""

    __tablename__ = "apply_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    application_id = Column(
        Integer,
        ForeignKey("applications.id"),
        nullable=False,
        index=True,
    )
    action = Column(String(32), nullable=False, default="apply")
    detail = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=datetime.now)

    application = relationship(
        "Application",
        back_populates="logs",
    )
