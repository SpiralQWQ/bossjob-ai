/** Electron 主进程 · 数据持久化域（从 main.js 抽离：导出/导入载荷构建 + 简历快照 + 备份/轮转/恢复 + zip 归档 + manifest 校验 + 外部链接白名单）。
 *  依赖：backend（后端生命周期：stopBackendForRestore/waitForBackendHealth/notifyBackendReady/startBackend/resolveBackendPort/getSettingsMtime/httpGet）、
 *        constants（路径/端口/SQLite 偏移/备份前缀/上限）、state（各缓冲与缓存）、utils（errMsg/isPlainObject/isValidPort/timestamp）。 */

const { app, BrowserWindow } = require('electron');
const { createHash } = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const { state } = require('./state');
const {
  BACKUP_DIR_PREFIX, BACKUP_NAME_PREFIX_RE, BACKUP_SORT_KEY_RE, SQLITE_WAL_SUFFIXES,
  EXPORT_REQUEST_TIMEOUT_MS, EXPORT_MAX_RESPONSE_BODY_BYTES, SETTINGS_STATUS,
  RESUME_STORAGE_KEY, MAX_RESUME_SAVE_BYTES, HASH_READ_BUFFER_BYTES, PREVIEW_SAMPLE_LIMIT,
  SQLITE_USER_VERSION_OFFSET, SQLITE_USER_VERSION_LEN, SQLITE_HEADER_SIZE,
  COPY_RETRY_SLEEP_MS, COPY_RETRY_ATTEMPTS, DB_SCHEMA_VERSION,
  DEFAULT_MAX_AUTO_BACKUPS, MS_PER_MINUTE,
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_APPLICATIONS, MAX_IMPORT_POST_BODY_BYTES,
  DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED,
  getSettingsPath, getDataDir, getBackupDir, TIMEOUT_ERR,
} = require('./constants');
const {
  stopBackendForRestore, waitForBackendHealth, notifyBackendReady, startBackend,
  resolveBackendPort, getSettingsMtime, httpGet, waitBackendReadyOrRetry,
} = require('./backend');
const { errMsg, isPlainObject, isValidPort, timestamp } = require('./utils');

/** zip 解析防护上限（resource-exhaustion 修复）：单条目解压后体积上限（256MB）与压缩后体积上限，
 * 在 inflate 前校验，防中央目录声明超大 uncompSize 对 tiny DEFLATE 载荷 inflate 出巨量内存。 */
const MAX_ZIP_ENTRY_UNCOMP_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRY_COMP_BYTES = 256 * 1024 * 1024;
/** zip 累计解压体积全局上限（512MB）：追踪所有条目解压字节之和，防 zip 炸弹累计耗尽内存。 */
const MAX_ZIP_TOTAL_UNCOMP_BYTES = 512 * 1024 * 1024;
/** 导入归档 .zip 文件本身的大小上限（64MB）：stat 通过后才 readFileSync，防一次性读入超大文件占满内存。 */
const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** list-backups 的 manifest 校验和缓存容量上限：超过即清空（防缓存无限增长）。 */
const BACKUP_CHK_CACHE_MAX = 64;


// ---------------------------------------------------------------------------
// 模块级定义（共享状态已抽离至 modules/state.js）
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 通用工具函数
// ---------------------------------------------------------------------------

/** 当前时间格式化为 YYYYMMDD-HHmm（本地时间），用于导出文件名 / 备份目录命名。 */

/**
 * 备份目录名解析为可比较的排序键：BossJobAI-backup-YYYYMMDD-HHmm-<base36毫秒>。
 * 后缀 Date.now().toString(36) 是变长 base36，字典序会错序（同一分钟内 ms=36 的 '10' 排在 ms=35 的 'z' 之前），
 * 导致轮转时把较新备份当成最旧删除。这里把日期/时间/毫秒解析后重组为定宽键，字典序即时间序。
 */
function backupSortKey(name) {
  const m = BACKUP_SORT_KEY_RE.exec(name);
  if (!m) return name; // 无法解析（历史/异常命名）时退化为原始名，保证排序稳定
  return `${m[1]}${m[2]}${String(parseInt(m[3], 36)).padStart(14, '0')}`;
}


/** 对话框父窗口：优先聚焦窗口，其次任意已打开窗口；无窗口时返回 undefined（由调用方走无父窗口变体）。 */

/**
 * 「打开文件/目录」对话框封装（backup-data / import-data / restore-data 共用）：
 * 以 getDialogParent 为父窗口调用，无窗口时退化为无父窗口变体，消除五处重复的条件分支。
 */

/** 「另存为」对话框封装（export-data / export-data-csv 共用），父窗口规则与 openDialog 一致。 */

/**
 * 从本地后端拉取 /api/export 全量 JSON（export-data / export-data-csv 共用）：
 * httpGet + TIMEOUT_ERR 单次重试 + statusCode 校验 + 载荷结构校验，返回解析后的 payload。
 * 任一步失败抛 Error（错误消息与两个 handler 原返回语义一致），由调用方 catch 统一上报。
 */
async function fetchExportPayload() {
  // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：主进程直连后端前先检查熔断标志，
  // 熔断态拒绝拉取 /api/export —— export-data / preview-export-data / export-data-csv 共用此函数，
  // 使「已停止与后端交互」的声明与实际行为一致（这些路径绕过代理通道，须自行兜底）。
  if (state.backendAuthFailure) {
    throw new Error('后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）');
  }
  const url = `http://127.0.0.1:${state.backendPort}/api/export`;
  let resp;
  try {
    resp = await httpGet(url, EXPORT_REQUEST_TIMEOUT_MS, EXPORT_MAX_RESPONSE_BODY_BYTES);
  } catch (err) {
    // 仅对超时（httpGet 以 TIMEOUT_ERR 哨兵销毁连接）做单次重试，其余真实错误（如连接拒绝）直接上抛，避免掩盖故障。
    if (err === TIMEOUT_ERR) {
      console.warn(`[electron] 导出请求首次超时，重试一次（url=${url}）`);
      resp = await httpGet(url, EXPORT_REQUEST_TIMEOUT_MS, EXPORT_MAX_RESPONSE_BODY_BYTES);
    } else {
      throw err;
    }
  }
  if (resp.statusCode !== 200) {
    throw new Error(`导出接口返回 HTTP ${resp.statusCode}`);
  }
  const payload = JSON.parse(resp.body);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.applications)) {
    throw new Error('后端返回的导出数据格式异常');
  }
  return payload;
}


/**
 * 拉取当前库内全部 applications 的 id 集合（轻量端点 GET /api/applications/ids，后端返回纯 id 数组）。
 * preview-import-data 统计『即将覆盖的 id 数』专用 —— 避免为取 id 集合而拉取整份 /api/export（上限 200MB）。
 * 任一步失败抛 Error（错误语义与调用方 catch 一致），由调用方兜底（后端不可达时按 0 展示，不阻塞预览）。
 * @returns {Promise<Set<number>>}
 */
async function fetchExistingIds() {
  // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：preview-import-data 的直连 GET 同样受熔断约束，
  // 熔断态拒绝拉取 /api/applications/ids，使「已停止与后端交互」的声明与实际行为一致。
  if (state.backendAuthFailure) {
    throw new Error('后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）');
  }
  const url = `http://127.0.0.1:${state.backendPort}/api/applications/ids`;
  let resp;
  try {
    resp = await httpGet(url, EXPORT_REQUEST_TIMEOUT_MS, 16 * 1024 * 1024);
  } catch (err) {
    // 仅对超时（httpGet 以 TIMEOUT_ERR 哨兵销毁连接）做单次重试，其余真实错误直接上抛，避免掩盖故障。
    if (err === TIMEOUT_ERR) {
      console.warn(`[electron] id 列表请求首次超时，重试一次（url=${url}）`);
      resp = await httpGet(url, EXPORT_REQUEST_TIMEOUT_MS, 16 * 1024 * 1024);
    } else {
      throw err;
    }
  }
  if (resp.statusCode !== 200) {
    throw new Error(`id 列表接口返回 HTTP ${resp.statusCode}`);
  }
  const ids = JSON.parse(resp.body);
  if (!Array.isArray(ids)) {
    throw new Error('后端返回的 id 列表格式异常');
  }
  const existingIds = new Set();
  for (const id of ids) {
    if (typeof id === 'number') existingIds.add(id);
  }
  return existingIds;
}


/**
 * 构建导出/预览载荷（export-data / preview-export-data 共用同一口径，保证两处输出恒一致）：
 * fetchExportPayload 拉取 /api/export → sanitizeSettingsForDisk 同口径剥离 llm.base_url
 * （api_key 已由后端 public_dump 剔除）→ readRendererResume 并入顶层 resume 段（读取失败/为空则省略）。
 */
async function buildExportPayload() {
  const payload = await fetchExportPayload();
  // 导出载荷已由后端 public_dump 剔除 llm.api_key；此处按 sanitizeSettingsForDisk 同口径再补剥离
  // llm.base_url，保证导出文件跨机器迁移时不携带任何 LLM 凭据 / 提供商重定向字段。
  if (isPlainObject(payload.settings)) {
    sanitizeSettingsForDisk(payload.settings);
  }
  // 简历快照：简历仅存渲染进程 localStorage，后端 /api/export 不含；经 readRendererResume 读取后
  // 并入顶层 resume 段（可解析对象；读取失败 / 为空则省略），import-data 导入时写回渲染层 localStorage，
  // 闭合「导出→换机→导入」的简历迁移回路，避免简历随换机 / 清空浏览器数据永久丢失。
  const resumeJson = await readRendererResume();
  if (resumeJson) {
    try {
      payload.resume = JSON.parse(resumeJson);
    } catch (_err) {
      // 简历快照损坏时不阻塞导出/预览：保持载荷不含 resume 段，导入侧按缺省跳过
    }
  }
  return payload;
}


/** 错误消息归一化：Error 实例取 message，其余值转字符串。 */

/**
 * 从当前已加载的渲染窗口读取简历 localStorage 快照（executeJavaScript，best-effort）。
 * 简历仅存于渲染进程 localStorage（ResumePage），后端 app.db / settings.json 均不含；
 * 备份/导出时经本函数读取后落盘或并入载荷，闭合「简历纳入备份/导出」回路。
 * 窗口未加载 / 读取失败返回 null（调用方跳过，不阻塞备份/导出）。
 */
/** 查找已加载且未销毁的渲染窗口（readRendererResume / writeRendererResume 共用，避免守卫条件漂移）。 */
function findLoadedRendererWindow() {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && !w.webContents.isDestroyed() && !w.webContents.isLoading()
  );
}


async function readRendererResume() {
  // 优先读取数据目录中的权威副本（resume-saved IPC 在每次保存/导入时写入）：
  // 相比 executeJavaScript 的 best-effort 读取，磁盘副本在窗口未加载 / 加载中被跳过时
  // （如启动瞬间 autoBackup 早于 createWindow）仍可靠，闭合「备份静默遗漏 resume.json」的缺口。
  const diskPath = path.join(getDataDir(), 'resume.json');
  try {
    if (fs.existsSync(diskPath)) {
      const raw = fs.readFileSync(diskPath, 'utf-8');
      if (typeof raw === 'string' && raw.length > 0) return raw;
    }
  } catch (err) {
    console.warn(`[electron] 读取数据目录简历快照失败（降级 executeJavaScript）：${errMsg(err)}`);
  }
  const win = findLoadedRendererWindow();
  if (!win) return null;
  try {
    const raw = await win.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(RESUME_STORAGE_KEY)})`
    );
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  } catch (err) {
    console.warn(`[electron] 读取渲染层简历快照失败（跳过简历备份）：${errMsg(err)}`);
    return null;
  }
}


/**
 * 把简历快照写入数据目录 resume.json（渲染层保存时经 resume-saved IPC 落盘，导入/恢复时同步）：
 * 与 localStorage 双写，使主进程始终持有权威磁盘副本，备份/导出/恢复不再依赖 best-effort 读取。
 * 写入失败仅告警，不抛错；返回是否成功。
 */
async function writeResumeJsonToDataDir(jsonText) {
  try {
    const dir = getDataDir();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'resume.json'), jsonText, 'utf-8');
    return true;
  } catch (err) {
    console.warn(`[electron] 写入数据目录简历快照失败（${errMsg(err)}）`);
    return false;
  }
}


/**
 * 把简历快照写回渲染窗口 localStorage（executeJavaScript，best-effort）。
 * 导入 / 恢复数据时调用，使简历与投递记录一起还原；同步写入数据目录副本保持权威一致。
 * 窗口未加载 / 写入失败返回 false。
 */
async function writeRendererResume(jsonText) {
  if (typeof jsonText !== 'string') return false;
  // 数据目录 resume.json 是权威磁盘副本（备份/导出/恢复均读磁盘，见 readRendererResume），
  // 故磁盘写成功即为本次写入成功信号；localStorage 同步是渲染层的 best-effort 缓存，
  // 写失败只记警告，不因此把 resumeStatus 误报为 write_failed（否则磁盘已落盘仍提示用户重存）。
  const diskOk = await writeResumeJsonToDataDir(jsonText);
  if (!diskOk) return false;
  const win = findLoadedRendererWindow();
  if (!win) return true; // 磁盘已落盘，窗口未加载仅影响 localStorage 缓存，不视为失败
  try {
    const ok = await win.webContents.executeJavaScript(
      `try { localStorage.setItem(${JSON.stringify(RESUME_STORAGE_KEY)}, ${JSON.stringify(jsonText)}); true; } catch (e) { false; }`
    );
    if (ok !== true) {
      console.warn('[electron] 写回渲染层 localStorage 简历失败（磁盘副本已落盘，仅缓存未同步）');
    }
    return true;
  } catch (err) {
    console.warn(`[electron] 写回渲染层 localStorage 简历失败：${errMsg(err)}（磁盘副本已落盘，仅缓存未同步）`);
    return true;
  }
}


/**
 * 把简历快照写入备份目录的 resume.json（backup-data / backup-now / autoBackup 共用）：
 * 与 app.db / settings.json 并列，restore-data 恢复时一并写回渲染层 localStorage。
 * 落盘后把 resume.json 的 SHA-256 校验和并入同目录 manifest.json（若已生成），
 * 使 verifyBackupManifest 对简历快照同样做完整性校验（缺失/损坏的 manifest 更新仅告警不阻塞）。
 * 读取 / 写入任一失败仅告警，不阻塞备份主流程。
 */
async function writeResumeSnapshotTo(dir) {
  const resumeJson = await readRendererResume();
  if (!resumeJson) return false;
  try {
    fs.writeFileSync(path.join(dir, 'resume.json'), resumeJson, 'utf-8');
    // 追加 resume.json 校验和到 manifest.json（sha256OfFile 为函数声明，可提前引用）
    const manifestPath = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (isPlainObject(manifest)) {
          const checksums =
            isPlainObject(manifest.checksums)
              ? manifest.checksums
              : {};
          const sum = sha256OfFile(path.join(dir, 'resume.json'));
          if (sum) {
            checksums['resume.json'] = sum;
            manifest.checksums = checksums;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
          }
        }
      } catch (_e) {
        // manifest 更新失败不影响简历备份本身（restore-data 对损坏 resume.json 有 try/catch 兜底）
      }
    }
    return true;
  } catch (err) {
    console.warn(`[electron] 写入备份简历快照失败（${errMsg(err)}），跳过简历备份`);
    return false;
  }
}


/**
 * 刷新外部链接宿主扩展白名单缓存并预归一化后缀数组。
 * 与 cachedExternalHostAllowlist 的每一处赋值配套调用：仅在白名单变更时计算一次，
 * isExternalHostAllowed 直接迭代预计算数组，杜绝 open-external 高频路径上的冗余计算。
 * 顺带记录本次读盘时 settings.json 的 mtimeMs，供 maybeRefreshExternalHostAllowlist 做变更检测。
 */
function refreshExternalHostAllowlistCache() {
  state.cachedExternalHostAllowlist = loadUserExternalHostAllowlist();
  state.cachedExternalHostSuffixes = DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED.concat((state.cachedExternalHostAllowlist || []).map((suffix) =>
    String(suffix).toLowerCase().replace(/^\./, '').replace(/\.+$/, '')
  ));
  state.lastAllowlistMtime = getSettingsMtime();
}


/**
 * 按需刷新外部链接宿主扩展白名单缓存：settings.json 的 mtime 未变化（上次读盘后无人改动）则跳过刷新、
 * 命中缓存直接放行；仅文件变更时才重读——既保持「渲染层直连保存新域名后无需重启即可放行」的语义，
 * 又避免 open-external 每次打开链接都做同步读盘 + JSON.parse 的重复 I/O（连续打开多个职位链接时尤甚）。
 */
function maybeRefreshExternalHostAllowlist() {
  const currentMtime = getSettingsMtime();
  if (currentMtime !== state.lastAllowlistMtime) {
    refreshExternalHostAllowlistCache();
  }
}


/**
 * 读取用户在 settings.json 中配置的外部链接宿主扩展白名单。
 * 字段：security.external_url_hosts（字符串数组，如 ["example.com"]，其子域名自动放行）。
 * 缺失 / 解析失败 → 返回空数组，仅用默认白名单，保证安全收敛。
 */
function loadUserExternalHostAllowlist() {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return [];
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const list = data && data.security && Array.isArray(data.security.external_url_hosts)
      ? data.security.external_url_hosts
      : [];
    return list
      .filter((item) => {
        if (typeof item !== 'string') return false;
        const h = item.trim();
        if (h.length === 0) return false;
        // 对齐 Settings 表单校验：拒绝含协议/端口/路径的条目；归一化（去首尾点）后必须含至少一个点（拒绝裸单标签如 "com"），
        // 否则 isExternalHostAllowed 会放行所有 *.com 宿主，突破表单校验。
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h) || /[\/:]/.test(h)) return false;
        return h.replace(/^\.+/, '').replace(/\.+$/, '').split('.').length >= 2;
      })
      .map((item) => item.trim());
  } catch (err) {
    console.warn(`[electron] 读取外部链接宿主扩展白名单失败（${errMsg(err)}），仅用默认白名单。`);
    return [];
  }
}


/**
 * 宿主是否命中白名单后缀：精确匹配或子域名匹配（如 zhipin.com、www.zhipin.com）。
 */
function isExternalHostAllowed(host) {
  // host 侧同样去尾随点：new URL().hostname 会保留尾随点（如 www.zhipin.com.），
  // 与后缀侧归一化对称，避免尾随点链接被误拒。
  const h = String(host).toLowerCase().replace(/\.+$/, '');
  // 迭代预归一化后缀数组（refreshExternalHostAllowlistCache 在每次白名单赋值时重建）；
  // null 仅出现在极端时序，兜底用预归一化默认白名单（DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED）放行，与原始行为保持一致。
  const suffixes = state.cachedExternalHostSuffixes || DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED;
  return suffixes.some((s) => h === s || h.endsWith('.' + s));
}


/**
 * 把投递记录扁平化为 CSV 文本（UTF-8 BOM 前缀 + 表头，Excel 双击直接打开、中文不乱码）。
 * 与 JSON 导出（/api/export）同数据源：applications 全表 + apply_logs 全表，
 * 每行按 application_id 汇总该投递的日志时间线到 apply_logs 列（『action | 时间 | 备注』，以换行拼接），
 * 无日志记录留空 —— Excel 里可据此做『投递→约面→offer』漏斗/时长分析，不再只覆盖 applications 扁平字段。
 */
function applicationsToCsv(applications, applyLogs) {
  const columns = ['id', 'job_title', 'company', 'city', 'salary', 'url', 'status', 'note', 'applied_at', 'updated_at', 'apply_logs'];
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    // CSV 公式注入防御：Excel/LibreOffice 会把以 =,+,-,@ 开头（含前导空白/控制字符绕过，
    // 如 ' =HYPERLINK(...)'、NBSP+@cmd、'\n=1+1'、NEL()=1+1）的单元格解释为公式/DDE。
    // 剥离全部前导控制字符（C0 \x00-\x1F、DEL/C1 \x7F-\x9F，含 NEL \x85）与空白（空格/NBSP/
    // 全角空格）后，若首字符是公式触发符，或首字符是双引号且紧随的是公式触发符（防仅 RFC 引用
    // 导致二次求值），或本身以单引号开头，就加前导单引号强制按文本处理；纯空白/控制字符的
    // 单元格也中和为空，避免被误判执行。
    const head = s.replace(/^[\x00-\x1F \x7F-\x9F\xA0\u3000]+/, '');
    if (s.startsWith("'") || /^[=+\-@]/.test(head) || /^"[=+\-@]/.test(head)) s = "'" + s;
    else if (head === '') s = '';
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // 按 application_id 汇总日志时间线（保持 /api/export 的 id 升序），供每行拼接。
  const logsByApp = new Map();
  for (const log of applyLogs || []) {
    const appId = log && log.application_id;
    if (appId == null) continue;
    if (!logsByApp.has(appId)) logsByApp.set(appId, []);
    logsByApp.get(appId).push(log);
  }
  const timelineOf = (a) => {
    const logs = logsByApp.get(a && a.id);
    if (!logs || !logs.length) return '';
    return logs
      .map((l) => {
        const ts = l.created_at == null ? '' : String(l.created_at);
        const parts = ts ? [l.action, ts] : [l.action];
        if (l.detail != null && String(l.detail) !== '') parts.push(l.detail);
        return parts.join(' | ');
      })
      .join('\n');
  };
  const lines = [columns.map(esc).join(',')];
  for (const a of applications) {
    const row = columns.map((c) => (c === 'apply_logs' ? timelineOf(a) : a && a[c]));
    lines.push(row.map(esc).join(','));
  }
  return '﻿' + lines.join('\r\n');
}


/**
 * 合并导入数据携带的脱敏 settings 到当前 settings.json：
 * 以当前配置为基底做顶层组合并 —— 导入组缺省/缺失的键保留当前值，
 * 尤其保留 llm.api_key（DPAPI 密文，导出载荷永不含该字段）与 llm.base_url。
 * 防御：若导出端版本较旧仍带凭据/提供商重定向字段，先在导入侧剥离再合并，
 * 绝不把攻击者指定的 LLM 凭据与提供商地址落盘。
 * 返回 settingsStatus（与 restore-data 取值对齐）：
 *   'restored'（合并写入成功）| 'retained_credentials_stripped'（合并成功但剥离了 LLM 凭据/重定向字段）
 *   | 'parse_failed'（当前或导入侧不可解析，保留当前配置）。
 */
/** 校验单个「良性配置键」的导入载荷，返回规范化后的可合并对象；仅当非对象时才返回 null（整体拒绝）。
 *  cities（目标城市）要求字符串数组；apply/browser/blacklist 逐子键校验——非法子键丢弃、合法子键保留
 *  （与 restoreSettingsSafely 逐子键口径一致，避免 daily_limit 非法时连同合法 interval_seconds 一起被剥）。
 *  注意：仅当没有任何已知子键合法时整体返回 null（调用方丢弃该键）；空对象 apply:{} 返回 {}，
 *  由调用方合并（空对象不重置为默认值——mergeImportedSettings 里 merged[key]=benign 覆盖为空对象
 *  会清空当前值，故调用方需在结果为空对象时跳过覆盖，见 validateImportedBenignKey 调用处）。
 */
function validateImportedBenignKey(key, value) {
  if (key === 'cities') {
    // 逐项过滤而非整体拒绝（与 apply/browser/blacklist 逐子键口径一致）：单条空串/纯空白城市
    // 只被丢弃，合法城市照常保留——整体 every() 校验会让一条非法导致所有城市静默丢失
    if (!Array.isArray(value)) return null;
    const valid = value.filter((c) => typeof c === 'string' && c.trim() !== '');
    return valid.length > 0 ? valid : null;
  }
  if (!isPlainObject(value)) return null;
  if (key === 'apply') {
    const rebuilt = {};
    if ('daily_limit' in value) {
      if (Number.isInteger(value.daily_limit) && value.daily_limit >= 1 && value.daily_limit <= 500) rebuilt.daily_limit = value.daily_limit;
    }
    if ('halt_on_risk' in value) {
      if (typeof value.halt_on_risk === 'boolean') rebuilt.halt_on_risk = value.halt_on_risk;
    }
    if ('interval_seconds' in value) {
      // 非空约束：空数组 [] 会通过 every()（vacuous truth），导入 {interval_seconds:[]} 会把
      // 已配置的投递间隔静默清空；空数组视为非法子键丢弃，保留当前配置
      if (Array.isArray(value.interval_seconds) && value.interval_seconds.length > 0 && value.interval_seconds.every((x) => Number.isInteger(x) && x >= 1 && x <= 3600)) rebuilt.interval_seconds = value.interval_seconds;
    }
    return Object.keys(rebuilt).length > 0 ? rebuilt : null;
  }
  if (key === 'browser') {
    const rebuilt = {};
    if ('headless' in value && typeof value.headless === 'boolean') rebuilt.headless = value.headless;
    if ('user_data_dir' in value && typeof value.user_data_dir === 'string') rebuilt.user_data_dir = value.user_data_dir;
    return Object.keys(rebuilt).length > 0 ? rebuilt : null;
  }
  if (key === 'blacklist') {
    const rebuilt = {};
    if ('companies' in value && Array.isArray(value.companies) && value.companies.every((x) => typeof x === 'string')) rebuilt.companies = value.companies;
    if ('keywords' in value && Array.isArray(value.keywords) && value.keywords.every((x) => typeof x === 'string')) rebuilt.keywords = value.keywords;
    return Object.keys(rebuilt).length > 0 ? rebuilt : null;
  }
  return null;
}


function mergeImportedSettings(imported) {
  let current = {};
  const settingsPath = getSettingsPath();
  try {
    if (fs.existsSync(settingsPath)) {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[electron] 读取当前 settings.json 失败，按空配置合并：${errMsg(err)}`);
    current = {};
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    current = {};
  }
  const merged = { ...current };
  let strippedCount = 0;
  // 是否剥离了 LLM 凭据/提供商重定向/外链白名单（安全敏感）——与「良性键非法被丢弃」区分开，
  // 前者返回 RETAINED_CREDENTIALS_STRIPPED，后者仅记 strippedCount（status 仍为 RESTORED，
  // 避免往返导入被误报「LLM 密钥已剥离」，实际上只是丢了个非法良性键）。
  let strippedCredentials = false;
  // 白名单合并：接受已知顶层键 port/llm/security/backup + 良性配置键 cities/apply/browser/blacklist，
  // 其余未知键一律剥离并计数报告。防止不可信导入文件把任意配置键原样写进 settings.json
  // （如 backup.intervalMinutes=1 触发 1 分钟高频自动备份、backup.maxBackups=60 关闭轮转等）。
  const ALLOWED_IMPORT_KEYS = new Set(['port', 'llm', 'security', 'backup', 'cities', 'apply', 'browser', 'blacklist']);
  for (const [key, value] of Object.entries(imported)) {
    if (!ALLOWED_IMPORT_KEYS.has(key)) {
      // 未知顶层键：剥离，不写入 settings.json
      strippedCount += 1;
      continue;
    }
    if (key === 'port') {
      // 端口安全敏感：仅合并经 isValidPort 校验通过的整数，非法/越界端口丢弃并告警。
      const portValue = Number(value);
      if (!isValidPort(portValue)) {
        strippedCount += 1;
        continue;
      }
      merged.port = portValue;
      continue;
    }
    if (key === 'cities' || key === 'apply' || key === 'browser' || key === 'blacklist') {
      // 良性配置键：导出往返应随导入迁移（目标城市/投递合规/浏览器 Profile/黑名单），
      // 逐子键类型校验后合并；整体非法（非对象/子键类型错）→ 丢弃该键并计数
      const benign = validateImportedBenignKey(key, value);
      if (benign === null) {
        strippedCount += 1;
        continue;
      }
      if (key === 'cities') {
        // cities 是 list[str]，非对象：直接整段替换，严禁对象展开——否则会写成 {0:'广州',1:'深圳'}
        // 数字键对象，后端 pydantic Settings.cities: list[str] 校验失败、下次启动崩溃
        merged.cities = benign;
      } else {
        // apply/browser/blacklist 子键合并（与 llm/security 同口径）：仅用导入的合法子键覆盖当前值，
        // 保留当前配置中缺省/缺失的子键——否则手改/部分导入文件（如 {apply:{daily_limit:20}}）会
        // 静默丢弃当前 apply.interval_seconds/halt_on_risk，下次加载回退默认值 [45,120]/true
        merged[key] = { ...(isPlainObject(current[key]) ? current[key] : {}), ...benign };
      }
      continue;
    }
    if (key === 'backup') {
      // 备份配置按 getBackupSettings 同口径逐项校验：仅接受 maxBackups（1~60 整数）、
      // autoBackupEnabled（布尔）、intervalMinutes（null 或 1~1440 整数）；非对象载荷、
      // 非法取值/未知子键一律剥离，防止恶意导入关闭备份轮转或开启超高频备份。
      if (!isPlainObject(value)) {
        strippedCount += 1;
        continue;
      }
      for (const bk of Object.keys(value)) {
        if (bk !== 'maxBackups' && bk !== 'autoBackupEnabled' && bk !== 'intervalMinutes') {
          strippedCount += 1;
        }
      }
      const currentBackup = isPlainObject(merged.backup) ? merged.backup : {};
      const backupPatch = {};
      let backupValid = false;
      if (value.maxBackups !== undefined) {
        if (Number.isInteger(value.maxBackups) && value.maxBackups >= 1 && value.maxBackups <= 60) {
          backupPatch.maxBackups = value.maxBackups;
          backupValid = true;
        } else {
          strippedCount += 1;
        }
      }
      if (value.autoBackupEnabled !== undefined) {
        if (typeof value.autoBackupEnabled === 'boolean') {
          backupPatch.autoBackupEnabled = value.autoBackupEnabled;
          backupValid = true;
        } else {
          strippedCount += 1;
        }
      }
      if (value.intervalMinutes !== undefined) {
        if (value.intervalMinutes === null || (Number.isInteger(value.intervalMinutes) && value.intervalMinutes >= 1 && value.intervalMinutes <= 1440)) {
          backupPatch.intervalMinutes = value.intervalMinutes;
          backupValid = true;
        } else {
          strippedCount += 1;
        }
      }
      if (backupValid) {
        merged.backup = { ...currentBackup, ...backupPatch };
      }
      continue;
    }
    // llm / security：先剥离敏感字段，且要求值为普通对象，否则整体剥离。
    let importedValue = value;
    if (key === 'llm') {
      if (!isPlainObject(value)) {
        strippedCount += 1;
        continue;
      }
      // 防御：导入组即使意外携带凭据/提供商重定向字段也在此剥离后再合并，
      // 保证 llm.api_key（DPAPI 密文）与 llm.base_url 保留当前值（正常导出本就不含）
      if (value.api_key !== undefined) {
        delete value.api_key;
        strippedCount += 1;
        strippedCredentials = true;
      }
      if (value.base_url !== undefined) {
        delete value.base_url;
        strippedCount += 1;
        strippedCredentials = true;
      }
    }
    if (key === 'security') {
      if (!isPlainObject(value)) {
        strippedCount += 1;
        continue;
      }
      // external_url_hosts 复用 restoreSettingsSafely 的逐项校验口径：合法 host 保留（用户自己的
      // 导出可往返迁移白名单），非法条目逐项过滤并计数——仅过滤非法项，不整体剥离整个白名单，
      // 也不再把它计入 strippedCredentials（它不属于 LLM 凭据，剥离只是丢非法 host，不误报密钥）。
      if (value.external_url_hosts !== undefined) {
        const hosts = value.external_url_hosts;
        if (Array.isArray(hosts)) {
          const valid = hosts.filter((item) => {
            if (typeof item !== 'string') return false;
            const h = item.trim();
            if (h.length === 0) return false;
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h) || /[\/:]/.test(h)) return false;
            return h.replace(/^\.+/, '').replace(/\.+$/, '').split('.').length >= 2;
          });
          if (valid.length > 0) {
            value.external_url_hosts = valid;
            if (valid.length !== hosts.length) strippedCount += hosts.length - valid.length;
          } else {
            delete value.external_url_hosts;
            strippedCount += 1;
          }
        } else {
          delete value.external_url_hosts;
          strippedCount += 1;
        }
      }
    }
    if (
      importedValue && isPlainObject(importedValue) &&
      current[key] && isPlainObject(current[key])
    ) {
      merged[key] = { ...current[key], ...importedValue };
    } else {
      merged[key] = importedValue;
    }
  }
  if (strippedCount > 0) {
    console.warn(`[electron] 导入数据合并 settings.json：已剥离 ${strippedCount} 项未知或非法字段，仅合并白名单键（port/llm/security/backup/cities/apply/browser/blacklist）。`);
  }
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
    state.backupSettingsCache = null; // 导入合并可能改写 backup 段，失效自动备份配置缓存
    // status 语义：仅当剥离了安全敏感凭据（LLM 密钥/提供商地址/外链白名单）才报
    // RETAINED_CREDENTIALS_STRIPPED（前端提示「LLM 密钥已剥离需重配」）；剥离非法良性键
    // 只是丢了单个配置项，配置仍算合并成功 → RESTORED，避免往返导入误报「密钥已剥离」。
    return strippedCredentials ? SETTINGS_STATUS.RETAINED_CREDENTIALS_STRIPPED : SETTINGS_STATUS.RESTORED;
  } catch (err) {
    console.warn(`[electron] 合并写入 settings.json 失败，保留当前配置：${errMsg(err)}`);
    return SETTINGS_STATUS.PARSE_FAILED;
  }
}


/**
 * 离线导出/预览降级通道（export-data / preview-export-data / export-data-csv 的后端不可达替代）：
 * 复用 preview-backup 的 node:sqlite 读备份库逻辑（stageDbForRead 暂存 + WAL 回放），
 * 从自动备份目录最新一份备份的 app.db 读取 applications / apply_logs，序列化为与
 * /api/export 同构的载荷（不含 settings/resume：离线通道只做「数据」查看/导出，配置与简历
 * 仍走备份/恢复主流程）。后端崩溃/端口冲突（应用显式处理的常见态）下，导出/预览/投递日志
 * 按钮降级到此通道，错误态下用户仍可查看/导出自己的数据，工具条「仅依赖主进程文件快照」契约才真正成立。
 */

/**
 * 读取自动备份目录最新一份备份的 app.db（BossJobAI-backup-* 按时间倒序取最新），
 * 经 stageDbForRead 暂存 + node:sqlite 读全量 applications / apply_logs。
 * 返回 { backupName, payload }；无备份 / 备份不可读 / node:sqlite 不可用时返回 null。
 * 只读安全：暂存副本在临时目录，调用方 finally 清理；绝不触碰线上主库（离线态主库可能仍被后端进程占用）。
 */
function readLatestBackupExport() {
  const backupDir = getBackupDir();
  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return null; // 备份目录不存在 → 无离线数据
  }
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_DIR_PREFIX))
    .map((e) => e.name)
    .sort((a, b) => {
      const ka = backupSortKey(a);
      const kb = backupSortKey(b);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
  if (backups.length === 0) return null;
  const backupName = backups[0];
  const dbPath = path.join(backupDir, backupName, 'app.db');
  if (!fs.existsSync(dbPath)) return null;
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    sqlite = null;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return null;
  let target;
  let cleanupDir;
  try {
    const staged = stageDbForRead(dbPath);
    target = staged.target;
    cleanupDir = staged.cleanupDir;
  } catch {
    return null; // 暂存失败（文件被占用等）→ 无离线数据
  }
  try {
    const db = new sqlite.DatabaseSync(target, { readOnly: cleanupDir == null });
    try {
      const applications = db.prepare('SELECT * FROM applications ORDER BY id').all();
      const applyLogs = db.prepare('SELECT * FROM apply_logs ORDER BY id').all();
      const appRows = (Array.isArray(applications) ? applications : []).map((r) => ({
        id: r.id,
        job_title: r.job_title,
        company: r.company,
        city: r.city,
        salary: r.salary,
        url: r.url,
        status: r.status,
        note: r.note,
        applied_at: r.applied_at == null ? null : String(r.applied_at),
        updated_at: r.updated_at == null ? null : String(r.updated_at),
      }));
      const logRows = (Array.isArray(applyLogs) ? applyLogs : []).map((r) => ({
        id: r.id,
        application_id: r.application_id,
        action: r.action,
        detail: r.detail,
        created_at: r.created_at == null ? null : String(r.created_at),
      }));
      return {
        backupName,
        payload: {
          exported_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          applications: appRows,
          apply_logs: logRows,
        },
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    if (cleanupDir) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}


// ---------------------------------------------------------------------------
// 数据备份：app.db + settings.json 快照（手动/自动/轮转）
// ---------------------------------------------------------------------------

/**
 * 读取自动备份配置（settings.json 的 backup 段，数据页「备份设置」入口读写）：
 * - maxBackups：保留份数上限（1~60 整数，默认 7）；
 * - autoBackupEnabled：是否启用定时自动备份（布尔，默认 true）；
 * - intervalMinutes：定时备份间隔分钟数（1~1440 整数；null 表示未配置定时）。
 * 读取失败 / 字段缺失 / 取值非法时逐项回退默认值，不抛错。
 */
function getBackupSettings() {
  if (state.backupSettingsCache) {
    // settings.json mtime 未变化 → 缓存仍有效直接返回；外部写入（如 Settings 页 PUT /api/settings 含 backup 段）
    // 会改变文件 mtime，此时失效缓存重新读盘，杜绝陈旧 maxBackups/intervalMinutes 持续到重启。
    const currentMtime = getSettingsMtime();
    if (currentMtime === state.lastBackupSettingsMtime) {
      return state.backupSettingsCache;
    }
    state.backupSettingsCache = null;
  }
  const settingsPath = getSettingsPath();
  let data = {};
  try {
    if (fs.existsSync(settingsPath)) {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[electron] 读取 settings.json 失败，自动备份配置使用默认值：${errMsg(err)}`);
    data = {};
  }
  const cfg = isPlainObject(data) ? data.backup : null;
  const settings = {
    maxBackups: DEFAULT_MAX_AUTO_BACKUPS,
    autoBackupEnabled: true,
    intervalMinutes: null,
  };
  if (isPlainObject(cfg)) {
    if (Number.isInteger(cfg.maxBackups) && cfg.maxBackups >= 1 && cfg.maxBackups <= 60) {
      settings.maxBackups = cfg.maxBackups;
    }
    if (typeof cfg.autoBackupEnabled === 'boolean') {
      settings.autoBackupEnabled = cfg.autoBackupEnabled;
    }
    if (Number.isInteger(cfg.intervalMinutes) && cfg.intervalMinutes >= 1 && cfg.intervalMinutes <= 1440) {
      settings.intervalMinutes = cfg.intervalMinutes;
    }
  }
  state.backupSettingsCache = settings;
  state.lastBackupSettingsMtime = getSettingsMtime();
  return settings;
}


/**
 * 持久化自动备份配置到 settings.json 的 backup 段。patch 为 { maxBackups?, autoBackupEnabled?, intervalMinutes? }
 * 的任意子集，未提供的字段保持原值；intervalMinutes 显式传 null 表示取消定时。
 * 写入失败仅告警，不抛错；返回 { settings, writeOk } —— settings 为最新完整配置（供 update-backup-settings 回填给渲染层），
 * writeOk 标识 settings.json 是否落盘成功（false 时本次改动仅存于会话内存，下次启动会回退）。
 */
function saveBackupSettings(patch) {
  const settingsPath = getSettingsPath();
  let current = {};
  try {
    if (fs.existsSync(settingsPath)) {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch (err) {
    console.warn(`[electron] 读取 settings.json 失败，按空配置写入自动备份设置：${errMsg(err)}`);
    current = {};
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    current = {};
  }
  const backup = isPlainObject(current.backup)
    ? { ...current.backup }
    : {};
  if (isPlainObject(patch)) {
    if (patch.maxBackups !== undefined) backup.maxBackups = patch.maxBackups;
    if (patch.autoBackupEnabled !== undefined) backup.autoBackupEnabled = patch.autoBackupEnabled;
    if (patch.intervalMinutes !== undefined) backup.intervalMinutes = patch.intervalMinutes;
  }
  current.backup = backup;
  let writeOk = true;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[electron] 写入自动备份配置失败，仅保留本次会话内存态：${errMsg(err)}`);
    writeOk = false;
  }
  if (writeOk) {
    state.backupSettingsCache = null; // 磁盘 backup 段已更新，强制下次 getBackupSettings() 重新读盘解析
    return { settings: getBackupSettings(), writeOk: true };
  }
  // 写入失败：以本次会话内存中的 backup 段（含本次 patch）回填缓存，保证 update-backup-settings
  // 返回给渲染层及后续 getBackupSettings() 一致（下次启动仍以磁盘旧配置为准回退）。
  state.backupSettingsCache = {
    maxBackups: Number.isInteger(backup.maxBackups) && backup.maxBackups >= 1 && backup.maxBackups <= 60
      ? backup.maxBackups
      : DEFAULT_MAX_AUTO_BACKUPS,
    autoBackupEnabled: typeof backup.autoBackupEnabled === 'boolean' ? backup.autoBackupEnabled : true,
    intervalMinutes: Number.isInteger(backup.intervalMinutes) && backup.intervalMinutes >= 1 && backup.intervalMinutes <= 1440
      ? backup.intervalMinutes
      : null,
  };
  return { settings: state.backupSettingsCache, writeOk: false };
}


/**
 * 按 settings.json 的自动备份配置启停「定时自动备份」：
 * - autoBackupEnabled=true 且 intervalMinutes 为正整数 → 以该分钟数为周期执行 autoBackup()；
 * - 否则清除已有定时器。启动时/破坏性操作前的一次性备份不受开关影响（安全兜底）。
 */
function syncBackupInterval() {
  if (state.backupIntervalTimer) {
    clearInterval(state.backupIntervalTimer);
    state.backupIntervalTimer = null;
  }
  const { autoBackupEnabled, intervalMinutes } = getBackupSettings();
  if (autoBackupEnabled && Number.isInteger(intervalMinutes) && intervalMinutes >= 1) {
    state.backupIntervalTimer = setInterval(() => void autoBackup(), intervalMinutes * MS_PER_MINUTE);
    console.log(`[electron] 定时自动备份已启用：每 ${intervalMinutes} 分钟一次`);
  }
}


/**
 * 对活动的 app.db 执行 `PRAGMA wal_checkpoint(TRUNCATE)`（通过 node:sqlite），把最近提交的帧
 * 全部回写进主库文件并清空 -wal，使后续仅拷贝 app.db 即为一致快照。
 * - 返回 true：checkpoint 成功（busy=0），-wal 已清空，单文件拷贝即可；
 * - 返回 false：node:sqlite 不可用 / 打不开 / checkpoint 期间后端正在写入返回 busy>0，
 *   调用方应退回「db + -wal + -shm」三件套拷贝（不丢 -wal 尾部最近写入）。
 */
function checkpointDbToSingleFile(dbPath) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return false;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    return false;
  }
  let db;
  try {
    // readOnly:false 才能执行 TRUNCATE（需对 -wal 有写权限）；WAL 模式多进程并发打开安全
    db = new sqlite.DatabaseSync(dbPath, { readOnly: false });
    db.exec('PRAGMA busy_timeout = 3000'); // 给后端瞬时写锁一个等待窗口，降低 busy>0 概率
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    // row 形如 { busy, log, checkpointed }；busy>0 表示存在并发写事务，-wal 未清空。
    // 仅在「确实拿到 busy=0 的结果行」时判定成功（true）；row 缺失/异常一律视为失败（false），
    // 由调用方退回三件套拷贝，绝不基于未执行的 checkpoint 做单文件快照而静默丢 -wal 尾部。
    return Boolean(row) && Number(row.busy) === 0;
  } catch (err) {
    console.warn(`[electron] WAL checkpoint(TRUNCATE) 失败，退回三件套拷贝：${errMsg(err)}`);
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}


/**
 * 把 app.db（及 WAL 模式配套的 app.db-wal / app.db-shm，见下）+ settings.json 快照进目标目录 dir
 * （目录不存在则创建）。
 * - 一致性策略：快照前先对本活动库执行 `PRAGMA wal_checkpoint(TRUNCATE)`（node:sqlite）把最近
 *   提交的帧全部回写进主库文件并清空 -wal，随后仅拷贝 app.db 单文件即为一刻钟一致快照。
 *   旧实现把 app.db / -wal / -shm 拆成三次独立 copyFileSync：期间后端可能并发 checkpoint 把已提交
 *   帧从 -wal 移回主库，使「拷完 app.db 再拷 -wal」两边状态错位，静默丢掉最新记录，或产生撕裂副本。
 * - checkpoint 不可用 / 期间后端正在写入返回 busy>0 时，退回三件套一并拷贝（保持旧行为，不丢 -wal 尾部）。
 *   单文件快照路径会清理目标目录残留的 -wal/-shm，保证备份自洽；app.db 与 settings.json 均缺失时抛错。
 */
function snapshotToDir(dir) {
  const dbPath = path.join(getDataDir(), 'app.db');
  const settingsPath = getSettingsPath();
  assertSafeMkdirTarget(dir, '目标备份目录为链接或非目录，已拒绝写入');
  fs.mkdirSync(dir, { recursive: true });
  let copied = 0;
  if (fs.existsSync(dbPath)) {
    // 一致快照：先强制 WAL checkpoint(TRUNCATE) 清空 -wal，尽量只拷贝单文件 app.db，
    // 消除「拷 db 与拷 wal 之间并发 checkpoint 移动已提交帧」的三瞬间竞态。
    let copiedWal = true; // 默认三件套路径（与旧行为一致的兜底）
    try {
      if (checkpointDbToSingleFile(dbPath)) {
        fs.copyFileSync(dbPath, path.join(dir, 'app.db'));
        copied += 1;
        copiedWal = false;
      }
    } catch (err) {
      console.warn(`[electron] WAL checkpoint 后单文件拷贝失败，尝试三件套：${errMsg(err)}`);
    }
    if (copiedWal) {
      // checkpoint 不可用（无 node:sqlite）或后端正写入返回 busy>0：退回三件套一并拷贝，
      // 避免 -wal 尾部的最近写入被丢弃（恢复时需三件套回放）
      fs.copyFileSync(dbPath, path.join(dir, 'app.db'));
      copied += 1;
      for (const suffix of SQLITE_WAL_SUFFIXES) {
        const src = dbPath + suffix;
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(dir, 'app.db' + suffix));
        }
      }
    } else {
      // 单文件一致快照：目标目录清理掉残留 -wal/-shm，保证备份为自洽单文件
      for (const suffix of SQLITE_WAL_SUFFIXES) {
        const stale = path.join(dir, 'app.db' + suffix);
        if (fs.existsSync(stale)) {
          try {
            fs.rmSync(stale, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  if (fs.existsSync(settingsPath)) {
    const targetSettings = path.join(dir, 'settings.json');
    try {
      // 安全备份：先剥离 llm.api_key / llm.base_url 再落盘（sanitizeSettingsForDisk；restore 侧为独立的 port 白名单处理），
      // 避免 LLM API 密钥明文驻留磁盘备份目录（打包态 %APPDATA%/BossJobAI/backups、开发态 code/.backups
      // 及用户手动备份目录）。备份仅含 port 等安全字段，恢复时用户需重新填写 LLM 配置。
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const obj = JSON.parse(raw);
      sanitizeSettingsForDisk(obj);
      fs.writeFileSync(targetSettings, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      // 解析/写入失败则回退为原样复制（读取侧自有容错兜底），仅告警
      fs.copyFileSync(settingsPath, targetSettings);
      console.warn(
        `[electron] 备份 settings.json 剥离 llm.api_key/llm.base_url 失败，已原样复制：${errMsg(err)}`
      );
    }
    copied += 1;
  }
  if (copied === 0) {
    throw new Error('未找到可备份的数据文件（app.db / settings.json 均不存在）');
  }
  // 落盘后写入 manifest.json 记录各文件 SHA-256 校验和，供 preview-backup / restore-data 做完整性验证
  try {
    writeBackupManifest(dir);
  } catch (err) {
    // manifest 写入失败（磁盘满/权限/ENOSPC）不影响已完成的 app.db/settings.json 快照，仅告警继续；
    // 缺失 manifest 时 verifyBackupManifest 返回 checked=false，恢复侧降级依赖 SQLite PRAGMA integrity_check
    console.warn(`[electron] 写入备份 manifest.json 失败（${errMsg(err)}），备份主体不受影响`);
  }
  return dir;
}


/**
 * 备份目录创建前安全校验：若路径已存在且为符号链接 / junction（reparse point）或非目录，
 * 拒绝继续——mkdirSync(recursive) 对已有链接是 no-op，后续 copyFileSync/writeFileSync
 * 会穿到链接目标（外部目录）落盘，造成备份写入任意位置。ENOENT（目录尚不存在）正常放行。
 * @param {string} dir 目标备份目录
 * @param {string} errorMessage 拒绝时抛出的错误信息
 */
function assertSafeMkdirTarget(dir, errorMessage) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(errorMessage);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw err; // 已存在且为链接/非目录，或 lstat 权限异常 → 上抛由调用方兜底
    }
    // ENOENT：目录尚不存在，mkdirSync 正常创建（含跨级父目录）
  }
}


/** 生成备份目录名 `BossJobAI-backup-<YYYYMMDD-HHmm>-<base36 后缀>`（base36 保证词法排序与时间序一致，见 backupSortKey）。 */
function newBackupName() {
  return `${BACKUP_DIR_PREFIX}${timestamp()}-${Date.now().toString(36)}`;
}


/** 计算单个文件的 SHA-256（流式读，避免整文件载入内存）；文件不存在/读取失败返回 null。 */
function sha256OfFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = createHash('sha256');
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HASH_READ_BUFFER_BYTES);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, n));
    }
    return hash.digest('hex');
  } catch (_err) {
    // openSync/readSync 竞态异常（EACCES/ENOENT 等）：返回 null，由调用方跳过/降级，不向 IPC 抛错
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* 忽略关闭失败 */
      }
    }
  }
}


/**
 * 备份落盘后写入 manifest.json：记录 app.db（及 WAL 三件套中的 -wal/-shm，存在即记）与
 * settings.json 的 SHA-256 校验和（resume.json 由 writeResumeSnapshotTo 在写盘后并入同表），
 * 供 preview-backup 展示 checksumOk、restore-data 覆盖前验证，
 * 防止截断/损坏/被篡改的备份副本被静默恢复而覆盖当前 app.db 造成不可逆数据损坏。
 */
function writeBackupManifest(dir) {
  const checksums = {};
  for (const name of ['app.db', ...SQLITE_WAL_SUFFIXES.map((suffix) => 'app.db' + suffix)]) {
    const sum = sha256OfFile(path.join(dir, name));
    if (sum) checksums[name] = sum;
  }
  // settings.json / resume.json 一并纳入校验：防止「app.db 完好但 settings/resume 被截断、损坏或篡改」
  // 的备份被 checksumOk 误判为整份备份完好（文件不存在则跳过，存在才记校验和）
  const settingsSum = sha256OfFile(path.join(dir, 'settings.json'));
  if (settingsSum) checksums['settings.json'] = settingsSum;
  const resumeSum = sha256OfFile(path.join(dir, 'resume.json'));
  if (resumeSum) checksums['resume.json'] = resumeSum;
  const manifest = { createdAt: new Date().toISOString(), checksums };
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (err) {
    // manifest 写入失败（磁盘满/权限/ENOSPC）仅告警，快照主体不受影响；缺失 manifest 时
    // verifyBackupManifest 返回 checked=false，恢复侧降级依赖 SQLite PRAGMA integrity_check
    console.warn(`[electron] 写入 manifest.json 失败：${errMsg(err)}`);
  }
}


/**
 * 校验备份目录内文件与其 manifest.json 记录的 SHA-256 是否一致。
 * 返回 { ok, checked, detail }：
 * - checked=false：备份无 manifest.json（本版本之前的旧备份），无法做校验和验证，调用方可降级依赖 SQLite 完整性校验；
 * - ok=false：manifest 损坏/缺失 checksums 字段/任一校验和不匹配（文件被截断、损坏或篡改），恢复方应拒绝覆盖。
 * @param {string} [stagedDir] WAL 三件套的暂存副本目录（stageDbForRead 的 cleanupDir）。传入时，
 *   app.db/-wal/-shm 从该目录读取计算哈希（暂存副本是备份原文件的逐字节拷贝，哈希与备份时记录的校验和等价），
 *   使全文件哈希与随后的 SQLite 打开共享一份读取，避免对备份原文件「先哈希、后拷贝」被读两遍；
 *   settings.json / resume.json 未暂存，仍读备份原文件。未传时行为不变（全部直读备份原文件）。
 */
function verifyBackupManifest(dir, stagedDir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: true, checked: false, detail: '备份无 manifest.json，跳过校验和验证' };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return { ok: false, checked: true, detail: 'manifest.json 无法解析' };
  }
  const checksums = manifest && typeof manifest === 'object' ? manifest.checksums : null;
  if (!checksums || typeof checksums !== 'object') {
    return { ok: false, checked: true, detail: 'manifest.json 缺少 checksums 字段' };
  }
  // 路径穿越防护：manifest checksums 的 key 直接用作 path.join 文件名（import-backup-archive 接受
  // 不可信 zip，其 manifest.json 内容不受信任）。仅允许白名单文件名，拒绝含路径分隔符 / .. 的 name，
  // 否则恶意 zip 可用 checksums 指向任意路径读取（且 sha256OfFile 同步读任意大文件阻塞主进程）。
  const MANIFEST_WHITELIST = /^(app\.db(-wal|-shm)?|settings\.json|resume\.json|manifest\.json)$/;
  for (const name of Object.keys(checksums)) {
    const expected = checksums[name];
    if (!MANIFEST_WHITELIST.test(name)) {
      return { ok: false, checked: true, detail: `manifest 中含非法文件名 ${name}，已拒绝校验` };
    }
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
      return { ok: false, checked: true, detail: `manifest 中 ${name} 校验和非法` };
    }
    const baseDir = stagedDir && name.indexOf('app.db') === 0 ? stagedDir : dir;
    const actual = sha256OfFile(path.join(baseDir, name));
    if (actual !== expected) {
      return { ok: false, checked: true, detail: `${name} 校验和不匹配（文件被截断、损坏或篡改）` };
    }
  }
  return { ok: true, checked: true, detail: '校验和全部匹配' };
}


/** 对自动备份目录做数量轮转：只保留最近 maxBackups 份（按目录名时间戳排序；上限默认取 settings.json 的 backup.maxBackups）。
 *  maxBackups 由调用方传入已解析值（如 saveBackupSettings / getBackupSettings 的结果），
 *  避免本函数内重复读盘解析 settings.json（update-backup-settings IPC 与 autoBackup 复用同一份解析结果）。 */
function rotateAutoBackups(maxBackups = getBackupSettings().maxBackups) {
  const backupDir = getBackupDir();
  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return; // 目录不存在则无需轮转
  }
  const prefix = BACKUP_DIR_PREFIX;
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => ({ name: e.name, full: path.join(backupDir, e.name), ts: backupSortKey(e.name) }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  while (dirs.length > maxBackups) {
    const oldest = dirs.shift();
    try {
      fs.rmSync(oldest.full, { recursive: true, force: true });
      console.log(`[electron] 备份轮转：删除最旧备份 ${oldest.name}`);
    } catch (err) {
      console.warn(`[electron] 备份轮转删除 ${oldest.full} 失败：${errMsg(err)}`);
    }
  }
}


/**
 * 快照全部数据到 dir 并执行自动备份轮转（autoBackup / backup-now 共用同一口径，杜绝三连漂移）：
 * snapshotToDir 快照 app.db + settings.json → writeResumeSnapshotTo 追加简历快照 resume.json
 * （读取失败仅告警不阻塞）→ rotateAutoBackups 按 maxBackups 保留上限裁剪自动备份目录。
 * 返回 dir 供调用方记录 / 返回。
 * 注意：backup-data（手动选目录备份）不适用本助手 —— 其目标为用户自选目录而非自动备份目录，
 * 不应触发 rotateAutoBackups 裁剪自动备份。
 */
async function snapshotAutoBackup(dir) {
  snapshotToDir(dir);
  await writeResumeSnapshotTo(dir);
  rotateAutoBackups();
  return dir;
}


/** 自动备份到备份目录（启动时 / 定时 / 破坏性操作前调用）；失败仅告警，不阻塞业务。
 * 与手动备份同口径：快照 app.db + settings.json 后追加简历快照 resume.json（窗口已加载时），
 * 使定时 / 前置自动备份也能随 restore-data 一并还原简历；读取失败仅告警不阻塞。 */
async function autoBackup() {
  try {
    // 启动早期后端尚未创建 app.db 时跳过快照：此时只能备份出无数据的 settings-only 备份，
    // 既无法用于恢复，还会污染自动备份列表。待 app.db 落盘后由下一次定时/前置自动备份补上。
    if (!fs.existsSync(path.join(getDataDir(), 'app.db'))) {
      console.warn('[electron] app.db 尚不存在（后端未就绪），跳过本次自动备份');
      return null;
    }
    // snapshotAutoBackup：快照 app.db + settings.json → 追加简历快照 resume.json → 轮转保留上限
    const dir = await snapshotAutoBackup(path.join(getBackupDir(), newBackupName()));
    console.log(`[electron] 自动备份完成 → ${dir}`);
    return dir;
  } catch (err) {
    console.warn(`[electron] 自动备份失败：${errMsg(err)}`);
    return null;
  }
}

/** CRC-32（ZIP 规格）：优先内置 zlib.crc32（Node ≥ 20.15），缺失时回退查表实现。 */
function zipCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  if (!zipCrc32._table) {
    zipCrc32._table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      zipCrc32._table[i] = c;
    }
  }
  const table = zipCrc32._table;
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}


/** 把 [{ name, data }] 打包为单一 zip 缓冲区（DEFLATE 压缩，条目名 UTF-8，统一 / 分隔符）。 */
function buildZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const dataBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = zlib.deflateRawSync(dataBuf);
    const crc = zipCrc32(dataBuf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags（已知尺寸，无 data descriptor）
    local.writeUInt16LE(8, 8); // method=DEFLATE
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method=DEFLATE
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...localParts, centralData, eocd]);
}


/**
 * 解析 zip 缓冲区为 [{ name, data }]（目录项跳过）：
 * 中央目录读取条目（尺寸以中央目录为准，兼容带 data descriptor 的流式写入），
 * 局部头仅用于定位数据起始偏移；DEFLATE(8) / STORE(0) 两种压缩方法均支持。
 * zip-slip 防护：条目名含 .. 段 / 反斜杠 / 绝对路径一律拒绝。
 */
function parseZipBuffer(buf) {
  let eocd = -1;
  // robustness：EOCD 至多被 65535 字节注释推到末尾 22+65535 字节窗口内，只在窗口内扫签名，
  // 缺失/伪造 EOCD 的恶意或损坏 zip 不会触发 O(文件大小) 同步循环阻塞主进程
  const searchStart = Math.max(0, buf.length - (65535 + 22));
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('无效的 zip 文件：找不到中央目录');
  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error('无效的 zip 文件：中央目录越界');
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);
    if (!name || name.length > 1024) throw new Error('zip 条目名非法');
    entries.push({ name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  const out = [];
  // 累计解压字节追踪（resource-exhaustion 修复）：每成功解压一个条目后累加，超过全局上限即中止
  let totalUncompBytes = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录项
    if (e.name.includes('\\') || e.name.startsWith('/') || e.name.split('/').some((seg) => seg === '..')) {
      throw new Error(`zip 含非法路径，已拒绝解压：${e.name}`);
    }
    if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw new Error(`zip 局部文件头损坏：${e.name}`);
    const lNameLen = buf.readUInt16LE(e.localOffset + 26);
    const lExtraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + e.compSize > buf.length) throw new Error(`zip 条目数据越界：${e.name}`);
    // resource-exhaustion 修复：解压前先按中央目录声明的尺寸校验单条目与累计上限，
    // 防恶意备份 .zip 对 tiny DEFLATE 载荷 inflate 出巨量内存（zip 炸弹）。
    if (e.uncompSize > MAX_ZIP_ENTRY_UNCOMP_BYTES) {
      throw new Error(`zip 条目解压后尺寸超限，已拒绝解压：${e.name}`);
    }
    if (e.compSize > MAX_ZIP_ENTRY_COMP_BYTES) {
      throw new Error(`zip 条目压缩后尺寸超限，已拒绝解压：${e.name}`);
    }
    if (totalUncompBytes + e.uncompSize > MAX_ZIP_TOTAL_UNCOMP_BYTES) {
      throw new Error('zip 累计解压体积超限，已拒绝解压');
    }
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    let data;
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else if (e.method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (err) {
        // 解压失败 / 分配失败（非法数据或资源耗尽）：中止解析，避免 inflate 异常被当作成功路径处理
        throw new Error(`zip 条目解压失败：${e.name}（${errMsg(err)}）`);
      }
    } else {
      throw new Error(`不支持的 zip 压缩方法：${e.name}`);
    }
    if (data.length !== e.uncompSize) throw new Error(`zip 解压后尺寸不符：${e.name}`);
    totalUncompBytes += data.length;
    out.push({ name: e.name, data });
  }
  return out;
}


/**
 * 导出便携备份归档：把 opts.dir 指定的应用内备份（listBackups 列表）打包为单一 .zip；
 * opts.dir 缺省时自动取自动备份目录里最新一份（保证「一键便携归档」默认拿到最近数据）。
 * 归档含四件套（app.db + settings.json + resume.json + manifest.json，存在即打包，WAL 副文件一并打包），
 * 弹出「另存为」对话框写入用户选择路径。
 * 返回 { canceled, ok, path?, name?, error? }（name=被打包备份的目录名）。
 */
/**
 * 路径穿越防护：目标路径是否落在自动备份目录内（export-backup-archive / restore-data 共用同一口径）。
 * 词法 startsWith 校验可被备份目录内的链接/junction 绕过，需 realpath 解析后仍落在 realpath 后的备份目录内；
 * 目录不存在（ENOENT/悬空链接）→ 放行由调用方按缺省分支上报，其余异常（权限等）视为越界拒绝，
 * 避免对无法解析的外部目标读取/写入。
 */
function isPathInsideBackupDir(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(getBackupDir());
  if (!resolved.startsWith(root + path.sep)) return false;
  try {
    const rr = fs.realpathSync(resolved);
    const rb = fs.realpathSync(root);
    return rr.startsWith(rb + path.sep);
  } catch (err) {
    return !fs.existsSync(resolved);
  }
}


/**
 * 从已解析的备份目录执行恢复落库（restore-data 与 import-backup-archive 共用核心）：
 * 校验 schema 版本兼容 → PRAGMA integrity_check → manifest 校验和 → 停后端 →
 * 覆盖写 app.db（含 WAL 三件套）+ settings.json（视 includeSettings）+ 简历快照 → 重启后端。
 * dir 必须已是合法备份目录（含 app.db）；includeSettings=false 时仅恢复 app.db，保留当前 settings.json。
 * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, error? }（与 restore-data 同构）。
 */
async function restoreBackupDir(dir, includeSettings) {
  // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：熔断态拒绝执行恢复流程
  // （停后端 / 覆盖 app.db / 重启后端 / 健康检查均属「与后端交互」），
  // 使「已停止与后端交互」的声明与实际行为一致（此路径绕过代理通道，须自行兜底）。
  if (state.backendAuthFailure) {
    return { canceled: false, ok: false, error: '后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）' };
  }
  // 快照进入恢复流程时的退出状态：若应用此刻已在退出（before-quit 的 stopBackend 已置
  // isShuttingDown=true 并清空 backendProc），则恢复完成后不得再 startBackend() 复活后端 ——
  // 否则会在退出期间 spawn 出孤儿后端进程占用端口，与下次启动冲突。
  // 该快照必须在本函数置位 isShuttingDown 之前捕获：stopBackendForRestore 自身（恢复引起的
  // 停服）也会把 isShuttingDown 置 true，无法用它区分「恢复引起的停服」与「应用退出」。
  const quittingBeforeRestore = state.isShuttingDown;
  let settingsStatus = SETTINGS_STATUS.RETAINED; // includeSettings=false：settings 完全保留
  const backupDb = path.join(dir, 'app.db');
  if (!fs.existsSync(backupDb)) {
    return { canceled: false, ok: false, error: '所选目录不是有效备份：缺少 app.db' };
  }
  // schema 兼容校验：备份库 user_version 必须与当前程序一致（legacy 0 视为兼容）
  const backupVersion = readDbUserVersion(backupDb);
  if (backupVersion === -1) {
    return {
      canceled: false,
      ok: false,
      error: '备份 app.db 损坏或不是有效 SQLite 数据库，已拒绝恢复。',
    };
  }
  // 仅拒绝「备份来自更高版本程序」的降级恢复；旧版本备份（含 schema v1）允许——
  // 复制覆盖后 finally 中的 startBackend() 会拉起后端，init_db() 自动执行 v1→v2 迁移。
  // 版本 0 视为旧版无版本标记（legacy 兼容）。此前按「不等于当前版本即拒绝」会让升级后的
  // 用户无法恢复升级前备份，属回归。
  if (backupVersion > DB_SCHEMA_VERSION) {
    return {
      canceled: false,
      ok: false,
      error: `备份 schema 版本高于当前程序（备份=${backupVersion}，当前程序=${DB_SCHEMA_VERSION}），已拒绝恢复，请升级应用后再试。`,
    };
  }
  // 完整性校验：对备份库执行 PRAGMA integrity_check（node:sqlite 不可用时降级手工结构校验），
  // 撕裂/截断副本在覆盖前即被拒绝，避免恢复出一个静默丢失最新数据的库
  const integrity = validateBackupDb(backupDb);
  if (!integrity.ok) {
    return {
      canceled: false,
      ok: false,
      error: `备份 app.db 完整性校验未通过，已拒绝恢复（${integrity.detail}）。`,
    };
  }
  // manifest 校验和验证：备份带 manifest.json（本版本起写入）时，覆盖前先验证
  // app.db（及 -wal/-shm）与备份时记录的校验和一致；不匹配/损坏/篡改 → 拒绝恢复。
  // 旧版备份无 manifest 时跳过（checked=false），仍由上方 PRAGMA integrity_check 兜底。
  const manifestCheck = verifyBackupManifest(dir);
  if (manifestCheck.checked && !manifestCheck.ok) {
    return {
      canceled: false,
      ok: false,
      error: `备份完整性校验和未通过，已拒绝恢复（${manifestCheck.detail}）。`,
    };
  }
  // 破坏性覆盖前的安全快照（可回滚点）：声明在 try 外，成功/失败路径都能随返回下发渲染层
  let preRestoreSnapshot = null;

  // 破坏性覆盖前自动备份当前数据：恢复出错/误选时仍可从自动备份回滚现状（后端已停止，文件无锁）。
  // 停后端 + 复制/覆盖均为可抛错操作，须用 try/finally 包住：无论成功失败都复位 isShuttingDown，
  // 避免 stopBackendForRestore 或任一 copyFileSync/mkdirSync 抛错后 isShuttingDown 永久卡 true，
  // 导致后端无法再自动/手动重启。
  try {
    // 停后端必须置于 try 内：stopBackendForRestore 内部已对 proc.kill 的 ESRCH 兜底保证永不 reject，
    // 此处再包一层 try/finally 双保险，即便出现意外 reject 也能由 finally 复位守护标志，后端重启不被永久卡死
    await stopBackendForRestore();

    // 先落一份「应用可见」自动备份作为本次恢复的前置快照，随 preRestoreSnapshot 下发渲染层提示用户可回滚。
    // 不调用 autoBackup()：其内部 rotateAutoBackups() 可能把「正在恢复的源备份」按最旧轮转删除
    // （源位于自动备份目录时），导致随后复制源 ENOENT 失败并丢失用户所选备份。
    // 此处仅做无轮转快照，轮转推迟到正常 autoBackup（启动/定时）与手动备份流程执行。
    let preSnapDir = null;
    try {
      preSnapDir = path.join(getBackupDir(), newBackupName());
      snapshotToDir(preSnapDir);
      await writeResumeSnapshotTo(preSnapDir);
    } catch (err) {
      console.warn(`[electron] 前置快照失败（跳过）：${errMsg(err)}`);
      preSnapDir = null;
    }
    if (preSnapDir) {
      preRestoreSnapshot = { name: path.basename(preSnapDir), path: preSnapDir };
    }

    // 覆盖写回 app.db（确保数据目录存在）
    const dataDir = getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const targetDb = path.join(dataDir, 'app.db');
    await copyFileSyncWithRetry(backupDb, targetDb);
    // WAL 三件套一并恢复：备份含 -wal/-shm 则写回（保证 wal 尾部最近提交可完整回放）；
    // 备份不含时删除目标残留的 -wal/-shm，避免旧 WAL 被应用到刚覆盖的新库上造成数据错乱
    for (const suffix of SQLITE_WAL_SUFFIXES) {
      const backupSuffixPath = backupDb + suffix;
      const targetSuffixPath = targetDb + suffix;
      if (fs.existsSync(backupSuffixPath)) {
        await copyFileSyncWithRetry(backupSuffixPath, targetSuffixPath);
      } else if (fs.existsSync(targetSuffixPath)) {
        fs.rmSync(targetSuffixPath, { force: true });
      }
    }

    // 备份含 settings.json 且调用方请求恢复 settings 时一并恢复；缺失或未请求则保留当前配置。
    // 安全处理：备份 settings.json 视为不可信输入，仅按白名单恢复校验通过的 port 与非敏感
    // llm 键（provider/model/temperature 等，api_key/base_url 剥离），丢弃
    // security.external_url_hosts 与全部未知键（见 restoreSettingsSafely），
    // 防止恶意/意外备份注入攻击者指定的 LLM 凭据、提供商地址或扩大外链宿主白名单。
    if (includeSettings) {
      const backupSettings = path.join(dir, 'settings.json');
      if (fs.existsSync(backupSettings)) {
        settingsStatus = restoreSettingsSafely(backupSettings);
        // 恢复后重新解析端口：备份可能含不同 port 配置，需在重启后端前更新，
        // 否则本会话仍沿用旧端口启动（get-backend-port IPC 与令牌注入头同步失效），直到下次重启才生效
        state.backendPort = resolveBackendPort();
        // settings.json 已热更新：同步刷新外部链接宿主白名单缓存，避免继续使用恢复前的旧配置
        refreshExternalHostAllowlistCache();
        // settings.json 已被 restoreSettingsSafely 重写（backup 段已继承写回），立即同步定时备份
        // 计时器，使周期/开关与恢复后的配置一致，避免运行中的旧定时器继续沿用陈旧状态
        syncBackupInterval();
        console.log(`[electron] 已从备份恢复 settings.json（settingsStatus=${settingsStatus}），后端端口更新为 ${state.backendPort}`);
      } else {
        settingsStatus = SETTINGS_STATUS.BACKUP_MISSING;
      }
    }
    if (includeSettings) {
      // 简历快照（备份时随 app.db / settings.json 写入 resume.json，见 writeResumeSnapshotTo）：
      // 恢复时写回渲染窗口 localStorage，使简历与投递记录一并还原。
      // 仅当调用方请求恢复 settings（includeSettings=true）时恢复简历 —— includeSettings=false 的
      // 「仅恢复投递记录，保留当前设置/LLM 配置」语义必须连当前简历一并保留，
      // 否则用户勾选「保留当前」后备份内旧简历会静默覆盖当前 resume.json（违背 UI 承诺的静默数据丢失）。
      // 旧版备份 / 无简历的备份不含 resume.json，则跳过（保留当前简历，与「缺失 settings 保留当前配置」语义一致）。
      const backupResume = path.join(dir, 'resume.json');
      if (fs.existsSync(backupResume)) {
        try {
          const resumeObj = JSON.parse(fs.readFileSync(backupResume, 'utf-8'));
          if (isPlainObject(resumeObj)) {
            // writeRendererResume 内部已校验 resume.json 落盘成功（失败返回 false），
            // 此处仅记日志：恢复数据的主流程不因简历写失败而中断（与 import-data 的 resumeStatus 语义一致）
            const resumeOk = await writeRendererResume(JSON.stringify(resumeObj));
            if (resumeOk) {
              console.log('[electron] 已从备份恢复简历快照（写入渲染层 localStorage）');
            } else {
              console.warn('[electron] 恢复简历快照落盘失败（保留当前简历，不阻塞恢复）');
            }
          }
        } catch (err) {
          console.warn(`[electron] 恢复简历快照失败（跳过，保留当前简历）：${errMsg(err)}`);
        }
      }
    }
  } finally {
    // 复位守护状态并重启后端（如进程仍未完全退出，退出事件处理器会兜底重启）。
    // 重启逻辑放在 finally：复制/WAL/settings 任一步抛错也强制把后端拉起来，
    // 避免「后端已被 stopBackendForRestore 停止、但复制步骤异常导致 startBackend() 永远不被执行」——
    // 此时仅复位 isShuttingDown 会让后端保持停止直到应用重启（静默死亡），
    // 而此处先复位 isShuttingDown 再 startBackend()，即使复制失败也能让后端复活（原始数据未动）。
    // 但若应用已在退出（before-quit 已置 isShuttingDown=true），则不得复活后端，
    // 否则退出期间 spawn 出孤儿后端进程占用端口，与下次启动冲突（见 quittingBeforeRestore 快照）。
    state.backendStoppedForRestore = false;
    state.backendRestartCount = 0;
    if (!quittingBeforeRestore) {
      state.isShuttingDown = false;
      startBackend();
    }
  }
  // 等待后端恢复健康后再返回成功，保证渲染进程 reload 后能立即拉到还原后的数据
  // （waitForBackendHealth 内部捕获异常并轮询超时，不会抛错；后端启动失败时最多等待约 10s 后仍返回，交由渲染层连接错误兜底）
  const healthy = await waitForBackendHealth();
  if (healthy) {
    // 先给当前已加载窗口推送 backend-ready，再显式重新登记缓冲：
    // 随后渲染层 window.location.reload()（见 will-navigate 注释）会触发 did-finish-load 冲刷，
    // 只有 pendingBackendReady 非空才能把就绪信号补发给重载后的新页面，避免 Dashboard 停在「未连接」。
    notifyBackendReady();
    return { canceled: false, ok: true, path: dir, settingsStatus, preRestoreSnapshot };
  }
  // 数据已恢复但后端未在预算内恢复健康：不能误报纯成功，
  // 否则渲染层 reload 后 Dashboard 停在断连状态却被告知恢复成功，状态上报与实际不符。
  // 以 ok:false + error 让渲染层据此提示用户检查端口占用后重启应用。
  // 同时转入周期复查（waitBackendReadyOrRetry）：后端稍后恢复健康时仍会推送 backend-ready，
  // 让 Dashboard 从「未连接」自动恢复，无需用户手工重启应用。
  waitBackendReadyOrRetry();
  return {
    canceled: false,
    ok: false,
    error: '数据已恢复，但后端未能恢复健康，请检查端口占用后重启应用',
    path: dir,
    settingsStatus,
    preRestoreSnapshot,
  };
}


// ---------------------------------------------------------------------------
// 数据恢复：从备份目录还原 app.db + settings.json（覆盖写 + 重启后端）
// ---------------------------------------------------------------------------

/**
 * 从 SQLite 文件头读取 user_version（偏移 60 处 4 字节大端整数，SQLite 文件格式规定）。
 * 避免在 Electron 主进程引入 sqlite 依赖；用于恢复前校验备份 schema 兼容性。
 */
function readDbUserVersion(dbPath) {
  const fd = fs.openSync(dbPath, 'r');
  try {
    // 小于 SQLite 文件头（固定 SQLITE_HEADER_SIZE 字节）的文件视为损坏/空备份，返回 -1 拒绝兼容放行
    if (fs.fstatSync(fd).size < SQLITE_HEADER_SIZE) {
      return -1;
    }
    const buf = Buffer.alloc(SQLITE_USER_VERSION_LEN);
    const n = fs.readSync(fd, buf, 0, SQLITE_USER_VERSION_LEN, SQLITE_USER_VERSION_OFFSET);
    if (n !== SQLITE_USER_VERSION_LEN) {
      return -1;
    }
    return buf.readUInt32BE(0);
  } finally {
    fs.closeSync(fd);
  }
}


/**
 * 对备份 app.db 执行完整性校验（恢复覆盖前调用，防止撕裂/截断副本蒙混通过）。
 * 优先用 Node 内置 node:sqlite 跑真正的 `PRAGMA integrity_check`：
 *   - 若备份带 app.db-wal（WAL 三件套），先把 app.db + -wal + -shm 暂存到临时目录并以可写方式打开，
 *     让 SQLite 先把 wal 尾部的最近提交回放到主库，再做 integrity_check，否则只读主库会漏掉 wal 尾部数据。
 * 若运行环境不支持 node:sqlite，降级为 validateBackupDbManual 手工结构校验。
 * 返回 { ok: boolean, detail: string }；ok=false 表示校验未通过，恢复方应拒绝覆盖。
 */
/**
 * 备份库只读校验的暂存：无论是否带 -wal，都把 app.db（及配套 -wal/-shm，若存在）拷贝到临时
 * 目录并以暂存路径返回，让 SQLite 可写回放 wal 尾部的最近提交（仅读主库会漏掉 wal 尾部数据）。
 * 统一走暂存副本而非直读原始备份：即使备份库头标注 WAL 模式但无 -wal（已 checkpoint 或旧版
 * 单文件备份），SQLite 打开时也会在同一目录生成 app.db-shm/-wal 副作用文件——这些文件会被
 * restore-data 的 WAL 三件套恢复循环一并拷回数据目录，并在备份目录留下垃圾。暂存副本将这些
 * 副作用限制在临时目录，调用方 finally 中 rmSync 一并清理。暂存失败抛错（由调用方决定降级直读
 * 主库或报错）。返回 { target, cleanupDir }。
 */
function stageDbForRead(dbPath) {
  const WAL_SUFFIX = SQLITE_WAL_SUFFIXES[0];
  const SHM_SUFFIX = SQLITE_WAL_SUFFIXES[1];
  const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'bossjob-stage-'));
  try {
    const staged = path.join(tmpDir, 'app.db');
    fs.copyFileSync(dbPath, staged);
    if (fs.existsSync(dbPath + WAL_SUFFIX)) {
      fs.copyFileSync(dbPath + WAL_SUFFIX, staged + WAL_SUFFIX);
      if (fs.existsSync(dbPath + SHM_SUFFIX)) {
        fs.copyFileSync(dbPath + SHM_SUFFIX, staged + SHM_SUFFIX);
      }
    }
    // cleanupDir 恒非 null（总是返回暂存副本），保证 SQLite 打开产生的 -shm/-wal 只落在临时目录。
    return { target: staged, cleanupDir: tmpDir };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}


function validateBackupDb(dbPath) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    sqlite = null;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    return validateBackupDbManual(dbPath);
  }
  let target;
  let cleanupDir;
  try {
    const staged = stageDbForRead(dbPath);
    target = staged.target;
    cleanupDir = staged.cleanupDir;
  } catch (err) {
    return { ok: false, detail: `暂存备份用于完整性校验失败：${errMsg(err)}` };
  }
  try {
    // stageDbForRead 恒返回暂存的私有副本（cleanupDir 非 null：其失败路径在上方 catch 提前 return，
    // 不会带着 null 进入本分支），故此处暂存副本恒可写：以 readOnly:false 打开以便 SQLite 回放
    // wal 尾部提交；SQLite 生成的 -shm/-wal 副作用文件只落在临时暂存目录，不污染备份目录。
    // （仅 preview-backup 因暂存失败退化为直读主库时才可能 cleanupDir==null，那里保留只读条件。）
    const db = new sqlite.DatabaseSync(target, { readOnly: false });
    try {
      const row = db.prepare('PRAGMA integrity_check').get();
      const result = row ? String(row.integrity_check) : '';
      if (result === 'ok') {
        return { ok: true, detail: 'PRAGMA integrity_check: ok' };
      }
      return { ok: false, detail: `PRAGMA integrity_check 未通过：${result}` };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, detail: `无法用 SQLite 校验备份：${errMsg(err)}` };
  } finally {
    if (cleanupDir) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}


/**
 * 手工 SQLite 结构校验（node:sqlite 不可用时的降级路径）：
 * 校验文件头魔数 + 页大小合法性 + 页数/文件尺寸一致性 + 第 1 页 b-tree 页类型，
 * 足以拒绝任意填充/明显截断的撕裂副本，而非仅凭 size>=100 放行。
 */
function validateBackupDbManual(dbPath) {
  const fd = fs.openSync(dbPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < SQLITE_HEADER_SIZE) {
      return { ok: false, detail: `文件过小（<${SQLITE_HEADER_SIZE} 字节），不是有效 SQLite 库` };
    }
    const header = Buffer.alloc(SQLITE_HEADER_SIZE);
    fs.readSync(fd, header, 0, SQLITE_HEADER_SIZE, 0);
    const magic = 'SQLite format 3\0';
    if (header.toString('latin1', 0, magic.length) !== magic) {
      return { ok: false, detail: '文件头魔数不符，不是 SQLite 数据库' };
    }
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const validPageSizes = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
    if (!validPageSizes.includes(pageSize)) {
      return { ok: false, detail: `页大小非法（${pageSize}）` };
    }
    const pageCount = header.readUInt32BE(28);
    if (pageCount === 0) {
      return { ok: false, detail: '声明页数为 0，疑似空/损坏库' };
    }
    // WAL 模式下最近页可能仍在 -wal 尾部，主库文件允许小于 pageCount×pageSize；
    // 仅当无配套 -wal 时，文件尺寸小于声明页数所需即判定为截断/撕裂副本
    const hasWal = fs.existsSync(dbPath + SQLITE_WAL_SUFFIXES[0]);
    if (!hasWal && size < pageCount * pageSize) {
      return { ok: false, detail: `文件尺寸(${size}B)小于声明页数所需(${pageCount}×${pageSize}B)，疑似截断/撕裂副本` };
    }
    const page1Type = Buffer.alloc(1);
    fs.readSync(fd, page1Type, 0, 1, SQLITE_HEADER_SIZE);
    if (page1Type[0] !== 0x0d && page1Type[0] !== 0x05) {
      return { ok: false, detail: `第 1 页 b-tree 页类型非法（0x${page1Type[0].toString(16)}）` };
    }
    return { ok: true, detail: '手工结构校验通过' };
  } finally {
    fs.closeSync(fd);
  }
}


/**
 * 覆盖拷贝文件并对 Windows 上的瞬态文件占用（EBUSY/EPERM）做短暂重试：
 * 即使 stopBackendForRestore 已等待进程退出，极端时序下被杀的 SQLite 进程仍可能尚未释放 app.db 句柄，
 * 重试 3 次（每次让出 150ms）兜底，避免恢复操作因瞬时占用误报失败。
 */
async function copyFileSyncWithRetry(src, dest, attempts = COPY_RETRY_ATTEMPTS) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < attempts; i++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err) {
      const code = err && err.code;
      if (!(code === 'EBUSY' || code === 'EPERM') || i === attempts - 1) {
        throw err;
      }
      await sleep(COPY_RETRY_SLEEP_MS);
    }
  }
}



/**
 * 恢复全部数据（数据还原）：
 *   1. 弹出「打开目录」对话框，选择备份目录（BossJobAI-backup-*，内含 app.db + settings.json + 简历快照 resume.json）。
 *   2. 校验备份结构：app.db 必须存在；user_version 与当前 DB_SCHEMA_VERSION 一致，
 *      （legacy user_version=0 视为兼容，因当前阶段尚无任何 schema 迁移），
 *      避免升级后旧库不兼容被静默覆盖；并对备份库执行 PRAGMA integrity_check 完整性校验，
 *      撕裂/截断副本在覆盖前即被拒绝。
 *   3. 停后端 → 覆盖写 data/app.db（含 WAL 三件套）与 settings.json → 重启后端。
 * 返回 { canceled, ok, path?, error? }，供渲染进程提示结果。
 */

/**
 * 安全恢复 settings.json：备份内容视为不可信输入，不盲抄备份文件，
 * 仅按显式白名单恢复——只保留经 isValidPort 校验通过的 port 与非敏感 llm 键
 * （provider/model/temperature 等，api_key/base_url 剥离；与 mergeImportedSettings 口径一致），
 * 丢弃 security.external_url_hosts（防止静默扩大 open-external 宿主白名单到钓鱼域名）与全部未知键；
 * backup 段属用户显式偏好，从当前配置继承写回，不从备份文件继承。
 * 备份缺失/解析失败/结构非法时保留当前配置，拒绝写入损坏或不可信内容。
 * 恢复本身会覆盖当前配置，故无论是否剥离均告警提示用户重新核对 LLM 配置。
 * 返回 settingsStatus：'restored'（成功还原）| 'retained_credentials_stripped'
 *   （还原但剥离了白名单外字段）| 'parse_failed'（读取/解析/写入失败，保留当前配置）。
 */
/**
 * 落盘前剥离 LLM 凭据与提供商重定向字段（与 snapshotToDir 备份落盘共用同一口径）：
 * 置空 llm.api_key、删除非空的 llm.base_url，原地修改 obj（void 变更，不返回剥离清单）。
 * 防止 LLM API 密钥明文驻留磁盘，并防止恶意备份注入攻击者指定的凭据与提供商地址。
 */
function sanitizeSettingsForDisk(obj) {
  if (isPlainObject(obj)) {
    const llm = obj.llm;
    if (llm && typeof llm === 'object') {
      // 无论值类型一律剥离：恶意备份可把 api_key/base_url 注入为数字或对象等非字符串。
      if (llm.api_key !== undefined && llm.api_key !== '') {
        llm.api_key = '';
      }
      if (llm.base_url !== undefined && llm.base_url !== '') {
        delete llm.base_url;
      }
    }
  }
}


/**
 * 主进程代理出口的 GET /api/settings 响应脱敏（defense-in-depth，见 backend-request 处理器）：
 * 解析响应体 → 仅置空 llm.api_key（与落盘 sanitizeSettingsForDisk 的 api_key 口径一致）→ 重新序列化。
 * 刻意保留 llm.base_url：设置表单需回显 base_url 并随 PUT /api/settings 原样回传，删除会导致
 * 表单显示空值、用户下次保存时把已配置的提供商端点误清空（设置往返回归）。
 * 保证 LLM 密钥「不出后端」，不落入渲染层 JS 堆（杜绝同主世界 XSS 经 backendRequest 读取外带）。
 * body 非字符串 / 非可解析 JSON 对象时返回 null，由调用方原样透传（不改变既有转发语义）。
 */
function sanitizeBackendSettingsBody(body) {
  if (typeof body !== 'string') {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (_err) {
    return null;
  }
  if (!isPlainObject(obj)) {
    return null;
  }
  const llm = obj.llm;
  if (llm && typeof llm === 'object' && llm.api_key !== undefined && llm.api_key !== '') {
    llm.api_key = '';
  }
  return JSON.stringify(obj);
}


function restoreSettingsSafely(backupPath) {
  let raw;
  try {
    raw = fs.readFileSync(backupPath, 'utf-8');
  } catch (err) {
    console.warn(`[electron] 读取备份 settings.json 失败，保留当前配置：${errMsg(err)}`);
    return SETTINGS_STATUS.PARSE_FAILED;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_err) {
    console.warn('[electron] 备份 settings.json 解析失败，保留当前配置（不覆盖）。');
    return SETTINGS_STATUS.PARSE_FAILED;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.warn('[electron] 备份 settings.json 结构非法，保留当前配置（不覆盖）。');
    return SETTINGS_STATUS.PARSE_FAILED;
  }
  // 备份 settings.json 视为不可信输入，仅按显式白名单恢复安全字段：
  // 只保留经 isValidPort 校验通过的 port；llm 段剥离 api_key/base_url 后保留非敏感键
  // （provider/model/temperature 等，与 mergeImportedSettings 口径一致）；仍丢弃
  // security.external_url_hosts 与全部未知键，防止恶意/意外备份静默扩大 open-external
  // 宿主白名单（放行钓鱼域名）或注入任意配置覆盖。
  const restored = {};
  const stripped = [];
  const backupPort = Number(obj && obj.port);
  if (isValidPort(backupPort)) {
    restored.port = backupPort;
  } else if (obj && obj.port !== undefined) {
    stripped.push('port');
  }
  for (const key of Object.keys(obj)) {
    if (key === 'port') continue;
    if (key === 'llm') {
      // 对齐 mergeImportedSettings：仅保留非敏感 llm 键，剥离 api_key（DPAPI 密文）与 base_url
      if (!isPlainObject(obj.llm)) {
        stripped.push('llm');
        continue;
      }
      const llm = { ...obj.llm };
      if (llm.api_key !== undefined) {
        delete llm.api_key;
        stripped.push('llm.api_key');
      }
      if (llm.base_url !== undefined) {
        delete llm.base_url;
        stripped.push('llm.base_url');
      }
      if (Object.keys(llm).length > 0) {
        restored.llm = llm;
      }
      continue;
    }
    if (key === 'security') {
      // 校验后恢复 external_url_hosts（非无条件剥离）：与 loadUserExternalHostAllowlist 同口径过滤，
      // 合法条目保留、非法丢弃并计入 stripped —— 恢复用户自己的备份不应静默清空外链白名单。
      if (!isPlainObject(obj.security)) {
        stripped.push('security');
        continue;
      }
      const security = { ...obj.security };
      if (security.external_url_hosts !== undefined) {
        const hosts = security.external_url_hosts;
        if (Array.isArray(hosts)) {
          const valid = hosts.filter((item) => {
            if (typeof item !== 'string') return false;
            const h = item.trim();
            if (h.length === 0) return false;
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h) || /[\/:]/.test(h)) return false;
            return h.replace(/^\.+/, '').replace(/\.+$/, '').split('.').length >= 2;
          });
          if (valid.length > 0) {
            security.external_url_hosts = valid;
            if (valid.length !== hosts.length) stripped.push('security.external_url_hosts(部分非法)');
          } else {
            delete security.external_url_hosts;
            stripped.push('security.external_url_hosts(全部非法)');
          }
        } else {
          delete security.external_url_hosts;
          stripped.push('security.external_url_hosts(非数组)');
        }
      }
      if (Object.keys(security).length > 0) {
        restored.security = security;
      }
      continue;
    }
    if (key === 'cities' || key === 'apply' || key === 'browser' || key === 'blacklist') {
      // 非敏感配置键：逐子键独立校验后恢复（不剥离），避免恢复后目标城市/黑名单/投递/浏览器配置
      // 静默重置为默认值；校验防止篡改备份含非法值导致恢复后后端 Settings 校验失败。
      // 与全有或全无不同：任一子键非法只丢弃该子键（单独计入 stripped 并含键名），合法子键照常保留，
      // 避免「daily_limit 非法 → 整个 apply 段连同合法 interval_seconds 一起被剥离」。
      if (key === 'cities') {
        // 逐项过滤（与 validateImportedBenignKey 同口径）：单条空串/纯空白城市丢弃、合法城市保留，
        // 整体 every() 校验会让一条非法导致全部城市静默丢失
        if (Array.isArray(obj.cities)) {
          const validCities = obj.cities.filter((c) => typeof c === 'string' && c.trim() !== '');
          if (validCities.length > 0) {
            restored.cities = validCities;
          } else {
            stripped.push(key);
          }
        } else {
          stripped.push(key);
        }
      } else if (key === 'apply' && isPlainObject(obj.apply)) {
        const rebuilt = {};
        if ('daily_limit' in obj.apply) {
          if (Number.isInteger(obj.apply.daily_limit) && obj.apply.daily_limit >= 1 && obj.apply.daily_limit <= 500) {
            rebuilt.daily_limit = obj.apply.daily_limit;
          } else {
            stripped.push('apply.daily_limit');
          }
        }
        if ('halt_on_risk' in obj.apply) {
          if (typeof obj.apply.halt_on_risk === 'boolean') {
            rebuilt.halt_on_risk = obj.apply.halt_on_risk;
          } else {
            stripped.push('apply.halt_on_risk');
          }
        }
        if ('interval_seconds' in obj.apply) {
          // 非空约束（与 validateImportedBenignKey 同口径）：空数组 [] 会通过 every() 的 vacuous truth，
          // 否则从含 interval_seconds:[] 的备份恢复会把已配置投递间隔静默清空
          if (Array.isArray(obj.apply.interval_seconds) && obj.apply.interval_seconds.length > 0 && obj.apply.interval_seconds.every((x) => Number.isInteger(x) && x >= 1 && x <= 3600)) {
            rebuilt.interval_seconds = obj.apply.interval_seconds;
          } else {
            stripped.push('apply.interval_seconds');
          }
        }
        if (Object.keys(rebuilt).length > 0) restored.apply = rebuilt;
      } else if (key === 'browser' && isPlainObject(obj.browser)) {
        const rebuilt = {};
        if ('headless' in obj.browser) {
          if (typeof obj.browser.headless === 'boolean') {
            rebuilt.headless = obj.browser.headless;
          } else {
            stripped.push('browser.headless');
          }
        }
        if ('user_data_dir' in obj.browser) {
          if (typeof obj.browser.user_data_dir === 'string') {
            rebuilt.user_data_dir = obj.browser.user_data_dir;
          } else {
            stripped.push('browser.user_data_dir');
          }
        }
        if (Object.keys(rebuilt).length > 0) restored.browser = rebuilt;
      } else if (key === 'blacklist' && isPlainObject(obj.blacklist)) {
        const rebuilt = {};
        if ('companies' in obj.blacklist) {
          if (Array.isArray(obj.blacklist.companies) && obj.blacklist.companies.every((x) => typeof x === 'string')) {
            rebuilt.companies = obj.blacklist.companies;
          } else {
            stripped.push('blacklist.companies');
          }
        }
        if ('keywords' in obj.blacklist) {
          if (Array.isArray(obj.blacklist.keywords) && obj.blacklist.keywords.every((x) => typeof x === 'string')) {
            rebuilt.keywords = obj.blacklist.keywords;
          } else {
            stripped.push('blacklist.keywords');
          }
        }
        if (Object.keys(rebuilt).length > 0) restored.blacklist = rebuilt;
      } else {
        stripped.push(key);
      }
      continue;
    }
    if (key === 'backup') {
      // backup 段由下方从当前配置继承写回，不从备份文件继承
      continue;
    }
    stripped.push(key);
  }
  // 恢复会整体覆盖 settings.json（restored 仅含白名单校验通过的 port），但自动备份配置 backup 段
  // 属于用户显式偏好而非敏感凭据/白名单，从当前配置中继承写回，避免 restore 后
  // intervalMinutes/maxBackups/autoBackupEnabled 被静默清空、定时备份退化为默认值。
  try {
    const currentRaw = fs.readFileSync(getSettingsPath(), 'utf-8');
    const current = JSON.parse(currentRaw);
    if (current && isPlainObject(current.backup)) {
      restored.backup = current.backup;
    }
    // 合并当前配置的 LLM 密钥/base_url：restore 会整体覆盖 settings.json，而备份里的
    // api_key/base_url 因不可信被剥离；若不把当前配置的密钥并回，恢复后用户现存 LLM 密钥会
    // 静默丢失，与 DataViews「当前 LLM 密钥已保留」的文案相悖。仅当备份未提供这些凭据时继承当前值，
    // 并相应从 stripped 中移除 llm.api_key/base_url（密钥实际已保留，不再视为被剥离项）。
    if (current && isPlainObject(current.llm)) {
      const curKey = current.llm.api_key;
      const curBase = current.llm.base_url;
      if ((typeof curKey === 'string' && curKey) || (typeof curBase === 'string' && curBase)) {
        if (!isPlainObject(restored.llm)) restored.llm = {};
        if (typeof curKey === 'string' && curKey) restored.llm.api_key = curKey;
        if (typeof curBase === 'string' && curBase) restored.llm.base_url = curBase;
        const kept = (k) => k !== 'llm.api_key' && k !== 'llm.base_url';
        const keptLen = stripped.filter(kept).length;
        if (keptLen !== stripped.length) {
          // 原位过滤：仅移除已由当前配置并回的密钥项
          let w = 0;
          for (let i = 0; i < stripped.length; i++) if (kept(stripped[i])) stripped[w++] = stripped[i];
          stripped.length = w;
        }
      }
    }
  } catch (_err) {
    // 当前 settings 缺失/不可解析：无 backup 配置可继承，restored 保持仅 port，
    // 后续 syncBackupInterval() 自会用默认值兜底
  }
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(restored, null, 2), 'utf-8');
    state.backupSettingsCache = null; // 恢复整体覆写 settings.json，失效自动备份配置缓存
    if (stripped.length > 0) {
      console.warn(`[electron] 已从恢复的 settings.json 剥离 ${stripped.join('、')}，请在应用内重新配置 LLM。`);
    }
  } catch (err) {
    console.warn(`[electron] 写入恢复后的 settings.json 失败：${errMsg(err)}`);
    return SETTINGS_STATUS.PARSE_FAILED;
  }
  console.warn('[electron] 恢复操作将用备份配置覆盖当前 settings.json（含原 LLM 密钥），请确认备份来源可信。');
  return stripped.length > 0 ? SETTINGS_STATUS.RETAINED_CREDENTIALS_STRIPPED : SETTINGS_STATUS.RESTORED;
}

function cachedBackupChecksumOk(dir, name, precomputedSig) {
  // list-backups 已在统计 sizeBytes/fileCount 的单趟遍历中收集了目录签名（各文件 name:size:mtimeMs + dir mtimeMs），
  // 直接复用，避免对同一备份目录重复 readdir/stat；仅当签名参数缺失时才现场扫描兜底。
  let sig = precomputedSig;
  if (sig === undefined) {
    const files = [];
    let dirMtime = 0;
    try {
      dirMtime = fs.statSync(dir).mtimeMs;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const st = fs.statSync(path.join(dir, f.name));
        files.push(f.name + ':' + st.size + ':' + st.mtimeMs);
      }
    } catch (err) {
      console.warn(`[electron] 读取备份目录 ${dir} 签名失败，退回全量校验：${errMsg(err)}`);
    }
    files.sort();
    sig = dirMtime + '|' + files.join('|');
  }
  const hit = state.backupChecksumCache.get(name);
  if (hit && hit.sig === sig) return hit.checksumOk;
  const manifestCheck = verifyBackupManifest(dir);
  const checksumOk = manifestCheck.checked ? manifestCheck.ok : null;
  if (state.backupChecksumCache.size >= BACKUP_CHK_CACHE_MAX) state.backupChecksumCache.clear();
  state.backupChecksumCache.set(name, { sig, checksumOk });
  return checksumOk;
}


/**
 * 删除自动备份目录下的单个备份（BossJobAI-backup-*），与应用内 listBackups 配对，
 * 让「数据」页为每个备份渲染删除按钮，避免用户离开应用用系统文件管理器手工清理。
 * 安全基线（防误删 / 防路径穿越）：
 *   1. name 必须匹配 ^BossJobAI-backup- 前缀，且不含任何路径分隔符；
 *   2. path.resolve(getBackupDir(), name) 必须仍落在 getBackupDir() 内；
 *   3. 通过校验后递归删除该备份目录，返回 { ok, error? } 供渲染层提示结果。
 */

/**
 * 校验备份名称并解析其绝对路径（delete-backup / preview-backup 共用，防路径穿越）：
 * 1. name 必须是字符串且匹配 ^BossJobAI-backup- 前缀，且不含任何路径分隔符；
 * 2. path.resolve(getBackupDir(), name) 必须仍落在 getBackupDir() 内；
 * 3. 校验失败返回 { error }，成功返回 { dir }。traversalMsg 为路径越界时的定制错误提示（删除/预览各自措辞）。
 * 四处守卫集中于此，后续加固（如拒绝 '..' 段）对两个 IPC 同时生效。
 */
function resolveBackupDir(name, traversalMsg) {
  if (typeof name !== 'string' || !BACKUP_NAME_PREFIX_RE.test(name)) {
    return { error: '非法备份名称' };
  }
  if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) {
    return { error: '备份名称不能包含路径分隔符' };
  }
  const backupDir = getBackupDir();
  const dir = path.resolve(backupDir, name);
  if (!dir.startsWith(backupDir + path.sep)) {
    return { error: traversalMsg || '备份路径越界' };
  }
  // 反符号链接 / junction 穿透：词法 startsWith 校验可被备份目录内的链接绕过
  // （若存在指向外部的 junction，resolve 后仍词法落在备份目录内，但实际读写会穿到外部）。
  // realpath 解析后再与 realpath 后的备份目录比对，穿过链接的目标一律拒绝——
  // delete-backup 的 rmSync 递归删除 / preview-backup 的读文件均不能越过备份目录。
  try {
    const realDir = fs.realpathSync(dir);
    const realBackup = fs.realpathSync(backupDir);
    if (!realDir.startsWith(realBackup + path.sep)) {
      return { error: traversalMsg || '备份路径越界' };
    }
  } catch (err) {
    // 目标不存在（悬空链接 / ENOENT）→ 交由调用方报「备份不存在」，rmSync/copy 不执行即无穿越风险；
    // 其余异常（权限等）一律按越界拒绝，避免对无法解析的外部目标操作。
    if (!fs.existsSync(dir)) {
      return { dir };
    }
    return { error: traversalMsg || '备份路径越界' };
  }
  return { dir };
}

module.exports = {
  backupSortKey, fetchExportPayload, fetchExistingIds, buildExportPayload,
  findLoadedRendererWindow, readRendererResume, writeResumeJsonToDataDir, writeRendererResume,
  writeResumeSnapshotTo, applicationsToCsv, validateImportedBenignKey, mergeImportedSettings,
  readLatestBackupExport, getBackupSettings, saveBackupSettings, syncBackupInterval,
  checkpointDbToSingleFile, snapshotToDir, assertSafeMkdirTarget, newBackupName, sha256OfFile,
  writeBackupManifest, verifyBackupManifest, rotateAutoBackups, snapshotAutoBackup, autoBackup,
  zipCrc32, buildZipBuffer, parseZipBuffer, isPathInsideBackupDir, restoreBackupDir,
  readDbUserVersion, stageDbForRead, validateBackupDb, validateBackupDbManual, copyFileSyncWithRetry,
  sanitizeSettingsForDisk, sanitizeBackendSettingsBody, restoreSettingsSafely,
  cachedBackupChecksumOk, resolveBackupDir,
  refreshExternalHostAllowlistCache, maybeRefreshExternalHostAllowlist, loadUserExternalHostAllowlist,
  isExternalHostAllowed,
};
