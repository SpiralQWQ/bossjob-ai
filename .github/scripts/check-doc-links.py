#!/usr/bin/env python3
"""CI 用：Markdown 相对链接健全性检查。

遍历仓库内所有 .md/.markdown 文件，解析 [text](link) 中的相对链接，
校验目标文件是否存在（锚点 # 后部分忽略；外部 http/https/mailto 跳过）。

用法：python check-doc-links.py [repo_root]（缺省为脚本所在仓库根 = 上级两级）。
"""

import os
import re
import sys

_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def main() -> int:
    root = os.path.normpath(
        os.path.abspath(sys.argv[1])
        if len(sys.argv) > 1
        else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    broken: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过构建产物与依赖目录
        dirnames[:] = [
            d for d in dirnames
            if d not in (".git", "node_modules", "dist", ".venv", "venv", "__pycache__")
        ]
        for fn in filenames:
            if not fn.endswith((".md", ".markdown")):
                continue
            path = os.path.join(dirpath, fn)
            try:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
            except (OSError, UnicodeDecodeError):
                continue
            for match in _LINK_RE.finditer(text):
                link = match.group(1)
                if link.startswith(("http://", "https://", "#", "mailto:")):
                    continue
                target = link.split("#")[0]
                if not target:
                    continue
                full = os.path.normpath(os.path.join(dirpath, target.replace("/", os.sep)))
                if not os.path.exists(full):
                    broken.append(f"{os.path.relpath(path, root)}: {link}")
    if broken:
        print("Broken relative links:")
        for item in broken:
            print(" -", item)
        return 1
    print("All Markdown relative links OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
