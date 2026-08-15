/** Electron 主进程 · 常量与路径（从 main.js 抽离：跨模块共享的配置单一事实源，禁止复制导致漂移）。
 *  注意：本模块位于 electron/modules/，__dirname = electron/modules —— 所有相对 __dirname 的
 *  路径推导都要比 main.js 时代（__dirname = electron/）深一层，详见下方各 path.join。 */

const { app } = require('electron');
const path = require('path');

// ---------------------------------------------------------------------------
// 路径与常量（相对 __dirname 推导，禁止硬编码）
// ---------------------------------------------------------------------------

/** electron/modules/ 的上级 = electron/，再上级 = code/（项目根），settings.json 与 backend/ 均在此（仅开发模式使用）。 */
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SETTINGS_PATH = path.join(PROJECT_ROOT, 'settings.json');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
/**
 * 前端构建产物入口：
 *   - 打包模式：frontend/dist 随 files 打包进 app.asar 根（__dirname = app.asar/modules → 上级即 asar 根）。
 *   - 开发模式：源码目录 frontend/dist。
 */
const FRONTEND_DIST_INDEX = app.isPackaged
  ? path.join(__dirname, '..', 'frontend', 'dist', 'index.html')
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
const { DEFAULT_BACKEND_PORT: DEFAULT_PORT } = require(path.join(__dirname, '..', 'backend-default-port.cjs'));
/** 端口合法区间（PORT_MIN/PORT_MAX 与 isValidPort 一起保留在 modules/utils.js，见该模块注释）。 */
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

/** settings.json 的实际读取路径：
 *   - 打包模式：userData（%APPDATA%/BossJobAI），首启由 ensurePackagedSettings() 复制写入，
 *     与后端 constants.py 的 frozen 分支指向同一目录。
 *   - 开发模式：源码根目录 settings.json。
 */
function getSettingsPath() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'settings.json')
    : SETTINGS_PATH;
}

/** 数据目录（与 backend/app/constants.py 对齐）：
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

/** 备份目录名完整匹配正则（backupSortKey 复用的模块级常量，与 BACKUP_NAME_PREFIX_RE 同风格，避免每次调用重新编译）。 */
const BACKUP_SORT_KEY_RE = new RegExp('^' + BACKUP_DIR_PREFIX + '(\\d{8})-(\\d{4})-([0-9a-z]+)$', 'i');

/** /api/export 全量导出专用响应体上限（200MB）：导出载荷可能含大量 applications + apply_logs，
 *  显著大于默认代理上限 BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES，避免合法大导出被 RESPONSE_TOO_LARGE_ERR 误杀。 */
const EXPORT_MAX_RESPONSE_BODY_BYTES = 200 * 1024 * 1024;

/** 简历 localStorage 键名（与 frontend/src/pages/ResumePage.tsx 的 STORAGE_KEY 保持一致）。 */
const RESUME_STORAGE_KEY = 'bossjobai.resume';
/** resume-saved IPC 载荷大小上限（2MB）：防渲染层被同主世界 XSS 拿下时反复写任意大 JSON 填满数据目录磁盘。 */
const MAX_RESUME_SAVE_BYTES = 2 * 1024 * 1024;

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

/** 超时哨兵：httpRequest 超时销毁连接时复用的 Error 实例（identity 恒定），
 *  导出重试等调用方以 `err === TIMEOUT_ERR` 判断超时，避免依赖消息文本的魔法字符串。 */
const TIMEOUT_ERR = new Error('timeout');
/** 响应体超限哨兵：httpRequest 响应体累积超过上限时销毁响应流并以此哨兵报错（防无限累积大响应占满内存）。 */
const RESPONSE_TOO_LARGE_ERR = new Error('response too large');

/** 一次性令牌文件 TTL 宽限期（ms）：须远大于后端冷启动模块导入时长（本地 uvicorn / PyInstaller exe 秒级），
 *  防止「定时器先于后端读取触发 → 后端读不到令牌 → AUTH_TOKEN 为空 → require_auth 静默 FAIL-OPEN」的
 *  auth-bypass 竞态（历史 30s 盲定时器已实测触发过该竞态，故放宽到 60s，且仅在「文件仍存在」时删除）。 */
const TOKEN_FILE_TTL_MS = 60_000;
/** 一次性令牌文件写入失败时的重试次数与重试间隔（ms）：磁盘抖动/瞬时权限竞态时避免一次失败即拒绝启动。 */
const TOKEN_FILE_WRITE_RETRIES = 3;
const TOKEN_FILE_WRITE_RETRY_DELAY_MS = 50;

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

/** 外部链接放行的 URL scheme 白名单：仅 http/https，杜绝 file: 等本地路径被打开。 */
const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:']);

/** 外部链接宿主默认白名单后缀：BOSS直聘（*.zhipin.com）；其余须经 settings.json security.external_url_hosts 显式配置。 */
const DEFAULT_EXTERNAL_HOST_SUFFIXES = ['zhipin.com'];

/** DEFAULT_EXTERNAL_HOST_SUFFIXES 的预归一化结果（小写、去前导点）：refreshExternalHostAllowlistCache 与 isExternalHostAllowed 共用，消除内联重复归一化逻辑。 */
const DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED = DEFAULT_EXTERNAL_HOST_SUFFIXES.map((suffix) =>
  String(suffix).toLowerCase().replace(/^\./, '').replace(/\.+$/, '')
);

/** 自动备份保留份数默认值（可在「数据」页经 updateBackupSettings 修改）：超出后按创建时间轮转删除最旧备份。 */
const DEFAULT_MAX_AUTO_BACKUPS = 7;
/** 分钟 → 毫秒换算常量（60 s/min × 1000 ms/s），供 syncBackupInterval 计算 setInterval 周期。 */
const MS_PER_MINUTE = 60 * 1000;
/** sha256OfFile 流式读缓冲大小（64 KiB = 64 * 1024），单次 fs.readSync 最大读入字节数。 */
const HASH_READ_BUFFER_BYTES = 64 * 1024;
/** preview-backup 样本记录上限：仅展示最新 10 条投递记录供恢复前确认。 */
const PREVIEW_SAMPLE_LIMIT = 10;

/** SQLite user_version（schema 版本），与 backend/app/db.py 的 DB_SCHEMA_VERSION 对齐，改版须同步。
 *  v2: applications.applied_at 可空（清空投递时间=未设置）。
 *  v3: applications.applied_at 建索引（日期过滤/趋势/排序 datetime 区间比较走索引）。 */
const DB_SCHEMA_VERSION = 3;

module.exports = {
  PROJECT_ROOT,
  SETTINGS_PATH,
  BACKEND_DIR,
  FRONTEND_DIST_INDEX,
  DEV_SERVER_URL,
  DEV_SERVER_PARSED,
  DEV_SERVER_ORIGIN,
  DEV_WS,
  DEFAULT_PORT,
  MAX_BACKEND_RESTARTS,
  HEALTH_POLL_INTERVAL_MS,
  HEALTH_POLL_ATTEMPTS,
  HEALTH_REQUEST_TIMEOUT_MS,
  BACKEND_HEALTH_RETRY_INTERVAL_MS,
  EXPORT_REQUEST_TIMEOUT_MS,
  SQLITE_USER_VERSION_OFFSET,
  SQLITE_USER_VERSION_LEN,
  SQLITE_HEADER_SIZE,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  STOP_BACKEND_TIMEOUT_MS,
  KILL_EXIT_GRACE_MS,
  COPY_RETRY_SLEEP_MS,
  COPY_RETRY_ATTEMPTS,
  BACKUP_DIR_PREFIX,
  BACKUP_NAME_PREFIX_RE,
  SQLITE_WAL_SUFFIXES,
  PACKAGED_BACKEND_DIR,
  PACKAGED_BACKEND_EXE,
  BACKUP_SORT_KEY_RE,
  EXPORT_MAX_RESPONSE_BODY_BYTES,
  RESUME_STORAGE_KEY,
  MAX_RESUME_SAVE_BYTES,
  SETTINGS_STATUS,
  TIMEOUT_ERR,
  RESPONSE_TOO_LARGE_ERR,
  TOKEN_FILE_TTL_MS,
  TOKEN_FILE_WRITE_RETRIES,
  TOKEN_FILE_WRITE_RETRY_DELAY_MS,
  BACKEND_PROXY_MAX_BODY_BYTES,
  BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES,
  BACKEND_PROXY_TIMEOUT_MS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_APPLICATIONS,
  MAX_IMPORT_POST_BODY_BYTES,
  IMPORT_JSON_DIALOG_OPTIONS,
  ALLOWED_LLM_BASE_URL_HOSTS,
  LOCALHOST_LLM_BASE_URL_HOSTS,
  EXTERNAL_URL_SCHEMES,
  DEFAULT_EXTERNAL_HOST_SUFFIXES,
  DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED,
  DEFAULT_MAX_AUTO_BACKUPS,
  MS_PER_MINUTE,
  HASH_READ_BUFFER_BYTES,
  PREVIEW_SAMPLE_LIMIT,
  DB_SCHEMA_VERSION,
  getSettingsPath,
  getDataDir,
  getBackupDir,
};
