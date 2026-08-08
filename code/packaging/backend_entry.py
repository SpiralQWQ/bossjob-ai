"""bossjob-backend 可执行入口（PyInstaller 打包专用）。

被打包的后端应用本体位于 ``backend/app/main.py``（FastAPI app，模块名 ``app.main``）。
PyInstaller 需要一个"可执行"的脚本入口，本文件负责：

1. 解析监听端口（优先级：环境变量 ``BOSS_PORT`` > ``settings.json`` 的 ``port`` 字段）；
2. 用 uvicorn 启动 ``app.main`` 导出的 FastAPI app，仅监听 ``127.0.0.1``。

端口解析刻意不重复实现校验逻辑、也不写死默认端口：
- ``BOSS_PORT`` 由 Electron 主进程注入（``electron/main.js`` 已做过 1024~65535 区间校验）；
- 兜底直接复用 ``app.config.settings.port``（pydantic 已按 ``ge=1024, le=65535`` 校验）。

打包注意事项（架构 v0.2 H4，详见 ``packaging/BUILD.md``）：
- 冻结（frozen）模式下，``app/constants.py`` 中基于 ``__file__`` 推导的项目根会落在
  PyInstaller 的临时目录里，正式发布前需按 BUILD.md「打包前必要代码改造」一节校准
  ``settings.json`` 与 ``data`` 目录位置（改指向可写目录，如 ``%APPDATA%``）。
"""

from __future__ import annotations

import os


def _resolve_port() -> int:
    """解析后端监听端口：``BOSS_PORT`` 环境变量优先，其次 ``settings.json``。"""
    env_port = os.environ.get("BOSS_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            pass  # 非法值忽略，交给 settings.json / 默认配置兜底

    # app.config 内部已按「env > settings.json > 默认值」解析，且 pydantic 校验区间
    from app.config import settings

    return settings.port


def main() -> int:
    """引导 uvicorn 加载 ``backend/app/main.py`` 中的 FastAPI app。"""
    import uvicorn

    # 真正的后端入口模块：backend/app/main.py（由本脚本引导启动）
    from app.main import app as fastapi_app

    port = _resolve_port()
    print(f"[bossjob-backend] serving http://127.0.0.1:{port}")
    uvicorn.run(
        fastapi_app,
        host="127.0.0.1",
        port=port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
