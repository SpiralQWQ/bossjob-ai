/**
 * 预加载桥接（preload）—— 渲染进程与主进程的唯一通信通道。
 *
 * 安全基线（架构 v0.2）：contextIsolation=true + nodeIntegration=false，
 * 渲染进程无 Node 权限，仅能调用这里暴露的最小 API 面。
 *
 * 配置持久化依赖（既有设计取舍，非缺陷）：主配置（cities/llm/apply/browser/blacklist/security）
 * 的读写单一走后端 HTTP GET/PUT /api/settings（前端 settingsStore 经 api.backendRequest 代理），
 * 本桥【不】提供 settings.json 的离线 IPC 读写（无 get-settings-file / save-settings-file，
 * 亦无 api.getSettingsSnapshot / api.saveSettingsFile）。因此后端启动失败时「设置」页不可用且无降级
 * —— 这是 CHANGELOG 已确认的单路径持久化决策（配置落盘唯一由后端 PUT 负责，api_key 不出后端）。
 * 对比：备份配置（getBackupInfo / updateBackupSettings）由主进程直接读写 settings.json 的 backup 段，
 * 后端离线时仍可用。若未来需覆盖后端离线的配置场景，须在 main.js 增加对应 IPC 并在本桥暴露
 * api.getSettingsSnapshot() / api.saveSettingsFile()（复用 getSettingsPath + sanitizeSettingsForDisk 口径）。
 *
 * 当前暴露（仅保留渲染进程实际消费的最小 API 面）：
 *   api.getBootstrapInfo()                    -> Promise<{port}>  一次性获取启动常量（后端端口，唯一引导通道）
 *   api.backendRequest(req)                   -> Promise<{ok,status,body}>  经主进程代理访问本地后端（唯一鉴权通道，req: {method,path,body?}，status 0=后端不可达）
 *   api.onBackendError(callback)              -> () => void        订阅后端启动失败消息（订阅时回放最近一次，若无则后续推送），返回取消订阅函数
 *   api.onBackendReady(callback)              -> () => void        订阅后端就绪消息（携带 { version, port }，订阅时回放最近一次），返回取消订阅函数
 *   api.onBackendRestarting(callback)         -> () => void        订阅后端崩溃重启进度（订阅时回放最近一次，若无则后续推送），返回取消订阅函数
 *   api.exportData()                          -> Promise<{canceled,ok,path?,error?}>  导出全部数据（另存为 JSON，载荷含脱敏 settings 供跨机器迁移配置）
 *   api.previewExportData()                   -> Promise<{ok,payload?,error?}>  预览导出载荷（不落盘、不弹「另存为」对话框）：与 exportData 同构的完整脱敏载荷（applications+apply_logs+脱敏 settings+resume 快照），供「数据」页导出前确认文件实际内容
 *   api.exportCsv()                           -> Promise<{canceled,ok,path?,error?}>  导出投递记录为 CSV（UTF-8 BOM + 表头，Excel 可直接打开）
 *   api.previewImportData()                   -> Promise<{canceled,ok,path?,preview?,error?}>  预览导入（先弹「打开文件」对话框读取校验 JSON，不落库）：preview={applications,applyLogs,hasSettings,overwriteIds} 供导入前确认弹窗展示，与导出侧 previewExportData 对称
 *   api.importData(path?)                      -> Promise<{canceled,ok,path?,importedCount?,skippedCount?,updatedCount?,settingsStatus?,resumeStatus?,error?}>  从「导出数据」JSON 文件导入全部数据（含可选 settings 合并与 resume 简历快照恢复）；传入 previewImportData 返回的 path 可跳过「打开文件」对话框直接导入已确认文件
 *   api.backupData()                          -> Promise<{canceled,ok,path?,error?}>  手动备份 app.db + settings.json + 简历快照 resume.json（备份同时写入 manifest.json 记录 SHA-256 校验和）
 *   api.backupNow() -> Promise<{ok,name,path?,error?}>  立即备份到自动备份目录
 *   api.exportBackup(opts?)                    -> Promise<{canceled,ok,path?,name?,error?}>  一键打包为单一 .zip 便携归档（自动备份最新一份 / opts.dir 指定备份，含 app.db+settings.json+resume.json+manifest.json 四件套）
 *   api.importBackup()                         -> Promise<{canceled,ok,path?,settingsStatus?,preRestoreSnapshot?,importedBackupName?,error?}>  导入 .zip 归档：解压后复用 restore-data 的 schema/integrity/manifest 校验链路落库
 *   api.restoreData(opts?)                   -> Promise<{canceled,ok,path?,settingsStatus?,preRestoreSnapshot?,error?}>  从备份目录恢复；opts.includeSettings=false 仅恢复 app.db（保留当前 LLM 配置与简历快照）；preRestoreSnapshot={name,path} 为覆盖前自动快照的当前数据（可回滚点）
 *   api.openBackupDir()                       -> Promise<{ok,error?}>                   在系统文件管理器中打开自动备份目录
 *   api.listBackups()                         -> Promise<Array<{name,path,createdAt,sizeBytes,fileCount,hasResume,checksumOk}>>  枚举应用内可见的备份列表（最新在前；hasResume=是否含简历快照；checksumOk=true/false/null 三态完整性标识）
 *   api.previewBackup(name)                   -> Promise<{ok,appCount,latestRecordAt,schemaVersion,hasSettings,settingsStatus,hasResume,checksumOk?,samples?,error?}>  预览备份内容供恢复前确认；ok=false 且带 error 表示备份无法读取（损坏/权限/越界/非法名称），调用方必须先判 ok===false/error 并报错返回，不得把默认值渲染成「0 条记录」空预览；hasResume=备份是否含 resume.json；checksumOk=manifest 校验和是否匹配（true/false，旧版备份无 manifest 为 null）；samples=备份内最新 10 条投递记录样例（形如 [{job_title,company,status,applied_at}]，供恢复确认弹窗展示备份实际内容）
 *   api.deleteBackup(name)                    -> Promise<{ok,error?}>                   删除自动备份目录下的单个备份（应用内管理，免去文件管理器手工清理）
 *   api.getBackupInfo()                       -> Promise<{backupDir,lastBackupAt,totalBackups,maxBackups,autoBackupEnabled,intervalMinutes}>  查询自动备份健康状态（目录/最近备份/保留份数/上限/定时开关/间隔分钟数）
 *   api.updateBackupSettings(cfg)             -> Promise<{ok,settings?,error?}>  修改自动备份配置（保留上限/定时开关/备份间隔），主进程持久化到 settings.json 的 backup 段
 *   api.openExternal(url)                     -> Promise<{ok,error?}>                   经系统浏览器打开外部链接（仅放行 http/https）
 *   api.reloadExternalAllowlist()             -> Promise<{ok}>     刷新外部链接放行域名白名单缓存（设置页保存后调用，免重启生效）
 *   api.notifyResumeSaved(resume)             -> Promise<{ok,error?}>  通知主进程简历已保存/已清空（resume.json 立即落盘或删除，供备份/导出/恢复使用）。
 *                                               返回契约 {ok,error?}：调用方【必须】await 并检查 ok —— ok:false 表示磁盘快照未落盘/未删除（写入失败等），
 *                                               主进程 readRendererResume 仍优先读数据目录 resume.json，备份/导出/恢复将拿到过期快照（仅磁盘副本缺失才降级读 localStorage），
 *                                               因此 UI 不得在 ok:false 时显示「已保存」，须向用户提示保存失败。
 *   api.getResumeSnapshot()                   -> Promise<{ok,resume?}>  读取数据目录 resume.json 权威快照（恢复/导入后主进程 writeRendererResume 已双写）——
 *                                               ResumePage 挂载时回灌渲染层 localStorage 与表单，避免 UI 显示旧 localStorage 简历、下次保存覆盖写回磁盘
 *                                               （静默丢失被恢复的简历）；磁盘副本缺失/不可解析返回 {ok:false}，调用方降级 localStorage 初始化。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 每通道缓冲最近一次载荷，供后注册的订阅者回放。
// 主进程只在 did-finish-load 一次性刷新 buffered backend 信号，晚订阅的渲染层若仅靠 push 会永久错过；
// 这里用 has()（而非真值判断）判定，兼容 payload 为 null / undefined 的合法载荷。
const lastPayloadByChannel = new Map();

// 并发订阅复用同一后端状态拉取 promise：同一通道缓冲为空时多个订阅者各自 invoke，
// 后 resolve 者会被前者的缓冲写入覆盖判定（has() 守卫）误吞，导致该订阅者永久错过回放。
const inFlightPullByChannel = new Map(); // channel -> Promise<payload>

// 模块加载即注册纯缓冲监听（不回调任何订阅者）：preload 先于页面脚本执行、早于 did-finish-load，
// 故主进程在窗口加载完成时一次性冲刷的 backend 信号必然先落缓冲；
// 此前缓冲只发生在 subscribe() 注册时（即渲染组件挂载时），若冲刷早于首次订阅仍会永久丢消息，
// 这里从根上消除「首次订阅晚于冲刷」的残余竞态，晚订阅者总能回放到最近一次载荷。
const BACKEND_PUSH_CHANNELS = ['backend-ready', 'backend-error', 'backend-restarting'];
for (const ch of BACKEND_PUSH_CHANNELS) {
  ipcRenderer.on(ch, (_e, payload) => {
    // 状态迁移失效：命中新终态时清除被其取代的旧状态缓冲，
    // 防止晚订阅者（如 Data 页晚挂载）在后端已恢复后仍回放过期的失败/重启进度载荷。
    if (ch === 'backend-ready') {
      lastPayloadByChannel.delete('backend-error');
      lastPayloadByChannel.delete('backend-restarting');
    } else if (ch === 'backend-error') {
      lastPayloadByChannel.delete('backend-ready');
      lastPayloadByChannel.delete('backend-restarting');
    } else if (ch === 'backend-restarting') {
      // 后端已进入重启：清除被其取代的「就绪」缓冲，避免晚订阅者误以为后端仍可用。
      // 不清除 backend-error：Dashboard 刻意保留最近失败原因（backendErrorRef 守卫优先展示错误）。
      lastPayloadByChannel.delete('backend-ready');
    }
    lastPayloadByChannel.set(ch, payload);
  });
}

// 每个通道按回调身份去重 + 引用计数：同一回调重复订阅同一通道时不再返回 no-op，
// 而是复用同一个 IPC 监听并对该 (channel, callback) 计数 +1；每次退订只把计数 -1，
// 仅当最后一个订阅者退订时才真正移除 ipcRenderer 监听并清掉注册表项。
// 既避免 React 双挂载/卸载未清理等场景重复 ipcRenderer.on 导致每次后端推送被双重分发 + 监听器泄漏，
// 又保证共享同一回调引用的多个消费者中一个退订不会让其余消费者失去实时后端推送。
const callbackRegistryByChannel = new Map(); // channel -> Map<callback, { listener, count }>

// 后端状态通道 → 主进程 get-backend-state 返回快照中的字段名（窗口 reload 后本缓冲重建为空的兜底拉取映射）。
const BACKEND_STATE_CHANNEL_KEY = {
  'backend-ready': 'ready',
  'backend-error': 'error',
  'backend-restarting': 'restarting',
};
// 只读拉取主进程当前缓冲的后端状态快照（{ ready, error, restarting }，未发生的字段为 null）。
// 主进程仅在状态变迁时推送，窗口 reload 后本进程缓冲为空又无新推送时，靠它在 subscribe 时兜底补投递。
const getBackendState = () => ipcRenderer.invoke('get-backend-state').catch(() => null);

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') {
    console.warn('[preload] subscribe requires a function callback (channel=' + channel + ')');
    return () => {};
  }
  let registry = callbackRegistryByChannel.get(channel);
  if (!registry) {
    registry = new Map();
    callbackRegistryByChannel.set(channel, registry);
  }
  let entry = registry.get(callback);
  if (!entry) {
    const listener = (_e, payload) => {
      // 缓冲写入由模块级监听（BACKEND_PUSH_CHANNELS 循环）统一完成，
      // 其同时负责跨通道状态迁移失效清理；此处仅分发回调，避免依赖注册顺序的重复写缓冲。
      try { callback(payload); } catch (err) { console.error('[' + channel + '] callback error', err); }
    };
    entry = { listener, count: 0 };
    registry.set(callback, entry);
    // 仅首次注册（该回调在该通道尚无条目）时回放缓冲，复用注册跳过回放，避免同一载荷被重复投递。
    if (lastPayloadByChannel.has(channel)) {
      // null/undefined 表示「该通道无事件」哨兵：保留 has() 防重复 invoke 的优化，但不向消费者投递空载荷，
      // 否则健康后端下 onBackendError/onBackendRestarting 会收到 callback(null)，Dashboard 误判状态/解构抛 TypeError。
      const buffered = lastPayloadByChannel.get(channel);
      if (buffered !== null && buffered !== undefined) {
        try { callback(buffered); } catch (err) { console.error('[' + channel + '] replay callback error', err); }
      }
    } else if (BACKEND_STATE_CHANNEL_KEY[channel]) {
      // 窗口 reload 后本进程缓冲被重建为空、主进程又无新推送时，晚订阅者会既收不到回放也收不到推送：
      // 经只读 invoke 拉取主进程当前缓冲的后端状态兜底。并发订阅复用同一 in-flight 拉取 promise，
      // 避免各自 invoke 被 has() 守卫相互误吞；null/undefined 载荷也写回缓冲哨兵（has() 判定），
      // 后续订阅直接回放、不再重复 invoke。
      let pull = inFlightPullByChannel.get(channel);
      if (!pull) {
        pull = getBackendState()
          .then((state) => {
            const payload = state ? state[BACKEND_STATE_CHANNEL_KEY[channel]] : undefined;
            // 竞态守卫：invoke 拉取期间若主进程已推送真实载荷（模块级 listener 已写入缓冲），
            // 此处不得用「invoke 时刻的旧快照」覆盖它——否则 pull.then 内
            // 「lastPayloadByChannel.get(channel) !== payload」守卫会因缓冲已被本拉取写回而永远不触发，
            // 导致陈旧载荷绕过去重重复分发。仅当拉取期间无真实推送时才写回快照。
            if (!lastPayloadByChannel.has(channel)) {
              lastPayloadByChannel.set(channel, payload);
            }
            return payload;
          })
          .catch(() => undefined);
        inFlightPullByChannel.set(channel, pull);
        pull.finally(() => { inFlightPullByChannel.delete(channel); }).catch(() => {});
      }
      pull.then((payload) => {
        // 拉取期间已有真实推送覆盖缓冲（非本拉取写回）→ 该推送已走 per-callback 监听分发，兜底让位避免重复投递
        if (lastPayloadByChannel.get(channel) !== payload && lastPayloadByChannel.has(channel)) return;
        // 仅 backend-restarting 在拉取路径直接回调：该通道没有 did-finish-load 冲刷（flushPendingSignals
        // 只补发 backend-ready/backend-error），拉取是 reload 后唯一补投递路径，直接回调不会重复。
        // ready/error 一律只写缓冲、不在此回调（原因见旧注释：会与冲刷推送重复投递非幂等副作用）。
        // 退订竞态守卫：异步 resolve 后可能已退订（entry.count===0），不再向已卸载消费者投递。
        if (channel === 'backend-restarting' && payload !== null && payload !== undefined && entry.count > 0) {
          try { callback(payload); } catch (err) { console.error('[' + channel + '] pull-state callback error', err); }
        }
      });
    }
    ipcRenderer.on(channel, listener);
  }
  entry.count += 1;
  let released = false;
  return () => {
    if (released) return; // 幂等退订：同一返回的退订函数重复调用不再影响共享计数
    released = true;
    entry.count -= 1;
    if (entry.count <= 0) {
      ipcRenderer.removeListener(channel, entry.listener);
      registry.delete(callback);
      if (registry.size === 0) callbackRegistryByChannel.delete(channel);
    }
  };
};

// 桥接层纵深防御：渲染进程参数最小类型门禁 —— 主进程仍是单一事实来源（各 handler 内部
// 仍做语义校验），此处仅拦截明显畸形的渲染进程调用，使其在进入 ipcMain 前快速失败并返回
// 结构化 { ok:false, error }，不改变合法调用的行为。
const isPlainObject = (v) => Object.prototype.toString.call(v) === '[object Object]';
const rejectPayload = (error) => Promise.resolve({ ok: false, error });

// 外部链接 scheme 白名单：单一事实来源在主进程（EXTERNAL_URL_SCHEMES，见 main.js open-external），
// preload 加载时经 sendSync 一次性同步下发。openExternal 的桥接预检与主进程强校验共用同一名单，
// 避免两处硬编码 http/https 随 scheme 演进漂移；主进程始终是最终裁决，此处仅作纵深防御预检。
// 兜底数组仅在极端时序（主进程 handler 未注册）下使用，不影响主进程的权威校验。
// 外部链接 scheme 白名单（主进程是单一事实来源）：改为惰性异步拉取（首次 openExternal 时 invoke），
// 消除模块加载期 sendSync 同步阻塞渲染进程初始化的反模式；名单规范化（补尾冒号+小写）后再比对，
// 避免主进程下发名单缺冒号/含大写时 preload 预检与主进程权威校验结果不一致。
let externalUrlSchemes = null;
const normalizeSchemes = (schemes) =>
  (Array.isArray(schemes) && schemes.length > 0 ? schemes : ['http:', 'https:']).map((s) => {
    let str = String(s);
    if (!str.endsWith(':')) str += ':';
    return str.toLowerCase();
  });
const ensureExternalSchemes = () => {
  if (externalUrlSchemes) return Promise.resolve(externalUrlSchemes);
  return ipcRenderer.invoke('get-external-url-schemes')
    .then((schemes) => { externalUrlSchemes = normalizeSchemes(schemes); return externalUrlSchemes; })
    .catch(() => { externalUrlSchemes = ['http:', 'https:']; return externalUrlSchemes; });
};

contextBridge.exposeInMainWorld('api', {
  /**
   * 一次性获取渲染层启动所需的后端端口（会话级常量），唯一引导通道
   * （历史上的 get-backend-port / get-csrf-token 已并入本通道，削减启动延迟与 IPC 流量）。
   * 返回 Promise<{ port: number }>。
   */
  getBootstrapInfo: () => ipcRenderer.invoke('get-bootstrap-info'),
  /**
   * 只读拉取主进程当前缓冲的后端状态快照（{ ready, error, restarting }，未发生的状态字段为 null）：
   * 窗口 reload 后本桥缓冲（lastPayloadByChannel）被重建为空、主进程又仅在状态变迁时推送，
   * 晚订阅 onBackendReady/onBackendError/onBackendRestarting 的组件可经本通道主动拉取当前状态兜底；
   * subscribe 首次注册且缓冲为空时亦会自动调用本通道补投递。返回 Promise<快照>。
   */
  getBackendState: () => ipcRenderer.invoke('get-backend-state'),
  /**
   * 经主进程代理访问本地后端（backend-request IPC）——渲染层访问 /api/* 的【唯一】鉴权通道：
   * 主进程按端点白名单（method + path）强制校验并附加 Bearer 鉴权令牌，渲染层直连后端不再携带凭证。
   * req: { method, path, body? }；返回 Promise<{ ok, status, body }>（body 为响应体文本，status 0=后端不可达）。
   */
  backendRequest: (req) =>
    isPlainObject(req) && typeof req.method === 'string' && typeof req.path === 'string'
      ? ipcRenderer.invoke('backend-request', req)
      : rejectPayload('backendRequest 需要 { method, path } 对象'),
  /**
   * 订阅主进程推送的后端启动失败原因（如 Python 不在 PATH / 打包 exe 缺失）。
   * 返回取消订阅函数，供组件卸载时调用以避免重复订阅。
   */
  onBackendError: (callback) => subscribe('backend-error', callback), // 已缓冲最近一次失败原因，晚订阅者立即收到回放
  /**
   * 订阅主进程推送的后端就绪信号（启动 / 重启后 waitForBackendHealth 通过时发送，
   * 携带 { version, port } 载荷：version 为后端版本（缺失时为 null），
   * port 为后端当前监听端口，恢复 settings.json 后端口可能变化，渲染层应以此刷新）。
   * 返回取消订阅函数，供组件卸载时调用以避免重复订阅。
   */
  onBackendReady: (callback) => subscribe('backend-ready', callback), // 已缓冲最近一次就绪信号，晚订阅者立即收到回放
  /**
   * 订阅主进程推送的后端崩溃自动重启进度（守护循环每次重启前发送 { attempt, max }）。
   * 返回取消订阅函数，供组件卸载时调用以避免重复订阅。
   */
  onBackendRestarting: (callback) => subscribe('backend-restarting', callback), // 已缓冲最近一次重启进度，晚订阅者立即收到回放
  /**
   * 导出全部数据：主进程从本地后端拉取全量 JSON（敏感字段已剔除），
   * 弹出「另存为」对话框并写入用户选择的路径。
   * 载荷内的 settings 段为主进程按 sanitizeSettingsForDisk 口径再剥离
   * llm.api_key / llm.base_url 后的公开快照，可随导入跨机器迁移「配置」。
   * 返回 { canceled: boolean, ok: boolean, path?: string, error?: string }。
   */
  exportData: () => ipcRenderer.invoke('export-data'),
  /**
   * 预览导出载荷（不落盘、不弹「另存为」对话框）：
   * 主进程复用 fetchExportPayload 拉取 /api/export 全量 JSON（applications + apply_logs + 脱敏 settings），
   * 并按 exportData 同口径剥离 llm.base_url / 并入 resume 快照后原样返回，
   * 供「数据」页在导出前渲染『导出内容预览』，确认文件里实际包含什么。
   * 返回 { ok: boolean, payload?: object, error?: string }。
   */
  previewExportData: () => ipcRenderer.invoke('preview-export-data'),
  /**
   * 导出投递记录为 CSV（UTF-8 BOM + 表头，Excel 可直接打开统计）：
   * 主进程从本地后端拉取 /api/export 后取 applications 段扁平化为表格，并与 JSON 导出同数据源，
   * 每行追加 apply_logs 投递日志时间线列（该投递的『action | 时间 | 备注』，无日志留空），
   * 覆盖 applications + apply_logs 全表，可在 Excel 做『投递→约面→offer』漏斗/时长分析。
   * 弹出「另存为」对话框写入。返回 { canceled, ok, path?, error? }，与 exportData 同构。
   */
  exportCsv: (filter) =>
    filter === undefined || filter === null || isPlainObject(filter)
      ? ipcRenderer.invoke('export-data-csv', filter)
      : rejectPayload('exportCsv 的 filter 必须是对象或省略'),
  /**
   * 离线导出全部数据（export-data-offline IPC，后端不可达降级通道）：
   * 复用主进程 stageDbForRead + node:sqlite 读备份库逻辑，从自动备份目录最新一份备份的 app.db
   * 序列化 applications + apply_logs 为 JSON（opts.format 缺省）或 CSV（opts.format='csv'）后弹「另存为」落盘。
   * 与 exportData/exportCsv 同构，但【不依赖 GET /api/export】——后端崩溃/端口冲突（应用显式处理的常见态）
   * 下仍可导出，让「数据」页导出/投递日志按钮在错误态下降级走离线数据。
   * 返回 { canceled, ok, path?, backupName?, error? }（backupName=数据来源的最新备份名）。
   */
  exportBackupData: (opts) =>
    opts === undefined || opts === null || isPlainObject(opts)
      ? ipcRenderer.invoke('export-data-offline', opts)
      : rejectPayload('exportBackupData 的 opts 必须是对象或省略'),
  /**
   * 离线导出内容预览（preview-export-data-offline IPC，不落盘、不弹对话框）：
   * 读自动备份目录最新一份备份的 app.db，返回与 previewExportData 同构的载荷
   * { applications, apply_logs }（不含 settings/resume），供「数据」页错误态下
   * 「预览导出内容」/「投递日志」按钮降级使用（此时预览的是备份快照，非实时数据）。
   * 返回 { ok, payload?, backupName?, error? }。
   */
  previewBackupExport: () => ipcRenderer.invoke('preview-export-data-offline'),
  /**
   * 导入全部数据：主进程弹出「打开文件」对话框选择由「导出数据」生成的 JSON 文件，
   * 校验载荷（顶层对象且含 applications 数组）后 POST 到本地后端 /api/import（按 id 覆盖/新建），
   * 载荷含可解析 settings 段时先合并写入当前 settings.json（剥离凭据/提供商重定向字段，
   * 保留当前 LLM 密钥），成功后推送 backend-ready。闭合「导出→恢复」回路，让导出的 JSON 可经应用内重新导入。
   * 载荷含 resume 段时主进程经 writeRendererResume 双写数据目录 resume.json，一并恢复简历快照。
   * 返回 { canceled, ok, path?, importedCount, skippedCount, updatedCount, settingsStatus?, resumeStatus?, error? }，
   * 其中 importedCount=新增条数 / updatedCount=覆盖更新条数 / skippedCount=跳过条数，
   * settingsStatus（与 restoreData 取值对齐）：'restored' | 'retained_credentials_stripped'
   *   | 'parse_failed' | 'missing'，供渲染进程提示「配置已合并 / 配置解析失败」；
   * resumeStatus：'restored'=简历快照已一并恢复 / 'missing'=载荷无 resume 段 / 'write_failed'=落盘失败。
   */
  importData: (path) =>
    typeof path === 'string' || path === undefined || path === null
      ? ipcRenderer.invoke('import-data', path)
      : rejectPayload('path 必须是字符串或省略'),
  previewImportData: () => ipcRenderer.invoke('preview-import-data'),
  /**
   * 手动备份全部数据：主进程弹出「打开目录」对话框，用户选择父目录后自动创建
   * BossJobAI-backup-<时间戳> 子目录并快照 app.db + settings.json + 简历快照 resume.json，
   * 备份同时写入 manifest.json 记录各文件 SHA-256 校验和（供 preview-backup / restore-data 完整性验证）。
   * 返回 { canceled, ok, path?, error? }，供渲染进程提示结果。
   */
  backupData: () => ipcRenderer.invoke('backup-data'),
  /**
   * 立即备份全部数据（应用内可见）：不走文件夹选择器，直接快照 app.db + settings.json + 简历快照 resume.json 到
   * 自动备份目录（与自动备份同源逻辑：同名 BossJobAI-backup-<时间戳>、同样执行保留上限裁剪），
   * 快照立即出现在 listBackups() 列表并被 maxBackups 保留策略管理。
   * 返回 { ok, name, path?, error? }，供渲染进程在破坏性操作前快速落一份「应用可见」快照。
   */
  backupNow: () => ipcRenderer.invoke('backup-now'),
  /**
   * 导出便携备份归档：把自动备份目录里最新一份备份（或 opts.dir 指定备份）打包为单一 .zip
   * （含 app.db + settings.json + resume.json + manifest.json 四件套），弹出「另存为」对话框写入。
   * 为纯产品经理型用户提供「一键打包为单文件」的跨机器 / 移动介质迁移形态，无需整目录拷贝。
   * 返回 { canceled, ok, path?, name?, error? }（name=被打包备份的目录名）。
   */
  exportBackup: (opts) =>
    opts == null
      ? ipcRenderer.invoke('export-backup-archive', {})
      : isPlainObject(opts)
        ? ipcRenderer.invoke('export-backup-archive', opts)
        : rejectPayload('exportBackup 的 opts 必须是对象或省略'),
  /**
   * 导入便携备份归档：弹出「打开文件」对话框选择由 exportBackup 生成的 .zip，
   * 主进程解压到临时目录后复用 restore-data 的完整校验链路（schema 版本 + integrity_check + manifest 校验和）
   * 落库并重启后端——与「应用内恢复备份」同一安全口径，闭合单文件归档的「导出→导入」回路。
   * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, importedBackupName?, error? }。
   */
  importBackup: () => ipcRenderer.invoke('import-backup-archive'),
  /**
   * 恢复全部数据：opts.dir 传入应用内备份列表（listBackups）给出的备份目录绝对路径时直接恢复该备份，
   * 免去系统目录选择器（主进程校验该路径必须落在自动备份目录内，与 delete-backup 同款路径穿越防护）；
   * opts.dir 缺省/为空时弹出「打开目录」对话框由用户手工选择备份目录（BossJobAI-backup-*）作为回退路径。
   * 校验备份 schema 版本兼容并验证 manifest 校验和（旧版备份无 manifest 时降级依赖 PRAGMA integrity_check）后，
   * 先停后端再覆盖写入 app.db（+ settings.json，视 opts 而定），随后重启后端。
   * opts.includeSettings 为 false 时仅恢复 app.db（投递记录），保留当前 settings.json（含 LLM 配置）与简历快照；
   * 缺省/true 时恢复 settings.json（安全剥离 llm.api_key / llm.base_url）并一并恢复简历快照。
   * 返回 { canceled, ok, path?, settingsStatus?, preRestoreSnapshot?, error? }，其中 settingsStatus 取
   *   'restored'（settings 已还原）| 'retained_credentials_stripped'（还原但剥离了 LLM 凭据）
   *   | 'backup_missing'（备份无 settings.json，保留当前）| 'parse_failed'（备份 settings 不可解析，保留当前）
   *   | 'retained'（includeSettings=false，settings 完全保留），供渲染进程如实提示用户；
   * preRestoreSnapshot={name,path} 为破坏性覆盖前自动快照的当前数据（可回滚点），快照失败时为 null。
   */
  restoreData: (opts) =>
    opts == null
      ? ipcRenderer.invoke('restore-data', {})
      : isPlainObject(opts)
        ? ipcRenderer.invoke('restore-data', opts)
        : rejectPayload('restoreData 的 opts 必须是对象或省略'),
  /**
   * 在系统文件管理器中打开自动备份目录（打包模式 %APPDATA%/BossJobAI/backups，开发模式 code/.backups）。
   * 返回 Promise<{ ok: boolean, error?: string }>。
   */
  openBackupDir: () => ipcRenderer.invoke('open-backup-dir'),
  /**
   * 枚举自动备份目录下的全部备份（BossJobAI-backup-*，最新在前），
   * 供渲染层渲染备份列表（名称/创建时间/大小/文件数/是否含简历/完整性标识）并在应用内选择要恢复的备份。
   * 每项额外携带 hasResume（是否含简历快照 resume.json）与 checksumOk：
   *   - true：备份 manifest 校验和全部通过（app.db/WAL、settings.json、resume.json 各自独立校验均一致）；
   *   - false：manifest 存在但任一文件校验和不匹配（备份被截断、损坏或篡改）——「数据」页应直接标红；
   *   - null：旧版备份无 manifest.json，无法校验（仅能依赖 SQLite PRAGMA integrity_check）。
   * 返回 Promise<Array<{ name, path, createdAt, sizeBytes, fileCount, hasResume, checksumOk }>>，目录不存在时为空数组。
   */
  listBackups: () => ipcRenderer.invoke('list-backups'),
  /**
   * 预览单个备份的内容：统计 applications 记录数、最近投递时间（applied_at）、schema 版本、
   * settings.json 是否存在及其解析状态、是否含简历快照。只读不落盘、不触发恢复，供恢复确认对话框展示。
   * 返回 Promise<{ appCount, latestRecordAt, schemaVersion, hasSettings, settingsStatus, hasResume, resumeSummary?, checksumOk?, samples? }>，
   *   hasResume=备份目录是否存在 resume.json（恢复确认弹窗据此如实提示『简历将一并还原 / 备份中无简历』）；
   *   resumeSummary=备份内 resume.json 的摘要字段 {name,phone,email}（hasResume 为 false 或 resume.json 损坏时为 null），
   *     供恢复前确认弹窗展示「这份备份是哪一版简历（姓名/联系方式）」，多版简历场景下可据此区分备份；
   *   checksumOk=备份 manifest 校验和是否匹配（true/false；旧版备份无 manifest 为 null）；
   *   samples=备份内最新 10 条投递记录样例（可选数组，形如 [{ job_title, company, status, applied_at }]，
   *     只读不落盘，供恢复前确认弹窗展示备份实际内容，让用户确认「备份里有没有某公司/某职位」）。
   *   注意：checksumOk 是 app.db(含 WAL 三件套)、settings.json、resume.json 各自独立 SHA-256 校验的联合结果，
   *   任一文件被截断/损坏/篡改即 false——它不代表「app.db 完好即整份备份完好」。
   */
  previewBackup: (name) =>
    typeof name === 'string'
      ? ipcRenderer.invoke('preview-backup', name)
      : rejectPayload('backup name must be a string'),
  /**
   * 删除自动备份目录下的单个备份（BossJobAI-backup-*）。
   * 主进程会校验备份名称并做路径穿越防护，仅允许删除自动备份目录内的备份；
   * 与 listBackups 配对，供「数据」页为每个备份渲染删除按钮，免去离开应用用系统文件管理器手工清理。
   * 返回 Promise<{ ok: boolean, error?: string }>。
   */
  deleteBackup: (name) =>
    typeof name === 'string'
      ? ipcRenderer.invoke('delete-backup', name)
      : rejectPayload('backup name must be a string'),
  /**
   * 查询自动备份健康状态：备份目录路径、最近一次备份时间、当前保留份数、保留上限，
   * 以及自动备份行为配置（autoBackupEnabled 定时开关 / intervalMinutes 备份间隔分钟数）。
   * 供「数据」页在导出/备份/恢复按钮旁展示备份概览（如「最近备份：…，N/7 份」）。
   * 返回 Promise<{ backupDir, lastBackupAt, totalBackups, maxBackups, autoBackupEnabled, intervalMinutes }>。
   */
  getBackupInfo: () => ipcRenderer.invoke('get-backup-info'),
  /**
   * 修改自动备份配置（保留份数上限 / 定时开关 / 备份间隔），主进程持久化到 settings.json 的 backup 段。
   * cfg 为 { maxBackups?, autoBackupEnabled?, intervalMinutes? } 的任意子集：
   * - maxBackups：保留份数上限（1~60 整数），保存后主进程立即轮转裁剪旧备份到新上限；
   * - autoBackupEnabled：是否启用定时自动备份（布尔）；
   * - intervalMinutes：定时备份间隔分钟数（1~1440 整数；null 取消定时）。
   * 返回 Promise<{ ok: boolean, settings?: { maxBackups, autoBackupEnabled, intervalMinutes }, error?: string }>。
   */
  updateBackupSettings: (cfg) =>
    isPlainObject(cfg) ? ipcRenderer.invoke('update-backup-settings', cfg) : rejectPayload('updateBackupSettings 的 cfg 必须是对象'),
  /**
   * 经系统浏览器打开外部链接（如 BOSS直聘职位页 / 公司主页）。
   * 主进程仅放行 http/https scheme，其余协议返回 { ok:false, error } 拒绝。
   * scheme 白名单与主进程共用同一来源（EXTERNAL_URL_SCHEMES，主进程同步下发）。
   * 返回 Promise<{ ok: boolean, error?: string }>。
   */
  openExternal: async (url) => {
    // 桥接层纵深防御：主进程仍是单一事实来源（仅放行 http/https），
    // 但此处提前做类型门禁 + scheme 校验，任何绕过主进程守卫的调用路径也会在此被拒，
    // 且转发的值必须是经校验的原始字符串（非字符串畸形载荷在门禁处即被拦截，不进入 IPC）。
    // scheme 名单与主进程 open-external 强校验共用（ensureExternalSchemes 惰性拉取），杜绝双处硬编码漂移。
    if (typeof url !== 'string') return { ok: false, error: '无效链接' };
    try {
      const schemes = await ensureExternalSchemes();
      const p = new URL(url).protocol;
      if (!schemes.includes(p)) return { ok: false, error: '仅允许 http/https 链接' };
    } catch {
      return { ok: false, error: '无效链接' };
    }
    return ipcRenderer.invoke('open-external', url);
  },
  /**
   * 刷新外部链接宿主扩展白名单缓存（设置页保存 security.external_url_hosts 后调用）：
   * 让主进程重新读盘 settings.json，使新配置的放行域名无需重启即可生效。
   * 返回 Promise<{ ok: boolean }>。
   */
  reloadExternalAllowlist: () => ipcRenderer.invoke('reload-external-allowlist'),
  /**
   * 通知主进程简历已保存 / 已清空（ResumePage 保存/清空时调用）：
   * 主进程立即把 resume.json 写入数据目录（保存即落盘），或清空时删除数据目录副本，
   * 使备份/导出/恢复有权威磁盘副本可用，不再仅依赖渲染层 localStorage。
   * 返回契约 Promise<{ ok: boolean, error?: string }>：调用方【必须】await 并检查 ok ——
   * ok:false（如磁盘写入失败）表示 resume.json 快照未同步，主进程 readRendererResume 仍优先读
   * 数据目录 resume.json，备份/导出/恢复将拿到过期快照（仅磁盘副本缺失才降级读 localStorage），
   * 因此 UI 不得在 ok:false 时提示「已保存」，须向用户展示保存失败原因（error）。
   */
  notifyResumeSaved: (resume) =>
    resume === null || resume === undefined || typeof resume === 'string' || isPlainObject(resume)
      ? ipcRenderer.invoke('resume-saved', resume)
      : rejectPayload('简历内容必须是字符串或对象'),
  /**
   * 读取数据目录 resume.json 权威快照（get-resume-snapshot IPC）：
   * 恢复/导入备份时主进程 writeRendererResume 已把恢复的简历双写进数据目录，ResumePage 挂载时
   * 经本通道拉取磁盘权威副本回灌 localStorage 与表单，避免 UI 仍显示旧 localStorage 简历、
   * 下一次保存用过期内容覆盖写回磁盘（静默丢失被恢复的简历）。
   * 返回 Promise<{ ok: boolean, resume?: object }>：磁盘副本缺失 / 不可解析 / 为空时返回
   * { ok:false }，调用方降级使用 localStorage 初始化（与 notifyResumeSaved 的磁盘优先语义一致）。
   */
  getResumeSnapshot: () => ipcRenderer.invoke('get-resume-snapshot'),
});
