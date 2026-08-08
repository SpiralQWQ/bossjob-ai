/**
 * Electron 主进程 —— 窗口管理 + 后端守护
 *
 * 职责：
 *   1. 创建 BrowserWindow（contextIsolation=true / nodeIntegration=false，仅经 preload 桥接）。
 *   2. 端口统一从 settings.json 读取（env BOSS_PORT 优先），代码内禁止硬编码端口。
 *   3. spawn 并守护后端：开发模式 spawn `python -m uvicorn app.main:app`，
 *      打包模式直接运行 resources/backend/bossjob-backend.exe（见 packaging/BUILD.md §8.1），
 *      意外退出时自动重启，最多 MAX_BACKEND_RESTARTS 次。
 *   4. 应用退出时优雅关闭后端子进程。
 *   5. 通过 IPC 暴露后端端口（渲染进程 / 前端调用），并把后端启动失败原因推送给渲染层。
 *
 * 路径一律基于 __dirname / process.resourcesPath 相对推导，禁止写死绝对路径。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, protocol } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// 路径与常量（相对 __dirname 推导，禁止硬编码）
// ---------------------------------------------------------------------------

/** electron/ 的上级 = code/（项目根），settings.json 与 backend/ 均在此（仅开发模式使用）。 */
const PROJECT_ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(PROJECT_ROOT, 'settings.json');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
/**
 * 前端构建产物入口：
 *   - 打包模式：frontend/dist 随 files 打包进 app.asar 根（__dirname = app.asar）。
 *   - 开发模式：源码目录 frontend/dist。
 */
const FRONTEND_DIST_INDEX = app.isPackaged
  ? path.join(__dirname, 'frontend', 'dist', 'index.html')
  : path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html');
/** 开发模式 Vite dev server（与 frontend/vite 默认端口一致）。 */
const DEV_SERVER_URL = 'http://127.0.0.1:5173';
// dev 源派生值：DEV_SERVER_URL 为常量，仅解析一次，避免 onHeadersReceived 热路径每次调用
// 都 new URL() + 重建 devWs 字符串（redundant-compute）；供 buildCspPolicy 与 dev 窗口复用。
const DEV_SERVER_PARSED = new URL(DEV_SERVER_URL);
/** Vite dev server origin（CSP connect-src 的 http 源）。 */
const DEV_SERVER_ORIGIN = DEV_SERVER_PARSED.origin;
/** Vite HMR websocket 源（CSP connect-src 的 ws 源，端口随 DEV_SERVER_URL，缺省 5173）。 */
const DEV_WS = `ws://${DEV_SERVER_PARSED.hostname}:${DEV_SERVER_PARSED.port || '5173'}`;
/** 端口兜底值：仅当 settings.json 缺失/非法且无 BOSS_PORT 环境变量时使用（与后端 constants 一致）。
 *  单一事实源：electron/backend-default-port.cjs（frontend/vite.config.ts 的 CSP 注入与之共用，杜绝端口字面量漂移）。 */
const { DEFAULT_BACKEND_PORT: DEFAULT_PORT } = require(path.join(__dirname, 'backend-default-port.cjs'));
/** 端口合法区间，与后端 constants.PORT_MIN/PORT_MAX 对齐。 */
const PORT_MIN = 1024;
const PORT_MAX = 65535;
/** 后端异常退出时的最大重启次数。 */
const MAX_BACKEND_RESTARTS = 3;
/** 后端健康检查轮询间隔与最大尝试次数（后端冷启动通常 1~3s）。 */
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_ATTEMPTS = 20;
/** 单次健康检查请求的超时时间（ms），超过即认为该轮失败。 */
const HEALTH_REQUEST_TIMEOUT_MS = 1000;
/** 健康检查 10s 预算超时后的周期复查间隔（ms）：后端冷启动/崩溃恢复可能超过预算，周期复查避免一次性放弃。 */
const BACKEND_HEALTH_RETRY_INTERVAL_MS = 5000;
/** 导出接口请求超时（ms）：全量导出（大数据集序列化/传输）可能耗时较长，故放宽到 30s；配合 export-data 内的超时单次重试使用。 */
const EXPORT_REQUEST_TIMEOUT_MS = 30000;
/** SQLite user_version 在文件头的偏移与长度（字节）。 */
const SQLITE_USER_VERSION_OFFSET = 60;
const SQLITE_USER_VERSION_LEN = 4;
/** SQLite 文件头固定长度（字节）：小于该尺寸的文件视为损坏/空备份。 */
const SQLITE_HEADER_SIZE = 100;
/** 后端异常退出重启的指数退避：基值（首次等待）与封顶（ms）。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 8000;
/** 停止后端（恢复数据前）等待其正常退出的超时（ms），超时后升级为 SIGKILL 强杀。 */
const STOP_BACKEND_TIMEOUT_MS = 5000;
/** SIGKILL 强杀后端后的额外宽限期（ms）：等待被强杀的 SQLite 进程真正释放 app.db 句柄，防 exit 事件缺失时 Promise 永不 settle。 */
const KILL_EXIT_GRACE_MS = 2000;
/** 文件复制重试（EBUSY/EPERM）的休眠间隔（ms）与最大尝试次数。 */
const COPY_RETRY_SLEEP_MS = 150;
const COPY_RETRY_ATTEMPTS = 3;
/** 自动备份目录前缀（备份目录命名 BossJobAI-backup-YYYYMMDD-HHmm-<随机后缀>）。 */
const BACKUP_DIR_PREFIX = 'BossJobAI-backup-';
/** 备份目录名前缀匹配正则（delete-backup / preview-backup 校验用），由 BACKUP_DIR_PREFIX 构造，避免魔法字面量漂移。 */
const BACKUP_NAME_PREFIX_RE = new RegExp('^' + BACKUP_DIR_PREFIX);
/** SQLite WAL 模式配套副文件后缀（一致性快照需 app.db 与 -wal/-shm 三件套一并拷贝/恢复）。 */
const SQLITE_WAL_SUFFIXES = ['-wal', '-shm'];
/** 打包模式：后端 exe 在 extraResources → <安装目录>/resources/backend/。 */
const PACKAGED_BACKEND_DIR = path.join(process.resourcesPath, 'backend');
const PACKAGED_BACKEND_EXE = path.join(PACKAGED_BACKEND_DIR, 'bossjob-backend.exe');
/** 当前生效的本地后端鉴权令牌（whenReady 中初始化，供主进程直连后端请求使用）。 */
let authToken = '';
/** 鉴权令牌指纹缓存：SHA-256(令牌) 前 16 位，whenReady 中一次性预计算，避免 /api/health 轮询重复哈希。 */
let authTokenFingerprint = '';

// ---------------------------------------------------------------------------
// 通用工具函数
// ---------------------------------------------------------------------------

/** 当前时间格式化为 YYYYMMDD-HHmm（本地时间），用于导出文件名 / 备份目录命名。 */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 备份目录名完整匹配正则（backupSortKey 复用的模块级常量，与 BACKUP_NAME_PREFIX_RE 同风格，避免每次调用重新编译）。 */
const BACKUP_SORT_KEY_RE = new RegExp('^' + BACKUP_DIR_PREFIX + '(\\d{8})-(\\d{4})-([0-9a-z]+)$', 'i');

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
function getDialogParent() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

/**
 * 「打开文件/目录」对话框封装（backup-data / import-data / restore-data 共用）：
 * 以 getDialogParent 为父窗口调用，无窗口时退化为无父窗口变体，消除五处重复的条件分支。
 */
async function openDialog(options) {
  const win = getDialogParent();
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

/** 「另存为」对话框封装（export-data / export-data-csv 共用），父窗口规则与 openDialog 一致。 */
async function saveDialog(options) {
  const win = getDialogParent();
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

/** /api/export 全量导出专用响应体上限（200MB）：导出载荷可能含大量 applications + apply_logs，
 *  显著大于默认代理上限 BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES，避免合法大导出被 RESPONSE_TOO_LARGE_ERR 误杀。 */
const EXPORT_MAX_RESPONSE_BODY_BYTES = 200 * 1024 * 1024;

/**
 * 从本地后端拉取 /api/export 全量 JSON（export-data / export-data-csv 共用）：
 * httpGet + TIMEOUT_ERR 单次重试 + statusCode 校验 + 载荷结构校验，返回解析后的 payload。
 * 任一步失败抛 Error（错误消息与两个 handler 原返回语义一致），由调用方 catch 统一上报。
 */
async function fetchExportPayload() {
  // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：主进程直连后端前先检查熔断标志，
  // 熔断态拒绝拉取 /api/export —— export-data / preview-export-data / export-data-csv 共用此函数，
  // 使「已停止与后端交互」的声明与实际行为一致（这些路径绕过代理通道，须自行兜底）。
  if (backendAuthFailure) {
    throw new Error('后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）');
  }
  const url = `http://127.0.0.1:${backendPort}/api/export`;
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
  if (backendAuthFailure) {
    throw new Error('后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）');
  }
  const url = `http://127.0.0.1:${backendPort}/api/applications/ids`;
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
const errMsg = (e) => (e instanceof Error ? e.message : String(e));

/** 简历 localStorage 键名（与 frontend/src/pages/ResumePage.tsx 的 STORAGE_KEY 保持一致）。 */
const RESUME_STORAGE_KEY = 'bossjobai.resume';
/** resume-saved IPC 载荷大小上限（2MB）：防渲染层被同主世界 XSS 拿下时反复写任意大 JSON 填满数据目录磁盘。 */
const MAX_RESUME_SAVE_BYTES = 2 * 1024 * 1024;

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
 * 渲染层通知主进程「简历已保存 / 已清空」（preload 桥 window.api.notifyResumeSaved）：
 * - resume 为合法对象 / JSON 字符串 → 立即写入数据目录 resume.json（保存即落盘，
 *   使后续备份/导出/恢复有权威副本可用）；
 * - resume 为 null / 空白串 → 删除数据目录 resume.json（清空简历时由渲染层调用，
 *   避免旧快照残留被后续备份捕获）。
 * 返回 { ok: boolean, error?: string }。
 */
guardedHandle('resume-saved', async (_event, resume) => {
  try {
    const diskPath = path.join(getDataDir(), 'resume.json');
    // 清空简历：null / undefined / 空白串均视为删除数据目录副本
    if (resume === null || resume === undefined || (typeof resume === 'string' && resume.trim() === '')) {
      if (fs.existsSync(diskPath)) {
        fs.unlinkSync(diskPath);
      }
      return { ok: true };
    }
    let jsonText;
    if (typeof resume === 'string') {
      jsonText = resume.trim();
    } else if (isPlainObject(resume)) {
      jsonText = JSON.stringify(resume);
    } else {
      return { ok: false, error: '简历内容格式非法' };
    }
    // 载荷大小上限（2MB）：防渲染层被同主世界 XSS 拿下时反复写任意大 JSON 填满数据目录磁盘
    if (Buffer.byteLength(jsonText, 'utf-8') > MAX_RESUME_SAVE_BYTES) {
      return { ok: false, error: '简历内容超过大小上限' };
    }
    // 落盘前校验可解析且为普通对象，拒绝把任意载荷写入数据目录
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '简历内容不是合法对象' };
    }
    const ok = await writeResumeJsonToDataDir(jsonText);
    return ok ? { ok: true } : { ok: false, error: '写入数据目录失败' };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

/**
 * 读取数据目录 resume.json 权威快照（preload 桥 window.api.getResumeSnapshot）：
 * 恢复/导入备份时 writeRendererResume 已把恢复的简历双写进数据目录 resume.json；渲染层 ResumePage
 * 挂载时经本通道拉取磁盘权威副本回灌 localStorage 与表单，避免 UI 仍显示旧 localStorage 简历、
 * 下一次 resume-saved 用过期 localStorage 覆盖写回磁盘（静默丢失被恢复的简历）。
 * 磁盘副本缺失 / 不可解析 / 为空时返回 { ok:false }，调用方降级用 localStorage 初始化
 * （与 readRendererResume 磁盘优先的语义一致）。
 */
guardedHandle('get-resume-snapshot', () => {
  const diskPath = path.join(getDataDir(), 'resume.json');
  try {
    if (fs.existsSync(diskPath)) {
      const raw = fs.readFileSync(diskPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        return { ok: true, resume: parsed };
      }
    }
  } catch (err) {
    console.warn(`[electron] 读取数据目录简历快照失败（get-resume-snapshot）：${errMsg(err)}`);
  }
  return { ok: false };
});

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
 * settingsStatus 统一取值（preview-backup / restore-data / import-data 共用同一词汇表，渲染层只认这一套）：
 * - 'ok'：settings.json 存在且可解析（preview-backup 统计态）
 * - 'invalid'：settings.json 存在但不可解析（preview-backup 统计态）
 * - 'missing'：settings.json 缺失（preview-backup 统计态 / import-data 载荷无 settings 段）
 * - 'restored'：settings 已成功合并写入 / 还原
 * - 'retained_credentials_stripped'：settings 已写入但剥离了 LLM 凭据/提供商地址
 * - 'retained'：settings 完全保留（未改动，如 includeSettings=false）
 * - 'backup_missing'：备份无 settings.json，保留当前配置
 * - 'parse_failed'：目标 settings 不可解析，保留当前配置
 */
const SETTINGS_STATUS = Object.freeze({
  OK: 'ok',
  INVALID: 'invalid',
  MISSING: 'missing',
  RESTORED: 'restored',
  RETAINED_CREDENTIALS_STRIPPED: 'retained_credentials_stripped',
  RETAINED: 'retained',
  BACKUP_MISSING: 'backup_missing',
  PARSE_FAILED: 'parse_failed',
});

/** 生成 256-bit 随机十六进制令牌（后端鉴权令牌 / CSRF 会话令牌复用）。 */
const newToken = () => randomBytes(32).toString('hex');

/** 超时哨兵：httpRequest 超时销毁连接时复用的 Error 实例（identity 恒定），
 *  导出重试等调用方以 `err === TIMEOUT_ERR` 判断超时，避免依赖消息文本的魔法字符串。 */
const TIMEOUT_ERR = new Error('timeout');
/** 响应体超限哨兵：httpRequest 响应体累积超过上限时销毁响应流并以此哨兵报错（防无限累积大响应占满内存）。 */
const RESPONSE_TOO_LARGE_ERR = new Error('response too large');

/**
 * 发起带鉴权头与超时控制的 HTTP 请求（GET/POST 通用），返回 { statusCode, body }（body 为响应体字符串）。
 * 自管计时器句柄：请求完成(end)/出错(error)/关闭(close)时统一 clearTimeout，
 * 避免 req.setTimeout 的 socket 计时器在响应结束后仍触发 req.destroy()，误伤已回收/复用的连接。
 * maxResponseBytes：可覆盖默认响应体累积上限（缺省 BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES）；
 * 大载荷端点（如 /api/export 全量导出）应传入专用大上限，避免合法大响应被 RESPONSE_TOO_LARGE_ERR 误杀。
 */
function httpRequest(url, { method = 'GET', body = null, maxResponseBytes = BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES } = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      let receivedBytes = 0;
      res.on('data', (c) => {
        receivedBytes += c.length;
        // 响应体累积上限：超过即销毁响应流并报错（与请求体上限 BACKEND_PROXY_MAX_BODY_BYTES 对称，
        // 防后端被攻破 / 超大数据集时无限累积 Buffer.concat 占满内存）
        if (receivedBytes > maxResponseBytes) {
          res.destroy(RESPONSE_TOO_LARGE_ERR);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') });
      });
    });
    const timer = setTimeout(() => req.destroy(TIMEOUT_ERR), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('close', () => clearTimeout(timer));
    if (body != null) {
      req.write(body);
    }
    req.end();
  });
}

/** 发起带鉴权头与超时控制的 GET 请求（httpRequest 的便捷封装）。
 *  maxResponseBytes：可选覆盖响应体累积上限（不传则用 httpRequest 缺省的代理默认上限）。 */
function httpGet(url, timeoutMs, maxResponseBytes) {
  return httpRequest(url, { method: 'GET', maxResponseBytes }, timeoutMs);
}

/** 发起带鉴权头与超时控制的文本 POST 请求（httpRequest 的便捷封装）。
 *  body 为原始字符串（通常为 JSON.stringify 后的 JSON 文本），
 *  响应以 { statusCode, body } 返回，body 为未解析的原始字符串（不在此处 JSON.parse）。
 *  @returns {Promise<{statusCode: number, body: string}>} */
function httpPostText(url, body, timeoutMs) {
  return httpRequest(url, { method: 'POST', body }, timeoutMs);
}

/**
 * 向所有渲染窗口投递 IPC 事件，统一处理「窗口/webContents 已销毁」与「页面仍在加载」的延迟补发：
 * 已加载窗口立即 send；加载中窗口注册 once('did-finish-load') 补发（避免渲染进程尚未订阅通道时丢消息）。
 * @param {Function} [deferredSend] 可选补发回调 (win, wc)，替换默认的直接 wc.send；
 *   调用方可注入自定义判重逻辑（如缓冲已被 createWindow 的 did-finish-load 冲刷消费时跳过补发）。
 * 本函数为 void：待补发缓冲由调用方无条件保留（createWindow 的 did-finish-load 冲刷按窗口消费），
 * 不再返回 anyLoading；若将来需要该信号应在调用点显式计算，而非依赖未使用的返回值。
 */
function sendToAppWindows(channel, payload, deferredSend) {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (win.isDestroyed() || wc.isDestroyed()) {
      continue;
    }
    if (wc.isLoading()) {
      wc.once('did-finish-load', () => {
        if (!win.isDestroyed() && !wc.isDestroyed()) {
          if (deferredSend) {
            deferredSend(win, wc);
          } else {
            wc.send(channel, payload);
          }
        }
      });
    } else {
      wc.send(channel, payload);
    }
  }
}

/** 向所有渲染窗口广播事件；窗口加载中时延迟到 did-finish-load 后补发。 */
function broadcast(channel, payload) {
  sendToAppWindows(channel, payload);
}

/** 后端进程句柄与重启计数（模块级状态）。 */
let backendProc = null;
let backendRestartCount = 0;
/** 正在退出/主动停服标记：为 true 时后端退出不再触发重启。 */
let isShuttingDown = false;
/** 数据恢复（restore-data）主动停服标记：为 true 时退出处理器的指数退避延迟重启也必须放弃，
 *  防止后端崩溃退出处理器在退避 sleep 期间被 restore 覆盖 app.db 时到期拉起新进程抢占 SQLite 锁。 */
let backendStoppedForRestore = false;
/** 后端健康监测代际：startup / 每次后端崩溃重启都会递增；旧代际的周期复查在被取代时自我退出。 */
let backendHealthMonitorGeneration = 0;
/** 健康预算超时后的周期复查定时器句柄（见 waitBackendReadyOrRetry）。 */
let backendHealthRetryTimer = null;
/** 当前生效的后端端口（启动时解析一次，经 IPC 暴露）。 */
let backendPort = DEFAULT_PORT;
/** 首次后端启动失败对话框是否已弹出（避免重复弹窗）。 */
let backendErrorDialogShown = false;
/** 后端启动失败消息缓冲（模块级最新值）：窗口未创建 / 渲染进程未订阅 backend-error 时暂存，
 *  待窗口加载完成后冲刷补发。冲刷按窗口核对（backendErrorDelivered），不再因某一窗口冲刷而清空全局缓冲，
 *  避免多窗口场景下第一个窗口 did-finish-load 冲刷后其它窗口永久丢失 backend-error。 */
let pendingBackendError = null;
/** 已消费当前 pendingBackendError 的 webContents id 集合：仅对「本窗口尚未消费该消息」的窗口补发；
 *  新错误代际 / 新的 backend-ready 会重建本集合；缓冲不清空，由各窗口 did-finish-load 冲刷按本集合判重补发。 */
let backendErrorDelivered = new Set();
/** 应用主窗口的 webContents 标识集合：本地后端令牌注入仅放行归属这些窗口的 XHR/fetch 数据请求。 */
const appWindowWebContentsIds = new Set();
/** import-data 安全：per-webContents 信任的导入文件路径集合。preview-import-data 对话框成功后登记所选路径，
 *  import-data 仅接受集合内路径（一次性消费），拒绝渲染进程拼装的任意本地路径，防同源 XSS 后读取任意可读 JSON。Map<wcId, Set<absPath>>。 */
const trustedImportPaths = new Map();
/** IPC 发送方是否归属应用主窗口（webContents 身份白名单）：
 *  当前仅 BrowserWindow.createWindow 登记的应用窗口在册；setWindowOpenHandler deny + will-navigate
 *  受限 + 未开 webviewTag 使今天不存在其它 webContents，但未来新增 webview / BrowserView /
 *  导航绕过回归时，非应用窗口将统一被拒 —— 防御纵深，防数据/备份/设置 IPC 被不可信 frame 触达。 */
const isAppSender = (e) => appWindowWebContentsIds.has(e && e.sender && e.sender.id);
/** 带「仅应用主窗口」发送方白名单的 ipcMain.handle 包装：非应用窗口的调用统一返回
 *  { ok:false, error:'forbidden' }，不进入 handler 逻辑；backend-request 的既有严格校验保留。 */
function guardedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isAppSender(event)) {
      return { ok: false, error: 'forbidden' };
    }
    return handler(event, ...args);
  });
}

// ---------------------------------------------------------------------------
// 本地后端鉴权令牌（认证绕过修复：后端所有端点要求 Bearer 令牌）
// ---------------------------------------------------------------------------

/**
 * 后端鉴权令牌：Electron 主进程首启生成 256-bit 随机令牌并持久化，重启复用。
 *  - 持久化优先 safeStorage（OS 加密）；加密不可用时仅 POSIX（0o600 权限位被强制）开发环境
 *    退回明文文件，Windows 开发环境一律不落盘明文（强制加密路径/临时令牌），打包生产环境
 *    不落盘明文，每次启动生成临时令牌并告警。
 *  - 优先经一次性令牌文件（BOSS_AUTH_TOKEN_FILE）注入后端（随机文件名，后端读后即删）；
 *    写盘失败重试后仍不可用时拒绝启动后端（不注入 BOSS_AUTH_TOKEN：令牌进子进程环境块会在后端整个
 *    生命周期内暴露，且后端无令牌时鉴权 FAIL-OPEN 不可接受）。后端全局依赖校验 Authorization: Bearer <token>。
 *  - 渲染进程的请求由 webRequest 统一附加该头（见 whenReady），前端无需感知令牌。
 */
function loadOrCreateAuthToken() {
  const userDataDir = app.getPath('userData');
  const plainPath = path.join(userDataDir, '.auth-token');
  const encPath = path.join(userDataDir, '.auth-token.enc');
  // 目录在任一落盘分支前一次性确保存在（后续分支复用，避免每分支重复 mkdirSync）
  fs.mkdirSync(userDataDir, { recursive: true });
  try {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();

    // 加密可用：始终以加密文件为准（优先于任何明文残留）。
    if (encryptionAvailable) {
      if (fs.existsSync(encPath)) {
        // 加密已可用：同步清理历史明文残留，避免明文令牌遗留磁盘。
        try {
          if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
        } catch (e) {
          console.warn(`[electron] 删除明文令牌文件失败：${errMsg(e)}`);
        }
        return safeStorage.decryptString(fs.readFileSync(encPath));
      }
      // 迁移历史明文令牌进加密存储，随后删除明文文件，避免遗留明文密钥。
      const plain = fs.existsSync(plainPath) ? fs.readFileSync(plainPath, 'utf-8').trim() : '';
      if (plain) {
        fs.writeFileSync(encPath, safeStorage.encryptString(plain));
        try {
          fs.unlinkSync(plainPath);
        } catch (e) {
          console.warn(`[electron] 删除明文令牌文件失败：${errMsg(e)}`);
        }
        return plain;
      }
      const token = newToken();
      fs.writeFileSync(encPath, safeStorage.encryptString(token));
      return token;
    }

    // 加密不可用：存在无法解密的加密文件时视为失败。
    if (fs.existsSync(encPath)) {
      throw new Error('safeStorage 不可用但存在加密令牌文件，无法解密');
    }

    const token = newToken();
    // 打包生产环境：不持久化明文密钥，本次启动使用临时令牌（后端每次启动均重新注入，重启后自动更新）。
    if (app.isPackaged) {
      console.warn('[electron] safeStorage 不可用：打包生产环境不落盘明文令牌，本次启动使用临时令牌');
      return token;
    }
    // Windows 上 POSIX 权限位（0o600）不被强制：明文文件对同用户任意进程可读且未 OS 加密。
    // safeStorage/DPAPI 在 Windows 本应可用，若不可用说明环境异常，视为错误强制走临时令牌，绝不落盘明文。
    if (process.platform === 'win32') {
      console.warn('[electron] Windows 下 safeStorage 不可用：不落盘明文令牌，本次启动使用临时令牌');
      return token;
    }
    // 非 Windows（POSIX 权限被强制）开发环境兜底：明文文件 + 严格权限（仅当前用户可读写）。
    fs.writeFileSync(plainPath, token, { encoding: 'utf-8', mode: 0o600 });
    return token;
  } catch (err) {
    console.warn(`[electron] 鉴权令牌持久化失败：${errMsg(err)}`);
    // 损坏/无法解密的加密令牌文件：删除以便下次启动重新持久化可加密令牌，
    // 避免每次启动反复读取同一损坏文件导致永远停留在临时令牌模式（明文迁移路径被遮蔽）。
    try {
      if (fs.existsSync(encPath)) {
        fs.unlinkSync(encPath);
      }
    } catch (e) {
      console.warn(`[electron] 删除损坏的加密令牌文件失败：${errMsg(e)}`);
    }
    return newToken();
  }
}

/** 当前一次性令牌文件路径（模块级）：writeAuthTokenFile 写入后记录，后端读后即删为正常路径，
 *  本路径仅供「主进程确认后端就绪后」与退出时兜底删除 —— 彻底移除旧的盲 30s 清理定时器，
 *  消除「定时器先于后端冷启动模块导入触发 → 后端读不到令牌 → AUTH_TOKEN 为空 → require_auth
 *  静默 FAIL-OPEN」的竞态（auth-bypass 修复）。 */
let authTokenFilePath = null;
/** 一次性令牌文件 TTL 兜底清理定时器句柄（key-exposure 加固）：writeAuthTokenFile 写入令牌后起一个
 *  长宽限定时器（TOKEN_FILE_TTL_MS），届时若令牌文件仍存在（后端未读取：spawn 失败 / FAIL-OPEN /
 *  启动即崩 / 崩溃循环 / 就绪确认前进程崩溃）即删除 —— 覆盖「后端就绪确认前崩溃 / 鉴权 FAIL-OPEN 熔断
 *  不再触发 cleanupAuthTokenFile」的残留路径，避免明文令牌整会话滞留磁盘。后端读后即删（正常路径）或
 *  就绪兜底删除后文件已不存在，定时器幂等无害。 */
let authTokenFileTtlTimer = null;
/** 一次性令牌文件 TTL 宽限期（ms）：须远大于后端冷启动模块导入时长（本地 uvicorn / PyInstaller exe 秒级），
 *  防止「定时器先于后端读取触发 → 后端读不到令牌 → AUTH_TOKEN 为空 → require_auth 静默 FAIL-OPEN」的
 *  auth-bypass 竞态（历史 30s 盲定时器已实测触发过该竞态，故放宽到 60s，且仅在「文件仍存在」时删除）。 */
const TOKEN_FILE_TTL_MS = 60_000;
/** 一次性令牌文件写入失败时的重试次数与重试间隔（ms）：磁盘抖动/瞬时权限竞态时避免一次失败即拒绝启动。 */
const TOKEN_FILE_WRITE_RETRIES = 3;
const TOKEN_FILE_WRITE_RETRY_DELAY_MS = 50;

/** 删除当前一次性令牌文件（若仍存在）：幂等，失败仅告警。后端读后即删为正常路径，
 *  本函数仅兜底「后端启动即崩溃 / 读盘前异常退出」遗留的明文密钥，就绪后 / 退出时调用。
 *  调用时同时取消 TTL 兜底清理定时器（key-exposure 加固），避免定时器在文件已删除后空转。 */
function cleanupAuthTokenFile() {
  if (authTokenFileTtlTimer) {
    clearTimeout(authTokenFileTtlTimer);
    authTokenFileTtlTimer = null;
  }
  if (authTokenFilePath) {
    const p = authTokenFilePath;
    authTokenFilePath = null;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      console.warn(`[electron] 清理遗留令牌文件失败：${errMsg(err)}`);
    }
  }
}

/** 起一次性令牌文件 TTL 兜底清理定时器（key-exposure 加固）：writeAuthTokenFile 每次写入后调用。
 *  后端读后即删为正常路径（文件通常在数秒内消失）；仅当后端在宽限期（TOKEN_FILE_TTL_MS）内仍未
 *  读取令牌（spawn 失败 / 启动即崩 / 鉴权 FAIL-OPEN 熔断 / 崩溃循环）时，定时器删除残留明文令牌，
 *  覆盖「后端就绪确认前进程崩溃后 cleanupAuthTokenFile 不再触发」的残留路径，杜绝明文令牌整会话滞留磁盘。
 *  宽限期须远大于后端冷启动模块导入时长，防止「定时器先于后端读取触发 → 后端读不到令牌 → AUTH_TOKEN
 *  为空 → require_auth 静默 FAIL-OPEN」的 auth-bypass 竞态（历史 30s 盲定时器已实测触发过，故放宽到 60s）。
 *  unref() 使定时器不阻止应用正常退出；cleanupAuthTokenFile / 下一次写入会 clearTimeout 重置。 */
function armAuthTokenFileTtlCleanup() {
  if (authTokenFileTtlTimer) {
    clearTimeout(authTokenFileTtlTimer);
  }
  authTokenFileTtlTimer = setTimeout(() => {
    authTokenFileTtlTimer = null;
    cleanupAuthTokenFile();
  }, TOKEN_FILE_TTL_MS);
  if (authTokenFileTtlTimer.unref) {
    authTokenFileTtlTimer.unref();
  }
}

/** 鉴权 FAIL-OPEN 熔断标志（auth-bypass 修复）：为 true 时后端未正确载入令牌（检测见
 *  verifyBackendTokenFingerprint / reportBackendAuthFailure），渲染层一切后端请求被拒绝转发。 */
let backendAuthFailure = false;

/**
 * 校验 /api/health 响应携带的令牌指纹与主进程持有的鉴权令牌一致（后端须在响应中返回
 * auth_token_fingerprint = SHA-256(令牌) 前 16 位）。后端未载入令牌（FAIL-OPEN）时返回 false。
 * @param {{auth_token_fingerprint?: string}} healthPayload /api/health 解析后的响应体
 * @returns {boolean} 指纹存在且与本地令牌匹配返回 true；缺失 / 不匹配返回 false。
 */
function verifyBackendTokenFingerprint(healthPayload) {
  if (!healthPayload || typeof healthPayload.auth_token_fingerprint !== 'string') {
    return false;
  }
  if (!authTokenFingerprint) {
    return false;
  }
  // 与后端 health.py 口径一致：SHA-256(令牌) 十六进制前 16 位（64 bit，足够唯一性且不泄露完整令牌）。
  // 指纹在 whenReady 载入令牌时一次性预计算，此处仅做字符串比对，避免每轮 /api/health 轮询重复哈希。
  return healthPayload.auth_token_fingerprint === authTokenFingerprint;
}

/** 鉴权 FAIL-OPEN 告警（auth-bypass 修复）：后端未载入令牌时弹窗 + 推送错误 + 熔断后端转发。 */
function reportBackendAuthFailure() {
  if (backendAuthFailure) {
    return; // 只告警一次，避免周期复查反复弹窗
  }
  backendAuthFailure = true;
  const message =
    '本地后端鉴权异常：未检测到有效鉴权令牌（鉴权 FAIL-OPEN），后端接口可能被本机任意进程匿名调用。\n\n' +
    '为保护本地求职数据，应用已停止与后端交互。请重启应用；若问题持续，请检查应用数据目录写入权限后重试。';
  console.error('[electron] 检测到后端鉴权 FAIL-OPEN（令牌指纹不匹配），拒绝与后端交互。');
  notifyBackendError(message);
  showBackendErrorDialog(message);
}

/** 同步睡眠（Node 无原生 sync sleep）：仅在令牌文件重试的同步写路径使用。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows ACL 收紧（key-leak 残余风险加固）：icacls 把一次性令牌文件访问权收窄为仅当前用户。
 *  Windows 不强制 POSIX 权限位（writeFileSync mode:0o600 在 Windows 上不生效），启动瞬间令牌文件
 *  对同账户其它进程可读；此处用 icacls /inheritance:r 撤销继承 + /grant:r 仅授当前用户 SID。
 *  失败仅告警，不阻断启动（后端读后即删 + 随机文件名已压缩暴露窗口，鉴权始终生效）。 */
function restrictTokenFileAcl(file) {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    // 解析当前用户 SID：whoami /user 输出形如 "<主机>\<用户> S-1-5-21-...-1001"
    const who = spawnSync('whoami', ['/user'], { encoding: 'utf-8', timeout: 5000 });
    if (who.error || who.status !== 0) {
      throw new Error('whoami /user 执行失败');
    }
    const sidMatch = /\bS-\d+(-\d+)+\b/.exec(who.stdout);
    if (!sidMatch) {
      throw new Error('未能从 whoami /user 输出解析当前用户 SID');
    }
    const sid = sidMatch[0];
    const res = spawnSync('icacls', [file, '/inheritance:r', `/grant:r ${sid}:(F)`], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (res.error || res.status !== 0) {
      throw new Error(`icacls 收紧失败（退出码 ${res.status}）`);
    }
  } catch (err) {
    console.warn(`[electron] 令牌文件 ACL 收紧失败（不影响启动）：${errMsg(err)}`);
  }
}

/**
 * 把后端鉴权令牌写入「一次性令牌文件」（key-leak 加固）。
 *  - 位置：后端数据目录（用户专有：打包态 %APPDATA%/BossJobAI/backend/data，开发态 <code>/backend/data），
 *    避开 %TEMP% 等公共目录；显式 0o600 权限。
 *  - 设计动机：不再把令牌放进子进程环境块 —— Windows 下同用户任意进程可经 toolhelp /
 *    NtQueryInformationProcess 读取运行中进程的环境变量，令牌一旦进入 env 会持续暴露到进程退出；
 *    而 Host 头校验拦不住本地进程，真正的鉴权边界就是令牌本身。改为把令牌落盘后仅把文件路径
 *    传给后端，后端（app/main.py 的 _load_auth_token）读取后立即删除，把暴露窗口压缩到启动瞬间。
 *  - key-leak 残余风险加固：Windows 不强制 POSIX 权限位，启动瞬间文件对同账户其他进程可读。
 *    一次性令牌文件一律落盘明文令牌：Electron 43 的 safeStorage 输出 OSCrypt v10 密文（AES 密钥
 *    存于 Electron 进程内，后端裸 CryptUnprotectData 无法解密，实测错误码 13/87），DPAPI 密文通道
 *    在 Electron 43 下不可行；令牌仍不进子进程环境块，文件后端读后即删 + 主进程就绪后兜底删除
 *    （cleanupAuthTokenFile，见 waitForBackendHealth），暴露窗口仅启动瞬间。
 *  - 文件名不可预测：用 crypto.randomBytes 生成随机后缀（.auth_token_<16hex>.tmp），替换掉
 *    `.auth_token_<pid>.tmp` 这种可被同用户进程枚举猜中/预创建（TOCTOU 竞态）的固定路径；随机路径
 *    仅经子进程 env 告知本次启动的后端。随机名不防目录枚举，但消除「预测路径 + 竞争预写」的确定性
 *    攻击面，配合后端读后即删，把明文令牌暴露窗口压到最小。
 *  - 无盲清理定时器（auth-bypass 修复）：令牌文件由后端读后即删（正常路径），兜底删除改为
 *    「主进程确认后端就绪后」经 cleanupAuthTokenFile 执行 —— 彻底移除旧的 30s 定时器，从源头
 *    消除「定时器先于后端冷启动模块导入触发 → 后端读不到令牌 → AUTH_TOKEN 为空 → require_auth
 *    静默 FAIL-OPEN」的竞态。
 *  - 写入失败重试 TOKEN_FILE_WRITE_RETRIES 次（磁盘抖动/瞬时权限竞态），仍失败返回 null；
 *    调用方（startBackend）在令牌文件通道不可用时拒绝启动后端 —— 令牌绝不进入子进程环境块。
 */
function writeAuthTokenFile(token) {
  if (!token) {
    return null;
  }
  // 重置当前令牌文件路径（无盲清理定时器，auth-bypass 修复）：令牌文件由后端读后即删（正常路径），
  // 兜底删除改为「主进程确认后端就绪后」经 cleanupAuthTokenFile 执行，见 waitForBackendHealth。
  authTokenFilePath = null;
  const dir = getDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[electron] 创建令牌目录失败：${errMsg(err)}`);
    return null;
  }
  // 清理上次异常退出可能遗留的一次性令牌文件，避免磁盘堆积（readdir 失败不阻断后续写文件）
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.auth_token_') && name.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (_e) {
          /* 忽略单个清理失败 */
        }
      }
    }
  } catch (_e) {
    /* 忽略 readdir 失败 */
  }
  // 落盘内容：一次性令牌文件一律写明文令牌。
  //  安全权衡（已实测验证）：Electron 43 的 safeStorage 在 Windows 输出 OSCrypt v10 密文
  //  （"v10" + 12B nonce + AES-GCM，AES 密钥仅存于 Electron 进程内，不随密文落盘），后端
  //  _dpapi_unprotect 的裸 CryptUnprotectData 无法解密（实测 CryptUnprotectData 返回错误码
  //  13/87）→ 后端令牌为空 → 全局鉴权静默 FAIL-OPEN（本地任意进程可无令牌调用后端，鉴权被绕过）。
  //  DPAPI 密文通道在 Electron 43 下不可行，故回退为全平台明文一次性文件：令牌仍经「一次性文件」
  //  通道注入（不进子进程环境块，保持 key-leak 加固），文件位于用户专有数据目录、随机文件名、
  //  后端读后即删 + 主进程就绪后兜底删除（cleanupAuthTokenFile），暴露窗口仅启动瞬间，鉴权始终生效。
  //  TOCTOU 加固（residual-risk）：不再「writeFileSync 落含令牌文件后再 icacls」——Windows 不强制
  //  POSIX mode:0o600，那样会在「写盘完成」到「icacls 生效」之间留下「文件已含明文令牌但 ACL 仍是
  //  默认继承」的泄漏窗口。改为三步原子化：O_EXCL 独占创建空文件 → 立即收紧 ACL（此刻文件为空，
  //  无令牌可泄）→ 再写入明文令牌。保证「文件含令牌」的任何时刻其 ACL 均已收窄为仅当前用户；
  //  icacls 失败仍仅告警不阻断启动（与既有 key-leak 加固口径一致，随机文件名 + 后端读后即删兜底）。
  // 写入失败重试（瞬时 EPERM/磁盘抖动），重试间短暂同步退避且每次换新随机名；仍失败由调用方拒绝启动后端
  let lastErr = null;
  for (let attempt = 1; attempt <= TOKEN_FILE_WRITE_RETRIES; attempt += 1) {
    const file = path.join(dir, `.auth_token_${randomBytes(8).toString('hex')}.tmp`);
    let fd = null;
    try {
      // 1) O_EXCL 独占创建空文件（拒绝已存在的预创建竞态）；此步不写入任何内容，无令牌可泄。
      fd = fs.openSync(file, 'wx', 0o600);
      // 2) 文件为空即收紧 ACL：Windows 撤销继承 + 仅授当前用户 SID（POSIX 上 0o600 已生效）。
      restrictTokenFileAcl(file);
      // 3) 空文件已收窄为仅当前用户，此刻才写入明文令牌。
      fs.writeSync(fd, token, null, 'utf-8');
      fs.closeSync(fd);
      fd = null;
      authTokenFilePath = file; // 记录当前令牌文件路径，供后端就绪后兜底删除 / 退出清理
      // key-exposure 加固：写入后立即起 TTL 兜底清理定时器（宽限期见 TOKEN_FILE_TTL_MS），
      // 覆盖「后端就绪确认前进程崩溃 / 鉴权 FAIL-OPEN 熔断」等不再触发 cleanupAuthTokenFile 的残留路径；
      // 正常路径下后端读后即删，就绪兜底删除也会取消该定时器，二者幂等无害。
      armAuthTokenFileTtlCleanup();
      return file;
    } catch (err) {
      lastErr = err;
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_e) { /* 忽略关闭失败 */ }
      }
      try { fs.unlinkSync(file); } catch (_e) { /* 忽略清理失败 */ }
      if (attempt < TOKEN_FILE_WRITE_RETRIES) {
        console.warn(`[electron] 写入一次性令牌文件失败（第 ${attempt}/${TOKEN_FILE_WRITE_RETRIES} 次），重试：${errMsg(err)}`);
        sleepSync(TOKEN_FILE_WRITE_RETRY_DELAY_MS);
      }
    }
  }
  if (lastErr) {
    console.warn(`[electron] 写入一次性令牌文件失败（${TOKEN_FILE_WRITE_RETRIES} 次重试均失败），拒绝启动后端：${errMsg(lastErr)}`);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 端口解析：env(BOSS_PORT) > settings.json > DEFAULT_PORT
// ---------------------------------------------------------------------------

function isValidPort(value) {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX;
}

/**
 * settings.json 的实际读取路径：
 *   - 打包模式：userData（%APPDATA%/BossJobAI），首启由 ensurePackagedSettings() 复制写入，
 *     与后端 constants.py 的 frozen 分支指向同一目录。
 *   - 开发模式：源码根目录 settings.json。
 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * settings.json 的 mtime 探测（文件不存在或读盘异常均返回 null），供多处缓存失效判定复用。
 */
function getSettingsMtime() {
  try {
    const p = getSettingsPath();
    return fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  } catch (_err) {
    return null;
  }
}

function getSettingsPath() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'settings.json')
    : SETTINGS_PATH;
}

/**
 * 读取后端端口。
 * 优先级与后端 config.py 保持一致：BOSS_PORT 环境变量 > settings.json 的 port 字段 > 兜底默认值。
 */
function resolveBackendPort() {
  if (process.env.BOSS_PORT) {
    const fromEnv = Number(process.env.BOSS_PORT);
    if (isValidPort(fromEnv)) {
      return fromEnv;
    }
    console.warn(`[electron] 环境变量 BOSS_PORT="${process.env.BOSS_PORT}" 非法，忽略。`);
  }

  const settingsPath = getSettingsPath();
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const data = JSON.parse(raw);
    const fromFile = Number(data && data.port);
    if (isValidPort(fromFile)) {
      return fromFile;
    }
    console.warn(`[electron] settings.json 中 port 字段非法（值=${data && data.port}），改用默认值。`);
  } catch (err) {
    // settings.json 缺失或 JSON 解析失败 → 走默认值兜底，保证应用可启动
    console.warn(`[electron] 读取 ${settingsPath} 失败（${errMsg(err)}），使用默认端口 ${DEFAULT_PORT}。`);
  }

  return DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// 后端进程守护
// ---------------------------------------------------------------------------

/**
 * 打包模式首启准备：把随包的 settings.json 复制到 userData 可写目录
 * （后端 constants.py frozen 分支与主进程端口解析共用该路径）；首启无 bundled 文件则写默认配置。
 * 开发模式直接使用源码根目录的 settings.json，无需处理。
 */
function ensurePackagedSettings() {
  if (!app.isPackaged) {
    return;
  }
  const target = getSettingsPath();
  if (fs.existsSync(target)) {
    return;
  }
  const bundled = path.join(process.resourcesPath, 'settings.json');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(bundled)) {
      // 安全兜底：随包文件必须是「仅默认值」模板（见 packaging/settings.default.json）。
      // 若误把带真实 api_key 的 settings.json 打进安装包，在此剥离后再落盘，
      // 保证明文密钥不进入 %APPDATA%/BossJobAI/settings.json。
      let bundledRaw = fs.readFileSync(bundled, 'utf-8');
      try {
        const bundledObj = JSON.parse(bundledRaw);
        const llm = bundledObj && bundledObj.llm;
        if (llm && typeof llm.api_key === 'string' && llm.api_key.length > 0) {
          console.warn(
            '[electron] 检测到 bundled settings.json 含明文 api_key，已剥离后写入（打包模板应使用 packaging/settings.default.json）。'
          );
          llm.api_key = '';
          bundledRaw = JSON.stringify(bundledObj, null, 2);
        }
      } catch (_err) {
        // 解析失败则原样复制，读取侧自有容错兜底
      }
      fs.writeFileSync(target, bundledRaw, 'utf-8');
      console.log(`[electron] 已复制 bundled settings.json → ${target}`);
    } else {
      fs.writeFileSync(target, JSON.stringify({ port: DEFAULT_PORT }, null, 2), 'utf-8');
      console.warn(`[electron] resources/settings.json 缺失，已写入默认配置 → ${target}`);
    }
  } catch (err) {
    // 复制失败不阻塞启动：后端仍可凭 BOSS_PORT 注入端口工作，其余配置回退 pydantic 默认
    console.warn(`[electron] 初始化 ${target} 失败：${errMsg(err)}`);
  }
}

/**
 * 启动后端进程。
 *   - 打包模式：直接运行 PyInstaller exe（extraResources → resources/backend/bossjob-backend.exe），
 *     exe 已内建 uvicorn 引导（packaging/backend_entry.py），无需额外参数。
 *   - 开发模式：spawn `python -m uvicorn app.main:app`，cwd=源码 backend/。
 * 两种模式都注入 BOSS_PORT 环境变量，确保与前端解析到的端口一致。
 */
function startBackend() {
  if (backendProc || isShuttingDown || backendStoppedForRestore) {
    return;
  }

  const isPackaged = app.isPackaged;
  let cmd;
  let args;
  let cwd;

  if (isPackaged) {
    cmd = PACKAGED_BACKEND_EXE;
    args = [];
    cwd = PACKAGED_BACKEND_DIR;
  } else {
    cmd = 'python';
    args = [
      '-m',
      'uvicorn',
      'app.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(backendPort),
    ];
    cwd = BACKEND_DIR;
  }

  console.log(`[electron] 启动后端（${isPackaged ? '打包模式' : '开发模式'}）：${cmd} ${args.join(' ')} (cwd=${cwd})`);
  // 鉴权令牌传递通道（key-leak 加固）：令牌绝不写入子进程环境块 —— Windows 下同用户任意进程
  // 可经 toolhelp/NtQueryInformationProcess 读取运行中进程的环境变量，令牌一旦进入 env 就会在进程
  // 整个生命周期内持续暴露；而 Host 头校验拦不住本地进程，真正的鉴权边界就是令牌本身。
  // 改经「一次性令牌文件」通道（writeAuthTokenFile）：启动前写入后端数据目录（用户专有目录），
  // 只把文件路径放入子进程 env；后端读取后立即删除，把令牌暴露窗口从「整个进程生命周期」
  // 压缩到「启动瞬间」。令牌文件写入失败时拒绝启动后端（旧的 env 回退通道已移除）：若强行注入
  // BOSS_AUTH_TOKEN 会在后端整个生命周期内持续暴露令牌，且后端无令牌时鉴权 FAIL-OPEN 更危险。
  const tokenFile = writeAuthTokenFile(authToken);
  if (!tokenFile) {
    // 安全边界：无可用令牌通道时绝不带着 FAIL-OPEN 后端裸奔，直接拒绝启动并给出可操作错误
    const message =
      '后端鉴权令牌文件无法写入（磁盘空间不足或权限不足），为保护本地求职数据，后端未启动。\n\n请确认应用数据目录可写且磁盘空间充足后重启应用。';
    console.error('[electron] 鉴权令牌文件写入失败，拒绝启动后端（令牌不进入子进程环境块，避免 FAIL-OPEN）。');
    notifyBackendError(message);
    showBackendErrorDialog(message);
    return;
  }
  backendProc = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      BOSS_PORT: String(backendPort),
      // OS 受保护通道：随机文件名、后端读后即删（app/main.py 的 _load_auth_token）
      BOSS_AUTH_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // Windows 下不弹出黑框
  });
  // 捕获当前进程句柄：stopBackendForRestore 超时强杀后已显式置 null / 新进程已接管时，
  // 旧进程晚到的 exit 事件应跳过自动重启，避免重复/二次启动
  const proc = backendProc;

  backendProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  backendProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });

  backendProc.on('error', (err) => {
    // spawn 失败（如 python 不在 PATH / 打包 exe 缺失 ENOENT）：不会触发 exit，重置句柄，避免误重启
    backendProc = null;
    const message = isPackaged
      ? `后端可执行文件启动失败：${err.message}\n\n请确认安装目录 resources/backend/bossjob-backend.exe 存在且完整，必要时重新安装应用。`
      : `后端启动失败：${err.message}\n\n开发模式需要 Python 已加入 PATH，并在 backend/ 下创建并激活虚拟环境（见 packaging/BUILD.md §2）。`;
    console.error(`[electron] 后端启动失败：${err.message}`);
    notifyBackendError(message);
    showBackendErrorDialog(message);
  });

  backendProc.on('exit', async (code, signal) => {
    // 旧进程晚到的 exit（stopBackendForRestore 超时强杀后已显式置 null / 新进程已接管）：
    // 不是当前句柄时跳过自动重启，避免重复启动
    if (backendProc !== proc) {
      return;
    }
    backendProc = null;
    console.log(`[electron] 后端退出 code=${code} signal=${signal}`);

    // 主动关闭时不再重启
    if (isShuttingDown) {
      return;
    }

    // 守护循环：异常退出时重启，最多 MAX_BACKEND_RESTARTS 次
    if (backendRestartCount < MAX_BACKEND_RESTARTS) {
      backendRestartCount += 1;
      console.log(
        `[electron] 后端异常退出，第 ${backendRestartCount}/${MAX_BACKEND_RESTARTS} 次重启...`
      );
      // 重启前向所有渲染窗口推送进度，避免守护循环期间 UI 停留在陈旧的「后端未连接」而无任何提示
      broadcast('backend-restarting', {
        attempt: backendRestartCount,
        max: MAX_BACKEND_RESTARTS,
      });
      // 重启前指数退避：瞬时退出/崩溃循环（如端口被占用、启动即崩）时避免毫秒级烧光全部重启次数。
      // 首次 1s，逐次翻倍，封顶 8s，为后端端口释放/依赖就绪留出时间。
      const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, backendRestartCount - 1), BACKOFF_MAX_MS);
      console.log(
        `[electron] ${backoffMs}ms 后重启后端（第 ${backendRestartCount}/${MAX_BACKEND_RESTARTS} 次）...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      // 退避等待期间用户可能已退出应用，或已触发数据恢复停服：
      // 主动关闭 / restore-data 进行中时放弃本次重启，避免复活进程在恢复覆盖 app.db 期间抢占 SQLite 锁。
      if (isShuttingDown || backendStoppedForRestore) {
        return;
      }
      startBackend();
      // 恢复可观测性：重置错误对话框门闩（后续若再次启动失败仍能弹窗提示），
      // 并重新等待后端健康，就绪后向所有渲染窗口推送 backend-ready，让 UI 从「连接失败」自动恢复
      backendErrorDialogShown = false;
      // 预算超时后转入周期复查（waitBackendReadyOrRetry）：后端恢复健康即推送 backend-ready 并清零
      // backendRestartCount，避免「进程存活但健康延迟」把重启计数虚增到 MAX_BACKEND_RESTARTS 提前放弃守护。
      waitBackendReadyOrRetry();
    } else {
      console.error(
        `[electron] 后端已退出且超过最大重启次数（${MAX_BACKEND_RESTARTS}），放弃守护。`
      );
      // 把「守护循环已耗尽」的具体可操作原因推送给渲染层（Dashboard Alert），
      // 替换掉通用的「后端未连接」，让用户明确知道应用已放弃自动重启。
      const message = '后端连续退出超过最大重启次数，已停止自动重启，请检查环境后手动重启应用';
      notifyBackendError(message);
      // 同步弹出错误对话框：后端已永久停摆，仅 console + IPC 推送对用户可见度不足，
      // 弹窗确保「后端已放弃重启」这一失败状态被用户明确感知。
      showBackendErrorDialog(message);
    }
  });
}

/** 主动关闭后端（应用退出时调用）。 */
function stopBackend() {
  isShuttingDown = true;
  if (backendProc) {
    console.log('[electron] 关闭后端进程...');
    backendProc.kill();
    backendProc = null;
  }
}

/** 把后端失败原因推送给所有渲染窗口（渲染进程展示可操作提示，见 Dashboard）。 */
function notifyBackendError(message) {
  // startBackend() 先于 createWindow() 执行，spawn 'error' 可能同步触发：此时尚无窗口 / 渲染进程未订阅
  // backend-error 通道，先缓冲到 pendingBackendError，由 createWindow 的 did-finish-load 冲刷补发。
  // 新错误代际：使已缓冲的就绪信号过期（后端状态已翻转），并重置上一代错误已消费记录，
  // 确保每个窗口都能收到这一最新错误（已加载窗口立即投递，加载中窗口延迟补发）。
  pendingBackendReady = null;
  backendReadyDelivered = new Set();
  backendErrorDelivered = new Set();
  pendingBackendError = message;
  // 统一经 sendToAppWindows 投递：已加载窗口立即发送，加载中窗口延迟到 did-finish-load 后补发。
  // createWindow() 已在 did-finish-load 上注册了冲刷监听器且先于本处补发注册，
  // 故补发回调需按 webContentsId 核对「本窗口是否已消费该消息」：已消费则跳过，避免重复下发；
  // 冲刷不再清空全局缓冲，故其它窗口（含之后才创建的窗口）加载完成后仍能补发，不会永久丢失该错误。
  sendToAppWindows('backend-error', message, (win, wc) => {
    // 代际校验：仅当本消息仍是当前缓冲（未被更新代际的 ready/error 取代）且本窗口未消费时才补发。
    // 否则窗口加载期间缓冲被反方信号代际替换后，过期的 deferredSend 会把陈旧错误补发给已收到新状态的窗口，
    // 导致 UI 错误地停在后端失败态（backendErrorDelivered 只按 wcId 判重，无法识别代际翻转）。
    if (pendingBackendError === message && !backendErrorDelivered.has(wc.id)) {
      backendErrorDelivered.add(wc.id);
      wc.send('backend-error', message);
    }
  });
  // 不再因「所有窗口均已加载」清空缓冲：缓冲保留最新错误，供之后创建的窗口（macOS activate 重建 / 多窗口）
  // 在 did-finish-load 冲刷时补发，防止该窗口永久丢失 backend-error。
}

/** 最近一次后端就绪版本与待补发缓冲（模块级，供 notifyBackendReady 使用）。
 *  冲刷改为按窗口核对（backendReadyDelivered）：pendingBackendReady 保留最新就绪载荷，
 *  不因某一窗口 did-finish-load 冲刷而清空，之后创建的窗口（macOS activate 重建 / 多窗口）
 *  加载完成后仍能补发，防止就绪信号被永久丢弃。 */
let backendReadyVersion = null;
let pendingBackendReady = null;
/** 已消费当前 pendingBackendReady 的 webContents id 集合：仅对「本窗口尚未消费该载荷」的窗口补发；
 *  新就绪代际 / 新的 backend-error 会重建本集合；缓冲不清空，由各窗口 did-finish-load 冲刷按本集合判重补发。 */
let backendReadyDelivered = new Set();

/**
 * 把后端就绪状态与版本推送给所有渲染窗口。
 *  - 直接投递给已加载完成的窗口；
 *  - 仍有窗口处于加载中（渲染进程尚未订阅 backend-ready 通道）时把载荷缓冲到 pendingBackendReady，
 *    由 createWindow 的 did-finish-load 冲刷补发，避免「后端就绪」信号在窗口引导期被永久丢弃；
 *  - 窗口尚未创建（startup 阶段 waitForBackendHealth 先于 createWindow 就绪）时同样缓冲。
 * 仅在后端真实就绪时调用（waitForBackendHealth 超时返回 false 不会触发），
 * 避免覆盖渲染层展示的具体失败原因（如 Python 不在 PATH）。
 */
function notifyBackendReady() {
  // 携带当前 backendPort：restore-data / import-backup-archive 恢复备份 settings.json 后端口可能
  // 重新解析变更（见 restoreBackupDir 内 backendPort = resolveBackendPort()），经此推送给渲染层，
  // 使渲染层任何按后端端口寻址的逻辑都能拿到恢复后的新端口，而非启动期 get-bootstrap-info 的旧值。
  const payload = { version: backendReadyVersion || null, port: backendPort };
  // 新就绪代际：使已缓冲的过期错误失效（后端已恢复健康），并重置已消费记录，
  // 确保每个窗口都能收到这一最新就绪信号（已加载窗口立即投递，加载中窗口延迟补发）。
  // 缓冲始终保留，供之后创建的窗口在 did-finish-load 冲刷时补发
  // （原 forceBuffer 参数已移除：本实现始终保留缓冲，该参数不再改变任何行为）。
  pendingBackendError = null;
  backendErrorDelivered = new Set();
  backendReadyDelivered = new Set();
  pendingBackendReady = payload;
  // 统一经 sendToAppWindows 投递：已加载窗口立即发送；加载中窗口同样延迟补发 —— 但
  // createWindow 的 did-finish-load 冲刷也会发送，故补发回调需按 webContentsId 核对
  // 「本窗口是否已消费该载荷」：已消费则跳过，避免同一就绪信号重复下发；
  // 冲刷不再清空全局缓冲，之后创建的窗口也能补发到最新就绪信号。
  sendToAppWindows('backend-ready', payload, (win, wc) => {
    // 代际校验：仅当该载荷仍是当前缓冲（未被更新代际的 error/ready 取代）且本窗口未消费时才补发，
    // 避免窗口加载期间缓冲被反方信号代际替换后，过期 deferredSend 把陈旧就绪补发给已收到新状态的窗口。
    if (pendingBackendReady === payload && !backendReadyDelivered.has(wc.id)) {
      backendReadyDelivered.add(wc.id);
      wc.send('backend-ready', payload);
    }
  });
}

/** 首次后端启动失败时弹出可操作对话框，避免「窗口正常打开但无任何提示」。 */
function showBackendErrorDialog(message) {
  if (backendErrorDialogShown) {
    return;
  }
  backendErrorDialogShown = true;
  const options = {
    type: 'error',
    title: '后端启动失败',
    message: 'BossJobAI 后端未能启动',
    detail: message,
    buttons: ['知道了'],
    defaultId: 0,
  };
  const win = getDialogParent();
  if (win) {
    void dialog.showMessageBox(win, options);
  } else {
    void dialog.showMessageBox(options);
  }
}

/**
 * 轮询 /api/health 直至后端就绪；成功时校验健康检查版本与安装包版本是否一致，
 * 防止 constants.APP_VERSION / electron/package.json / frontend/package.json 三处版本漂移
 * （不一致仅告警，不阻断运行）。
 * @returns {Promise<boolean>} 后端在预算内就绪返回 true；轮询超时返回 false（不会抛错）。
 */
async function waitForBackendHealth() {
  const url = `http://127.0.0.1:${backendPort}/api/health`;
  // 安装包版本在轮询期间恒定不变，仅读取一次供各次尝试复用（避免循环内重复调用 app.getVersion()）
  const packagedVersion = app.getVersion();
  for (let attempt = 1; attempt <= HEALTH_POLL_ATTEMPTS; attempt += 1) {
    try {
      const resp = await httpGet(url, HEALTH_REQUEST_TIMEOUT_MS);
      const parsed = JSON.parse(resp.body);
      if (parsed && parsed.status === 'ok') {
        // 鉴权指纹校验（auth-bypass 修复）：/api/health 就绪后校验后端返回的令牌指纹与主进程持有
        // 令牌是否一致。若后端未载入令牌（FAIL-OPEN，指纹缺失/不匹配），说明后端处于「本地任意进程
        // 可无令牌调用全部 /api/*」的危险状态 —— 弹窗告警、拒绝交互（不推送 backend-ready）并熔断
        // 后续转发（backend-request），由用户介入修复环境，绝不带病放行。
        if (!verifyBackendTokenFingerprint(parsed)) {
          reportBackendAuthFailure();
          return false;
        }
        // 后端持有有效令牌：解除此前可能已触发的鉴权 FAIL-OPEN 熔断（backendAuthFailure），
        // 使后端转发代理（backend-request）恢复放行，避免「UI 提示已就绪但所有请求仍 401」的矛盾态。
        backendAuthFailure = false;
        // 后端确认就绪：此时后端必然已在模块导入期读完一次性令牌文件（读后即删），此处兜底删除
        // 可能遗留的令牌文件（后端启动即崩溃等异常场景），消除明文密钥残留。
        cleanupAuthTokenFile();
        // 后端健康即清零重启计数：只有连续崩溃循环才计入 MAX_BACKEND_RESTARTS
        backendRestartCount = 0;
        backendReadyVersion = parsed.version; // 记录就绪版本，供 notifyBackendReady 推送 backend-ready 时携带
        if (parsed.version && packagedVersion && parsed.version !== packagedVersion) {
          console.warn(
            `[electron] 版本漂移告警：后端 /api/health version=${parsed.version}，` +
              `安装包 version=${packagedVersion}（electron/package.json）。` +
              `请同步 backend/app/constants.py 的 APP_VERSION 与 frontend/package.json。`
          );
        } else {
          console.log(`[electron] 后端就绪 version=${parsed.version}`);
        }
        return true;
      }
    } catch (_err) {
      // 后端未就绪：继续轮询
    }
    if (attempt < HEALTH_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
  }
  console.warn(
    `[electron] 等待后端就绪超时（${HEALTH_POLL_ATTEMPTS} 次 × ${HEALTH_POLL_INTERVAL_MS}ms），窗口内将显示连接失败。`
  );
  return false;
}

/** 清除健康预算超时后的周期复查定时器（若在运行）。 */
function clearBackendHealthRetry() {
  if (backendHealthRetryTimer !== null) {
    clearInterval(backendHealthRetryTimer);
    backendHealthRetryTimer = null;
  }
}

/**
 * 等待后端就绪并处理「就绪 / 超时」终态（startup 与后端异常重启路径共用）：
 *  - 就绪：推送 backend-ready（含版本载荷）并清零重启计数；
 *  - 预算超时：不一次性放弃——补发一次通用错误（已有更具体错误时不覆盖），随后启动周期复查，
 *    每 BACKEND_HEALTH_RETRY_INTERVAL_MS 重跑一次 waitForBackendHealth；后端在预算之后才恢复健康时，
 *    复查命中即推送 backend-ready，解除渲染层（已停止自轮询）永久停留在「未连接/重启中」的卡死；
 *    同时清零 backendRestartCount，避免「进程存活但健康延迟」被计入崩溃预算、
 *    虚增到 MAX_BACKEND_RESTARTS 提前放弃守护。
 * 周期复查在应用退出（isShuttingDown）或被更新的监测代际（后续崩溃重启 / 数据恢复流程重新调用
 * 本函数时递增 backendHealthMonitorGeneration）取代时自动清除退出。
 */
function waitBackendReadyOrRetry() {
  // 递增代际并清掉上一轮（若仍在周期复查）的定时器：新监测周期取代旧周期，杜绝并发复查/重复推送
  const generation = ++backendHealthMonitorGeneration;
  clearBackendHealthRetry();
  void waitForBackendHealth().then((healthy) => {
    if (isShuttingDown || backendHealthMonitorGeneration !== generation) {
      return;
    }
    if (healthy) {
      // 后端真实就绪 → 推送 backend-ready（携带版本载荷、对加载中的窗口缓冲补发）。
      // waitForBackendHealth 命中健康时已清零 backendRestartCount，此处显式复置以表达「恢复即清零」意图；
      // 同时复位 backendErrorDialogShown：后端已恢复健康，允许同会话后续失败再次弹「后端启动失败」
      // 对话框，避免「弹过一次后仅剩 IPC 推送、不再弹窗」的失败信号静默降级。
      backendRestartCount = 0;
      backendErrorDialogShown = false;
      notifyBackendReady();
      return;
    }
    // 预算内未就绪：先补发一次通用终态信号（已有更具体的后端错误时不覆盖），
    // 但超时不是终态——启动周期复查，后端恢复健康后自动推送 backend-ready。
    if (pendingBackendError === null) {
      notifyBackendError('后端未在预算时间内恢复健康，请检查端口占用或运行环境');
    }
    if (backendHealthRetryTimer === null) {
      // 上一轮 waitForBackendHealth 可能耗时约 10s（20 次 × 500ms 轮询），长于复查间隔：
      // 用 retryRunning 门闩跳过尚未结束的重叠 tick，避免对同一端点并发轮询。
      let retryRunning = false;
      backendHealthRetryTimer = setInterval(() => {
        if (isShuttingDown || backendHealthMonitorGeneration !== generation) {
          clearBackendHealthRetry();
          return;
        }
        if (retryRunning) {
          return;
        }
        retryRunning = true;
        void waitForBackendHealth().then((ok) => {
          retryRunning = false;
          if (isShuttingDown || backendHealthMonitorGeneration !== generation) {
            return;
          }
          if (ok) {
            // 预算后恢复健康：清除复查定时器、清零重启计数并推送 backend-ready（后端就绪终态）。
            // 同时复位 backendErrorDialogShown：恢复健康后允许同会话后续失败再次弹「后端启动失败」对话框。
            clearBackendHealthRetry();
            backendRestartCount = 0;
            backendErrorDialogShown = false;
            notifyBackendReady();
          }
        });
      }, BACKEND_HEALTH_RETRY_INTERVAL_MS);
    }
  });
}

// ---------------------------------------------------------------------------
// 窗口创建
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'BossJobAI 求职投递助手',
    backgroundColor: '#ffffff',
    webPreferences: {
      // 安全基线（架构 v0.2）：渲染进程隔离，仅经 preload 桥接
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // 显式锁定沙箱：渲染进程无 Node 能力，仅经 preload 桥接
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 登记应用窗口：令牌注入仅对归属本窗口的 XHR/fetch 放行，其它 webContents（webview/意外窗口）不派发凭证
  appWindowWebContentsIds.add(win.webContents.id);
  win.webContents.once('destroyed', () => {
    appWindowWebContentsIds.delete(win.webContents.id);
    trustedImportPaths.delete(win.webContents.id); // 回收该窗口已登记的导入信任路径，防 Map 泄漏
    backendReadyDelivered.delete(win.webContents.id); // 回收该窗口已消费标记，防 Set 泄漏
    backendErrorDelivered.delete(win.webContents.id);
  });

  // 安全加固：禁止渲染进程新开原生窗口（外部链接走系统浏览器由前端控制）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 安全加固：禁止任意导航 —— 仅放行开发模式 Vite dev server 的自身导航，
  // 渲染进程侧 location 跳转（链接 / 任意脚本）一律阻断，防止被导航到任意 URL。
  // 打包模式完全禁止一切导航（只加载本地 index.html）。
  // 例外：放行「当前页面自身的 reload」——恢复数据成功后前端会 window.location.reload()
  // 刷新页面（DataViews.tsx 恢复数据流程），同一 URL 的重新加载不构成任意导航风险。
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) {
      return; // 同一 URL 的 reload（如恢复数据后刷新），放行
    }
    if (app.isPackaged) {
      event.preventDefault();
      return;
    }
    // 开发模式：仅放行 Vite dev server 同源导航（严格 origin 匹配，防 localhost:5173.evil.com 前缀绕过）
    try {
      const devOrigin = DEV_SERVER_ORIGIN;
      if (new URL(url).origin !== devOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  // 导航提交（含同 URL reload：恢复数据后渲染层 window.location.reload() 触发）时回收
  // 本窗口在 backendReadyDelivered / backendErrorDelivered 中的「已消费」标记，使随后的
  // did-finish-load 冲刷（flushPendingSignals）能向重载后的新页面重新补发当前缓冲的后端状态，
  // 重灌 preload 缓冲（lastPayloadByChannel）——否则 reload 后 preload 缓冲被重建为空、旧 wcId
  // 又已在已消费集合中，晚订阅 onBackendReady/onBackendError 的组件既收不到回放也收不到推送。
  win.webContents.on('did-navigate', () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      const wcId = win.webContents.id;
      backendReadyDelivered.delete(wcId);
      backendErrorDelivered.delete(wcId);
    }
  });

  if (app.isPackaged) {
    // 生产：加载构建产物
    win.loadFile(FRONTEND_DIST_INDEX).catch((err) => {
      console.error('[electron] 加载前端失败 (loadFile):', err);
    });
  } else {
    // 开发：加载 Vite dev server
    win.loadURL(DEV_SERVER_URL).catch((err) => {
      console.error('[electron] 加载开发服务器失败 (loadURL):', err);
    });
  }

  // 冲刷缓冲的后端启动失败消息：渲染进程加载完成并订阅 backend-error 后立即补发，
  // 覆盖 startBackend() 早于 createWindow() 触发的 spawn 'error'，避免该消息被永久丢弃。
  // 冲刷是窗口生命周期内常驻的持久监听器（非 once）：did-fail-load 清理一次性补发监听器时
  // removeAllListeners 会连它一并移除，故命名为 flushPendingSignals 以便失败分支重新挂回，
  // 否则 restore-data 的 forceBuffer 冲刷（见下方 did-fail-load 注释）在重载页将永久丢失 backend-ready。
  const flushPendingSignals = () => {
    // 冲刷缓冲的后端失败消息：按 webContentsId 核对「本窗口是否已消费」，未消费才补发并登记；
    // 不再清空全局缓冲 —— 其它窗口（含之后创建的窗口）加载完成后仍能补发，避免多窗口场景下
    // 第一个窗口冲刷把缓冲置空导致其它窗口永久丢失 backend-error。
    if (pendingBackendError !== null && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const wcId = win.webContents.id;
      if (!backendErrorDelivered.has(wcId)) {
        backendErrorDelivered.add(wcId);
        win.webContents.send('backend-error', pendingBackendError);
      }
    }
    // 冲刷缓冲的后端就绪信号：startup 阶段 waitForBackendHealth 可能在窗口加载完成前就绪，
    // notifyBackendReady 会把载荷暂存于此，待渲染进程订阅 backend-ready 后补发，避免信号永久丢失。
    // 同样按 webContentsId 核对已消费状态，冲刷不清空全局缓冲，之后创建的窗口也能补发。
    if (pendingBackendReady !== null && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const wcId = win.webContents.id;
      if (!backendReadyDelivered.has(wcId)) {
        backendReadyDelivered.add(wcId);
        win.webContents.send('backend-ready', pendingBackendReady);
      }
    }
  };
  win.webContents.on('did-finish-load', flushPendingSignals);

  // 加载失败（如生产模式 dist/ 缺失、dev server 未启动）时 did-finish-load 永不触发，
  // sendToAppWindows 在加载中窗口上注册的 once('did-finish-load') 补发监听器会永久滞留。
  // 此处仅做窗口本地的监听器清理（removeAllListeners + 重新挂回 flushPendingSignals），
  // 不清空模块级缓冲 pendingBackendError / pendingBackendReady：冲刷已按 webContentsId 核对
  // 「本窗口是否已消费该信号」（flushPendingSignals / deferredSend 均跳过已消费窗口，见上），
  // 某一窗口加载失败不再清除其它窗口（含之后创建、仍在加载中的窗口）待补发的信号，
  // 避免多窗口场景下第一个窗口 did-fail-load 清空缓冲导致其它窗口永久丢失 backend-ready/backend-error。
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // 仅主框架加载失败才清理窗口本地监听器：did-fail-load 对子框架（iframe）导航失败同样触发，
    // 若此时清空缓冲，会把本应经主框架 did-finish-load 冲刷的合法 backend-ready/error 误删（窗口引导期丢信号）。
    if (isMainFrame === false) {
      return;
    }
    // 内存泄漏修复：主框架加载失败时 did-finish-load 永不触发，sendToAppWindows 在加载中窗口上
    // 注册的 once('did-finish-load') 补发监听器将永久滞留；后端反复重启会累积未触发的监听器，
    // 直到窗口销毁才释放（旧代码只清缓冲不清监听器）。此处统一移除，加载失败后不再残留补发监听器。
    // 注意 removeAllListeners 会连同上方 createWindow 的持久冲刷监听器一并移除，因此立即重新挂回
    // flushPendingSignals（冲刷是窗口常驻机制，restore-data 的 forceBuffer 冲刷依赖它来给重载后的
    // 新页面补发 backend-ready，见 createWindow 内 will-navigate 处理（同一 URL reload 放行逻辑）。
    // 缓冲不清空：flushPendingSignals 按 webContentsId 核对「本窗口是否已消费该信号」，已消费窗口
    // 不会重复补发（无陈旧状态重放），未消费窗口（本窗口重载后的新页面 / 其它仍在加载中的窗口）
    // 在后续成功加载时仍会经冲刷补发到最新后端状态 —— 不会因某一窗口加载失败而让其它窗口永久丢失
    // backend-ready/backend-error。此后新错误/就绪通知仍会经 sendToAppWindows 对加载中窗口重新注册
    // once 补发监听器，两者路径互不冲突。
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.removeAllListeners('did-finish-load');
      win.webContents.on('did-finish-load', flushPendingSignals);
    }
  });

  return win;
}

// ---------------------------------------------------------------------------
// IPC：get-bootstrap-info —— 返回渲染层启动所需的会话级常量（后端端口）。
// ---------------------------------------------------------------------------
// 渲染层访问本地后端的唯一鉴权通道已收口为主进程代理 backend-request（端点白名单 + Bearer
// 主进程附加，见下方 IPC 定义）。不再向渲染层签发 csrfToken：该令牌已无安全语义（webRequest 的
// onBeforeSendHeaders 鉴权门退役），移除 csrfTokenFor / csrfTokenByWebContents 死代码，
// 减少对渲染层暴露的无用凭据（key-leak 加固）。
// 端口在常规会话内恒定，但 restore-data / import-backup-archive 恢复备份 settings.json 后可能
// 重新解析变更（见 restoreBackupDir 内 backendPort = resolveBackendPort()），故本通道每次按当前
// backendPort 实时返回；渲染层应以每次读取为准，或消费 backend-ready 载荷中携带的 port 刷新缓存。
guardedHandle('get-bootstrap-info', () => ({
  port: backendPort,
}));

// IPC：get-backend-state —— 只读拉取主进程当前缓冲的后端状态快照（{ ready, error, restarting }）。
// 供 preload 在窗口 reload 后缓冲（lastPayloadByChannel）被重建为空、主进程又仅在状态变迁时推送
// 的窗口期兜底拉取当前状态：覆盖「reload 前后端已就绪/失败、reload 后无新推送」导致晚订阅者
// 收不到任何信号（onBackendReady/onBackendError/onBackendRestarting）的缺口。
// 未发生的状态字段为 null；restarting 由模块级重启计数实时推导（计数 > 0 即处于崩溃重启循环）。
guardedHandle('get-backend-state', () => ({
  ready: pendingBackendReady,
  error: pendingBackendError,
  restarting: backendRestartCount > 0 ? { attempt: backendRestartCount, max: MAX_BACKEND_RESTARTS } : null,
}));

// ---------------------------------------------------------------------------
// IPC：backend-request —— 渲染层访问本地后端的【唯一】经主进程代理通道（认证加固）。
// 渲染层所有 /api/* 调用统一经此 IPC 转发，不再直连 http://127.0.0.1:<port>：
//  1) 端点白名单在主进程强制（method + pathname 匹配）：即使渲染层被同主世界 XSS 拿下、
//     也能拿到 window.api.getCsrfToken()，仍无法触达白名单以外的任何后端端点；
//  2) Bearer 鉴权令牌由主进程 httpRequest 附加，渲染层全程不可见、不可外带；
//  3) 强制 127.0.0.1:backendPort 源 + /api/ 前缀，杜绝 SSRF 到任意本地/远端地址。
// 历史背景：此前的 webRequest onBeforeSendHeaders 依据 X-CSRF-Token 匹配为渲染层
// fetch 附加 Bearer，构成「同主世界脚本 getCsrfToken() + 直连 fetch → 全量后端 API」
// 的提权原语（CSRF 令牌挡不住同世界 DOM XSS）。本代理把信任边界收敛到主进程，使 CSRF
// 令牌不再是渲染层访问后端的唯一凭证；webRequest 的 Bearer 附加逻辑同步退役（见下方鉴权门）。
// ---------------------------------------------------------------------------
// 端点白名单与匹配函数收口到独立模块（单一事实来源，见 endpoint-whitelist.cjs）。
// 后端端点演进时必须同步更新该模块与 scripts/verify-endpoint-whitelist.cjs 回归测试，
// 防止白名单扩容引入 SSRF / 任意路径访问回归。
const { isEndpointAllowed } = require('./endpoint-whitelist.cjs');

/** backend-request 转发请求体大小上限（50KB，防恶意大载荷占满内存）。 */
const BACKEND_PROXY_MAX_BODY_BYTES = 50 * 1024;
/** httpRequest 响应体累积上限（10MB）：对称于请求体上限，防响应体无限累积 Buffer.concat 占满内存。
 *  导出/备份全量载荷可能较大（applications + apply_logs + settings），故取值放宽到 10MB。 */
const BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
/** backend-request 转发超时（与既有 httpRequest 兜底口径一致）。 */
const BACKEND_PROXY_TIMEOUT_MS = 15000;
/** import-data 导入文件大小上限（对齐导出上限 EXPORT_MAX_RESPONSE_BODY_BYTES=200MB）：
 *  readFile + JSON.parse 前先 stat 拒绝超大文件，防一次性读入占满内存；
 *  保证应用自身能导出的载荷（最高 200MB）都能导回。 */
const MAX_IMPORT_FILE_BYTES = EXPORT_MAX_RESPONSE_BODY_BYTES;
/** import-data 的 applications 行数上限（500k）：防超大数组整份 JSON.stringify / POST 耗尽内存。 */
const MAX_IMPORT_APPLICATIONS = 500000;
/** import-data 序列化后 POST 请求体上限（对齐导出上限 EXPORT_MAX_RESPONSE_BODY_BYTES=200MB）：
 *  防深嵌套/超大对象 stringify 出巨量内存；同时保证粘贴导入（POST /api/import 转发放行）
 *  与文件导入容量一致，应用自身导出的载荷均可导回。 */
const MAX_IMPORT_POST_BODY_BYTES = EXPORT_MAX_RESPONSE_BODY_BYTES;
/** 「打开 JSON 导入文件」对话框选项（preview-import-data / import-data 共用同一份，杜绝 title/buttonLabel/message/filters 漂移）。 */
const IMPORT_JSON_DIALOG_OPTIONS = {
  title: '导入求职数据',
  buttonLabel: '选择 JSON 文件',
  message: '请选择由「导出数据」生成的 JSON 文件（含 applications 数组）',
  properties: ['openFile'],
  filters: [{ name: 'JSON 数据文件', extensions: ['json'] }],
};

// ---------------------------------------------------------------------------
// 后端请求载荷校验：PUT /api/settings 的 llm.base_url 允许来源白名单（config-tampering 加固）
// ---------------------------------------------------------------------------
// 配置热更新（PUT /api/settings）会把 llm.base_url 落盘并供后端 LLM 调用；若不做主进程校验，
// 同主世界 XSS 可把 base_url 指向攻击者主机，让后端把用户 API key 服务端外带 —— 这是唯一绕过
// 渲染层 CSP connect-src 的通道（import/restore/backup 路径均已剥离 llm.base_url，唯独此 PUT 直通）。
// 故对 llm.base_url 施以「https + 已知提供商宿主白名单 + 禁止 userinfo」校验，与后端路由器校验构成双保险。
/** 允许的 LLM base_url 宿主白名单：主流 OpenAI 兼容提供商。 */
const ALLOWED_LLM_BASE_URL_HOSTS = new Set([
  'api.deepseek.com',       // DeepSeek
  'dashscope.aliyuncs.com', // 阿里云百炼 DashScope（Qwen）
  'open.bigmodel.cn',       // 智谱 GLM
  'api.openai.com',         // OpenAI
  'api.moonshot.cn',        // Moonshot Kimi
  'api.siliconflow.cn',     // 硅基流动 SiliconFlow
  'api.z.ai',               // Z.ai
  'openrouter.ai',          // OpenRouter
  'api.anthropic.com',      // Anthropic
]);
/** 本地 LLM 服务（Ollama / llama.cpp / LM Studio 等）允许 http，但仅限回环地址，无法把密钥外带。 */
const LOCALHOST_LLM_BASE_URL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * 校验单个 llm.base_url：空串放行（走提供商默认端点）。
 * 非空时要求：https（本地回环允许 http）+ 宿主命中白名单或为本地回环 + 无 userinfo。
 * 返回 null 表示通过，返回字符串表示拒绝原因。
 */
function validateLlmBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') {
    return 'llm.base_url 必须是字符串';
  }
  const url = baseUrl.trim();
  if (url === '') {
    return null; // 空 = 使用提供商默认端点
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return 'llm.base_url 不是合法 URL';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'llm.base_url 禁止携带 userinfo';
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (LOCALHOST_LLM_BASE_URL_HOSTS.has(host)) {
    return null; // 本地回环：仅本机，无法把密钥外带
  }
  if (parsed.protocol !== 'https:') {
    return 'llm.base_url 仅允许 https';
  }
  if (!ALLOWED_LLM_BASE_URL_HOSTS.has(host)) {
    return 'llm.base_url 宿主不在允许列表中';
  }
  return null;
}

/**
 * 校验 PUT /api/settings 请求体中的 llm.base_url（body 为原始 JSON 字符串）。
 * 未携带 llm.base_url / body 非 JSON 时返回 null（由后端既有 422 校验兜底），不额外阻断。
 */
function validateSettingsPutBody(body) {
  if (body == null) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (_err) {
    return null;
  }
  const llm = payload && typeof payload === 'object' ? payload.llm : undefined;
  if (!llm || typeof llm !== 'object' || llm.base_url === undefined) {
    return null;
  }
  return validateLlmBaseUrl(llm.base_url);
}

guardedHandle('backend-request', async (event, payload) => {
  // 鉴权 FAIL-OPEN 熔断（auth-bypass 修复）：主进程检测到后端未正确载入鉴权令牌时
  // （verifyBackendTokenFingerprint / reportBackendAuthFailure 置位 backendAuthFailure），
  // 拒绝转发渲染层一切后端请求，阻止 UI 在「无鉴权后端」上读写本地求职数据。
  if (backendAuthFailure) {
    return { ok: false, status: 401, body: '{"detail":"backend authentication failure"}' };
  }
  // 仅放行应用主窗口（与 webRequest 登记口径一致）：注入的 iframe / 其它 webContents 一律拒绝。
  if (!appWindowWebContentsIds.has(event.sender.id)) {
    return { ok: false, status: 403, body: '{"detail":"forbidden"}' };
  }
  const method = typeof payload?.method === 'string' ? payload.method.toUpperCase() : '';
  const path = typeof payload?.path === 'string' ? payload.path : '';
  // 白名单校验：isEndpointAllowed 内部实现「路径必须 /api/ 开头 + 方法精确匹配 + 查询串剥离 +
  // 严格锚定正则」，与 scripts/verify-endpoint-whitelist.cjs 回归测试共用同一模块（防演进回归）。
  const allowed = isEndpointAllowed(method, path);
  if (!allowed) {
    console.warn(`[electron] backend-request 拒绝非白名单端点：${method} ${path}`);
    return { ok: false, status: 403, body: '{"detail":"endpoint not allowed"}' };
  }
  // 载荷大小限制 + 仅接受合法 JSON 字符串 / null。
  // 粘贴导入（POST /api/import）会携带完整导出载荷，UTF-8 多字节中文极易触及通用代理 50KB 上限，
  // 故对该端点单独放行到与 import-data 一致的 MAX_IMPORT_POST_BODY_BYTES，对齐两条导入路径的容量。
  let body = null;
  if (payload.body != null) {
    const isImportEndpoint = method === 'POST' && path === '/api/import';
    const bodyLimitBytes = isImportEndpoint ? MAX_IMPORT_POST_BODY_BYTES : BACKEND_PROXY_MAX_BODY_BYTES;
    if (typeof payload.body !== 'string' || Buffer.byteLength(payload.body, 'utf-8') > bodyLimitBytes) {
      return { ok: false, status: 400, body: '{"detail":"body too large or invalid"}' };
    }
    body = payload.body;
  }
  // 配置热更新载荷校验：PUT /api/settings 的 llm.base_url 必须命中允许来源白名单
  // （https + 已知提供商宿主，禁止 http / 任意宿主 / userinfo），防止同主世界 XSS 把后端
  // LLM 调用指向攻击者主机、经服务端外带用户 API key —— 唯一绕过渲染层 CSP connect-src 的通道。
  if (method === 'PUT' && path === '/api/settings') {
    const baseUrlError = validateSettingsPutBody(body);
    if (baseUrlError !== null) {
      console.warn(`[electron] backend-request 拒绝非法 llm.base_url：${baseUrlError}`);
      return { ok: false, status: 400, body: JSON.stringify({ detail: baseUrlError }) };
    }
  }
  try {
    // 强制 127.0.0.1:backendPort 源：path 已由白名单限定为 /api/ 前缀，双保险杜绝 SSRF。
    const url = new URL(`http://127.0.0.1:${backendPort}${path}`);
    const { statusCode, body: resBody } = await httpRequest(url, { method, body }, BACKEND_PROXY_TIMEOUT_MS);
    // defense-in-depth（api_key 不出后端）：GET /api/settings 的响应体可能含 llm.api_key 明文，
    // 必须在主进程代理出口置空后再交还渲染层 —— 否则任何同主世界 XSS 都可通过
    // window.api.backendRequest({method:'GET',path:'/api/settings'}) 读取并外带 LLM API 密钥。
    // 仅置空 api_key，保留 llm.base_url（设置表单需回显并随 PUT 原样回传，删除会破坏设置往返）；
    // 解析失败/非对象时返回 null 由下方原样透传。
    if (statusCode >= 200 && statusCode < 300 && method === 'GET' &&
        path.split('?')[0].replace(/\/$/, '') === '/api/settings') {
      const sanitizedBody = sanitizeBackendSettingsBody(resBody);
      if (sanitizedBody !== null) {
        return { ok: true, status: statusCode, body: sanitizedBody };
      }
    }
    return { ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: resBody };
  } catch (err) {
    console.error('[electron] backend-request 转发失败：', err);
    // 区分超时 / 响应体超限 / 不可达三类失败，向渲染层返回真实原因：
    // 避免把大响应超限（RESPONSE_TOO_LARGE_ERR）误报为 status:0 / backend unreachable。
    let detail = '{"detail":"backend unreachable"}';
    if (err === TIMEOUT_ERR) {
      detail = '{"detail":"backend timeout"}';
    } else if (err === RESPONSE_TOO_LARGE_ERR) {
      detail = '{"detail":"backend response too large"}';
    }
    return { ok: false, status: 0, body: detail };
  }
});

// ---------------------------------------------------------------------------
// IPC：外部链接出口（P4/P5：投递记录中 BOSS直聘职位页 / 公司主页经系统浏览器打开）
// ---------------------------------------------------------------------------

/** 外部链接放行的 URL scheme 白名单：仅 http/https，杜绝 file: 等本地路径被打开。 */
const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:']);

/** scheme 白名单单一事实来源：EXTERNAL_URL_SCHEMES（http/https）。
 *  preload 经 invoke（get-external-url-schemes）惰性拉取，消除旧 sendSync 同步阻塞；
 *  旧 ipcMain.on 同步 handler 已移除（preload 仅走 invoke 路径，同步 handler 是死代码）。
 *  走 guardedHandle 以复用应用主窗口发送方白名单（与其余 IPC 一致），当前仅返回静态
 *  http/https 列表，但为未来扩展 scheme 来源时保持同一防御纵深口径。 */
guardedHandle('get-external-url-schemes', () => [...EXTERNAL_URL_SCHEMES]);

/** 外部链接宿主默认白名单后缀：BOSS直聘（*.zhipin.com）；其余须经 settings.json security.external_url_hosts 显式配置。 */
const DEFAULT_EXTERNAL_HOST_SUFFIXES = ['zhipin.com'];

/** DEFAULT_EXTERNAL_HOST_SUFFIXES 的预归一化结果（小写、去前导点）：refreshExternalHostAllowlistCache 与 isExternalHostAllowed 共用，消除内联重复归一化逻辑。 */
const DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED = DEFAULT_EXTERNAL_HOST_SUFFIXES.map((suffix) =>
  String(suffix).toLowerCase().replace(/^\./, '').replace(/\.+$/, '')
);

/** 外部链接宿主扩展白名单缓存：whenReady 启动时加载一次作为初始值；open-external 每次 IPC 打开前都会重读 settings.json 刷新本缓存（见 open-external），settings 热更新（PUT /api/settings / restore-data 恢复）时也会刷新。 */
let cachedExternalHostAllowlist = null;

/** 预归一化的宿主后缀数组（小写、去前导点）：由 DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED + cachedExternalHostAllowlist 归一化一次生成，isExternalHostAllowed 只做 O(n) 迭代匹配，避免每次打开外部链接都重复 concat/toLowerCase/replace。 */
let cachedExternalHostSuffixes = null;

/** 最近一次白名单读盘时 settings.json 的 mtimeMs：open-external 前经它判断文件是否变更，未变则跳过读盘+JSON.parse（兼容渲染层直连保存的同时避免每次点击链接做同步磁盘 I/O）。 */
let lastAllowlistMtime = null;

/**
 * 刷新外部链接宿主扩展白名单缓存并预归一化后缀数组。
 * 与 cachedExternalHostAllowlist 的每一处赋值配套调用：仅在白名单变更时计算一次，
 * isExternalHostAllowed 直接迭代预计算数组，杜绝 open-external 高频路径上的冗余计算。
 * 顺带记录本次读盘时 settings.json 的 mtimeMs，供 maybeRefreshExternalHostAllowlist 做变更检测。
 */
function refreshExternalHostAllowlistCache() {
  cachedExternalHostAllowlist = loadUserExternalHostAllowlist();
  cachedExternalHostSuffixes = DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED.concat((cachedExternalHostAllowlist || []).map((suffix) =>
    String(suffix).toLowerCase().replace(/^\./, '').replace(/\.+$/, '')
  ));
  lastAllowlistMtime = getSettingsMtime();
}

/**
 * 按需刷新外部链接宿主扩展白名单缓存：settings.json 的 mtime 未变化（上次读盘后无人改动）则跳过刷新、
 * 命中缓存直接放行；仅文件变更时才重读——既保持「渲染层直连保存新域名后无需重启即可放行」的语义，
 * 又避免 open-external 每次打开链接都做同步读盘 + JSON.parse 的重复 I/O（连续打开多个职位链接时尤甚）。
 */
function maybeRefreshExternalHostAllowlist() {
  const currentMtime = getSettingsMtime();
  if (currentMtime !== lastAllowlistMtime) {
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
  const suffixes = cachedExternalHostSuffixes || DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED;
  return suffixes.some((s) => h === s || h.endsWith('.' + s));
}

/**
 * 经系统浏览器打开外部链接（受控出口）。
 * preload 桥暴露 api.openExternal 供渲染进程调用（见 preload.js）；
 * 渲染进程无 window.open / <a target="_blank"> 出口（setWindowOpenHandler 一律 deny 新窗口）。
 * 双重校验：第一道闸 scheme 白名单（http/https）；第二道闸宿主白名单
 * （默认 *.zhipin.com + settings.json security.external_url_hosts 扩展配置）。
 * 任一不通过即拒绝并记录日志，防止外部注入的职位/公司链接把系统浏览器导向钓鱼或下载站。
 * 返回 Promise<{ ok: boolean, error?: string }>。
 */
guardedHandle('open-external', async (_event, rawUrl) => {
  try {
    const url = new URL(String(rawUrl));
    // 第一道闸：scheme 白名单，仅 http/https
    if (!EXTERNAL_URL_SCHEMES.has(url.protocol)) {
      console.warn(`[electron] open-external 拒绝：非法 scheme ${url.protocol}//`);
      return { ok: false, error: `不允许打开 ${url.protocol}// 链接` };
    }
    // 第二道闸：宿主白名单
    // 打开前按 mtime 按需刷新扩展白名单缓存：Settings 页经 PUT /api/settings 保存
    // （渲染层直连后端保存）成功后主进程不会自动收到通知，若不在此检测
    // 变更并刷新，新配置的域名会一直命中缓存中的旧白名单而被拒，直到重启应用。
    // mtime 未变化时跳过读盘（settings.json 未被改动，缓存仍有效），避免连续打开多个链接重复同步磁盘 I/O。
    maybeRefreshExternalHostAllowlist();
    if (!isExternalHostAllowed(url.hostname)) {
      console.warn(`[electron] open-external 拒绝：宿主 ${url.hostname} 不在白名单（仅放行 *.zhipin.com 或 settings.json security.external_url_hosts 配置项）`);
      return { ok: false, error: `出于安全考虑，不允许打开 ${url.hostname} 的链接` };
    }
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

/**
 * 刷新外部链接宿主扩展白名单缓存（设置页保存 security.external_url_hosts 后调用）：
 * 重新读盘 settings.json 并更新 cachedExternalHostAllowlist，
 * 使「打开」无需重启即可放行新配置的域名，避免用户陷入「配置→保存→打开被拒」的死胡同。
 * 与 restore-data 恢复 settings 后的刷新路径一致（见 restore-data 内 cachedExternalHostAllowlist 赋值）。
 * 返回 { ok: boolean }。
 */
guardedHandle('reload-external-allowlist', () => {
  refreshExternalHostAllowlistCache();
  console.log(
    `[electron] 已刷新外部链接宿主扩展白名单缓存：${(cachedExternalHostAllowlist || []).length} 项`
  );
  return { ok: true };
});

/**
 * 导出全部数据（隐私优先本地应用）：
 *   1. 从本地后端拉取 /api/export 全量 JSON（敏感字段已由后端 public_dump 剔除）。
 *   2. 弹出「另存为」对话框，写入用户选择的路径。
 * 返回 { canceled, ok, path?, error? }，供渲染进程提示结果。
 */
guardedHandle('export-data', async () => {
  try {
    // 构建载荷（fetchExportPayload + sanitizeSettingsForDisk + 简历快照并入）统一走 buildExportPayload，
    // 与 preview-export-data 同口径，保证导出文件与预览内容恒一致。
    const payload = await buildExportPayload();
    const json = JSON.stringify(payload, null, 2);

    const options = {
      title: '导出求职数据',
      defaultPath: path.join(app.getPath('documents'), `bossjob-export-${timestamp()}.json`),
      filters: [{ name: 'JSON 数据文件', extensions: ['json'] }],
    };
    const { canceled, filePath } = await saveDialog(options);
    if (canceled || !filePath) {
      return { canceled: true, ok: false };
    }
    await fs.promises.writeFile(filePath, json, 'utf-8');
    return { canceled: false, ok: true, path: filePath };
  } catch (err) {
    return {
      canceled: false,
      ok: false,
      error: errMsg(err),
    };
  }
});

/**
 * 预览导出载荷（不落盘、不弹「另存为」对话框）：
 * 复用 buildExportPayload 从本地后端拉取 /api/export 全量 JSON（applications + apply_logs + 脱敏 settings），
 * 并按 export-data 同口径剥离 llm.base_url（sanitizeSettingsForDisk）与并入 resume 快照后原样返回，
 * 供「数据」页在导出前渲染『导出内容预览』，确认文件实际包含什么。
 * 读取侧本身只读安全（GET /api/export），不随载荷外发任何凭证，无副作用。
 * 返回 { ok: boolean, payload?: object, error?: string }。
 */
guardedHandle('preview-export-data', async () => {
  try {
    const payload = await buildExportPayload();
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

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
    backupSettingsCache = null; // 导入合并可能改写 backup 段，失效自动备份配置缓存
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
 * 导出投递记录为 CSV（与「导出全部数据」同数据源：applications + apply_logs 全表）：
 *   1. 从本地后端拉取 /api/export 全量 JSON。
 *   2. 取 applications 数组生成带表头的 CSV（UTF-8 BOM，Excel 可直接打开做统计），
 *      每行追加 apply_logs 时间线列（该投递的『action | 时间 | 备注』，无日志留空），
 *      覆盖与 JSON 导出同源的投递追踪日志（投递→约面→offer 漏斗/时长分析）。
 *   3. 弹出「另存为」对话框写入用户选择的路径。
 * 返回 { canceled, ok, path?, error? }，与 exportData 同构。
 */
guardedHandle('export-data-csv', async (_event, filter) => {
  try {
    const payload = await fetchExportPayload();
    // 支持渲染进程透传的当前筛选（status + keyword + date_from/date_to 日期区间 + 旧版 date 单日）：
    // 原子全量拉取后仅导出筛选子集，与 GET /api/applications 的筛选口径一致
    // （keyword 匹配 job_title / company / city；日期匹配 func.date(applied_at) 区间）
    const {
      status: fStatus,
      keyword: fKeyword,
      date: fDate,
      date_from: fDateFrom,
      date_to: fDateTo,
    } = filter || {};
    const applications = (payload.applications || []).filter((a) => {
      if (fStatus && a?.status !== fStatus) return false;
      const kw = typeof fKeyword === 'string' ? fKeyword.trim().toLowerCase() : '';
      if (kw) {
        const haystack = [a?.job_title, a?.company, a?.city]
          .map((v) => (v == null ? '' : String(v)))
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      // 日期筛选（YYYY-MM-DD）：applied_at 由 /api/export 序列化为 'YYYY-MM-DD HH:MM:SS'，
      // 取其日期部分与区间起止（含当日）比对，旧版 date 单日下钻仍兼容；与后端 func.date(applied_at) 过滤同口径。
      // 仅当存在任一日期筛选时才惰性计算 appliedDay，避免无日期筛选时逐行无条件做字符串截取。
      const needDate = fDateFrom || fDateTo || fDate;
      if (needDate) {
        const appliedDay = String(a?.applied_at ?? '').slice(0, 10);
        if (fDateFrom && appliedDay < fDateFrom) return false;
        if (fDateTo && appliedDay > fDateTo) return false;
        if (fDate && appliedDay !== fDate) return false;
      }
      return true;
    });
    const csv = applicationsToCsv(applications, payload.apply_logs || []);

    const options = {
      title: '导出投递记录（CSV）',
      defaultPath: path.join(app.getPath('documents'), `bossjob-applications-${timestamp()}.csv`),
      filters: [{ name: 'CSV 表格文件', extensions: ['csv'] }],
    };
    const { canceled, filePath } = await saveDialog(options);
    if (canceled || !filePath) {
      return { canceled: true, ok: false };
    }
    await fs.promises.writeFile(filePath, csv, 'utf-8');
    return { canceled: false, ok: true, path: filePath };
  } catch (err) {
    return {
      canceled: false,
      ok: false,
      error: errMsg(err),
    };
  }
});

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

/**
 * 离线导出全部数据（JSON/CSV，export-data-offline IPC）：读最新一份自动备份的 app.db，
 * 序列化后弹「另存为」落盘。opts.format='csv' 时导出投递记录 CSV（复用 applicationsToCsv 同源口径）。
 * 返回 { canceled, ok, path?, backupName?, error? }（与 exportData 同构，backupName 供渲染层提示数据来源）。
 */
guardedHandle('export-data-offline', async (_event, opts) => {
  try {
    const offline = readLatestBackupExport();
    if (!offline) {
      return { canceled: false, ok: false, error: '没有可用的自动备份，无法离线导出（请先「立即备份」或等待自动备份）' };
    }
    const { payload, backupName } = offline;
    const isCsv = opts && opts.format === 'csv';
    // 离线降级导出也应用当前筛选（status/keyword/date），与在线 export-data-csv 同口径，
    // 避免用户拿到与筛选预期不符的全量备份记录。
    let applications = payload.applications || [];
    if (isCsv && opts && (opts.status || opts.keyword || opts.date || opts.date_from || opts.date_to)) {
      const fStatus = opts.status;
      const fKeyword = typeof opts.keyword === 'string' ? opts.keyword.trim().toLowerCase() : '';
      const fDate = opts.date;
      const fDateFrom = opts.date_from;
      const fDateTo = opts.date_to;
      applications = applications.filter((a) => {
        if (fStatus && a?.status !== fStatus) return false;
        if (fKeyword) {
          const haystack = [a?.job_title, a?.company, a?.city].map((v) => (v == null ? '' : String(v))).join(' ').toLowerCase();
          if (!haystack.includes(fKeyword)) return false;
        }
        const needDate = fDateFrom || fDateTo || fDate;
        if (needDate) {
          const appliedDay = String(a?.applied_at ?? '').slice(0, 10);
          if (fDateFrom && appliedDay < fDateFrom) return false;
          if (fDateTo && appliedDay > fDateTo) return false;
          if (fDate && appliedDay !== fDate) return false;
        }
        return true;
      });
    }
    const content = isCsv
      ? applicationsToCsv(applications, payload.apply_logs || [])
      : JSON.stringify(payload, null, 2);
    const options = isCsv
      ? {
          title: '导出投递记录（离线备份）',
          defaultPath: path.join(app.getPath('documents'), `bossjob-backup-${timestamp()}.csv`),
          filters: [{ name: 'CSV 表格文件', extensions: ['csv'] }],
        }
      : {
          title: '导出求职数据（离线备份）',
          defaultPath: path.join(app.getPath('documents'), `bossjob-backup-${timestamp()}.json`),
          filters: [{ name: 'JSON 数据文件', extensions: ['json'] }],
        };
    const { canceled, filePath } = await saveDialog(options);
    if (canceled || !filePath) {
      return { canceled: true, ok: false };
    }
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { canceled: false, ok: true, path: filePath, backupName };
  } catch (err) {
    return { canceled: false, ok: false, error: errMsg(err) };
  }
});

/**
 * 离线导出内容预览（preview-export-data-offline IPC，不落盘、不弹对话框）：
 * 读最新一份自动备份的 app.db，返回与 preview-export-data 同构的载荷 { applications, apply_logs }
 * （不含 settings/resume），供「数据」页错误态下「预览导出内容」/「投递日志」按钮降级使用。
 * 返回 { ok, payload?, backupName?, error? }。
 */
guardedHandle('preview-export-data-offline', async () => {
  try {
    const offline = readLatestBackupExport();
    if (!offline) {
      return { ok: false, error: '没有可用的自动备份，无法离线预览（请先「立即备份」或等待自动备份）' };
    }
    return { ok: true, payload: offline.payload, backupName: offline.backupName };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

/**
 * 预览导入数据（import-data 的前置确认步，与 preview-export-data 的「先预览后执行」对称）：
 *   1. 弹出「打开文件」对话框（filter: json），选择由 export-data 导出的 JSON 文件。
 *   2. 解析并校验载荷（与 import-data 同口径：顶层对象且 applications 为数组 + 文件大小/行数上限）。
 *   3. 计算预览：applications / apply_logs 计数 + settings 段存在性 + 即将覆盖的 id 数
 *      （经轻量端点 GET /api/applications/ids 取当前库内 applications 的 id 集合求交；
 *       后端不可达时按 0 计，不阻塞预览）。
 *   4. 不落库、不 POST，仅返回预览供渲染层弹确认框；确认后才调用 import-data(path) 真正导入。
 * 返回 { canceled, ok, path?, preview?: { applications, applyLogs, hasSettings, overwriteIds }, error? }。
 */
guardedHandle('preview-import-data', async (_event) => {
  try {
    // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：熔断态直接拒绝预览，
    // 避免直连后端统计覆盖数，使「已停止与后端交互」的声明与实际行为一致。
    if (backendAuthFailure) {
      return { canceled: false, ok: false, error: '后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）' };
    }
    const { canceled, filePaths } = await openDialog(IMPORT_JSON_DIALOG_OPTIONS);
    const filePath = filePaths && filePaths[0];
    if (canceled || !filePath) {
      return { canceled: true, ok: false };
    }
    let importStat;
    try {
      importStat = await fs.promises.stat(filePath);
    } catch (err) {
      return { canceled: false, ok: false, error: `无法读取所选 JSON 文件：${errMsg(err)}` };
    }
    if (importStat.size > MAX_IMPORT_FILE_BYTES) {
      return { canceled: false, ok: false, error: '所选 JSON 文件过大（超过 200MB），已拒绝导入' };
    }
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    } catch (err) {
      return { canceled: false, ok: false, error: `无法解析所选 JSON 文件：${errMsg(err)}` };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.applications)) {
      return { canceled: false, ok: false, error: '所选文件不是有效的导出数据（需含 applications 数组）' };
    }
    if (payload.applications.length > MAX_IMPORT_APPLICATIONS) {
      return { canceled: false, ok: false, error: '导入数据行数超过上限（50 万条），已拒绝导入' };
    }
    // 即将覆盖的 id 数：经轻量端点 GET /api/applications/ids 取当前库内 applications 的 id 集合，
    // 与导入文件 id 求交 —— 不再为统计 id 拉取整份 /api/export（上限 200MB）。
    // 后端不可达 / 接口失败时不阻塞预览（overwriteIds 按 0 计），由 import-data 真正落库时兜底判定。
    let existingIds = new Set();
    try {
      existingIds = await fetchExistingIds();
    } catch (_err) {
      /* 后端暂不可达：覆盖数未知，按 0 展示，不阻断预览确认 */
    }
    // id 归一：后端 ImportItem.id 会把数字字符串（如 "5"）强制转 int 并覆盖，预览统计须同口径，
    // 否则弹窗会误报「全部为新增」而实际发生了覆盖（数字字符串 id 不纳入则掩盖覆盖风险）
    const overwriteIds = payload.applications.filter((app) => {
      if (!app || typeof app !== 'object') return false;
      const n = Number((app).id);
      return Number.isInteger(n) && n > 0 && existingIds.has(n);
    }).length;
    // 登记信任路径：仅对同一 webContents 随后发起的 import-data(confirmedPath) 放行，且路径必须与
    // 对话框所选一致 —— 渲染层后续导入不再重复弹框，但必须证明该路径来自本次用户确认（防注入脚本读任意文件）。
    const trusted = trustedImportPaths.get(_event.sender.id) || new Set();
    const resolvedPath = path.resolve(filePath);
    trusted.add(resolvedPath);
    trustedImportPaths.set(_event.sender.id, trusted);
    // 安全 TTL：即使渲染层随后取消「导入前确认」弹窗，该信任路径 10min 后自动失效，
    // 避免信任路径保留至 webContents 销毁期间被同主世界 XSS 获知后绕过二次确认直接调用 importData。
    // 60s 太短：用户阅读「确认导入」弹窗 + 思考期间即过期，确认后 importData(preview.path)
    // 会报「导入路径未经过预览确认」形成交互死路；10min 覆盖正常确认时长同时保留兜底回收。
    setTimeout(() => {
      const cur = trustedImportPaths.get(_event.sender.id);
      if (cur) { cur.delete(resolvedPath); if (cur.size === 0) trustedImportPaths.delete(_event.sender.id); }
    }, 600000);
    return {
      canceled: false,
      ok: true,
      path: filePath,
      preview: {
        applications: payload.applications.length,
        applyLogs: Array.isArray(payload.apply_logs) ? payload.apply_logs.length : 0,
        hasSettings: isPlainObject(payload.settings),
        overwriteIds,
      },
    };
  } catch (err) {
    return { canceled: false, ok: false, error: errMsg(err) };
  }
});

/**
 * 导入全部数据（与「导出数据」成对，闭合导出→恢复回路）：
 *   1. 弹出「打开文件」对话框（filter: json），选择由 export-data 导出的 JSON 文件；
 *      若调用方传入已确认的文件路径（来自 preview-import-data 返回的 path），则跳过对话框直接使用。
 *   2. 解析并校验载荷：顶层对象且 applications 为数组（对齐 export-data 的校验，见上方 export-data handler）。
 *   3. 原样 POST 到本地后端 /api/import（后端按 id 覆盖已有、新建缺失，apply_logs 一并落库恢复追溯）。
 *   4. 成功后推送 backend-ready，供渲染进程刷新数据列表。
 * 返回 { canceled, ok, path?, importedCount, skippedCount, updatedCount, error? }，供渲染进程提示结果。
 */
guardedHandle('import-data', async (_event, confirmedPath) => {
  try {
    const senderId = _event.sender.id;
    let filePath = typeof confirmedPath === 'string' && confirmedPath.trim() !== '' ? confirmedPath : null;
    let canceled = false;
    if (filePath) {
      // local-file-read 修复：仅接受 preview-import-data 刚登记到该 webContents 信任集合的路径，
      // 并做 path.resolve 归一化比对（防相对路径 / 路径逃逸绕过）；不在集合内一律拒绝，强制回走预览确认。
      const trusted = trustedImportPaths.get(senderId);
      const resolved = path.resolve(filePath);
      if (!trusted || !trusted.has(resolved)) {
        return { canceled: false, ok: false, error: '导入路径未经过预览确认，请先选择文件并确认后重试' };
      }
      // 信任路径不在开头消费：改为成功导入后才删除（见下方 ok:true 分支前）——
      // 若在开头删除，导入因文件过大/解析失败/后端暂不可用等瞬态原因失败后重试会报
      // 「路径未经过预览确认」形成死路；延迟到成功保留 anti-replay（成功后仍一次性失效）。
      filePath = resolved;
    } else {
      const dialogResult = await openDialog(IMPORT_JSON_DIALOG_OPTIONS);
      canceled = dialogResult.canceled;
      filePath = dialogResult.filePaths && dialogResult.filePaths[0];
    }
    if (canceled || !filePath) {
      return { canceled: true, ok: false };
    }

    // resource-exhaustion 修复：readFile + JSON.parse 前先 stat，超过上限（200MB）直接拒绝，
    // 避免恶意/异常超大 JSON 一次性读入内存占满堆（含深嵌套对象）
    let importStat;
    try {
      importStat = await fs.promises.stat(filePath);
    } catch (err) {
      return { canceled: false, ok: false, error: `无法读取所选 JSON 文件：${errMsg(err)}` };
    }
    if (importStat.size > MAX_IMPORT_FILE_BYTES) {
      return { canceled: false, ok: false, error: '所选 JSON 文件过大（超过 200MB），已拒绝导入' };
    }

    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    } catch (err) {
      return {
        canceled: false,
        ok: false,
        error: `无法解析所选 JSON 文件：${errMsg(err)}`,
      };
    }
    // 与 export-data 相同的结构校验：顶层对象且 applications 为数组，拒绝任意 JSON 混入
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.applications)) {
      return { canceled: false, ok: false, error: '所选文件不是有效的导出数据（需含 applications 数组）' };
    }
    // resource-exhaustion 修复：applications 行数上限（500k），防超大数组整份序列化 / POST 耗尽内存
    if (payload.applications.length > MAX_IMPORT_APPLICATIONS) {
      return { canceled: false, ok: false, error: '导入数据行数超过上限（50 万条），已拒绝导入' };
    }

    // state-not-reset 修复：settings 合并块已延后到 /api/import POST 成功（statusCode===200）之后执行
    // （见下方 success 分支），避免导入接口失败时 settings.json 已被改写而投递记录未落库（配置被静默变更）。

    const url = `http://127.0.0.1:${backendPort}/api/import`;
    // resource-exhaustion 修复：序列化后 POST 请求体设上限（200MB），防深嵌套/超大对象
    // JSON.stringify 出巨量内存；超过上限直接拒绝（主进程直连后端，绕过了 50KB 代理上限，须自行兜底）
    const importBody = JSON.stringify(payload);
    if (Buffer.byteLength(importBody, 'utf-8') > MAX_IMPORT_POST_BODY_BYTES) {
      return { canceled: false, ok: false, error: '导入数据序列化后体积超过上限，已拒绝导入' };
    }
    // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：主进程直连 POST /api/import 前检查熔断标志，
    // 熔断态拒绝把导入数据写入后端（后端可能处于「本地任意进程可无令牌调用」的危险状态），
    // 使「已停止与后端交互」的声明与实际行为一致（此路径绕过代理通道，须自行兜底）。
    if (backendAuthFailure) {
      return { canceled: false, ok: false, error: '后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）' };
    }
    const resp = await httpPostText(url, importBody, EXPORT_REQUEST_TIMEOUT_MS);
    if (resp.statusCode !== 200) {
      let detail = '';
      try {
        detail = JSON.parse(resp.body).detail;
      } catch (_err) {
        /* ignore */
      }
      return {
        canceled: false,
        ok: false,
        error: `导入接口返回 HTTP ${resp.statusCode}${detail ? `：${detail}` : ''}`,
      };
    }
    notifyBackendReady();

    // 可选携带脱敏后的 settings（export-data 已剥离 llm.api_key / llm.base_url）：
    // 存在且可解析为合法对象时合并写入当前 settings.json，闭合「仅迁移配置」的跨机器需求；
    // 合并以当前配置为基底，保留 llm.api_key（DPAPI 密文）与 llm.base_url（见 mergeImportedSettings）。
    // state-not-reset 修复：此块原在 POST 之前执行，若导入失败则 settings.json 已被改写而数据未落库；
    // 现将合并延后到 POST 成功之后，仅在数据导入确认成功时变更配置（refresh/sync 亦只在 success 路径触发）。
    let settingsStatus = SETTINGS_STATUS.MISSING; // 载荷无 settings 段：仅导入投递记录，保留当前配置
    // 防御：仅对「可解析的普通对象」settings 执行合并 —— null/字符串/数字/数组等异常载荷
    // 若直接进 mergeImportedSettings 会让 Object.entries(null) 抛错、中止整个导入（含 applications），
    // 或把字符串/数组下标写成 settings.json 的顶层杂键，故一律视为缺失、不合并、保留当前配置。
    if (isPlainObject(payload.settings)) {
      settingsStatus = mergeImportedSettings(payload.settings);
      if (settingsStatus === SETTINGS_STATUS.RESTORED || settingsStatus === SETTINGS_STATUS.RETAINED_CREDENTIALS_STRIPPED) {
        // settings.json 已热更新：同步刷新外部链接宿主白名单缓存，避免继续使用导入前的旧配置
        refreshExternalHostAllowlistCache();
        // settings.json 已合并（intervalMinutes / autoBackupEnabled 可能变化）：同步定时备份计时器，
        // 使周期/开关与导入后的配置一致，避免运行中的旧定时器继续沿用导入前的陈旧状态（与 restore-data 一致）
        syncBackupInterval();
        // 端口变更同步（state-consistency）：合并后 settings.json 的 port 可能已变化，而运行中的后端
        // 仍监听旧端口（get-backend-port / get-bootstrap-info 仍返回旧值），配置与进程端口漂移直到下次
        // 重启才对齐。与 restoreBackupDir 恢复 settings 后的口径一致：重新解析端口，若与当前 backendPort
        // 不一致则停旧后端 → 以新端口启动 → 周期复查兜底推送 backend-ready（不阻塞导入成功返回）。
        const newPort = resolveBackendPort();
        if (newPort !== backendPort) {
          backendPort = newPort;
          // 与 restoreBackupDir 同一口径：stopBackendForRestore 会把 isShuttingDown 置 true，
          // 须在调用前快照退出状态，避免应用退出期间误复位标志并复活出孤儿后端进程占用新端口
          // （与下次启动冲突）。
          const quittingBeforeRestore = isShuttingDown;
          await stopBackendForRestore();
          // stopBackendForRestore 置位了 isShuttingDown / backendStoppedForRestore：复位后方可让
          // startBackend 真正以新端口拉起后端（与 restoreBackupDir finally 的复位一致）；
          // 但若应用已在退出（quittingBeforeRestore 快照为真）则不得复活后端，否则退出期间
          // spawn 出孤儿进程占用端口，与下次启动冲突。
          backendStoppedForRestore = false;
          backendRestartCount = 0;
          if (!quittingBeforeRestore) {
            isShuttingDown = false;
            startBackend();
            waitBackendReadyOrRetry();
          }
          console.log(`[electron] 已从导入数据合并 settings.json 后后端端口更新为 ${backendPort}（已重启后端）`);
        }
        console.log(`[electron] 已从导入数据合并 settings.json（settingsStatus=${settingsStatus}）`);
      }
    }

    // 简历快照（export-data 并入的 resume 段）：导入成功时与投递记录一起还原，
    // 经 writeRendererResume 双写数据目录 resume.json（权威磁盘副本），闭合「导出→换机→导入」的简历迁移闭环。
    // resumeStatus 如实汇报：'restored'=已双写落盘 / 'missing'=载荷无 resume 段 / 'write_failed'=落盘失败（不阻塞导入）。
    let resumeStatus = 'missing';
    if (isPlainObject(payload.resume)) {
      try {
        // writeRendererResume 失败时返回 false 而非抛错（见函数内 try/catch），
        // 因此必须检查返回值判断落盘结果；仅依赖 catch 会把实际写入失败误报为 'restored'。
        const resumeOk = await writeRendererResume(JSON.stringify(payload.resume));
        resumeStatus = resumeOk ? 'restored' : 'write_failed';
      } catch (_err) {
        // 写回异常（罕见：窗口销毁竞态等）同样视为失败，不阻塞导入：投递记录已落库，仅简历缺失
        resumeStatus = 'write_failed';
      }
    }
    // 解析后端逐条结果（imported=处理总数 / updated=覆盖更新数 / skipped=跳过数），
    // 供渲染层展示「新增 N 条 / 更新 M 条 / 跳过 K 条」
    let respCounts = {};
    try {
      respCounts = JSON.parse(resp.body);
    } catch (_err) {
      /* ignore */
    }
    const processedTotal = typeof respCounts.imported === 'number' ? respCounts.imported : payload.applications.length;
    // 先声明 updatedCount/skippedCount 再算 createdCount：created 的回退表达式依赖两者，
    // 若后者在前者之后声明会触发 TDZ ReferenceError（Round 10 自引入回归），导致已落库的导入被误报失败
    const updatedCount = typeof respCounts.updated === 'number' ? respCounts.updated : 0;
    const skippedCount = typeof respCounts.skipped === 'number' ? respCounts.skipped : 0;
    // created 为后端逐行统计的新增数（Round 10 起后端返回 created/updated 分离）。
    // 旧后端回退公式与前端 importApplications 完全一致：imported = created + updated
    // （后端 imported 已排除 skipped，见 data.py「imported += 1」只对处理行累加），
    // 故 created = imported - updated，不再额外减 skipped（Round 13 修正，避免少算）。
    const createdCount = typeof respCounts.created === 'number'
      ? respCounts.created
      : Math.max(0, processedTotal - updatedCount);
    // 成功导入后一次性消费信任路径（anti-replay）：保留 10min TTL 兜底；失败路径不删除，
    // 用户可重试（瞬态失败不再死路）。
    // 用 filePath 而非 resolved：resolved 是上面 if(filePath) 块内的块级 const，此处越界
    // （Round 17 引入的 ReferenceError 回归，每次成功导入都报失败）；filePath 在 confirmedPath
    // 分支已被重赋值为 resolved，是到达本行时的唯一路径来源。
    if (typeof confirmedPath === 'string' && confirmedPath.trim() !== '') {
      const trusted = trustedImportPaths.get(senderId);
      if (trusted) {
        trusted.delete(filePath);
        if (trusted.size === 0) trustedImportPaths.delete(senderId);
      }
    }
    return {
      canceled: false,
      ok: true,
      path: filePath,
      importedCount: createdCount,
      updatedCount,
      skippedCount,
      settingsStatus,
      resumeStatus,
    };
  } catch (err) {
    return {
      canceled: false,
      ok: false,
      error: errMsg(err),
    };
  }
});

// ---------------------------------------------------------------------------
// 数据备份：app.db + settings.json 快照（手动/自动/轮转）
// ---------------------------------------------------------------------------

/**
 * 数据目录（与 backend/app/constants.py 对齐）：
 *   - 打包模式：%APPDATA%/BossJobAI/backend/data（后端 frozen 分支写入同一位置）。
 *   - 开发模式：<code>/backend/data。
 */
function getDataDir() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'backend', 'data')
    : path.join(PROJECT_ROOT, 'backend', 'data');
}

/** 自动备份目录：打包模式 %APPDATA%/BossJobAI/backups；开发模式 <code>/.backups。 */
function getBackupDir() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'backups')
    : path.join(PROJECT_ROOT, '.backups');
}

/** 自动备份保留份数默认值（可在「数据」页经 updateBackupSettings 修改）：超出后按创建时间轮转删除最旧备份。 */
const DEFAULT_MAX_AUTO_BACKUPS = 7;
/** 分钟 → 毫秒换算常量（60 s/min × 1000 ms/s），供 syncBackupInterval 计算 setInterval 周期。 */
const MS_PER_MINUTE = 60 * 1000;
/** sha256OfFile 流式读缓冲大小（64 KiB = 64 * 1024），单次 fs.readSync 最大读入字节数。 */
const HASH_READ_BUFFER_BYTES = 64 * 1024;
/** preview-backup 样本记录上限：仅展示最新 10 条投递记录供恢复前确认。 */
const PREVIEW_SAMPLE_LIMIT = 10;

/** 定时自动备份的 interval 句柄（模块级），由 syncBackupInterval() 统一启停。 */
let backupIntervalTimer = null;

/** 自动备份配置的内存缓存：避免启动/定时备份路径上对 settings.json 反复同步 readFileSync+JSON.parse。
 *  getBackupSettings() 命中缓存直接返回；任何写 settings.json backup 段（saveBackupSettings / 导入合并 / 恢复）后失效，
 *  或 settings.json 被外部改写（mtime 变化，如 Settings 页 PUT /api/settings 写入 backup 段）时按 mtime 检测失效。 */
let backupSettingsCache = null;

/** 最近一次读 backup 段时 settings.json 的 mtimeMs：getBackupSettings() 经它判断文件是否被外部改写，
 *  未变则命中缓存直接返回（复用 maybeRefreshExternalHostAllowlist 的 mtime 失效语义），避免每次定时备份检查同步读盘 + JSON.parse。 */
let lastBackupSettingsMtime = null;

/**
 * 读取自动备份配置（settings.json 的 backup 段，数据页「备份设置」入口读写）：
 * - maxBackups：保留份数上限（1~60 整数，默认 7）；
 * - autoBackupEnabled：是否启用定时自动备份（布尔，默认 true）；
 * - intervalMinutes：定时备份间隔分钟数（1~1440 整数；null 表示未配置定时）。
 * 读取失败 / 字段缺失 / 取值非法时逐项回退默认值，不抛错。
 */
function getBackupSettings() {
  if (backupSettingsCache) {
    // settings.json mtime 未变化 → 缓存仍有效直接返回；外部写入（如 Settings 页 PUT /api/settings 含 backup 段）
    // 会改变文件 mtime，此时失效缓存重新读盘，杜绝陈旧 maxBackups/intervalMinutes 持续到重启。
    const currentMtime = getSettingsMtime();
    if (currentMtime === lastBackupSettingsMtime) {
      return backupSettingsCache;
    }
    backupSettingsCache = null;
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
  backupSettingsCache = settings;
  lastBackupSettingsMtime = getSettingsMtime();
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
    backupSettingsCache = null; // 磁盘 backup 段已更新，强制下次 getBackupSettings() 重新读盘解析
    return { settings: getBackupSettings(), writeOk: true };
  }
  // 写入失败：以本次会话内存中的 backup 段（含本次 patch）回填缓存，保证 update-backup-settings
  // 返回给渲染层及后续 getBackupSettings() 一致（下次启动仍以磁盘旧配置为准回退）。
  backupSettingsCache = {
    maxBackups: Number.isInteger(backup.maxBackups) && backup.maxBackups >= 1 && backup.maxBackups <= 60
      ? backup.maxBackups
      : DEFAULT_MAX_AUTO_BACKUPS,
    autoBackupEnabled: typeof backup.autoBackupEnabled === 'boolean' ? backup.autoBackupEnabled : true,
    intervalMinutes: Number.isInteger(backup.intervalMinutes) && backup.intervalMinutes >= 1 && backup.intervalMinutes <= 1440
      ? backup.intervalMinutes
      : null,
  };
  return { settings: backupSettingsCache, writeOk: false };
}

/**
 * 按 settings.json 的自动备份配置启停「定时自动备份」：
 * - autoBackupEnabled=true 且 intervalMinutes 为正整数 → 以该分钟数为周期执行 autoBackup()；
 * - 否则清除已有定时器。启动时/破坏性操作前的一次性备份不受开关影响（安全兜底）。
 */
function syncBackupInterval() {
  if (backupIntervalTimer) {
    clearInterval(backupIntervalTimer);
    backupIntervalTimer = null;
  }
  const { autoBackupEnabled, intervalMinutes } = getBackupSettings();
  if (autoBackupEnabled && Number.isInteger(intervalMinutes) && intervalMinutes >= 1) {
    backupIntervalTimer = setInterval(() => void autoBackup(), intervalMinutes * MS_PER_MINUTE);
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

/**
 * 手动备份全部数据：
 *   1. 弹出「打开目录」对话框（openDirectory + createDirectory），让用户选择父目录。
 *   2. 程序在所选父目录下创建 BossJobAI-backup-YYYYMMDD-HHmm-<随机后缀> 子目录并快照 app.db + settings.json + 简历快照 resume.json。
 * 采用「选父目录 + 自动建子目录」而非 showSaveDialog 返回文件名后 mkdirSync 同名目录：
 * 避免用户输入 .json 后缀或选中已存在文件名时 mkdirSync 抛 EEXIST，以及「保存文件」对话框却静默建文件夹的交互错位。
 * 返回 { canceled, ok, path?, error? }，供渲染进程提示结果。
 */
guardedHandle('backup-data', async () => {
  try {
    const options = {
      title: '备份求职数据',
      buttonLabel: '选择此文件夹',
      message:
        '请选择备份的存放位置。程序会在该位置创建 BossJobAI-backup-<时间戳> 子目录，内含 app.db、settings.json 与简历快照（resume.json）。',
      defaultPath: path.join(app.getPath('documents')),
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } = await openDialog(options);
    const parent = filePaths && filePaths[0];
    if (canceled || !parent) {
      return { canceled: true, ok: false };
    }
    const dir = snapshotToDir(path.join(parent, newBackupName()));
    // 简历快照：简历仅存渲染层 localStorage，随「手动备份全部数据」一并写入 resume.json（restore-data 时还原）
    await writeResumeSnapshotTo(dir);
    return { canceled: false, ok: true, path: dir };
  } catch (err) {
    return {
      canceled: false,
      ok: false,
      error: errMsg(err),
    };
  }
});

/**
 * 立即备份全部数据（应用内可见）：不走文件夹选择器，复用自动备份的落盘逻辑
 * （写入自动备份目录、同名 BossJobAI-backup-<时间戳>、同样执行 rotateAutoBackups 保留上限裁剪），
 * 快照立即出现在 listBackups() 列表并被 maxBackups 保留策略管理。
 * 返回 { ok, name, path?, error? }，供渲染进程在破坏性操作前快速落一份「应用可见」快照。
 */
guardedHandle('backup-now', async () => {
  try {
    const name = newBackupName();
    const dir = await snapshotAutoBackup(path.join(getBackupDir(), name));
    console.log(`[electron] 立即备份完成 → ${dir}`);
    return { ok: true, name, path: dir };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

// ---------------------------------------------------------------------------
// 打开自动备份目录：在系统文件管理器中打开备份目录（目录不存在则先创建）。
// 返回 { ok: boolean, error?: string }。
// ---------------------------------------------------------------------------
guardedHandle('open-backup-dir', async () => {
  try {
    const dir = getBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

// ---------------------------------------------------------------------------
// 便携备份归档：单文件 .zip 导出 / 导入（export-backup-archive / import-backup-archive）
// 为纯产品经理型用户提供「一键打包为单一 .zip」的跨机器 / 移动介质迁移形态：
// 备份不再是只能整目录拷贝的文件夹，而是可归档 / 解压的单文件。
// 用 Node 内置 zlib 实现最小 ZIP(DEFLATE) 读写，不引入第三方依赖（打包体积 / 供应链零新增）。
// ---------------------------------------------------------------------------

const zlib = require('zlib');

/** zip 解析防护上限（resource-exhaustion 修复）：单条目解压后体积上限（256MB）与压缩后体积上限，
 * 在 inflate 前校验，防中央目录声明超大 uncompSize 对 tiny DEFLATE 载荷 inflate 出巨量内存。 */
const MAX_ZIP_ENTRY_UNCOMP_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRY_COMP_BYTES = 256 * 1024 * 1024;
/** zip 累计解压体积全局上限（512MB）：追踪所有条目解压字节之和，防 zip 炸弹累计耗尽内存。 */
const MAX_ZIP_TOTAL_UNCOMP_BYTES = 512 * 1024 * 1024;
/** 导入归档 .zip 文件本身的大小上限（64MB）：stat 通过后才 readFileSync，防一次性读入超大文件占满内存。 */
const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024;

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

guardedHandle('export-backup-archive', async (_event, opts = {}) => {
  try {
    let dir = typeof opts.dir === 'string' && opts.dir.trim() ? opts.dir.trim() : null;
    if (dir) {
      // 反符号链接 / junction 穿透：词法 startsWith + realpath 双重校验（见 isPathInsideBackupDir），
      // 越界（或无法解析的外部目标）一律拒绝导出，防止从链接目标读取数据并打包进归档。
      if (!isPathInsideBackupDir(dir)) {
        return { canceled: false, ok: false, error: '备份路径越界，已拒绝导出' };
      }
    } else {
      let entries;
      try {
        entries = fs.readdirSync(getBackupDir(), { withFileTypes: true });
      } catch {
        entries = [];
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_DIR_PREFIX))
        .sort((a, b) => backupSortKey(b.name).localeCompare(backupSortKey(a.name)));
      if (dirs.length === 0) {
        return { canceled: false, ok: false, error: '自动备份目录为空，请先执行一次备份' };
      }
      dir = path.join(getBackupDir(), dirs[0].name);
    }
    if (!fs.existsSync(path.join(dir, 'app.db'))) {
      return { canceled: false, ok: false, error: '所选备份不是有效备份：缺少 app.db' };
    }
    // 四件套打包：app.db（含 WAL 副文件）+ settings.json + resume.json + manifest.json，存在即打包
    const files = [];
    for (const name of ['app.db', ...SQLITE_WAL_SUFFIXES.map((s) => 'app.db' + s), 'settings.json', 'resume.json', 'manifest.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        files.push({ name, data: fs.readFileSync(p) });
      }
    }
    const zipBuf = buildZipBuffer(files);
    const defaultName = `${BACKUP_DIR_PREFIX}${timestamp()}.zip`;
    const { canceled, filePath } = await saveDialog({
      title: '导出备份归档（.zip）',
      buttonLabel: '导出',
      message: '将把所选备份打包为单一 .zip 归档（含投递记录 app.db、配置、简历快照与校验清单），便于跨机器 / 移动介质迁移。',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'ZIP 备份归档', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { canceled: true, ok: false };
    fs.writeFileSync(filePath, zipBuf);
    console.log(`[electron] 备份归档已导出 → ${filePath}（${files.map((f) => f.name).join('、')}）`);
    return { canceled: false, ok: true, path: filePath, name: path.basename(dir) };
  } catch (err) {
    return { canceled: false, ok: false, error: errMsg(err) };
  }
});

/**
 * 导入便携备份归档：选择 export-backup-archive 生成的 .zip，解压到临时目录后
 * 先落到自动备份目录成为应用可见备份，再复用 restoreBackupDir（与 restore-data 同一口径的
 * schema 版本 + PRAGMA integrity_check + manifest 校验和 + 覆盖写 + 重启后端链路）落库。
 * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, importedBackupName?, error? }。
 */
guardedHandle('import-backup-archive', async () => {
  let tmpDir = null;
  try {
    const { canceled, filePaths } = await openDialog({
      title: '导入备份归档（.zip）',
      buttonLabel: '选择备份归档',
      message: '请选择由「导出备份归档」生成的 .zip 文件（内含 app.db、settings.json、简历快照与 manifest）。',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 备份归档', extensions: ['zip'] }],
    });
    const zipPath = filePaths && filePaths[0];
    if (canceled || !zipPath) return { canceled: true, ok: false };
    // resource-exhaustion 修复：readFileSync 前先 stat，归档文件超过上限（64MB）直接拒绝，
    // 避免恶意/异常超大 .zip 一次性读入内存占满堆
    let zipStat;
    try {
      zipStat = fs.statSync(zipPath);
    } catch (err) {
      return { canceled: false, ok: false, error: `无法读取所选归档文件：${errMsg(err)}` };
    }
    if (zipStat.size > MAX_ZIP_ARCHIVE_BYTES) {
      return { canceled: false, ok: false, error: '所选归档文件过大（超过 64MB），已拒绝导入' };
    }
    const entries = parseZipBuffer(fs.readFileSync(zipPath));
    // 兼容「应用内导出（扁平四件套）」与「手工把备份文件夹整体压缩」两种形态：按最末路径段识别 app.db
    if (!entries.some((e) => e.name.split('/').pop() === 'app.db')) {
      return { canceled: false, ok: false, error: '所选 zip 不是有效备份归档：缺少 app.db' };
    }
    tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'bossjob-import-'));
    for (const e of entries) {
      // 扁平落盘：zip 内条目取最末路径段，仅认备份四件套（parseZipBuffer 已拦截 .. / 反斜杠等路径穿越）
      const base = e.name.includes('/') ? e.name.slice(e.name.lastIndexOf('/') + 1) : e.name;
      if (!(base === 'app.db' || /^app\.db-(wal|shm)$/.test(base) || /^(settings|resume|manifest)\.json$/.test(base))) {
        continue;
      }
      fs.writeFileSync(path.join(tmpDir, base), e.data);
    }
    // 落到自动备份目录成为应用可见备份（同时规避 restore 路径穿越防护），再走 restoreBackupDir 完整恢复链路
    const importedName = newBackupName();
    const importedDir = path.join(getBackupDir(), importedName);
    assertSafeMkdirTarget(importedDir, '目标备份目录为链接或非目录，已拒绝导入');
    fs.mkdirSync(importedDir, { recursive: true });
    for (const f of fs.readdirSync(tmpDir)) {
      fs.copyFileSync(path.join(tmpDir, f), path.join(importedDir, f));
    }
    const result = await restoreBackupDir(importedDir, true);
    return { ...result, importedBackupName: importedName };
  } catch (err) {
    return { canceled: false, ok: false, error: errMsg(err) };
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响结果 */
      }
    }
  }
});

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
  if (backendAuthFailure) {
    return { canceled: false, ok: false, error: '后端鉴权异常，已停止交互（见鉴权 FAIL-OPEN 提示）' };
  }
  // 快照进入恢复流程时的退出状态：若应用此刻已在退出（before-quit 的 stopBackend 已置
  // isShuttingDown=true 并清空 backendProc），则恢复完成后不得再 startBackend() 复活后端 ——
  // 否则会在退出期间 spawn 出孤儿后端进程占用端口，与下次启动冲突。
  // 该快照必须在本函数置位 isShuttingDown 之前捕获：stopBackendForRestore 自身（恢复引起的
  // 停服）也会把 isShuttingDown 置 true，无法用它区分「恢复引起的停服」与「应用退出」。
  const quittingBeforeRestore = isShuttingDown;
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
        backendPort = resolveBackendPort();
        // settings.json 已热更新：同步刷新外部链接宿主白名单缓存，避免继续使用恢复前的旧配置
        refreshExternalHostAllowlistCache();
        // settings.json 已被 restoreSettingsSafely 重写（backup 段已继承写回），立即同步定时备份
        // 计时器，使周期/开关与恢复后的配置一致，避免运行中的旧定时器继续沿用陈旧状态
        syncBackupInterval();
        console.log(`[electron] 已从备份恢复 settings.json（settingsStatus=${settingsStatus}），后端端口更新为 ${backendPort}`);
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
    backendStoppedForRestore = false;
    backendRestartCount = 0;
    if (!quittingBeforeRestore) {
      isShuttingDown = false;
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

/** SQLite user_version（schema 版本），与 backend/app/db.py 的 DB_SCHEMA_VERSION 对齐，改版须同步。
 *  v2: applications.applied_at 可空（清空投递时间=未设置）。
 *  v3: applications.applied_at 建索引（日期过滤/趋势/排序 datetime 区间比较走索引）。 */
const DB_SCHEMA_VERSION = 3;

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
 * 停止后端并等待其完全退出（kill 为异步，须等 exit 事件后再覆盖 app.db，
 * 避免 SQLite 文件句柄/锁冲突）。结束时把 isShuttingDown 置真防止退出处理器自动重启，
 * 恢复完成后由调用方复位并手动重启。
 */
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

function stopBackendForRestore() {
  if (!backendProc) {
    // 后端已不在运行（如崩溃退出处理器正处于指数退避 sleep 中）：仍须标记停服，
    // 否则退避到期后的延迟重启会在 restore 覆盖 app.db 期间拉起新进程抢占 SQLite 锁。
    // 注意：不复位 isShuttingDown —— 若应用正在退出（before-quit 的 stopBackend 已置
    // isShuttingDown=true 并清空 backendProc），此处保留该标志，避免 restore 的 finally
    // 在退出期间 startBackend() 复活后端 spawn 出孤儿进程占用端口、与下次启动冲突。
    // 是否重启后端由 restoreBackupDir 的 finally 依据 quittingBeforeRestore 快照决定。
    backendStoppedForRestore = true;
    return Promise.resolve();
  }
  const proc = backendProc;
  isShuttingDown = true;
  backendStoppedForRestore = true;
  return new Promise((resolve) => {
    // 统一结算守卫：超时强杀分支与正常 exit 分支都可能走到 resolve，确保只结算一次
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[electron] 等待后端退出超时，尝试强制结束（可能仍有数据库句柄未释放）。');
      try {
        proc.kill('SIGKILL');
      } catch (_err) {
        // 进程可能已退出
      }
      // 显式清空句柄：否则 restore-data 随后 startBackend() 因 `if (backendProc || isShuttingDown)` 提前返回，
      // 后端不会被立即重启，紧跟的 waitForBackendHealth 会因端口未恢复而白等后误报 ok:true
      backendProc = null;
      // SIGKILL 后不立即 resolve：Windows 上被强杀的 SQLite 进程仍可能短暂持有 app.db 文件句柄，
      // 必须等 exit 事件（进程真实退出、句柄释放）后再 resolve，否则随后的
      // fs.copyFileSync(app.db) 会抛 EBUSY/EPERM，导致恢复误报失败。
      // 另设 2s 宽限期兜底，防 exit 事件缺失时 Promise 永不 settle。
      const grace = setTimeout(settle, KILL_EXIT_GRACE_MS);
      if (proc.exitCode !== null) {
        // 进程此前已退出（exit 事件不会再触发），无需等待
        clearTimeout(grace);
        settle();
      } else {
        proc.once('exit', () => {
          clearTimeout(grace);
          settle();
        });
      }
    }, STOP_BACKEND_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      settle();
    });
    try {
      proc.kill();
    } catch (err) {
      // 子进程已自行退出（exit 事件已入队但尚未处理）：kill 抛 ESRCH。
      // 视同已退出并立即结算，保证 stopBackendForRestore 永不 reject，
      // 否则 restore-data 的 await 被拒会令 isShuttingDown/backendStoppedForRestore 永久卡 true。
      // 显式清空句柄（与超时强杀分支保持一致）：否则 restore finally 中的 startBackend()
      // 因 `if (backendProc || isShuttingDown || backendStoppedForRestore)` 看到残留的
      // 已退出进程句柄而提前返回，后端无法立即重启。
      backendProc = null;
      clearTimeout(timer);
      settle();
      return;
    }
  });
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
    backupSettingsCache = null; // 恢复整体覆写 settings.json，失效自动备份配置缓存
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

guardedHandle('restore-data', async (_event, opts = {}) => {
  try {
    // includeSettings=false 时仅恢复 app.db（投递记录），保留当前 settings.json（含 LLM 配置）；
    // 缺省/true 时恢复 settings.json：备份内容视为不可信输入，仅按白名单恢复校验通过的 port
    // 与非敏感 llm 键（provider/model/temperature 等，api_key/base_url 剥离），
    // security.external_url_hosts 与全部未知键一律丢弃（见 restoreSettingsSafely）。
    const includeSettings = opts.includeSettings !== false;
    // 支持 opts.dir 直接指定备份目录（应用内备份列表「恢复」按钮走此路径，免去系统目录选择器）：
    // 渲染层传入的 dir 需为非空字符串；缺省/空时才弹出「打开目录」对话框由用户手工选择。
    const rendererDir = typeof opts.dir === 'string' && opts.dir.trim() ? opts.dir.trim() : null;
    // 渲染层传入的 dir 必须落在自动备份目录内（与 delete-backup 同款路径穿越防护）：
    // 仅允许恢复 listBackups() 枚举出的应用内备份，拒绝任意路径注入；用户经系统目录选择器
    // 手工选中的路径是受信任的显式行为，不受此限，保持为回退路径。
    if (rendererDir) {
      // 反符号链接 / junction 穿透：词法 startsWith + realpath 双重校验（见 isPathInsideBackupDir），
      // 越界（或无法解析的外部目标）一律拒绝恢复，防止从链接目标读取数据覆盖到数据目录。
      if (!isPathInsideBackupDir(rendererDir)) {
        return { canceled: false, ok: false, error: '备份路径越界，已拒绝恢复' };
      }
    }
    let dir = rendererDir;
    if (!dir) {
      const options = {
        title: '从备份恢复数据',
        buttonLabel: '选择备份目录',
        message: '请选择包含 app.db 与 settings.json 的备份目录（BossJobAI-backup-*）',
        properties: ['openDirectory'],
      };
      const { canceled, filePaths } = await openDialog(options);
      dir = filePaths && filePaths[0];
      if (canceled || !dir) {
        return { canceled: true, ok: false };
      }
    }

    // 校验 + 覆盖写 + 重启后端的核心逻辑（与 import-backup-archive 共用）抽为 restoreBackupDir：
    // schema 版本 + PRAGMA integrity_check + manifest 校验和 + 停后端覆盖写 + 重启后端，同一安全口径。
    return await restoreBackupDir(dir, includeSettings);
  } catch (err) {
    return {
      canceled: false,
      ok: false,
      error: errMsg(err),
    };
  }
});

// ---------------------------------------------------------------------------
// 备份列表 / 备份预览：让渲染层在应用内枚举并检查备份内容，避免依赖系统文件管理器盲选恢复。
// 仅读备份目录与备份内的 SQLite 文件头/统计，不落盘、不触发恢复。
// ---------------------------------------------------------------------------

// list-backups 若对每个备份都跑 verifyBackupManifest，会在数据页每次渲染时对每个备份全量
// SHA-256 一次 app.db/WAL/settings/resume，多 MB 的同步文件读取直接阻塞主进程事件循环。
// 引入按「备份目录 mtime + 各文件 (size, mtimeMs)」变更签名的缓存：签名未变即复用上次的
// checksumOk，签名变化（文件被截断/修改/删除/新增）才重算。该缓存仅服务列表展示；
// restoreBackupDir 恢复前的完整性校验仍走 verifyBackupManifest 全量哈希，不经此缓存。
const backupChecksumCache = new Map(); // backupName -> { sig, checksumOk }
const BACKUP_CHK_CACHE_MAX = 64;

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
  const hit = backupChecksumCache.get(name);
  if (hit && hit.sig === sig) return hit.checksumOk;
  const manifestCheck = verifyBackupManifest(dir);
  const checksumOk = manifestCheck.checked ? manifestCheck.ok : null;
  if (backupChecksumCache.size >= BACKUP_CHK_CACHE_MAX) backupChecksumCache.clear();
  backupChecksumCache.set(name, { sig, checksumOk });
  return checksumOk;
}

/**
 * 枚举自动备份目录下的全部备份目录（BossJobAI-backup-*），汇总各备份的元信息。
 * 每项额外携带 hasResume（是否含简历快照 resume.json）与 checksumOk
 *   （备份 manifest 校验和是否通过：true=完好 / false=被截断损坏或被篡改 / null=旧版备份无 manifest 不可校验），
 * 使「数据」页在备份列表直接标红损坏备份，无需进入恢复流程才发现。
 * 返回 [{ name, path, createdAt, sizeBytes, fileCount, hasResume, checksumOk }]，最新在前；目录不存在时为空数组。
 */
guardedHandle('list-backups', async () => {
  const backupDir = getBackupDir();
  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return []; // 备份目录不存在 → 空列表
  }
  const prefix = BACKUP_DIR_PREFIX;
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => {
      const dir = path.join(backupDir, e.name);
      let sizeBytes = 0;
      let fileCount = 0;
      let createdAt = null;
      let dirMtime = 0;
      const fileSigs = [];
      // 单趟遍历：同时统计 sizeBytes/fileCount 并收集目录变更签名（各文件 'name:size:mtimeMs'），
      // 供 cachedBackupChecksumOk 复用，避免对同一备份目录再 readdir+stat 一遍。
      try {
        dirMtime = fs.statSync(dir).mtimeMs;
        createdAt = new Date(dirMtime).toISOString();
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isFile()) {
            const st = fs.statSync(path.join(dir, f.name));
            sizeBytes += st.size;
            fileCount += 1;
            fileSigs.push(f.name + ':' + st.size + ':' + st.mtimeMs);
          }
        }
      } catch (err) {
        console.warn(`[electron] 读取备份目录 ${dir} 失败：${errMsg(err)}`);
      }
      fileSigs.sort();
      const backupSig = dirMtime + '|' + fileSigs.join('|');
      // hasResume：该备份目录是否包含简历快照 resume.json（数据页据此告知用户每个备份的简历覆盖情况）
      const hasResume = fs.existsSync(path.join(dir, 'resume.json'));
      // checksumOk：复用按备份目录变更签名缓存的 manifest 校验结果，供数据页在备份列表直接标红
      // 损坏备份（旧版无 manifest 的备份为 null 不可校验；有 manifest 但任一文件校验不通过为 false）。
      // 备份目录签名（mtime+各文件 size/mtimeMs）未变时不再全量哈希，避免每次渲染阻塞主进程事件循环。
      let checksumOk = null;
      try {
        checksumOk = cachedBackupChecksumOk(dir, e.name, backupSig);
      } catch {
        checksumOk = null; // 单条备份校验失败不拖垮整个备份列表 IPC，其余备份正常返回
      }
      return {
        name: e.name,
        path: dir,
        createdAt,
        sizeBytes,
        fileCount,
        hasResume,
        checksumOk,
      };
    })
    // 目录名以 BossJobAI-backup-<时间戳> 命名，按解析出的时间键倒序即最新在前
    .sort((a, b) => {
      const ka = backupSortKey(a.name);
      const kb = backupSortKey(b.name);
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
});

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

guardedHandle('delete-backup', (_event, name) => {
  const resolved = resolveBackupDir(name, '备份路径越界，已拒绝删除');
  if (resolved.error) {
    return { ok: false, error: resolved.error };
  }
  const target = resolved.dir;
  try {
    if (!fs.existsSync(target)) {
      return { ok: false, error: '备份不存在' };
    }
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[electron] 已删除备份目录 ${name}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

/**
 * 查询自动备份健康状态，供「数据」页在导出/备份/恢复按钮旁展示备份概览：
 * - backupDir：自动备份目录绝对路径；
 * - lastBackupAt：最近一次备份的目录 mtime（ISO 字符串；无备份为 null）；
 * - totalBackups：当前保留的备份份数（BossJobAI-backup-* 目录数）；
 * - maxBackups：自动备份保留上限（settings.json 的 backup.maxBackups，默认 7）；
 * - autoBackupEnabled：是否启用定时自动备份；
 * - intervalMinutes：定时备份间隔分钟数（null 表示未配置定时）。
 * 目录不存在时返回 totalBackups=0、lastBackupAt=null，不抛错。
 */
guardedHandle('get-backup-info', () => {
  const backupDir = getBackupDir();
  const prefix = BACKUP_DIR_PREFIX;
  const { maxBackups, autoBackupEnabled, intervalMinutes } = getBackupSettings();
  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return { backupDir, lastBackupAt: null, totalBackups: 0, maxBackups, autoBackupEnabled, intervalMinutes };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => path.join(backupDir, e.name));
  let lastBackupAt = null;
  try {
    const mtimes = dirs.map((d) => fs.statSync(d).mtimeMs).filter((n) => Number.isFinite(n));
    if (mtimes.length > 0) {
      lastBackupAt = new Date(Math.max(...mtimes)).toISOString();
    }
  } catch {
    lastBackupAt = null;
  }
  return { backupDir, lastBackupAt, totalBackups: dirs.length, maxBackups, autoBackupEnabled, intervalMinutes };
});

/**
 * 更新自动备份配置（「数据」页备份设置入口）：持久化到 settings.json 的 backup 段。
 * cfg 为 { maxBackups?, autoBackupEnabled?, intervalMinutes? } 的任意子集：
 * - maxBackups：保留份数上限（1~60 整数）；保存后立即对现有备份做轮转裁剪到新上限；
 * - autoBackupEnabled：是否启用定时自动备份（布尔）；关闭时停止定时任务（启动备份兜底不受影响）；
 * - intervalMinutes：定时备份间隔分钟数（1~1440 整数；null 取消定时）。
 * 返回 { ok: boolean, settings: { maxBackups, autoBackupEnabled, intervalMinutes }, error? }。
 */
guardedHandle('update-backup-settings', (_e, cfg) => {
  const patch = {};
  const c = isPlainObject(cfg) ? cfg : {};
  if (c.maxBackups !== undefined) {
    const n = c.maxBackups;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 60) {
      return { ok: false, error: 'maxBackups 必须是 1~60 的整数' };
    }
    patch.maxBackups = n;
  }
  if (c.autoBackupEnabled !== undefined) {
    if (typeof c.autoBackupEnabled !== 'boolean') {
      return { ok: false, error: 'autoBackupEnabled 必须是布尔值' };
    }
    patch.autoBackupEnabled = c.autoBackupEnabled;
  }
  if (c.intervalMinutes !== undefined) {
    if (c.intervalMinutes === null) {
      patch.intervalMinutes = null;
    } else {
      const n = c.intervalMinutes;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1440) {
        return { ok: false, error: 'intervalMinutes 必须是 1~1440 的整数或 null' };
      }
      patch.intervalMinutes = n;
    }
  }
  const { settings, writeOk } = saveBackupSettings(patch);
  // 立即应用：间隔/开关变更即刻启停定时任务。
  // 注意 rotateAutoBackups 必须放在 writeOk 校验之后：落盘失败时 settings.maxBackups 是
  // 未持久化的会话内存值，若先轮转会按「下次启动即回退」的新上限立刻永久删除旧备份。
  syncBackupInterval();
  if (!writeOk) {
    return { ok: false, settings, error: '写入 settings.json 失败（自动备份配置未持久化）' };
  }
  // 保留上限已确认落盘，再按已持久化的 settings.maxBackups 裁剪旧备份；
  // rotateAutoBackups 复用 saveBackupSettings 已解析的 settings.maxBackups，避免本 IPC 内重复读盘解析 settings.json。
  rotateAutoBackups(settings.maxBackups);
  return { ok: true, settings };
});

/**
 * 预览单个备份目录的内容（不落盘、不触发恢复），供恢复前确认对话框展示：
 * - appCount：applications 表记录数；备份带 WAL 时先暂存到临时目录回放再查询，
 *   保证统计包含 wal 尾部最近提交，与 restore-data 的实际恢复口径一致。
 * - latestRecordAt：最近一条投递记录的 applied_at（字符串；无记录/无法读取为 null）。
 * - schemaVersion：备份库 user_version（-1 = 文件损坏或非 SQLite）。
 * - hasSettings / settingsStatus：settings.json 是否存在及其解析状态（ok/invalid/missing）。
 * - hasResume：备份目录是否含简历快照 resume.json（恢复确认弹窗据此提示「简历将一并还原 / 备份中无简历」）。
 * 返回 { appCount, latestRecordAt, schemaVersion, hasSettings, settingsStatus, hasResume, checksumOk? }。
 * 安全基线（与 delete-backup 一致，防路径穿越 / 防任意路径读取）：
 *   1. 参数为备份名称（非路径）：必须匹配 ^BossJobAI-backup- 前缀，且不含任何路径分隔符；
 *   2. path.resolve(getBackupDir(), name) 必须仍落在 getBackupDir() 内；
 *   3. 越界或非法输入 → 返回 { ok:false, error }，绝不读取备份目录外的 settings.json / app.db。
 */
guardedHandle('preview-backup', async (_event, name) => {
  const result = {
    appCount: 0,
    latestRecordAt: null,
    schemaVersion: -1,
    hasSettings: false,
    settingsStatus: SETTINGS_STATUS.MISSING,
    hasResume: false,
    checksumOk: null,
  };
  const resolved = resolveBackupDir(name, '备份路径越界，已拒绝预览');
  if (resolved.error) {
    return { ...result, ok: false, error: resolved.error };
  }
  const dirPath = resolved.dir;
  // hasResume：备份目录是否含简历快照 resume.json（恢复确认弹窗据此提示「简历将一并还原 / 备份中无简历」）
  result.hasResume = fs.existsSync(path.join(dirPath, 'resume.json'));
  // resumeSummary：备份内 resume.json 的摘要字段 {name,phone,email}，供恢复确认弹窗在覆盖当前数据前
  // 展示「这份备份是哪一版简历（姓名/联系方式）」，多版简历场景下用户可据此区分备份；缺失/损坏为 null。
  result.resumeSummary = null;
  if (result.hasResume) {
    try {
      const parsedResume = JSON.parse(fs.readFileSync(path.join(dirPath, 'resume.json'), 'utf-8'));
      if (isPlainObject(parsedResume)) {
        result.resumeSummary = {
          name: typeof parsedResume.name === 'string' ? parsedResume.name : null,
          phone: typeof parsedResume.phone === 'string' ? parsedResume.phone : null,
          email: typeof parsedResume.email === 'string' ? parsedResume.email : null,
        };
      }
    } catch (_err) {
      result.resumeSummary = null; // 简历快照损坏 → 摘要置 null，不阻塞预览
    }
  }
  // settings.json：是否存在 + 是否可解析为合法对象（与 restoreSettingsSafely 的合法性口径一致）
  const settingsPath = path.join(dirPath, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    result.hasSettings = true;
    try {
      const obj = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      result.settingsStatus =
        isPlainObject(obj) ? SETTINGS_STATUS.OK : SETTINGS_STATUS.INVALID;
    } catch {
      result.settingsStatus = SETTINGS_STATUS.INVALID;
    }
  }
  // schema 版本：从 SQLite 文件头读取（-1 = 损坏/非 SQLite）
  const dbPath = path.join(dirPath, 'app.db');
  if (!fs.existsSync(dbPath)) {
    // 缺 app.db 的备份视为损坏（契约要求 ok:false + error，见 preload previewBackup 声明），
    // 否则前端只查 ok===false 会把该备份渲染成「0 条记录 / Schema -1」的伪正常预览且恢复按钮可用
    return { ...result, ok: false, error: '备份目录缺少 app.db，无法预览' };
  }
  try {
    result.schemaVersion = readDbUserVersion(dbPath);
  } catch (err) {
    // 读取失败（EACCES / 句柄占用 / 文件被锁等）→ 置 -1 并返回结构化错误，
    // 与 delete-backup 等分支错误形态一致，避免整条 IPC 以 rejected Promise 抛给渲染层
    result.schemaVersion = -1;
    return { ...result, ok: false, error: errMsg(err) };
  }
  // 记录数 / 最近投递时间：node:sqlite 可用时精确查询；不可用则仅返回头部版本信息，
  // 校验和仍直接哈希备份原文件（无暂存副本可复用）。
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    sqlite = null;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    // 校验和：备份带 manifest.json（本版本起写入）时验证 app.db（及 WAL 副文件）与备份时记录的
    // SHA-256 是否一致；缺失（旧版备份）为 null，供恢复前确认对话框提示「可校验 / 已损坏 / 旧版无法校验」。
    // 补 ok:true：node:sqlite 不可用时仍是合法头部预览（版本/结构已读），与缺 app.db 的硬失败区分开
    const manifestCheck = verifyBackupManifest(dirPath);
    result.checksumOk = manifestCheck.checked ? manifestCheck.ok : null;
    return { ...result, ok: true };
  }
  let target;
  let cleanupDir;
  try {
    const staged = stageDbForRead(dbPath);
    target = staged.target;
    cleanupDir = staged.cleanupDir;
  } catch {
    target = dbPath; // 暂存失败则退化为直读主库
    cleanupDir = null;
  }
  // 校验和：WAL 暂存副本是备份原文件的逐字节拷贝，app.db/-wal/-shm 的哈希改读暂存副本，
  // 使全文件哈希与随后的 SQLite 打开共享一份读取，避免对备份原文件「先哈希、后拷贝」被读两遍；
  // 无 WAL（cleanupDir == null）/ 暂存失败时仍直接哈希备份原文件。
  const manifestCheck = verifyBackupManifest(dirPath, cleanupDir);
  result.checksumOk = manifestCheck.checked ? manifestCheck.ok : null;
  try {
    // 统计元信息，绝不写目标备份库（防篡改任意路径 SQLite）：stageDbForRead 恒返回私有 mkdtemp
    // 副本（cleanupDir != null），以读写方式打开，使 SQLite 在无 -shm 时也能自行创建并回放 wal
    // 尾部提交，避免只读打开无法建 shm 导致预览误报 appCount=0/latestRecordAt=null；生成的
    // -shm/-wal 副作用只落在临时目录。仅当暂存失败退化为直读主库时（cleanupDir==null）保持只读。
    const db = new sqlite.DatabaseSync(target, { readOnly: cleanupDir == null });
    try {
      const countRow = db.prepare('SELECT COUNT(*) AS n FROM applications').get();
      result.appCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
      // 样本记录（预览弹窗展示备份实际内容用，供用户恢复前确认「备份里有没有某公司/某职位」）：
      // 最新 10 条投递记录的关键字段，只读不落盘；applications 表缺失时保持默认空数组。
      const sampleRows = db
        .prepare('SELECT job_title, company, status, applied_at FROM applications ORDER BY applied_at DESC LIMIT ?')
        .all(PREVIEW_SAMPLE_LIMIT);
      result.samples = (Array.isArray(sampleRows) ? sampleRows : []).map((r) => ({
        job_title: r.job_title != null ? String(r.job_title) : null,
        company: r.company != null ? String(r.company) : null,
        status: r.status != null ? String(r.status) : null,
        applied_at:
          r.applied_at instanceof Date ? r.applied_at.toISOString() : r.applied_at != null ? String(r.applied_at) : null,
      }));
      const maxRow = db.prepare('SELECT MAX(applied_at) AS m FROM applications').get();
      if (maxRow && maxRow.m != null) {
        const m = maxRow.m;
        result.latestRecordAt = m instanceof Date ? m.toISOString() : String(m);
      }
    } catch (_err) {
      // applications 表缺失（旧/空库）→ 保持默认值，恢复前兼容性校验仍由 restore-data 兜底
    } finally {
      db.close();
    }
  } catch (_err) {
    // 无法打开库（损坏/权限）→ 返回结构化错误，防止渲染层把损坏备份渲染成「0 条记录」空预览
    return { ...result, ok: false, error: errMsg(_err) };
  } finally {
    if (cleanupDir) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return { ...result, ok: true };
});

// ---------------------------------------------------------------------------
// 配置持久化说明：设置写入由后端承担（渲染层经 HTTP PUT /api/settings 保存，
// 见 frontend/src/stores/settingsStore.ts 与 pages/Settings.tsx），
// 主进程不再提供 save-settings / get-settings-path IPC，此处保留 getSettingsPath() 供端口解析/备份/恢复使用。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// 单实例锁：避免重复启动导致后端端口冲突（address already in use）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已有实例运行时再次启动 → 聚焦既有窗口
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // 打包模式：把 userData 对齐到后端 constants.py 冻结态目录 %APPDATA%/BossJobAI。
    // Electron 默认按 package.json 的 productName/name 命名 userData（BossJobAI求职投递助手
    // 或 boss-job-ai-desktop），与后端硬编码目录不一致，会导致打包态备份/恢复读写错位。
    // 必须在任何 getSettingsPath/getDataDir 解析前设置。
    if (app.isPackaged) {
      app.setPath('userData', path.join(app.getPath('appData'), 'BossJobAI'));
    }
    // 打包模式首启：先准备 userData 下的 settings.json，再解析端口（保证读取的是同一份配置）
    ensurePackagedSettings();
    backendPort = resolveBackendPort();
    console.log(`[electron] 后端端口 = ${backendPort}`);
    // 开发模式 CSP 端口漂移告警：frontend/index.html 的 <meta http-equiv="Content-Security-Policy">
    // connect-src 端口由 vite.config.ts strictCspDev 从单一事实源注入（backend-default-port.cjs 默认值，
    // 或优先跟随其进程的 BOSS_PORT 环境变量）。dev 下该 meta 与 buildCspPolicy 注入的 header CSP 取交集，
    // 若经 BOSS_PORT / settings.json port / restore-data 改用非默认端口而 vite dev 进程未同步设置 BOSS_PORT，
    // meta connect-src 会拦截渲染进程对实际端口的 fetch，Dashboard 即使后端健康也停在「未连接」。此处仅当
    // 端口漂移时大声告警，提示以 BOSS_PORT 对齐两端（无需修改 index.html 字面量——它只有占位符）。
    if (!app.isPackaged && backendPort !== DEFAULT_PORT) {
      console.warn(
        `[electron] 开发模式后端端口=${backendPort} 与 vite strictCspDev 注入的 CSP meta 端口=${DEFAULT_PORT} 不一致：` +
          `渲染进程对 ${backendPort} 的 fetch 会被 meta connect-src 拦截（Dashboard 停在「未连接」）。` +
          `请为 vite dev 与 electron 启动进程设置相同的 BOSS_PORT=${backendPort} 环境变量并重启（index.html 端口由 strictCspDev 注入，勿手工改字面量）。`
      );
    }
    // 外部链接宿主扩展白名单：先加载一次作为初始值；open-external 每次 IPC 打开前会
    // 重读 settings.json 刷新本缓存，使 Settings 页直连保存的新域名无需重启即可放行。
    refreshExternalHostAllowlistCache();

    // 本地后端鉴权令牌：首启生成并持久化，注入后端 + 统一附加到渲染进程请求。
    // 令牌固定后一次性预计算指纹，供 verifyBackendTokenFingerprint 在每轮 /api/health 轮询直接比对（避免重复哈希）。
    authToken = loadOrCreateAuthToken();
    authTokenFingerprint = authToken ? createHash('sha256').update(authToken, 'utf-8').digest('hex').slice(0, 16) : '';
    console.log('[electron] 本地后端鉴权令牌已就绪（经一次性令牌文件注入后端，不写入子进程环境块）');

    // 内容安全策略（CSP）注入 —— 渲染层防御纵深基线（架构 v0.2 安全加固）。
    //  - 打包模式主文档走 file://（webRequest 不拦截 file 协议），CSP 由
    //    frontend/dist/index.html 的 <meta http-equiv="Content-Security-Policy"> 承担：script-src 'self' 严格版
    //    + connect-src 收紧为 http://127.0.0.1:8675（具体后端端口，默认值；无 Vite HMR / localhost:5173 源），
    //    由 vite.config.ts strictCspBuild 在构建期断言 script-src 收紧 + connect-src 具体端口 +
    //    form-action 'none'（verify-dist.mjs / verify-csp.mjs 产物校验兜底）；主文档加载时下方
    //    interceptFileProtocol 还会整体重写为进程内严格策略（运行时强制，见打包分支）。
    //  - 此处 onHeadersReceived 仅覆盖开发模式 Vite dev server：开发态 @vitejs/plugin-react 注入
    //    内联 Fast Refresh 预置脚本由 vite.config.ts strictCspDev 用一次性 nonce 放行（Vite html.cspNonce），
    //    HMR 走 ws://127.0.0.1:5173（随 location.hostname，与 DEV_SERVER_URL 一致），故本 header 不写
    //    default-src / script-src（避免把 meta 的 nonce 交集掉），脚本源完全交由 meta 管辖。
    //  - style-src 'unsafe-inline'：React 内联 style 属性（类型化）+ antd v5 cssinjs 运行时注入 <style>
    //    （src 无外部 CSS），移除会丢失全部样式；保留前提下严禁把不可信 job/导入内容插值进 style 属性或
    //    <style> 内容 —— verify-csp.mjs 源码扫描门禁在每次构建兜底（2026-08-04 审计）。
    //  - buildCspPolicy 每次调用时实时插值当前 backendPort：restore-data 恢复备份 settings.json 后
    //    会重新解析端口（见 restore-data 内 backendPort = resolveBackendPort()），若 CSP 在启动期一次性
    //    烘焙旧端口，重载后的渲染进程访问新端口会被 connect-src 拦截，Dashboard 即使后端健康也停在「未连接」。
    //    故必须按调用时模块级 backendPort 动态构建，与下方 webRequest 鉴权门读取 backendPort 的方式保持一致。
    // 开发模式 header CSP 与 vite.config.ts strictCspDev 注入的 meta（script-src 'self' 'nonce-*'）取交集。
    // 关键约束：header 不得写 default-src / script-src —— CSP 多策略按指令取交集，header 若带
    // default-src 'self' 或 script-src，会把 meta 的 nonce 交集掉，导致 Vite Fast Refresh 内联预置脚本
    // 被拦、dev 白屏。故脚本源完全交由 meta（含 nonce）管辖，header 仅负责其余指令并显式加
    // form-action 'none'（防跨源 <form> 外发数据，form-action 不受 default-src / connect-src 管辖）。
    const buildCspPolicy = () => {
      // Vite HMR 源自模块级 DEV_SERVER_ORIGIN / DEV_WS（DEV_SERVER_URL 仅解析一次），避免改常量后
      // 遗留陈旧的 connect-src；backendPort 仍需每次调用实时插值（restore-data 可运行时改端口）。
      return [
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        // 后端端口按当前值插值：connect-src 收紧到具体端口，
        // 不再用裸 http://127.0.0.1 放行任意本地端口（认证绕过加固）。
        // Vite HMR 按 location.hostname 连接，源由 DEV_SERVER_URL 派生，主机始终一致。
        `connect-src http://127.0.0.1:${backendPort} ${DEV_SERVER_ORIGIN} ${DEV_WS}`,
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ].join('; ');
    }
    session.defaultSession.webRequest.onHeadersReceived(
      (details, callback) => {
        if (details.url.startsWith(DEV_SERVER_URL + '/')) {
          const headers = { ...details.responseHeaders };
          headers['Content-Security-Policy'] = [buildCspPolicy()];
          callback({ responseHeaders: headers });
        } else {
          callback({ responseHeaders: details.responseHeaders });
        }
      }
    );

    // 打包模式 CSP 动态化（display-update 修复）：
    // Electron webRequest 不拦截 file:// 协议（上方 onHeadersReceived 仅覆盖 http 的 Vite
    // dev server 响应），打包态主文档走 file://，其 CSP 由 dist/index.html 的
    // <meta http-equiv="Content-Security-Policy"> 承担，而 vite.config.ts strictCspBuild 在
    // 构建期把 connect-src 烘焙为默认端口 http://127.0.0.1:8675。当后端端口被运行时改为
    // 非默认值（settings.json port 字段 / BOSS_PORT 环境变量 / restore-data 恢复备份后重新
    // 解析），该静态 CSP 会拦截渲染进程对 http://127.0.0.1:<实际端口> 的全部 fetch，Dashboard
    // 与数据页在后端健康时仍假性显示「无法连接后端」。
    // 修复：protocol.interceptFileProtocol 接管 file://，仅对主文档 index.html 请求在返回前
    // 实时把 CSP meta 的 connect-src 端口替换为当前 backendPort，其余 file:// 请求（js/css/
    // 图片等）按原路径正常服务。每次请求都重新读取模块级 backendPort，故 restore-data 改端口
    // 后渲染层 reload 也会用新端口重写，无需重启进程。构建期其余安全指令（script-src 'self'、
    // 无 'unsafe-inline' 等）原样保留，不牺牲生产严格 CSP。
    //
    // 两个关键实现约束（Electron 43 实测）：
    //  1) interceptFileProtocol 的 callback 不接受 { data, mimeType }（该形式仅 registerBufferProtocol
    //     / protocol.handle 支持），传 data 会导致主文档 ERR_FAILED、页面加载失败。必须先把改写后的
    //     HTML 写入临时文件再回调 { path }。
    //  2) 渲染层 HashRouter 下 reload 的 URL 形如 file://.../index.html#/data（request.url 含 hash
    //     片段），既使 endsWith('/index.html') 判不准主文档，也会让 fileURLToPath 抛 TypeError。
    //     故先剥离 #? 后缀再做判定与转换。
    if (app.isPackaged) {
      // 模块级缓存：以 backendPort 为键缓存「改写后的 index.html 临时文件路径」。
      // 若每次主文档请求都 readFileSync 完整 index.html + 正则替换 + writeFileSync 临时文件，
      // 即使端口未变化（reload / 多次导航）也会重复做同样的读改写盘（每导航一次同步写盘）。
      // 此处首次计算后缓存，端口变更（如 restore-data 改端口）时失效重算，命中缓存直接复用
      // 改写结果并跳过 writeFileSync；临时文件写入仅在端口变化时发生。
      const rewrittenIndexCache = new Map();
      // 缓存派生放行集合：改写后临时 index.html 的路径列表（缓存至多当前端口一份）。
      // 仅在缓存变更时重建，供下方 else 分支每次 file:// 请求复用，避免每请求展开 Map（redundant-compute）。
      let rewrittenIndexPaths = [];
      protocol.interceptFileProtocol('file', (request, callback) => {
        const pathOnly = request.url.split('#')[0].split('?')[0];
        // 主文档判定：打包产物仅含单个 index.html 主文档，assets 均为 /assets/index-*.js
        if (pathOnly.endsWith('/index.html')) {
          try {
            if (!rewrittenIndexCache.has(backendPort)) {
              const html = fs.readFileSync(FRONTEND_DIST_INDEX, 'utf-8');
              // 运行时强制 CSP（2026-08-05 csp-hardening 纵深）：打包态主文档不再只改 connect-src 端口，
              // 而是整体重写 CSP meta 为进程内严格生产策略——script-src 'self'（无 'unsafe-inline' /
              // 'unsafe-eval'）、form-action 'none'、connect-src 收紧为当前 backendPort。即使构建期
              // strictCspBuild / verify-dist.mjs 失效、产物残留宽松脚本许可（陈旧/被篡改 dist），运行时
              // 也强制严格，杜绝打包态内联脚本执行与跨源表单外发。检测到产物本就宽松时记录告警便于排查。
              const strictProductionCsp = [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                `connect-src http://127.0.0.1:${backendPort}`,
                "font-src 'self' data:",
                "object-src 'none'",
                "base-uri 'none'",
                "frame-ancestors 'none'",
                "form-action 'none'",
              ].join('; ');
              if (/script-src [^;]*'unsafe-inline'/.test(html) || !/form-action 'none'/.test(html)) {
                console.warn(
                  '[electron] 构建产物 CSP 非严格（script-src 含 unsafe-inline 或缺失 form-action），' +
                    '已被运行时重写为严格生产策略（构建门禁疑似被绕过）。'
                );
              }
              const rewritten = html.replace(
                /content="(default-src [^"]*)"/,
                () => `content="${strictProductionCsp}"`
              );
              // 主文档改从临时目录加载后，浏览器 base URL 变为临时目录；若保留相对路径
              // ./assets/*，会解析到临时目录下不存在的位置（ERR_FILE_NOT_FOUND）导致白屏。
              // 故把相对 src/href 改写为指向真实 dist 目录的绝对 file:// URL，由下方 else
              // 分支 fileURLToPath 后正常服务（与打包产物同目录，CSP 'self' 语义与原先一致）。
              const distDirUrl = pathToFileURL(path.dirname(FRONTEND_DIST_INDEX)).href;
              const rewrittenAbs = rewritten.replace(/(src|href)="\.\//g, `$1="${distDirUrl}/`);
              // 安全加固（防 symlink-attack）：不再写入固定共享目录 %TEMP%/bossjobai/<port>/——
              // 同用户攻击者可在 %TEMP% 预置 bossjobai junction/symlink 指向任意可写目录，
              // 使 writeFileSync 穿过链接造成任意位置覆盖。改为每次 mkdtempSync 生成不可预测
              // 的私有目录（%TEMP%/bossjobai-XXXXXX）再写入 index.html，并按端口缓存目录句柄，
              // 供 before-quit 统一清理；端口未变时复用缓存路径，跳过重复读盘/写盘。
              // 文件仍命名为 index.html：reload（URL 为临时 index.html）仍命中上方主文档判定，
              // 端口变更时重新重写，restore-data 改端口后 reload 也取新端口。
              // 端口变更时（restore-data / import 改端口）先清理上一端口缓存的临时改写目录，
              // 保证至多缓存当前端口一份，避免整个会话在 %TEMP% 与 Map 中累计 mkdtemp 目录，
              // 也让下方 else 分支放行集合（tmpRewrittenIndexes）不再随端口变更无限增长。
              // before-quit 的全量清扫仍保留作为安全网（正常流程下此刻缓存已空）。
              for (const oldEntry of rewrittenIndexCache.values()) {
                try {
                  fs.rmSync(oldEntry.dir, { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
              }
              rewrittenIndexCache.clear();
              const tmpIndexDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'bossjobai-'));
              const tmpIndex = path.join(tmpIndexDir, 'index.html');
              fs.writeFileSync(tmpIndex, rewrittenAbs, 'utf-8');
              rewrittenIndexCache.set(backendPort, { dir: tmpIndexDir, file: tmpIndex });
              // 缓存变更时才重建派生放行集合（改写后临时 index.html 路径），与缓存保持同步。
              rewrittenIndexPaths = [...rewrittenIndexCache.values()].map((v) => v.file);
            }
            callback({ path: rewrittenIndexCache.get(backendPort).file });
          } catch (err) {
            console.error('[electron] CSP 动态重写失败，回退原文件加载：', err);
            callback({ path: FRONTEND_DIST_INDEX });
          }
        } else {
          // 路径穿越加固：本 else 分支会把任意 file:// URL 解析为本地路径并回传，若不设
          // 目录约束，渲染层一旦被注入 XSS，即可用 <img>/<iframe> 探测任意本地文件
          // （boolean/timing oracle），成为本地文件读取原语。故仅放行：
          //   1. frontend/dist 目录内的资源（打包产物 assets，CSP 重写后以绝对 file:// 引用）；
          //   2. CSP 重写的临时 index.html（正常走上方主文档分支，此处兜底放行）。
          // 其余一律按「文件不存在」拒绝（net::ERR_FILE_NOT_FOUND），杜绝目录逃逸。
          // 用 path.resolve 归一化路径：fileURLToPath 不折叠 `..` 段，直接 startsWith 判空
          // 会让 file:///.../dist/../secret 之类的 URL 绕过前缀检查，必须先解析成真实路径。
          let filePath;
          try {
            filePath = fileURLToPath(pathOnly);
          } catch (err) {
            filePath = null; // 解析失败 → 直接拒绝，不再兜底到 FRONTEND_DIST_INDEX
            console.error('[electron] file:// 路径解析失败，已拒绝：', err);
          }
          const distDir = path.dirname(FRONTEND_DIST_INDEX);
          // 临时改写 index.html 现位于 mkdtempSync 生成的不可预测目录，放行集合取缓存派生的
          // rewrittenIndexPaths（缓存至多保留当前端口一份，端口变更时重建），
          // 防目录逃逸的同时放行 CSP 重写产物。
          const resolved = filePath !== null ? path.resolve(filePath) : null;
          const isAllowed =
            resolved !== null &&
            (resolved.startsWith(distDir + path.sep) || rewrittenIndexPaths.includes(resolved));
          if (!isAllowed) {
            callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND，拒绝越界/任意本地路径
            return;
          }
          callback({ path: resolved });
        }
      });

      // 退出时清理 mkdtempSync 生成的临时改写目录（含全部端口缓存），防 %TEMP% 残留；
      // 不随窗口 close 清理——多窗口可能共享同一缓存文件，且 macOS 关闭后重开仍复用缓存。
      app.on('before-quit', () => {
        for (const entry of rewrittenIndexCache.values()) {
          try {
            fs.rmSync(entry.dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
        rewrittenIndexCache.clear();
        rewrittenIndexPaths = [];
      });
    }

    startBackend();
    // 后端就绪后由主进程统一推送 backend-ready（含版本）给所有窗口：
    // 渲染层 Dashboard 改为监听该信号而非各自重复轮询 /api/health（见 Dashboard.tsx），
    // 消除启动期同一端点被重复探测（主进程 20×500ms + 渲染层 10×1000ms）与冗余 IPC 流量。
    // 预算超时后转入周期复查：后端在 10s 预算之后才恢复健康时仍会推送 backend-ready，
    // 避免 Dashboard（已停止自轮询）永久停留在「未连接」。
    waitBackendReadyOrRetry();
    // 启动时自动备份（失败仅告警不阻塞启动），并对旧备份做数量轮转；
    // 随后按 settings.json 的备份配置启停「定时自动备份」（intervalMinutes 配置了才会启动）
    void autoBackup();
    syncBackupInterval();
    createWindow();

    // macOS：点击 Dock 图标且无窗口时重新创建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // 除 macOS 外，全部窗口关闭即退出应用（触发 before-quit 清理后端）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    stopBackend();
    // 退出时兜底删除可能遗留的一次性令牌文件（后端未读取路径：spawn 失败 / 崩溃循环 / FAIL-OPEN
    // 熔断 / restore 崩溃等），兑现 writeAuthTokenFile/authTokenFilePath 注释承诺的「退出清理」。
    // 令牌为跨启动持久化（safeStorage），文件残留会让同用户本地进程读取到明文令牌后冒充鉴权。
    cleanupAuthTokenFile();
  });
  // key-exposure 加固：除 before-quit 外，注册 will-quit 兜底清理 —— 退出阶段若一次性令牌文件仍存在
  // 立即删除（before-quit 已先调用 stopBackend 关闭后端，后端不会再读取该文件，删除安全），
  // 压缩退出路径上明文令牌残留磁盘的暴露窗口（TTL 定时器 + 下次启动清理兜底）。
  // cleanupAuthTokenFile 幂等：文件已删 / 未写入时无操作，多生命周期信号先后触发无害。
  // 注意：不再注册 render-process-gone / child-process-gone —— 渲染进程 / Chromium 子进程崩溃可能在
  // 后端冷启动模块导入窗口内（writeAuthTokenFile 之后、后端读盘之前）触发，此时删除令牌文件会使
  // 后端读不到令牌 → AUTH_TOKEN 为空 → require_auth 静默 FAIL-OPEN（本地任意进程可无令牌访问后端），
  // 重现历史 30s 盲定时器已实测触发的 auth-bypass 竞态。该残留窗口已由 TOKEN_FILE_TTL_MS(60s) 定时器
  // 兜底覆盖（届时文件仍存在才删除）；且 Electron 的 child-process-gone 仅覆盖 Chromium 子进程
  // （renderer/GPU/utility），并不覆盖 child_process.spawn 出的后端进程，注册它并不能实现
  // 「后端崩溃即清令牌」的预期。
  app.on('will-quit', () => cleanupAuthTokenFile());
}
