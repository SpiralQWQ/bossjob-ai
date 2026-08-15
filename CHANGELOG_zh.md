# CHANGELOG

> BossJobAI 求职投递助手 — 版本变更与修复记录（中文）
> 格式遵循 Keep a Changelog：**最新版本在顶部，向下倒序**；每次更新已归入对应版本迭代，不保留逐轮流水账。

## [0.1.17] — 2026-08-14 · 第二批增强：全局搜索 / 报错通知 / 表格 / 欢迎区 / 外观 / URL / hooks

同一 S1-S4 流程（8 Task × 4 轮审核 + 穷举验收，**high=0**），补上补丁重构计划「高价值未做」项。

**新增**
- **Cmd+K 全局搜索**：搜公司/职位，点击/回车跳转记录页预筛（防抖 + seq 防过期响应）
- **事件式报错通知**（`notifyError/Warning/Success`，非组件代码可发）+ **全局错误边界**（渲染异常原生兜底不白屏）
- **表格列显隐**（设置面板 + localStorage 持久化 + 防呆至少一列）+ 薪资/时间数字等宽对齐
- **工作台首屏欢迎区**（标题/副文案/快捷入口）
- **设置页「外观」卡**：主题三态 + 5 主色预设（品牌蓝/天青/青绿/紫罗兰/琥珀）
- **表单质感统一**（输入框圆角 8 / 标签次级色，亮暗自适应）
- **分页 URL 化**（刷新/回退保留页码，replace 防循环）
- **通用 hooks**：usePrefersDark / useDebouncedValue / useInterval / useCopyToClipboard

**测试**：单元测试 75 → **91 项**

**已知边界**：全局搜索内联防抖待统一到 useDebouncedValue；暗色主色随主色预设（默认品牌蓝）。

---

## [0.1.16] — 2026-08-14 · 视觉改造 V1：品牌化 Antd + 暗色 + 现代看板

基于 139 份开源调研（`UI调研报告/08_补丁重构计划报告.md`）落地，全流程 11 Task × 4 轮审核 + 穷举验收（**high=0**，终点一致性 6 组全一致）。主线：脱离 Antd 出厂大众脸 → 品牌化 + 暗色 + 现代看板。

**新增（主题）**
- 主题令牌唯一真源 `theme/designTokens.ts`（品牌色/语义色/字体/圆角/阴影）+ 亮/暗双 `tokenBuilders`（DESIGN §2-5）
- 暗色模式：`settingsStore.themeMode` 三态（跟随系统/亮/暗）+ persist 持久化 + ConfigProvider 全局注入
- 顶栏主题切换按钮 `ThemeSwitch`（三态菜单）
- 暗色体验闭环：首帧防闪外部脚本（CSP 兼容）+ 切换禁过渡 + 暗色滚动条 + body 基线（`GlobalStyle`）

**新增（看板）**
- ECharts 6 按需接入 + `BaseChart` 封装（init/resize/dispose/点击事件，防泄漏）
- 看板统计卡 `StatCard`/`ChartCard`（大数字 tabular-nums + 语义色 + hover 上浮 + 点击下钻）
- 近 30 天投递趋势面积图 + 投递状态环形图（数据 `/api/stats`，**后端零改动**）

**优化（图标/清理/工程）**
- 统一线性图标 tabler + `AppIcon` 注册表（菜单 7 + 工作台 4 图标）
- 硬编码色清理 13 处归零（状态色收敛 `designTokens.STATUS_HEX` 真源；interview Badge 黄→蓝紫按 DESIGN §2.3）
- 新增 `verify:colors` 禁硬编码色门禁 + Prettier + CI 模板

**测试**
- 单元测试 8 → **55 项**（新增令牌/主题/切换/防闪/统计卡/图表/图标/护栏）

**已知边界**：imperative Modal（操作日志/导入预览）暗色下为 Antd 默认白底（static API 局限）；CI 需同步开源仓库 `SpiralQWQ/bossjob-ai/.github` 自动生效。

---

## [0.1.15] — 2026-08-12 · 多 Agent 串行修复 R1+R2：前端 13 处健壮性修复

多 Agent 串行扫描 + 每 Task 4 轮审核收敛（**high=0**）。主线主题：终点一致性——「殊途同归必须同果」。

**修复（重连探活，R1-⑨ + R2-①②）**
- `useBackendBase.reload` 先探 `/api/health`（HTTP ok + 响应体 `status==='ok'`）成功才切 base——后端宕机不再把「无法连接后端」翻转成列表级拉取错误
- 新增公共 `probeHealth(url)`（useBackendBase.ts 导出）；ApplyPage / InterviewPage「重新连接」复用（原为裸 `getBaseUrl().then(setBaseUrl)`）——reload / ApplyPage / InterviewPage / Dashboard.checkBackend 四处入口探活同口径

**修复（分页与撤销，R1-⑧）**
- ApplyPage / InterviewPage：末页唯一记录改状态移出列表时记录 `prevPage`；撤销后回 `prevPage` 重拉，记录重新可见（原为撤销后仍留在当前页看不到记录）

**修复（表单与登记一致性，R1-②⑥ + R2-④）**
- ApplyPage / InterviewPage 新建弹窗预填 `applied_at: dayjs()`（对齐 JobsPage，三入口殊途同归）
- InterviewPage `openCreateModal` 对称重置瞬态状态（编辑→取消→新建不再残留「手写时间无法解析」陈旧警示）
- InterviewPage 保存时刻 `orig` 块改取 `openEditModal` 快照（与回填标记同源同刻）——不在当前页的记录手写时间不再被丢弃

**修复（看板统计兜底，R1-④ + R2-③）**
- TrackerPage 统计字段缺省 `?? 0`（含 `(pass_rate ?? 0) * 100` 优先级安全）；`daily_trend` 渲染两处 `?? []`（与 maxCount 口径一致）——后端缺字段不 NaN 不崩

**修复（设置钳制与离线可用，R1-⑤⑦⑩ + R2-⑤）**
- `daily_limit` 保存钳制 [1,500]（`Math.min/max` + fallback），手输超界不再落盘
- 备份保留份数 `maxBackups` 钳 [1,60] 取整、备份间隔 `intervalMinutes` 钳 [1,1440] 取整；清空输入（`v != null` 守卫）不再静默重置为默认 7
- Settings 错误分支独立渲染 `BackupSettingsCard`（备份仅依赖主进程 IPC，后端离线仍可编辑）

**验证**：完整构建链通过（`tsc` + `vite build` + `verify-csp` + `verify-dist`）；每修复穷举测试（路径穷举 / 边界严格 / 终点一致性分组比对）；验收证据见 `temp/fixloop_evidence/round_1.md` + `round_2.md`

---

## [0.1.14] — 2026-08-12 · P0 收尾：starlette pin + 前端 code-split

**修复（后端依赖兼容）**
- `backend/requirements.txt` 显式 pin `starlette>=0.37.2,<0.39`（fastapi 0.115 兼容上限）——此前环境被升级到 starlette 1.6.0，导致 fastapi 启动抛 HTTP_422 弃用警告；实测降到 0.38.6 后 app 导入 16 路由无 starlette 警告

**优化（前端加载性能，遗留-2）**
- 路由懒加载：`router.tsx` 全部 6 页面改 `React.lazy` + `Suspense`（antd Spin fallback），首屏只加载当前路由 chunk
- Vite `manualChunks`：react 全家桶拆独立 `react-vendor` chunk；antd 不显式拆分（vite5+antd5 默认 ESM tree-shaking 按需摇树，显式锁单 chunk 反而阻止摇树）
- 效果：单 JS 1.33MB → 拆分多 chunk，无 >500kB chunk；首屏 gzip 约 183kB（index 117kB + vendor 66kB），其余页面按需加载
- 构建校验链全过：`tsc` 类型检查 + `vite build` + `verify-csp` + `verify-dist`

---

## [0.1.13] — 2026-08-11

清洗工作流转写内容保护（P1a_简历素材库/清洗工作流，区分教学 vs 噪音）：

- **修复台词误删元凶**：移除"整行重复≥3次删"（此前把视频反复播放的教学台词/中文翻译当水印误删）；改为**压缩保留** `原文…[出现N次]`（教学强调信号不丢 + 省 token）
- **教学白名单保护**：识别音标/中文翻译/单词卡/教学英文（词表+模糊匹配），放所有删除前，永不误删教学短行
- **OCR乱码检测**：词典零命中+无元音+字符熵识别 `dnrduork` 类碎片删除，教学行豁免（保守不误删）
- **续句合并**：无终止标点+下行小写+时间相邻 → 拼接被 OCR 拆断的台词
- **界面水印删除**：`坚持打卡30天`/`片名：`/`知识点` 等固定界面词删除，与教学台词区分
- **规则引擎多动作化**：YAML v3→v4，`protect_teaching`/`compress_repeat`/`watermark`/`garbled` 四区块；`sentencex` 句粒度前置（合并拆行）
- **工程加固**：空输出回退（保留率<30% 回退原文）+ 审计字段 + 教学保留率门禁（30 条基准 ≥95%）
- **验收**：T1-T12 逐个本体审核通过；真实 179 帧验证；教学保留率 100%；原 14 项验收零回归；详见 `docs/验收报告_v3.0.md`

## [0.1.12] — 2026-08-11

清洗工作流接口适配（P1a_简历素材库/清洗工作流，对接 M.AIStudy 转写产出）：

- **ASR json 逐段清洗原型**：新增 `cleaner/clean_asr_json.py`，ASR json（text+segments+sentences）逐段/逐句清洗，**保 json 结构**输出 `_clean.json`（原 json 保留溯源）；遵守接口红线（结构不拼平/中文讲解不删/时间戳·confidence·review 不改值/srt 不清洗）；段级去重（同文本+同时间戳=重复记录删后留前，同文本+不同时间戳=重播保留，中文段永不删）
- **接口对接**：`docs/接口对接/` 接入 M.AIStudy 转写产出规范（格式契约/红线/接口，含示例文件）；补丁重构计划升 v1.1（接口契约 + 开放问题定案：逐段映射/GLM水印保留/词级纠错交 Claude）
- **修复**：规则指纹路径 bug（`clean_batch.py` 引用不存在的 `config/` → `rules/`），恢复"规则变更触发增量重洗"
- **规则扩展**：`cleaning_rules.yaml` 新增 8 条视频界面水印正则（坚持打卡/片名/知识点/高手盲听/初学看字幕/纯英字幕/爱说英语的福安），行首锚定不误删 GLM 描述，修复短样本水印漏删
- **验收**：T1-T7 逐个本体审核通过；接口红线 15/15 遵守；`_clean.json` 保结构输出；原 14 项验收测试全过（零回归）；详见 `docs/验收报告_v2.0.md`

## [0.1.11] — 2026-08-10

清洗工作流独立化（P1a_简历素材库/清洗工作流，与 _crawl 平级，可开源模块）：

- **结构独立**：清洗工作流从 _crawl 内抽离为独立项目（cleaner/cli/rules/tests/docs/output 分层）；解耦 collector 依赖（工具路径读 `.env`、KB 参数化、输出到 `output/`）
- **开源准备**：`.env.example` 工具路径模板 + `requirements.txt` 独立依赖 + 工作流专属 CHANGELOG（v0.3.0）
- **验收**：`tests/test_acceptance.py` 14/14 通过，40 篇知乎清洗输出到独立项目；_crawl 原文件删除（独立项目为唯一来源）；详见 `docs/独立化报告.md`

## [0.1.10] — 2026-08-10

清洗工作流升级：视频转写形态 + 工程完善（P1a_简历素材库/_crawl，内部使用）：

- **视频转写清洗**：新增 `video_ocr`（帧标记/OCR标签/重复水印清除，GLM 画面描述保留）+ `video_asr`（ASR 标点乱码规范化）规则分组；引擎按形态选规则（`clean_text(form=...)`）；MD 代码块保护（``` 围栏内不误删）；srt 不清洗（保留时间戳给人看）
- **工程完善**：增量清洗+断点续洗（文件哈希+规则指纹，未变跳过/规则变重洗/中断恢复）、并行批量清洗（`--parallel N`）、清洗后去重检查（`--dedup`）、结构化索引（`_clean_results.json`）、清洗日志、统计报告（`_clean_report.json` 历史累积）、规则版本管理（YAML version+变更日志）、worker 失败重试
- **工作流独立化**：建立工作流专属 CHANGELOG（`_crawl/清洗工作流/CHANGELOG.md`，v0.2.0）记录工作流变化路径，与 BossJobAI 项目 CHANGELOG 分离
- **验收**：验收脚本扩展至 14/14 通过（含 video_ocr/video_asr/MD 代码块/规则校验）；40 篇知乎增量跳过、残留 0、正文完整、去重 0

## [0.1.9] — 2026-08-10

清洗工作流地基加固（A/G/I，不依赖数据的可靠性改进）：

- **残留检测器补全（A）**：`scan_residual` 扩展覆盖水印/推荐问题标题/栏目按钮/孤立答主名（与清洗删除类型对齐），修复孤立检测重复误报
- **规则文件 schema 校验（G）**：`cleaning_rules.yaml` 加载时用 jsonschema 校验结构，格式错明确报错（防正则写错/分组打错静默失效）
- **清洗质量自动验证（I）**：`check_content_integrity` 检查正文误删（保留率/中文内容/空壳），挂进 clean_kb 批量流程
- **验收**：全量清洗残留 0 + 正文完整，验收脚本 10/10；待改进清单 A/G/I 完成，其余（C/D/H/J/B/E/F）暂缓待数据

## [0.1.8] — 2026-08-10

清洗工作流可复用化 + 知乎方法论入知识库（P1a_简历素材库/_crawl，内部使用）：

- **规则数据化（A）**：6 类噪音规则（固定词/正则/白名单/栏目/疑问词）从代码外置到 `config/cleaning_rules.yaml`（按 common/zhihu 站点分组，加噪音=改配置）；引擎 `cleaning.py` 配置驱动加载（YAML 缺失降级内置默认）；新增**残留检测器**（`scan_residual`）——清洗后自动扫描已知噪音，40 篇残留 0，防"评论/点赞漏检"复发
- **结构算法储备（C）**：调研 jusText/boilerpipe/dragnet，明确未来真 HTML 正文提取降级链（trafilatura→jusText→dragnet）；数据形态自动分流（`is_html_like` 纯文本/HTML 自适应）已实现并验证
- **成果入知识库（D）**：40 篇知乎干净方法论文本增量入 RAG（`add_zhihu_to_rag.py`，40367→40833 块，+466 知乎）；检索准确率 100%（36/36），知乎方法论查询 top1 命中；知乎方法论与 GitHub 200 仓模板互补
- **验收**：18 个最小单元 task 逐个本体审核通过；验收报告 `_scan/清洗调研/100_清洗工作流验收报告.md`

## [0.1.7] — 2026-08-10

爬取文本数据清洗流水线（P1a_简历素材库/_crawl，P1 前置调研交付，内部使用不随仓库分发）：

- **5 补丁融合**（工具装于 AAA.Tool，遵循 README 命名规范）：
  - **trafilatura 2.2.0**（`T.trafilatura_TextExtract_Env_v2.2.0` 独立 venv）：HTML → 正文提取去导航（favor_precision），subprocess 网关（`collector/shared/cleaning.py::extract_article`），与 yt-dlp/ffmpeg 同模式不污染主环境
  - **clean-text 0.7.1**（主环境）：URL 去除 / HTML 实体还原 / 零宽字符与空白归一化（`normalize_stage1`），fix_unicode=False 保护中文全角标点
  - **snownlp 0.12.3**（主环境）：分句 / 词性标注，供水印识别辅助（`analyze_snownlp`）
  - **jsonschema 4.26.0**（主环境）：清洗结果结构体检（`validate_schema`，engine 枚举 + stats 结构校验），接入 clean_text 返回 valid 标记
  - **presidio 2.2.364**（`T.presidio_PIIScrub_Env_v2.2.364` 独立 venv）：PII 脱敏（中国手机号 / 身份证 / 邮箱 → `***`），精简 registry 排除 NER 中文误报与 URL/日期噪音，`score_threshold=0.5`；`--anonymize` 发布前启用，本地知识库保留 PII
- **自研中文水印清除**（`remove_chinese_noise`，借鉴 unstructured 思路）：去顶部导航 / 答主水印（≥2 次无标点短行）/ AI标记 / 评论数 / 热搜 / ICP 备案 / 广告行 / 推荐栏目按钮 / 尾部"大家都在搜"截断；正文小节标题白名单保护，栏目词作句子时不误伤
- **批量清洗工具** `tools/clean_kb.py`：扫描知识库文本 → 全链清洗 → 输出 `知识库_clean/`（镜像词结构，realpath 解 junction 落 D 盘）40 篇知乎快照，保留率 73–90%
- **借鉴融合**（`_scan/清洗调研/99_借鉴思路融合报告.md`）：unstructured（cleaners 行级过滤）/ texthero（Stage 管道）/ pyjanitor（链式 API）/ dataprep（clean_* 函数家族）；dupeguru 去重思路由爬取期 deduper 落地且数据实测无重复
- **全量验收**（`_scan/清洗调研/_acceptance.py`）：10/10 通过（HTML 提取 / 归一化 / 中文分析 / 体检 / 脱敏 / 自研规则 / 40 文件全链 / 批量入口 / 降级路径 / 性能 40 文件 0.12s）

## [0.1.6] — 2026-08-06

P1a 简历素材库 + RAG 知识库（P1 前置调研交付，内部使用不随仓库分发）：

- **版本号统一**：三处 `APP_VERSION` / `electron/package.json` / `frontend/package.json` 从 0.1.0 同步到 0.1.6
- **简历素材库**：GitHub 扫描 34 关键词 → 200 个简历/文档/求职生态仓库（1k+ star 优先）隔离 clone 至本地调研语料（不随本仓库分发）；《简历知识库_详细内容.md》1194 行——方法论（FAB/STAR/ATS）、JSON Resume Schema、分岗位模板、中英例句/Cover Letter、AI 优化模型（resumePolice/career-ops）
- **RAG 索引**：bge-m3 1024 维，40,367 块 × 200/200 仓全覆盖（GPU CUDA 加速）；`build_rag.py`（文档全量 + 源码每仓抽样）、`check_coverage.py`（覆盖检查）、`test_rag.py`（36 条人工查询 100%）、`test_rag_2000.py`（2000 次压力测试 **99.8% ≥98% 达标**）

## [0.1.5] — 2026-08-06

- **文档**：新增《接口文档 v0.1》（`docs/求职投递项目_接口文档_v0.1.md`）——架构三层总览、鉴权模型、12 个后端 HTTP 接口（含索引表/参数/请求响应/错误码）、26 个 Electron IPC 通道（含索引表/语义）、数据模型与 schema 迁移、配置项、安全基线、修订记录；与 README 接口表交叉验证一致

## [0.1.4] — 2026-08-06

回归收敛 + 最终验收：

- **面试页**：无法解析块的保留/重建修复（回填标记拆分）；面试形式 Select 加 `allowClear`；手写时间只读提示 + 移除按钮
- **high 回归**：`cities` 列表被误展开崩溃修复；import-data 成功路径 ReferenceError 修复
- **设置**：`apply.interval_seconds` 非空约束（恢复 + 导入两侧）；LLM 未接入时 onFinish 不再回传 llm 段（解除配置保存死锁）；cities 逐项过滤
- **收尾**：「本周」preset Sunday-safe；无 high 遗留 → P0 骨架加固循环关闭

## [0.1.3] — 2026-08-06

导入计数收敛 + 安全加固：

- **回归修复**：TDZ `createdCount` ReferenceError；粘贴导入 skipped/created 回退与文件导入收敛一致
- **导入载荷**：`applications`/`apply_logs` 放宽为 `list[object]` + 逐行 `isinstance` 防御性构造（坏行计入 skipped 而非整批 422）
- **设置导入/恢复**：逐子键校验统一；良性键（cities/apply/browser/blacklist）随往返迁移；`external_url_hosts` 逐项校验保留合法 host
- **Schema v3**：`applied_at` 建索引 + sargable datetime 区间过滤；看板近 30 天趋势分桶移 Python 侧
- **备份安全**：`verifyBackupManifest` checksum 键白名单正则（封堵路径穿越）；损坏备份预览识别
- **重构**：STATUS_TEXT/COLOR/OPTIONS 集中到 `lib/applyStatus.ts`；显式声明 `dayjs`；「本周」preset 起点改周一

## [0.1.2] — 2026-08-06

投递时间「未设置」语义 + 导入健壮性：

- **applied_at NULL 语义**：schema v2 迁移（重建 applications 表、v1 数据无损搬迁、status 索引重建）；PATCH 清空存 NULL；表单 tooltip/placeholder 改「留空=未设置」；`ApplicationItem.applied_at` 放宽为 `datetime | None`
- **导入**：恢复 `updated_at`；移除列 `default=datetime.now`（import NULL 落成今天的根因）；datetime 精度归一（`replace(microsecond=0)`）；`ImportItem` 去掉 max_length 与 url scheme 校验实现逐行容错；保留原 id；`created/updated/skipped` 分离计数
- **更新**：显式 `status: null` 保留原值；url 加 netloc/scheme 校验；仅真实值变化才写 apply_log
- **设置恢复**：`apply/browser/blacklist` 改子键白名单重建

## [0.1.1] — 2026-08-05

P0 骨架加固第一批：

- **IPC / preload 安全**：拉取回调退订守卫；同通道 in-flight 拉取复用；`importData` 类型门禁；外部链接 scheme 归一化；scheme 名单改惰性异步拉取（移除模块加载期 sendSync）
- **外部链接白名单**：host 后缀去尾随点归一；trusted 导入路径 60s TTL；条目格式校验（拒绝协议/端口/路径及归一化后无点号的裸单标签如 `com`）
- **设置恢复**：`restoreSettingsSafely` 类型校验后恢复非敏感键；备份恢复不再静默清空外链白名单；恢复的 `cities/apply/browser/blacklist` 加字段级校验
- **导出**：`export-data-offline` 应用 status/keyword/date 筛选（对齐 CSV 导出）
- **后端**：LIKE 通配符（`%`/`_`）转义 + ESCAPE 声明；显式清空 applied_at 语义；导入 `_parse_dt` 宽松解析
- **面试页**：`parseInterviewBlock` 限定到【面试登记】段内解析；CSP 校验脚本断言 `script-src 'self'`
