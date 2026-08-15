/** Electron 主进程 · 共享可变状态（从 main.js 抽离：auth/backend/backup 各模块经本对象读写同一份状态，避免循环依赖）。
 *  单一事实源：模块只缓存一份，require 侧拿到同一对象引用 —— `state.xxx` 任意模块可读可写，改动全局可见。
 *  注意：state 仅承载「运行期可变状态」；纯常量与路径请用 modules/constants.js。 */

const { DEFAULT_PORT } = require('./constants');

/** 共享可变状态对象：所有字段初始值与原 main.js 模块级 let/const 一致。 */
const state = {
  /** 当前生效的本地后端鉴权令牌（whenReady 中初始化，供主进程直连后端请求使用）。 */
  authToken: '',

  /** 鉴权令牌指纹缓存：SHA-256(令牌) 前 16 位，whenReady 中一次性预计算，避免 /api/health 轮询重复哈希。 */
  authTokenFingerprint: '',

  /** 后端进程句柄与重启计数（后端守护模块状态）。 */
  backendProc: null,
  backendRestartCount: 0,

  /** 正在退出/主动停服标记：为 true 时后端退出不再触发重启。 */
  isShuttingDown: false,

  /** 数据恢复（restore-data）主动停服标记：为 true 时退出处理器的指数退避延迟重启也必须放弃，
   *  防止后端崩溃退出处理器在退避 sleep 期间被 restore 覆盖 app.db 时到期拉起新进程抢占 SQLite 锁。 */
  backendStoppedForRestore: false,

  /** 后端健康监测代际：startup / 每次后端崩溃重启都会递增；旧代际的周期复查在被取代时自我退出。 */
  backendHealthMonitorGeneration: 0,

  /** 健康预算超时后的周期复查定时器句柄（见 waitBackendReadyOrRetry）。 */
  backendHealthRetryTimer: null,

  /** 当前生效的后端端口（启动时解析一次，经 IPC 暴露）。 */
  backendPort: DEFAULT_PORT,

  /** 首次后端启动失败对话框是否已弹出（避免重复弹窗）。 */
  backendErrorDialogShown: false,

  /** 后端启动失败消息缓冲（模块级最新值）：窗口未创建 / 渲染进程未订阅 backend-error 时暂存，
   *  待窗口加载完成后冲刷补发。冲刷按窗口核对（backendErrorDelivered），不再因某一窗口冲刷而清空全局缓冲，
   *  避免多窗口场景下第一个窗口 did-finish-load 冲刷后其它窗口永久丢失 backend-error。 */
  pendingBackendError: null,

  /** 已消费当前 pendingBackendError 的 webContents id 集合：仅对「本窗口尚未消费该消息」的窗口补发；
   *  新错误代际 / 新的 backend-ready 会重建本集合；缓冲不清空，由各窗口 did-finish-load 冲刷按本集合判重补发。 */
  backendErrorDelivered: new Set(),

  /** 应用主窗口的 webContents 标识集合：本地后端令牌注入仅放行归属这些窗口的 XHR/fetch 数据请求。 */
  appWindowWebContentsIds: new Set(),

  /** import-data 安全：per-webContents 信任的导入文件路径集合。preview-import-data 对话框成功后登记所选路径，
   *  import-data 仅接受集合内路径（一次性消费），拒绝渲染进程拼装的任意本地路径，防同源 XSS 后读取任意可读 JSON。Map<wcId, Set<absPath>>。 */
  trustedImportPaths: new Map(),

  /** 当前一次性令牌文件路径：writeAuthTokenFile 写入后记录，后端读后即删为正常路径，
   *  本路径仅供「主进程确认后端就绪后」与退出时兜底删除 —— 彻底移除旧的盲 30s 清理定时器。 */
  authTokenFilePath: null,

  /** 一次性令牌文件 TTL 兜底清理定时器句柄（key-exposure 加固）：writeAuthTokenFile 写入令牌后起一个
   *  长宽限定时器（TOKEN_FILE_TTL_MS），届时若令牌文件仍存在（后端未读取：spawn 失败 / FAIL-OPEN /
   *  启动即崩 / 崩溃循环 / 就绪确认前进程崩溃）即删除 —— 覆盖「后端就绪确认前崩溃 / 鉴权 FAIL-OPEN 熔断
   *  不再触发 cleanupAuthTokenFile」的残留路径，避免明文令牌整会话滞留磁盘。 */
  authTokenFileTtlTimer: null,

  /** 鉴权 FAIL-OPEN 熔断标志（auth-bypass 修复）：为 true 时后端未正确载入令牌（检测见
   *  verifyBackendTokenFingerprint / reportBackendAuthFailure），渲染层一切后端请求被拒绝转发。 */
  backendAuthFailure: false,

  /** 最近一次后端就绪版本与待补发缓冲（供 notifyBackendReady 使用）。
   *  冲刷改为按窗口核对（backendReadyDelivered）：pendingBackendReady 保留最新就绪载荷，
   *  不因某一窗口 did-finish-load 冲刷而清空，之后创建的窗口加载完成后仍能补发。 */
  backendReadyVersion: null,
  pendingBackendReady: null,

  /** 已消费当前 pendingBackendReady 的 webContents id 集合：仅对「本窗口尚未消费该载荷」的窗口补发；
   *  新就绪代际 / 新的 backend-error 会重建本集合；缓冲不清空，由各窗口 did-finish-load 冲刷按本集合判重补发。 */
  backendReadyDelivered: new Set(),

  /** 外部链接宿主扩展白名单缓存：whenReady 启动时加载一次作为初始值；open-external 每次 IPC 打开前都会重读 settings.json 刷新本缓存，settings 热更新时也会刷新。 */
  cachedExternalHostAllowlist: null,

  /** 预归一化的宿主后缀数组（小写、去前导点）：由 DEFAULT_EXTERNAL_HOST_SUFFIXES_NORMALIZED + cachedExternalHostAllowlist 归一化一次生成，isExternalHostAllowed 只做 O(n) 迭代匹配。 */
  cachedExternalHostSuffixes: null,

  /** 最近一次白名单读盘时 settings.json 的 mtimeMs：open-external 前经它判断文件是否变更，未变则跳过读盘+JSON.parse。 */
  lastAllowlistMtime: null,

  /** 定时自动备份的 interval 句柄，由 syncBackupInterval() 统一启停。 */
  backupIntervalTimer: null,

  /** 自动备份配置的内存缓存：避免启动/定时备份路径上对 settings.json 反复同步 readFileSync+JSON.parse。
   *  getBackupSettings() 命中缓存直接返回；任何写 settings.json backup 段后失效，或按 mtime 检测失效。 */
  backupSettingsCache: null,

  /** 最近一次读 backup 段时 settings.json 的 mtimeMs：getBackupSettings() 经它判断文件是否被外部改写。 */
  lastBackupSettingsMtime: null,

  /** list-backups 的 manifest 校验和缓存：backupName -> { sig, checksumOk }（防数据页每次渲染对每个备份全量 SHA-256 阻塞主进程）。 */
  backupChecksumCache: new Map(),
};

module.exports = { state };
