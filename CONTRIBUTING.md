# Contributing to BossJobAI

First off, thanks for taking the time to contribute! 🎉

BossJobAI is a privacy-first, local-first job-search assistant. We welcome all kinds of contributions — bug reports, feature ideas, documentation, and code.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Features](#suggesting-features)
  - [Submitting Code](#submitting-code)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. **Fork** the repository and clone it locally.
2. Follow the [Quick Start](README.md#quick-start) to run the app from source.
3. Make your changes on a **feature branch** (never commit directly to `master`).

## How to Contribute

### Reporting Bugs

Open an [issue](https://github.com/SpiralQWQ/bossjob-ai/issues) with:

- A clear, descriptive title.
- Steps to reproduce (include OS, Python/Node versions).
- Expected vs. actual behavior.
- Screenshots or logs if applicable.

### Suggesting Features

Open a [discussion](https://github.com/SpiralQWQ/bossjob-ai/discussions) or an issue tagged `enhancement`:

- Explain the problem you're solving (not just the feature name).
- Sketch how it fits the existing architecture (see [docs/architecture-design-v0.2.md](docs/architecture-design-v0.2.md)).

### Submitting Code

1. Fork & clone, create a branch (`fix/…`, `feat/…`, `docs/…`, `refactor/…`).
2. Make focused, reviewable changes — one logical change per PR.
3. Add or update tests where applicable (see [verify scripts](#coding-standards)).
4. Push and open a Pull Request against `master`.

## Development Setup

```powershell
# backend
cd code\backend
python -m venv .venv && .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# frontend
cd code\frontend
npm install

# electron
cd code\electron
npm install
```

## Coding Standards

- **Python**: follow the existing style (PEP 8, type hints `from __future__ import annotations`, docstrings in Chinese matching the surrounding code).
- **TypeScript/React**: strict TS (`strict: true`), follow existing component patterns.
- **No hardcoded secrets or absolute paths** — configuration comes from `settings.json` / env / constants.
- **Security matters**: this project has a strict security baseline. Any change touching IPC, auth, CSP, or file handling must preserve the existing guards.
- **Verification gates** (run before submitting):
  ```powershell
  cd code\frontend
  node scripts/verify-csp.mjs        # CSP 断言
  node scripts/verify-dist.mjs       # dist 与源码同步
  cd ..\electron
  node scripts/verify-endpoint-whitelist.cjs   # 端点白名单回归
  ```

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

feat: 新增简历 PDF 解析
fix(settings): 修复 cities 空数组崩溃
docs: 更新 README 快速开始
refactor(backend): 收敛配置加载
security: 收紧备份校验和
perf(electron): 优化导出路径
```

Types: `feat` / `fix` / `docs` / `refactor` / `perf` / `security` / `test` / `chore`.

> Versioning rule: a release requires bumping **all three** version files together (`backend/app/constants.py` `APP_VERSION`, `electron/package.json`, `frontend/package.json`) and updating [CHANGELOG.md](CHANGELOG.md).

## Pull Request Process

1. PR title follows the commit convention above.
2. Describe what & why, and how you verified it (tests run, smoke checks).
3. Ensure CI (`.github/workflows/ci.yml`) is green.
4. A maintainer will review; keep changes rebased on `master`.

---

*Questions? Open a [discussion](https://github.com/SpiralQWQ/bossjob-ai/discussions).*
