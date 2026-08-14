# Changelog

本文件记录 **BossJobAI** 的全部重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.7] — 2026-08-13

### Added（新增）
- **开源发布打磨**：中英双语 README 按开源规范重写（徽章、快速开始、功能表、API 参考、安全基线、贡献与协议章节）。
- **贡献指南**（[CONTRIBUTING.md](CONTRIBUTING.md)）、**安全政策**（[SECURITY.md](SECURITY.md)）与**行为准则**（[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)）。
- **CI 工作流**（`.github/workflows/ci.yml`）——push 与 PR 时前端构建 + CSP / 端点白名单校验门禁。
- **Issue / PR 模板**（`.github/`）。
- `.gitattributes`（行尾归一化）与 `.editorconfig`（编辑器一致性）。

### Changed（变更）
- 统一 Electron 打包配置：`electron/package.json` 不再携带重复的 `build` 字段；`npm run pack` / `npm run dist` 显式使用单一事实源 `packaging/electron-builder.yml`（修复了一条会静默打出「缺 Python 后端」安装包的路径）。
- `packaging/electron-builder.yml` 的 `files` 清单补入 `backend-default-port.cjs`（`electron/main.js` 运行时必需）。
- 全库文档/注释版本引用从陈旧的 `0.1.0` 同步到当前发布版本（`health.py` docstring、`electron-builder.yml`、接口文档与架构文档）。
- README_zh 配置示例与随包模板对齐（`cities` 空数组）。

### Fixed（修复）
- `README_zh.md` 中路径的控制字符损坏（退格/换页符）——`code\backend`、`code\frontend` 现可正常显示。

### Security（安全）
- 全库隐私 / 硬编码密钥扫描通过：源码树中无真实 PII、凭据、API Key 或绝对路径（本版本已核验）。

## [0.1.6] — 2026-08-06

P1a 简历素材库 + RAG 知识库（P1 前置调研交付，内部使用不随仓库分发）。

### Changed（变更）
- **版本号统一**：三处 `APP_VERSION` / `electron/package.json` / `frontend/package.json` 从 0.1.0 同步到 0.1.6。

### Added（新增）
- **简历素材库**：GitHub 扫描 34 关键词 → 200 个简历/文档/求职生态仓库（1k+ star 优先）隔离 clone 至本地调研语料（不随本仓库分发）；《简历知识库_详细内容.md》1194 行——方法论（FAB/STAR/ATS）、JSON Resume Schema、分岗位模板、中英例句/Cover Letter、AI 优化模型（resumePolice/career-ops）。
- **RAG 索引**：bge-m3 1024 维，40,367 块 × 200/200 仓全覆盖（GPU CUDA 加速）；`build_rag.py`（文档全量 + 源码每仓抽样）、`check_coverage.py`（覆盖检查）、`test_rag.py`（36 条人工查询 100%）、`test_rag_2000.py`（2000 次压力测试 **99.8% ≥98% 达标**）。

## [0.1.5] — 2026-08-06

### Added（新增）
- **文档**：新增《接口文档 v0.1》（`docs/api-docs-v0.1.md`）——架构三层总览、鉴权模型、12 个后端 HTTP 接口（含索引表/参数/请求响应/错误码）、26 个 Electron IPC 通道（含索引表/语义）、数据模型与 schema 迁移、配置项、安全基线、修订记录；与 README 接口表交叉验证一致。

## [0.1.4] — 2026-08-06

回归收敛 + 最终验收。

### Fixed（修复）
- **面试页**：无法解析块的保留/重建修复（回填标记拆分）；面试形式 Select 加 `allowClear`；手写时间只读提示 + 移除按钮。
- **high 回归**：`cities` 列表被误展开崩溃修复；import-data 成功路径 ReferenceError 修复。
- **设置**：`apply.interval_seconds` 非空约束（恢复 + 导入两侧）；LLM 未接入时 onFinish 不再回传 llm 段（解除配置保存死锁）；cities 逐项过滤。
- **收尾**：「本周」preset Sunday-safe；无 high 遗留 → P0 骨架加固循环关闭。

## [0.1.3] — 2026-08-06

导入计数收敛 + 安全加固。

### Fixed（修复）
- **回归修复**：TDZ `createdCount` ReferenceError；粘贴导入 skipped/created 回退与文件导入收敛一致。
- **导入载荷**：`applications`/`apply_logs` 放宽为 `list[object]` + 逐行 `isinstance` 防御性构造（坏行计入 skipped 而非整批 422）。
- **设置导入/恢复**：逐子键校验统一；良性键（cities/apply/browser/blacklist）随往返迁移；`external_url_hosts` 逐项校验保留合法 host。
- **Schema v3**：`applied_at` 建索引 + sargable datetime 区间过滤；看板近 30 天趋势分桶移 Python 侧。
- **重构**：STATUS_TEXT/COLOR/OPTIONS 集中到 `lib/applyStatus.ts`；显式声明 `dayjs`；「本周」preset 起点改周一。

### Security（安全）
- **备份安全**：`verifyBackupManifest` checksum 键白名单正则（封堵路径穿越）；损坏备份预览识别。

## [0.1.2] — 2026-08-06

投递时间「未设置」语义 + 导入健壮性。

### Added（新增）
- **applied_at NULL 语义**：schema v2 迁移（重建 applications 表、v1 数据无损搬迁、status 索引重建）；PATCH 清空存 NULL；表单 tooltip/placeholder 改「留空=未设置」；`ApplicationItem.applied_at` 放宽为 `datetime | None`。

### Fixed（修复）
- **导入**：恢复 `updated_at`；移除列 `default=datetime.now`（import NULL 落成今天的根因）；datetime 精度归一（`replace(microsecond=0)`）；`ImportItem` 去掉 max_length 与 url scheme 校验实现逐行容错；保留原 id；`created/updated/skipped` 分离计数。
- **更新**：显式 `status: null` 保留原值；url 加 netloc/scheme 校验；仅真实值变化才写 apply_log。
- **设置恢复**：`apply/browser/blacklist` 改子键白名单重建。

## [0.1.1] — 2026-08-05

P0 骨架加固第一批。

### Changed（变更）
- **IPC / preload 安全**：拉取回调退订守卫；同通道 in-flight 拉取复用；`importData` 类型门禁；外部链接 scheme 归一化；scheme 名单改惰性异步拉取（移除模块加载期 sendSync）。
- **外部链接白名单**：host 后缀去尾随点归一；trusted 导入路径 60s TTL；条目格式校验（拒绝协议/端口/路径及归一化后无点号的裸单标签如 `com`）。
- **设置恢复**：`restoreSettingsSafely` 类型校验后恢复非敏感键；备份恢复不再静默清空外链白名单；恢复的 `cities/apply/browser/blacklist` 加字段级校验。
- **导出**：`export-data-offline` 应用 status/keyword/date 筛选（对齐 CSV 导出）。
- **后端**：LIKE 通配符（`%`/`_`）转义 + ESCAPE 声明；显式清空 applied_at 语义；导入 `_parse_dt` 宽松解析。
- **面试页**：`parseInterviewBlock` 限定到【面试登记】段内解析；CSP 校验脚本断言 `script-src 'self'`。

## [0.1.0] — 2026-08-05

初始发布。

### Added（新增）
- **P0 骨架**：Electron 壳 + FastAPI 后端 + SQLite；7 大页面；投递记录全量 CRUD + 筛选 + 批量改状态；导出（JSON/CSV/离线）/ 导入（文件/粘贴）/ 备份恢复（zip 四件套 + checksum 校验）；安全基线（contextIsolation、全局 Bearer 鉴权、Host/Origin 校验、严格 CSP、DPAPI 加密 api_key）。

---

[Unreleased]: https://github.com/SpiralQWQ/bossjob-ai/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/SpiralQWQ/bossjob-ai/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/SpiralQWQ/bossjob-ai/releases/tag/v0.1.6
[0.1.5]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.4]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.3]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.2]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.1]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
[0.1.0]: https://github.com/SpiralQWQ/bossjob-ai/commit/acf5d55
