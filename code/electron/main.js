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
const { timestamp, openDialog, saveDialog, errMsg, isPlainObject } = require('./modules/utils');
const {
  FRONTEND_DIST_INDEX,
  DEV_SERVER_URL, DEV_SERVER_ORIGIN, DEV_WS, DEFAULT_PORT,
  MAX_BACKEND_RESTARTS,
  BACKUP_DIR_PREFIX, SQLITE_WAL_SUFFIXES,
  MAX_RESUME_SAVE_BYTES,
  SETTINGS_STATUS, TIMEOUT_ERR, RESPONSE_TOO_LARGE_ERR,
  BACKEND_PROXY_MAX_BODY_BYTES, BACKEND_PROXY_TIMEOUT_MS,
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_APPLICATIONS, MAX_IMPORT_POST_BODY_BYTES, IMPORT_JSON_DIALOG_OPTIONS,
  ALLOWED_LLM_BASE_URL_HOSTS, LOCALHOST_LLM_BASE_URL_HOSTS,
  EXTERNAL_URL_SCHEMES,
  PREVIEW_SAMPLE_LIMIT,
  getDataDir, getBackupDir,
} = require('./modules/constants');
const { state } = require('./modules/state');
const {
  loadOrCreateAuthToken, cleanupAuthTokenFile, verifyBackendTokenFingerprint, writeAuthTokenFile,
} = require('./modules/auth');
const {
  httpRequest, httpPostText,
  resolveBackendPort, ensurePackagedSettings,
  startBackend, stopBackend, notifyBackendReady,
  waitForBackendHealth, waitBackendReadyOrRetry, stopBackendForRestore,
} = require('./modules/backend');
const {
  backupSortKey, fetchExportPayload, fetchExistingIds, buildExportPayload,
  readRendererResume, writeResumeJsonToDataDir, writeRendererResume, writeResumeSnapshotTo,
  applicationsToCsv, mergeImportedSettings, readLatestBackupExport,
  getBackupSettings, saveBackupSettings, syncBackupInterval,
  snapshotToDir, assertSafeMkdirTarget, newBackupName,
  verifyBackupManifest, rotateAutoBackups, snapshotAutoBackup, autoBackup,
  buildZipBuffer, parseZipBuffer, isPathInsideBackupDir, restoreBackupDir,
  readDbUserVersion, stageDbForRead, sanitizeSettingsForDisk, sanitizeBackendSettingsBody,
  restoreSettingsSafely, cachedBackupChecksumOk, resolveBackupDir,
  refreshExternalHostAllowlistCache, maybeRefreshExternalHostAllowlist, isExternalHostAllowed,
} = require('./modules/backup');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');

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

/** IPC 发送方是否归属应用主窗口（webContents 身份白名单）：
 *  当前仅 BrowserWindow.createWindow 登记的应用窗口在册；setWindowOpenHandler deny + will-navigate
 *  受限 + 未开 webviewTag 使今天不存在其它 webContents，但未来新增 webview / BrowserView /
 *  导航绕过回归时，非应用窗口将统一被拒 —— 防御纵深，防数据/备份/设置 IPC 被不可信 frame 触达。 */
const isAppSender = (e) => state.appWindowWebContentsIds.has(e && e.sender && e.sender.id);
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

/** 同步睡眠（Node 无原生 sync sleep）：仅在令牌文件重试的同步写路径使用。 */

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
  state.appWindowWebContentsIds.add(win.webContents.id);
  win.webContents.once('destroyed', () => {
    state.appWindowWebContentsIds.delete(win.webContents.id);
    state.trustedImportPaths.delete(win.webContents.id); // 回收该窗口已登记的导入信任路径，防 Map 泄漏
    state.backendReadyDelivered.delete(win.webContents.id); // 回收该窗口已消费标记，防 Set 泄漏
    state.backendErrorDelivered.delete(win.webContents.id);
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
      state.backendReadyDelivered.delete(wcId);
      state.backendErrorDelivered.delete(wcId);
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
    if (state.pendingBackendError !== null && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const wcId = win.webContents.id;
      if (!state.backendErrorDelivered.has(wcId)) {
        state.backendErrorDelivered.add(wcId);
        win.webContents.send('backend-error', state.pendingBackendError);
      }
    }
    // 冲刷缓冲的后端就绪信号：startup 阶段 waitForBackendHealth 可能在窗口加载完成前就绪，
    // notifyBackendReady 会把载荷暂存于此，待渲染进程订阅 backend-ready 后补发，避免信号永久丢失。
    // 同样按 webContentsId 核对已消费状态，冲刷不清空全局缓冲，之后创建的窗口也能补发。
    if (state.pendingBackendReady !== null && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const wcId = win.webContents.id;
      if (!state.backendReadyDelivered.has(wcId)) {
        state.backendReadyDelivered.add(wcId);
        win.webContents.send('backend-ready', state.pendingBackendReady);
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
  port: state.backendPort,
}));

// IPC：get-backend-state —— 只读拉取主进程当前缓冲的后端状态快照（{ ready, error, restarting }）。
// 供 preload 在窗口 reload 后缓冲（lastPayloadByChannel）被重建为空、主进程又仅在状态变迁时推送
// 的窗口期兜底拉取当前状态：覆盖「reload 前后端已就绪/失败、reload 后无新推送」导致晚订阅者
// 收不到任何信号（onBackendReady/onBackendError/onBackendRestarting）的缺口。
// 未发生的状态字段为 null；restarting 由模块级重启计数实时推导（计数 > 0 即处于崩溃重启循环）。
guardedHandle('get-backend-state', () => ({
  ready: state.pendingBackendReady,
  error: state.pendingBackendError,
  restarting: state.backendRestartCount > 0 ? { attempt: state.backendRestartCount, max: MAX_BACKEND_RESTARTS } : null,
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
  if (state.backendAuthFailure) {
    return { ok: false, status: 401, body: '{"detail":"backend authentication failure"}' };
  }
  // 仅放行应用主窗口（与 webRequest 登记口径一致）：注入的 iframe / 其它 webContents 一律拒绝。
  if (!state.appWindowWebContentsIds.has(event.sender.id)) {
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
    const url = new URL(`http://127.0.0.1:${state.backendPort}${path}`);
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

/** scheme 白名单单一事实来源：EXTERNAL_URL_SCHEMES（http/https）。
 *  preload 经 invoke（get-external-url-schemes）惰性拉取，消除旧 sendSync 同步阻塞；
 *  旧 ipcMain.on 同步 handler 已移除（preload 仅走 invoke 路径，同步 handler 是死代码）。
 *  走 guardedHandle 以复用应用主窗口发送方白名单（与其余 IPC 一致），当前仅返回静态
 *  http/https 列表，但为未来扩展 scheme 来源时保持同一防御纵深口径。 */
guardedHandle('get-external-url-schemes', () => [...EXTERNAL_URL_SCHEMES]);

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
    `[electron] 已刷新外部链接宿主扩展白名单缓存：${(state.cachedExternalHostAllowlist || []).length} 项`
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
    if (state.backendAuthFailure) {
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
    const trusted = state.trustedImportPaths.get(_event.sender.id) || new Set();
    const resolvedPath = path.resolve(filePath);
    trusted.add(resolvedPath);
    state.trustedImportPaths.set(_event.sender.id, trusted);
    // 安全 TTL：即使渲染层随后取消「导入前确认」弹窗，该信任路径 10min 后自动失效，
    // 避免信任路径保留至 webContents 销毁期间被同主世界 XSS 获知后绕过二次确认直接调用 importData。
    // 60s 太短：用户阅读「确认导入」弹窗 + 思考期间即过期，确认后 importData(preview.path)
    // 会报「导入路径未经过预览确认」形成交互死路；10min 覆盖正常确认时长同时保留兜底回收。
    setTimeout(() => {
      const cur = state.trustedImportPaths.get(_event.sender.id);
      if (cur) { cur.delete(resolvedPath); if (cur.size === 0) state.trustedImportPaths.delete(_event.sender.id); }
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
      const trusted = state.trustedImportPaths.get(senderId);
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

    const url = `http://127.0.0.1:${state.backendPort}/api/import`;
    // resource-exhaustion 修复：序列化后 POST 请求体设上限（200MB），防深嵌套/超大对象
    // JSON.stringify 出巨量内存；超过上限直接拒绝（主进程直连后端，绕过了 50KB 代理上限，须自行兜底）
    const importBody = JSON.stringify(payload);
    if (Buffer.byteLength(importBody, 'utf-8') > MAX_IMPORT_POST_BODY_BYTES) {
      return { canceled: false, ok: false, error: '导入数据序列化后体积超过上限，已拒绝导入' };
    }
    // 鉴权 FAIL-OPEN 熔断（与 backend-request 一致）：主进程直连 POST /api/import 前检查熔断标志，
    // 熔断态拒绝把导入数据写入后端（后端可能处于「本地任意进程可无令牌调用」的危险状态），
    // 使「已停止与后端交互」的声明与实际行为一致（此路径绕过代理通道，须自行兜底）。
    if (state.backendAuthFailure) {
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
        if (newPort !== state.backendPort) {
          state.backendPort = newPort;
          // 与 restoreBackupDir 同一口径：stopBackendForRestore 会把 isShuttingDown 置 true，
          // 须在调用前快照退出状态，避免应用退出期间误复位标志并复活出孤儿后端进程占用新端口
          // （与下次启动冲突）。
          const quittingBeforeRestore = state.isShuttingDown;
          await stopBackendForRestore();
          // stopBackendForRestore 置位了 isShuttingDown / backendStoppedForRestore：复位后方可让
          // startBackend 真正以新端口拉起后端（与 restoreBackupDir finally 的复位一致）；
          // 但若应用已在退出（quittingBeforeRestore 快照为真）则不得复活后端，否则退出期间
          // spawn 出孤儿进程占用端口，与下次启动冲突。
          state.backendStoppedForRestore = false;
          state.backendRestartCount = 0;
          if (!quittingBeforeRestore) {
            state.isShuttingDown = false;
            startBackend();
            waitBackendReadyOrRetry();
          }
          console.log(`[electron] 已从导入数据合并 settings.json 后后端端口更新为 ${state.backendPort}（已重启后端）`);
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
      const trusted = state.trustedImportPaths.get(senderId);
      if (trusted) {
        trusted.delete(filePath);
        if (trusted.size === 0) state.trustedImportPaths.delete(senderId);
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
    state.backendPort = resolveBackendPort();
    console.log(`[electron] 后端端口 = ${state.backendPort}`);
    // 开发模式 CSP 端口漂移告警：frontend/index.html 的 <meta http-equiv="Content-Security-Policy">
    // connect-src 端口由 vite.config.ts strictCspDev 从单一事实源注入（backend-default-port.cjs 默认值，
    // 或优先跟随其进程的 BOSS_PORT 环境变量）。dev 下该 meta 与 buildCspPolicy 注入的 header CSP 取交集，
    // 若经 BOSS_PORT / settings.json port / restore-data 改用非默认端口而 vite dev 进程未同步设置 BOSS_PORT，
    // meta connect-src 会拦截渲染进程对实际端口的 fetch，Dashboard 即使后端健康也停在「未连接」。此处仅当
    // 端口漂移时大声告警，提示以 BOSS_PORT 对齐两端（无需修改 index.html 字面量——它只有占位符）。
    if (!app.isPackaged && state.backendPort !== DEFAULT_PORT) {
      console.warn(
        `[electron] 开发模式后端端口=${state.backendPort} 与 vite strictCspDev 注入的 CSP meta 端口=${DEFAULT_PORT} 不一致：` +
          `渲染进程对 ${state.backendPort} 的 fetch 会被 meta connect-src 拦截（Dashboard 停在「未连接」）。` +
          `请为 vite dev 与 electron 启动进程设置相同的 BOSS_PORT=${state.backendPort} 环境变量并重启（index.html 端口由 strictCspDev 注入，勿手工改字面量）。`
      );
    }
    // 外部链接宿主扩展白名单：先加载一次作为初始值；open-external 每次 IPC 打开前会
    // 重读 settings.json 刷新本缓存，使 Settings 页直连保存的新域名无需重启即可放行。
    refreshExternalHostAllowlistCache();

    // 本地后端鉴权令牌：首启生成并持久化，注入后端 + 统一附加到渲染进程请求。
    // 令牌固定后一次性预计算指纹，供 verifyBackendTokenFingerprint 在每轮 /api/health 轮询直接比对（避免重复哈希）。
    state.authToken = loadOrCreateAuthToken();
    state.authTokenFingerprint = state.authToken ? createHash('sha256').update(state.authToken, 'utf-8').digest('hex').slice(0, 16) : '';
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
        `connect-src http://127.0.0.1:${state.backendPort} ${DEV_SERVER_ORIGIN} ${DEV_WS}`,
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
            if (!rewrittenIndexCache.has(state.backendPort)) {
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
                `connect-src http://127.0.0.1:${state.backendPort}`,
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
              rewrittenIndexCache.set(state.backendPort, { dir: tmpIndexDir, file: tmpIndex });
              // 缓存变更时才重建派生放行集合（改写后临时 index.html 路径），与缓存保持同步。
              rewrittenIndexPaths = [...rewrittenIndexCache.values()].map((v) => v.file);
            }
            callback({ path: rewrittenIndexCache.get(state.backendPort).file });
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
