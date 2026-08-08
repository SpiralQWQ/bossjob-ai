/// <reference types="vite/client" />

/**
 * Electron preload 桥接（electron/preload.js）在 window 上暴露的最小 API 面。
 * 安全基线（架构 v0.2）：contextIsolation=true + nodeIntegration=false，
 * 渲染进程只能通过 window.api 与主进程通信。
 * 声明为可选：在纯浏览器（无 preload）下运行时优雅降级为「后端未连接」。
 */
interface Window {
  api?: {
    /**
     * 一次性获取渲染层启动所需的后端端口（会话级常量），
     * 唯一引导通道（历史上的 getBackendPort / getCsrfToken 已并入本通道）。
     * 返回 { port }。
     */
    getBootstrapInfo: () => Promise<{ port: number }>;
    /**
     * 经主进程代理访问本地后端（端点白名单 + Bearer 主进程附加）——渲染层访问 /api/* 的唯一鉴权通道。
     * req: { method, path, body? }；返回 { ok, status, body }（body 为响应体文本，status 0=后端不可达）。
     */
    backendRequest?: (req: { method: string; path: string; body?: string | null }) => Promise<{
      ok: boolean;
      status: number;
      body: string | null;
    }>;
    /**
     * 订阅主进程推送的后端启动失败消息（如 Python 不在 PATH / 打包 exe 缺失）。
     * 返回取消订阅函数，组件卸载时调用以避免重复订阅。
     */
    onBackendError?: (callback: (message: string) => void) => () => void;
    /**
     * 订阅主进程推送的后端就绪信号（启动 / 重启后由主进程发送，携带后端版本）。
     * 返回取消订阅函数。
     */
    onBackendReady?: (callback: (payload: { version: string | null }) => void) => () => void;
    /**
     * 订阅主进程推送的后端崩溃自动重启进度（守护循环每次重启前发送 { attempt, max }）。
     * 返回取消订阅函数。
     */
    onBackendRestarting?: (callback: (info: { attempt: number; max: number }) => void) => () => void;
    /**
     * 导出全部数据（隐私优先）：主进程从本地后端拉取全量 JSON（敏感字段已剔除），
     * 弹出「另存为」对话框并写入用户选择的路径。
     * 返回 { canceled, ok, path?, error? }。
     */
    exportData?: () => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      error?: string;
    }>;
    /**
     * 预览导出载荷（不落盘、不弹「另存为」对话框）：主进程复用与 exportData 相同的
     * fetchExportPayload 拉取 /api/export 全量 JSON，并按同口径剥离 llm.base_url、并入
     * resume 快照后原样返回，供「数据」页导出前渲染『导出内容预览』。
     * 返回 { ok, payload?, error? }，payload 为与导出文件同构的完整脱敏载荷
     * （applications + apply_logs + 脱敏 settings + resume 快照）。
     */
    previewExportData?: () => Promise<{
      ok: boolean;
      payload?: Record<string, unknown>;
      error?: string;
    }>;
    /**
     * 导出投递记录为 CSV（UTF-8 BOM + 表头，Excel 可直接打开）：主进程从本地后端拉取
     * /api/export 全量数据（applications 全表 + apply_logs 全表）扁平化后，每行按 application_id
     * 追加 apply_logs 投递日志时间线列（『action | 时间 | 备注』，无日志留空），与 JSON 导出同数据源，
     * 可在 Excel 做『投递→约面→offer』漏斗/时长分析；弹出「另存为」对话框写入用户选择的路径。
     * 返回 { canceled, ok, path?, error? }，与 exportData 同构。
     */
    exportCsv?: (filter?: { status?: string; keyword?: string; date?: string; date_from?: string; date_to?: string }) => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      error?: string;
    }>;
    /**
     * 离线导出全部数据（export-data-offline IPC，后端不可达降级通道）：
     * 读自动备份目录最新一份备份的 app.db，序列化为 JSON（opts.format 缺省）或 CSV（opts.format='csv'）
     * 后弹「另存为」落盘。与 exportData/exportCsv 同构，但不依赖 GET /api/export——后端崩溃/端口冲突下仍可导出。
     * 返回 { canceled, ok, path?, backupName?, error? }（backupName=数据来源的最新备份名）。
     */
    exportBackupData?: (opts?: { format?: 'json' | 'csv'; status?: string; keyword?: string; date?: string; date_from?: string; date_to?: string }) => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      backupName?: string;
      error?: string;
    }>;
    /**
     * 离线导出内容预览（preview-export-data-offline IPC，不落盘、不弹对话框）：
     * 读自动备份目录最新一份备份的 app.db，返回与 previewExportData 同构的载荷
     * { applications, apply_logs }（不含 settings/resume），供「数据」页错误态下
     * 「预览导出内容」/「投递日志」按钮降级使用。返回 { ok, payload?, backupName?, error? }。
     */
    previewBackupExport?: () => Promise<{
      ok: boolean;
      payload?: Record<string, unknown>;
      backupName?: string;
      error?: string;
    }>;
    /**
     * 预览导入数据（preview-import-data IPC，importData 的前置确认步）：
     * 弹出「打开文件」对话框选择导出 JSON，读取校验后返回预览统计（不落库、不 POST），
     * 供「数据」页导入前弹确认框；确认后再用返回的 path 调 importData(path) 跳过二次文件选择直接导入。
     * 返回 { canceled, ok, path?, preview?, error? }，
     * preview = { applications, applyLogs, hasSettings, overwriteIds }（applications 条数 / 日志条数 /
     *   是否含 settings 段 / 将覆盖的已有 id 数）。
     */
    previewImportData?: () => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      preview?: {
        applications: number;
        applyLogs: number;
        hasSettings: boolean;
        overwriteIds: number;
      };
      error?: string;
    }>;
    /**
     * 从「导出数据」JSON 文件导入全部数据（与 exportData 成对，闭合导出→换机→导入回路）：
     * 主进程弹出「打开文件」对话框（或跳过——传入 previewImportData 返回的 path），校验载荷
     * （顶层对象且含 applications 数组）后 POST 到本地后端 /api/import（按 id 覆盖/新建），成功后推送 backend-ready。
     * 返回 { canceled, ok, path?, importedCount, skippedCount, updatedCount, settingsStatus?, error? }，
     * 其中 importedCount=新增条数 / updatedCount=覆盖更新条数 / skippedCount=跳过条数，
     * settingsStatus（与 restoreData 取值对齐）：'restored' | 'retained_credentials_stripped'
     *   | 'parse_failed' | 'missing'，供提示「配置已合并 / 配置解析失败」。
     */
    importData?: (path?: string) => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      importedCount?: number;
      skippedCount?: number;
      updatedCount?: number;
      settingsStatus?: 'restored' | 'retained_credentials_stripped' | 'parse_failed' | 'missing';
      resumeStatus?: 'restored' | 'missing' | 'write_failed';
      error?: string;
    }>;
    /**
     * 手动备份全部数据（另存为）：主进程弹出对话框并在所选路径创建 BossJobAI-backup-* 目录，
     * 快照 app.db + settings.json + 简历快照 resume.json。返回 { canceled, ok, path?, error? }。
     */
    backupData?: () => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      error?: string;
    }>;
    /**
     * 立即备份全部数据（应用内可见）：不走文件夹选择器，直接快照到自动备份目录，
     * 与自动备份同源（BossJobAI-backup-<时间戳> 命名 + maxBackups 保留裁剪），
     * 快照立即出现在 listBackups() 列表。返回 { ok, name, path?, error? }。
     */
    backupNow?: () => Promise<{
      ok: boolean;
      name: string;
      path?: string;
      error?: string;
    }>;
    /**
     * 从备份目录恢复全部数据：主进程校验 schema 版本后停后端、覆盖 app.db，并视 opts.includeSettings
     * 决定是否一并恢复 settings.json（缺省/true 时恢复并安全剥离 LLM 凭据；false 时仅恢复投递记录，保留当前 LLM 配置）。
     * opts.dir 可直接指定备份目录（应用内备份列表「恢复」按钮使用，复用既有 schema/integrity/manifest 校验），
     * 缺省时才弹出「打开目录」对话框由用户手工选择。
     * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, error? }，preRestoreSnapshot={name,path}
     *   为破坏性覆盖前自动快照的当前数据（可回滚点，快照失败时为 null）；settingsStatus 取
     *   'restored' | 'retained_credentials_stripped' | 'backup_missing' | 'parse_failed' | 'retained'。
     */
    restoreData?: (opts?: { includeSettings?: boolean; dir?: string }) => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      settingsStatus?: 'restored' | 'retained_credentials_stripped' | 'backup_missing' | 'parse_failed' | 'retained';
      preRestoreSnapshot?: { name: string; path: string } | null;
      error?: string;
    }>;
    /**
     * 在系统文件管理器中打开自动备份目录（打包模式 %APPDATA%/BossJobAI/backups）。
     * 返回 { ok, error? }。
     */
    openBackupDir?: () => Promise<{
      ok: boolean;
      error?: string;
    }>;
    /**
     * 枚举自动备份目录下的全部备份（BossJobAI-backup-*，最新在前），
     * 供渲染层渲染备份列表并在应用内删除/选择备份。
     * 返回 Array<{ name, path, createdAt, sizeBytes, fileCount, hasResume, checksumOk }>，目录不存在时为空数组。
     * - hasResume：该备份是否含简历快照 resume.json；
     * - checksumOk：备份 manifest 校验和是否通过（true=完好 / false=被截断损坏或篡改 / null=旧版无 manifest 不可校验）。
     */
    listBackups?: () => Promise<
      Array<{
        name: string;
        path: string;
        createdAt: string | null;
        sizeBytes: number;
        fileCount: number;
        hasResume: boolean;
        checksumOk: boolean | null;
      }>
    >;
    /**
     * 删除自动备份目录下的单个备份（BossJobAI-backup-*）。
     * 主进程校验备份名称并做路径穿越防护后递归删除。返回 { ok, error? }。
     */
    deleteBackup?: (name: string) => Promise<{
      ok: boolean;
      error?: string;
    }>;
    /**
     * 预览单个备份目录的内容（不落盘、不触发恢复），供恢复前确认：
     * - appCount：applications 表记录数（含 WAL 尾部，与实际恢复口径一致）；
     * - latestRecordAt：最近一条投递记录的 applied_at（ISO 字符串；无记录为 null）；
     * - schemaVersion：备份库 user_version（-1 = 文件损坏或非 SQLite）；
     * - hasSettings：settings.json 是否存在；settingsStatus：'ok' | 'invalid' | 'missing'；
     * - hasResume：备份目录是否含简历快照 resume.json；
     * - checksumOk：app.db(WAL)/settings/resume 各自独立 SHA-256 校验的联合结果（true=全部通过 / false=任一损坏 / null=旧版无 manifest 不可校验）。
     * 返回 { appCount, latestRecordAt, schemaVersion, hasSettings, settingsStatus, hasResume, checksumOk }。
     */
    /**
     * 导出便携备份归档：把自动备份目录里最新一份备份打包为单一 .zip
     * （含 app.db + settings.json + resume.json + manifest.json 四件套），弹出「另存为」对话框写入。
     * 返回 { canceled, ok, path?, name?, error? }（name=被打包备份的目录名）。
     */
    exportBackup?: (opts?: { dir?: string }) => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      name?: string;
      error?: string;
    }>;
    /**
     * 导入便携备份归档：弹出「打开文件」对话框选择由 exportBackup 生成的 .zip，主进程解压后复用
     * restore-data 的完整校验链路（schema 版本 + integrity_check + manifest 校验和）落库并重启后端。
     * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, importedBackupName?, error? }。
     */
    importBackup?: () => Promise<{
      canceled: boolean;
      ok: boolean;
      path?: string;
      settingsStatus?: 'restored' | 'retained_credentials_stripped' | 'backup_missing' | 'parse_failed' | 'retained';
      preRestoreSnapshot?: { name: string; path?: string } | null;
      importedBackupName?: string;
      error?: string;
    }>;
    previewBackup?: (name: string) => Promise<{
      ok: boolean;
      appCount: number;
      latestRecordAt: string | null;
      schemaVersion: number;
      hasSettings: boolean;
      settingsStatus: 'ok' | 'invalid' | 'missing';
      hasResume: boolean;
      resumeSummary?: { name: string | null; phone: string | null; email: string | null } | null;
      checksumOk?: boolean | null;
      samples?: Array<{
        job_title: string | null;
        company: string | null;
        status: string | null;
        applied_at: string | null;
      }>;
      error?: string;
    }>;
    /**
     * 查询自动备份健康状态：备份目录路径、最近一次备份时间、当前保留份数、保留上限，
     * 以及自动备份行为配置（autoBackupEnabled 定时开关 / intervalMinutes 间隔分钟数）。
     * 返回 { backupDir, lastBackupAt, totalBackups, maxBackups, autoBackupEnabled, intervalMinutes }。
     */
    getBackupInfo?: () => Promise<{
      backupDir: string;
      lastBackupAt: string | null;
      totalBackups: number;
      maxBackups: number;
      autoBackupEnabled: boolean;
      intervalMinutes: number | null;
    }>;
    /**
     * 修改自动备份配置（保留份数上限 / 定时开关 / 备份间隔），主进程持久化到 settings.json 的 backup 段，
     * 保存后立即按新上限轮转裁剪旧备份并启停定时任务。cfg 为 { maxBackups?, autoBackupEnabled?, intervalMinutes? } 子集：
     * - maxBackups：保留份数上限（1~60 整数）；
     * - autoBackupEnabled：是否启用定时自动备份（布尔）；
     * - intervalMinutes：定时备份间隔分钟数（1~1440 整数；null 取消定时）。
     * 返回 { ok, settings?, error? }，settings 为保存后的最新备份配置。
     */
    updateBackupSettings?: (cfg: {
      maxBackups?: number;
      autoBackupEnabled?: boolean;
      intervalMinutes?: number | null;
    }) => Promise<{
      ok: boolean;
      settings?: {
        maxBackups: number;
        autoBackupEnabled: boolean;
        intervalMinutes: number | null;
      };
      error?: string;
    }>;
    /**
     * 经系统浏览器打开外部链接（仅放行 http/https，其余 scheme 由主进程拒绝）。
     * 返回 { ok, error? }。
     */
    openExternal?: (url: string) => Promise<{
      ok: boolean;
      error?: string;
    }>;
    /**
     * 刷新外部链接宿主扩展白名单缓存（设置页保存 security.external_url_hosts 后调用）：
     * 让主进程重新读盘 settings.json，使新配置的放行域名无需重启即可生效。
     * 返回 { ok }。
     */
    reloadExternalAllowlist?: () => Promise<{
      ok: boolean;
    }>;
    /**
     * 读取数据目录 resume.json 权威快照（恢复/导入后主进程 writeRendererResume 已写入）：
     * 供 ResumePage 挂载时回灌 localStorage 与表单，避免 UI 显示旧 localStorage 简历、下次保存覆盖写回磁盘。
     * 返回 { ok, resume?, error? }；磁盘副本缺失 / 不可解析时 { ok:false }，调用方降级 localStorage 初始化。
     */
    getResumeSnapshot?: () => Promise<{
      ok: boolean;
      resume?: Record<string, unknown>;
      error?: string;
    }>;
    /**
     * 保存简历时通知主进程把 resume.json 权威副本写入数据目录（ResumePage handleSave / 回灌 / 清空共用）。
     * 返回 { ok, error? }；undefined 表示 preload 桥缺失（纯浏览器模式）。
     */
    notifyResumeSaved?: (
      resume: object | null,
    ) => Promise<{ ok: boolean; error?: string } | undefined>;
  };
}
