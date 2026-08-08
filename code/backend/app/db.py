"""SQLAlchemy 数据层：engine / SessionLocal / Base。

- SQLite 数据库文件：backend/data/app.db（目录不存在则自动创建）。
- SQLite 需关闭线程检查（FastAPI 多线程访问本地连接）。
- 所有表创建统一走 init_db()（在应用启动时调用）。
- schema 版本用 SQLite user_version PRAGMA 管理：P1-P7 新增业务表时递增
  DB_SCHEMA_VERSION 并在 init_db() 中执行对应迁移，防止升级后旧库不兼容。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app.constants import DATA_DIR, DB_PATH

# 当前 schema 版本（与 electron/main.js 的 DB_SCHEMA_VERSION 对齐，改版须同步）
# v2: applications.applied_at 由 NOT NULL 改为可空（清空投递时间=未设置，历史修正不再落今天）
# v3: applications.applied_at 建索引（日期过滤/看板趋势/列表排序 datetime 区间比较走索引，避免全表扫描）
DB_SCHEMA_VERSION: int = 3

# 创建数据目录（幂等）
DATA_DIR.mkdir(parents=True, exist_ok=True)

# as_posix()：避免 Windows 反斜杠路径拼接问题
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH.as_posix()}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},  # FastAPI 多线程场景必需
    future=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)

Base = declarative_base()


def get_db():
    """FastAPI 依赖注入：每请求一个会话，请求结束自动关闭。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_schema_version(db_path: Path | None = None) -> int:
    """读取指定 SQLite 文件的 user_version（schema 版本）；缺省读取应用 DB，文件不存在返回 0。"""
    target = Path(db_path) if db_path else DB_PATH
    if not target.exists():
        return 0
    check_engine = create_engine(f"sqlite:///{target.as_posix()}")
    try:
        with check_engine.connect() as conn:
            return int(conn.execute(text("PRAGMA user_version")).scalar() or 0)
    finally:
        check_engine.dispose()


def _run_migrations(conn, current: int) -> None:
    """按序执行 schema 迁移（版本单调递增，每次改动在此追加对应迁移分支）。

    当前迁移：
    - v1→v2（applied_at 可空）：SQLite 无法 ALTER COLUMN 改 NOT NULL，采用「重建表」三步法——
      rename 旧表 → 按新 schema 建表 → INSERT SELECT 搬迁数据 → drop 旧表，并重建 status 索引。
      外键由 apply_logs.application_id 指向 applications，重建同名新表后引用关系保持不变。
    - v2→v3（applied_at 索引）：CREATE INDEX，纯增量无需重建表。
    """
    from app import models  # noqa: F401  # 确保新表结构来自 models（CREATE TABLE 显式列即新 schema）

    # 崩溃残留防护：上次迁移中断可能残留 applications_v1 且 user_version 仍旧；
    # 先清理残留表，否则后续 ALTER TABLE RENAME 会因表已存在抛错，后端无法启动
    if current < 2:
        conn.execute(text("DROP TABLE IF EXISTS applications_v1"))
        # v1 → v2：applications.applied_at NOT NULL → NULL（清空投递时间=未设置）
        # RENAME 会把索引一并带到 applications_v1（索引名不变），故先 DROP 再重建，避免同名冲突
        conn.execute(text("DROP INDEX IF EXISTS ix_applications_status"))
        conn.execute(text("ALTER TABLE applications RENAME TO applications_v1"))
        conn.execute(
            text(
                "CREATE TABLE applications ("
                "id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "
                "job_title VARCHAR(255) NOT NULL, "
                "company VARCHAR(255) NOT NULL, "
                "city VARCHAR(64) NOT NULL DEFAULT '', "
                "salary VARCHAR(128) NOT NULL DEFAULT '', "
                "url TEXT NOT NULL DEFAULT '', "
                "status VARCHAR(32) NOT NULL DEFAULT 'pending', "
                "note TEXT NOT NULL DEFAULT '', "
                "applied_at DATETIME, "
                "updated_at DATETIME NOT NULL)"
            )
        )
        conn.execute(text("CREATE INDEX ix_applications_status ON applications (status)"))
        conn.execute(
            text(
                "INSERT INTO applications (id, job_title, company, city, salary, url, status, note, applied_at, updated_at) "
                "SELECT id, job_title, company, city, salary, url, status, note, applied_at, updated_at "
                "FROM applications_v1"
            )
        )
        conn.execute(text("DROP TABLE applications_v1"))
    # v2 → v3：applications.applied_at 建索引（幂等：IF NOT EXISTS）
    if current < 3:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_applications_applied_at ON applications (applied_at)"))


def init_db() -> None:
    """初始化数据层：导入全部模型注册到 Base.metadata 后建表，并维护 schema 版本。

    - 版本落后于当前：按序执行 _run_migrations 后写入 DB_SCHEMA_VERSION。
    - 版本高于当前：数据库来自更新版本应用，不降级仅告警（恢复前由主进程校验版本拒绝不兼容备份）。
    """
    import app.models  # noqa: F401  # 仅用于把 ORM 模型注册到 Base.metadata

    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        current = int(conn.execute(text("PRAGMA user_version")).scalar() or 0)
        # 全新库（user_version=0）：create_all 已建好当前 schema，无需跑历史重建迁移，直接写版本。
        # 仅旧库（current>=1 且 < DB_SCHEMA_VERSION）才逐版本迁移，避免全新库冗余重建表 + 崩溃残留死锁。
        if current < DB_SCHEMA_VERSION:
            if current > 0:
                _run_migrations(conn, current)
            conn.execute(text(f"PRAGMA user_version = {DB_SCHEMA_VERSION}"))
        elif current > DB_SCHEMA_VERSION:
            import logging

            logging.getLogger(__name__).warning(
                "数据库 schema 版本 %s 高于当前程序支持 %s，请升级应用后再使用。",
                current,
                DB_SCHEMA_VERSION,
            )
