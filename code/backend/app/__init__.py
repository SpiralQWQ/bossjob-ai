"""BOSS直聘 AI 求职助手 · 后端应用包。

模块划分（严格模块化）：
- constants.py  全局常量（路径/版本/默认端口），禁止在业务代码中硬编码
- config.py     配置加载（settings.json / env）
- db.py         SQLAlchemy engine/session/Base（SQLite）
- models.py     ORM 模型（P0 骨架暂无业务表）
- schemas.py    Pydantic 响应模型
- routers/      API 路由（health / settings）
- main.py       FastAPI 入口
"""
