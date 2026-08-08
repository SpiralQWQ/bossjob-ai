# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec —— 后端 bossjob-backend（console，单文件夹模式）。

产物（配合 BUILD.md 的 --distpath 参数）：
    code/backend/dist/bossjob-backend/bossjob-backend.exe

说明：
  - 后端应用本体入口为 ``backend/app/main.py``（FastAPI app，模块 ``app.main``）。
    本 spec 的启动脚本是 ``packaging/backend_entry.py`` —— 它导入 ``app.main`` 并以
    uvicorn 启动，从而使 PyInstaller 能产出真正可运行的后端 exe（main.py 本身不调用
    uvicorn.run，不能直接作为可执行脚本打包）。
  - 收集 ``app`` 包全部子模块 + uvicorn/fastapi/sqlalchemy/pydantic 运行时依赖。
    collect_all 属兜底策略；正常情况下 pyinstaller-hooks-contrib 已覆盖大部分。
  - 名称 bossjob-backend，console=True（Electron 以 CREATE_NO_WINDOW 隐藏黑框）。
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

# ---------------------------------------------------------------------------
# 路径：SPECPATH 由 PyInstaller 注入，指向本 spec 所在目录 packaging/
# ---------------------------------------------------------------------------
SPEC_DIR = Path(SPECPATH)
PROJECT_ROOT = SPEC_DIR.parent          # code/
BACKEND_DIR = PROJECT_ROOT / "backend"  # code/backend

# 让 collect_* 在解析阶段能定位到 app 包（app 仅在 backend/ 下可 import）
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(PROJECT_ROOT))


def _safe_collect(pkg: str) -> tuple[list, list, list]:
    """``collect_all`` 的容错封装：某个包收集失败不阻断整体构建。"""
    try:
        datas, binaries, hiddenimports = collect_all(pkg)
        return datas, binaries, hiddenimports
    except Exception as exc:  # noqa: BLE001 —— 打包阶段容错，失败仅跳过该包
        print(f"[backend.spec] 警告：collect_all('{pkg}') 失败，已跳过（{exc}）")
        return [], [], []


def _safe_submodules(pkg: str) -> list:
    """``collect_submodules`` 的容错封装。"""
    try:
        return collect_submodules(pkg)
    except Exception as exc:  # noqa: BLE001
        print(f"[backend.spec] 警告：collect_submodules('{pkg}') 失败，已跳过（{exc}）")
        return []


# ---------------------------------------------------------------------------
# 收集运行时依赖
# ---------------------------------------------------------------------------
d_uvicorn, b_uvicorn, h_uvicorn = _safe_collect("uvicorn")
d_fastapi, b_fastapi, h_fastapi = _safe_collect("fastapi")
d_sqlalchemy, b_sqlalchemy, h_sqlalchemy = _safe_collect("sqlalchemy")
d_pydantic, b_pydantic, h_pydantic = _safe_collect("pydantic")

# app 包全部子模块（main/config/db/models/schemas/routers/...）
hidden_app = _safe_submodules("app")

a = Analysis(
    [SPEC_DIR / "backend_entry.py"],
    pathex=[str(BACKEND_DIR), str(PROJECT_ROOT)],
    binaries=b_uvicorn + b_fastapi + b_sqlalchemy + b_pydantic,
    datas=d_uvicorn + d_fastapi + d_sqlalchemy + d_pydantic,
    hiddenimports=hidden_app + h_uvicorn + h_fastapi + h_sqlalchemy + h_pydantic,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],  # 桌面 GUI 无关，削减体积
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # 单文件夹模式：二进制由下方 COLLECT 统一收集
    name="bossjob-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # 控制台应用
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="bossjob-backend",
)
