/** Electron 主进程 · 后端生命周期（从 main.js 抽离：HTTP 传输 + 进程守护 + 健康轮询 + 状态通知/弹窗）。
 *  依赖：auth（令牌注入/指纹校验/令牌文件清理）、state（进程句柄/端口/缓冲/熔断）、constants（超时/退避/端口）。
 *  注：reportBackendAuthFailure 归入本模块（E-T5 从 auth 域迁来），使 auth 保持纯令牌逻辑、避免 auth↔backend 循环依赖。 */

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { state } = require('./state');
const {
  BACKEND_PROXY_MAX_RESPONSE_BODY_BYTES, TIMEOUT_ERR, RESPONSE_TOO_LARGE_ERR,
  MAX_BACKEND_RESTARTS, HEALTH_POLL_ATTEMPTS, HEALTH_REQUEST_TIMEOUT_MS, HEALTH_POLL_INTERVAL_MS,
  BACKEND_HEALTH_RETRY_INTERVAL_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
  STOP_BACKEND_TIMEOUT_MS, KILL_EXIT_GRACE_MS,
  PACKAGED_BACKEND_EXE, PACKAGED_BACKEND_DIR, BACKEND_DIR, DEFAULT_PORT,
  getSettingsPath,
} = require('./constants');
const { writeAuthTokenFile, verifyBackendTokenFingerprint, cleanupAuthTokenFile } = require('./auth');
const { errMsg, getDialogParent, isValidPort } = require('./utils');

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
      ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
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

/** 鉴权 FAIL-OPEN 告警（auth-bypass 修复）：后端未载入令牌时弹窗 + 推送错误 + 熔断后端转发。 */
function reportBackendAuthFailure() {
  if (state.backendAuthFailure) {
    return; // 只告警一次，避免周期复查反复弹窗
  }
  state.backendAuthFailure = true;
  const message =
    '本地后端鉴权异常：未检测到有效鉴权令牌（鉴权 FAIL-OPEN），后端接口可能被本机任意进程匿名调用。\n\n' +
    '为保护本地求职数据，应用已停止与后端交互。请重启应用；若问题持续，请检查应用数据目录写入权限后重试。';
  console.error('[electron] 检测到后端鉴权 FAIL-OPEN（令牌指纹不匹配），拒绝与后端交互。');
  notifyBackendError(message);
  showBackendErrorDialog(message);
}

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
  if (state.backendProc || state.isShuttingDown || state.backendStoppedForRestore) {
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
      String(state.backendPort),
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
  const tokenFile = writeAuthTokenFile(state.authToken);
  if (!tokenFile) {
    // 安全边界：无可用令牌通道时绝不带着 FAIL-OPEN 后端裸奔，直接拒绝启动并给出可操作错误
    const message =
      '后端鉴权令牌文件无法写入（磁盘空间不足或权限不足），为保护本地求职数据，后端未启动。\n\n请确认应用数据目录可写且磁盘空间充足后重启应用。';
    console.error('[electron] 鉴权令牌文件写入失败，拒绝启动后端（令牌不进入子进程环境块，避免 FAIL-OPEN）。');
    notifyBackendError(message);
    showBackendErrorDialog(message);
    return;
  }
  state.backendProc = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      BOSS_PORT: String(state.backendPort),
      // OS 受保护通道：随机文件名、后端读后即删（app/main.py 的 _load_auth_token）
      BOSS_AUTH_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, // Windows 下不弹出黑框
  });
  // 捕获当前进程句柄：stopBackendForRestore 超时强杀后已显式置 null / 新进程已接管时，
  // 旧进程晚到的 exit 事件应跳过自动重启，避免重复/二次启动
  const proc = state.backendProc;

  state.backendProc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  state.backendProc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });

  state.backendProc.on('error', (err) => {
    // spawn 失败（如 python 不在 PATH / 打包 exe 缺失 ENOENT）：不会触发 exit，重置句柄，避免误重启
    state.backendProc = null;
    const message = isPackaged
      ? `后端可执行文件启动失败：${err.message}\n\n请确认安装目录 resources/backend/bossjob-backend.exe 存在且完整，必要时重新安装应用。`
      : `后端启动失败：${err.message}\n\n开发模式需要 Python 已加入 PATH，并在 backend/ 下创建并激活虚拟环境（见 packaging/BUILD.md §2）。`;
    console.error(`[electron] 后端启动失败：${err.message}`);
    notifyBackendError(message);
    showBackendErrorDialog(message);
  });

  state.backendProc.on('exit', async (code, signal) => {
    // 旧进程晚到的 exit（stopBackendForRestore 超时强杀后已显式置 null / 新进程已接管）：
    // 不是当前句柄时跳过自动重启，避免重复启动
    if (state.backendProc !== proc) {
      return;
    }
    state.backendProc = null;
    console.log(`[electron] 后端退出 code=${code} signal=${signal}`);

    // 主动关闭时不再重启
    if (state.isShuttingDown) {
      return;
    }

    // 守护循环：异常退出时重启，最多 MAX_BACKEND_RESTARTS 次
    if (state.backendRestartCount < MAX_BACKEND_RESTARTS) {
      state.backendRestartCount += 1;
      console.log(
        `[electron] 后端异常退出，第 ${state.backendRestartCount}/${MAX_BACKEND_RESTARTS} 次重启...`
      );
      // 重启前向所有渲染窗口推送进度，避免守护循环期间 UI 停留在陈旧的「后端未连接」而无任何提示
      broadcast('backend-restarting', {
        attempt: state.backendRestartCount,
        max: MAX_BACKEND_RESTARTS,
      });
      // 重启前指数退避：瞬时退出/崩溃循环（如端口被占用、启动即崩）时避免毫秒级烧光全部重启次数。
      // 首次 1s，逐次翻倍，封顶 8s，为后端端口释放/依赖就绪留出时间。
      const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, state.backendRestartCount - 1), BACKOFF_MAX_MS);
      console.log(
        `[electron] ${backoffMs}ms 后重启后端（第 ${state.backendRestartCount}/${MAX_BACKEND_RESTARTS} 次）...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      // 退避等待期间用户可能已退出应用，或已触发数据恢复停服：
      // 主动关闭 / restore-data 进行中时放弃本次重启，避免复活进程在恢复覆盖 app.db 期间抢占 SQLite 锁。
      if (state.isShuttingDown || state.backendStoppedForRestore) {
        return;
      }
      startBackend();
      // 恢复可观测性：重置错误对话框门闩（后续若再次启动失败仍能弹窗提示），
      // 并重新等待后端健康，就绪后向所有渲染窗口推送 backend-ready，让 UI 从「连接失败」自动恢复
      state.backendErrorDialogShown = false;
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
  state.isShuttingDown = true;
  if (state.backendProc) {
    console.log('[electron] 关闭后端进程...');
    state.backendProc.kill();
    state.backendProc = null;
  }
}

/** 把后端失败原因推送给所有渲染窗口（渲染进程展示可操作提示，见 Dashboard）。 */
function notifyBackendError(message) {
  // startBackend() 先于 createWindow() 执行，spawn 'error' 可能同步触发：此时尚无窗口 / 渲染进程未订阅
  // backend-error 通道，先缓冲到 pendingBackendError，由 createWindow 的 did-finish-load 冲刷补发。
  // 新错误代际：使已缓冲的就绪信号过期（后端状态已翻转），并重置上一代错误已消费记录，
  // 确保每个窗口都能收到这一最新错误（已加载窗口立即投递，加载中窗口延迟补发）。
  state.pendingBackendReady = null;
  state.backendReadyDelivered = new Set();
  state.backendErrorDelivered = new Set();
  state.pendingBackendError = message;
  // 统一经 sendToAppWindows 投递：已加载窗口立即发送，加载中窗口延迟到 did-finish-load 后补发。
  // createWindow() 已在 did-finish-load 上注册了冲刷监听器且先于本处补发注册，
  // 故补发回调需按 webContentsId 核对「本窗口是否已消费该消息」：已消费则跳过，避免重复下发；
  // 冲刷不再清空全局缓冲，故其它窗口（含之后才创建的窗口）加载完成后仍能补发，不会永久丢失该错误。
  sendToAppWindows('backend-error', message, (win, wc) => {
    // 代际校验：仅当本消息仍是当前缓冲（未被更新代际的 ready/error 取代）且本窗口未消费时才补发。
    // 否则窗口加载期间缓冲被反方信号代际替换后，过期的 deferredSend 会把陈旧错误补发给已收到新状态的窗口，
    // 导致 UI 错误地停在后端失败态（backendErrorDelivered 只按 wcId 判重，无法识别代际翻转）。
    if (state.pendingBackendError === message && !state.backendErrorDelivered.has(wc.id)) {
      state.backendErrorDelivered.add(wc.id);
      wc.send('backend-error', message);
    }
  });
  // 不再因「所有窗口均已加载」清空缓冲：缓冲保留最新错误，供之后创建的窗口（macOS activate 重建 / 多窗口）
  // 在 did-finish-load 冲刷时补发，防止该窗口永久丢失 backend-error。
}

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
  const payload = { version: state.backendReadyVersion || null, port: state.backendPort };
  // 新就绪代际：使已缓冲的过期错误失效（后端已恢复健康），并重置已消费记录，
  // 确保每个窗口都能收到这一最新就绪信号（已加载窗口立即投递，加载中窗口延迟补发）。
  // 缓冲始终保留，供之后创建的窗口在 did-finish-load 冲刷时补发
  // （原 forceBuffer 参数已移除：本实现始终保留缓冲，该参数不再改变任何行为）。
  state.pendingBackendError = null;
  state.backendErrorDelivered = new Set();
  state.backendReadyDelivered = new Set();
  state.pendingBackendReady = payload;
  // 统一经 sendToAppWindows 投递：已加载窗口立即发送；加载中窗口同样延迟补发 —— 但
  // createWindow 的 did-finish-load 冲刷也会发送，故补发回调需按 webContentsId 核对
  // 「本窗口是否已消费该载荷」：已消费则跳过，避免同一就绪信号重复下发；
  // 冲刷不再清空全局缓冲，之后创建的窗口也能补发到最新就绪信号。
  sendToAppWindows('backend-ready', payload, (win, wc) => {
    // 代际校验：仅当该载荷仍是当前缓冲（未被更新代际的 error/ready 取代）且本窗口未消费时才补发，
    // 避免窗口加载期间缓冲被反方信号代际替换后，过期 deferredSend 把陈旧就绪补发给已收到新状态的窗口。
    if (state.pendingBackendReady === payload && !state.backendReadyDelivered.has(wc.id)) {
      state.backendReadyDelivered.add(wc.id);
      wc.send('backend-ready', payload);
    }
  });
}

/** 首次后端启动失败时弹出可操作对话框，避免「窗口正常打开但无任何提示」。 */
function showBackendErrorDialog(message) {
  if (state.backendErrorDialogShown) {
    return;
  }
  state.backendErrorDialogShown = true;
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
  const url = `http://127.0.0.1:${state.backendPort}/api/health`;
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
        state.backendAuthFailure = false;
        // 后端确认就绪：此时后端必然已在模块导入期读完一次性令牌文件（读后即删），此处兜底删除
        // 可能遗留的令牌文件（后端启动即崩溃等异常场景），消除明文密钥残留。
        cleanupAuthTokenFile();
        // 后端健康即清零重启计数：只有连续崩溃循环才计入 MAX_BACKEND_RESTARTS
        state.backendRestartCount = 0;
        state.backendReadyVersion = parsed.version; // 记录就绪版本，供 notifyBackendReady 推送 backend-ready 时携带
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
  if (state.backendHealthRetryTimer !== null) {
    clearInterval(state.backendHealthRetryTimer);
    state.backendHealthRetryTimer = null;
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
  const generation = ++state.backendHealthMonitorGeneration;
  clearBackendHealthRetry();
  void waitForBackendHealth().then((healthy) => {
    if (state.isShuttingDown || state.backendHealthMonitorGeneration !== generation) {
      return;
    }
    if (healthy) {
      // 后端真实就绪 → 推送 backend-ready（携带版本载荷、对加载中的窗口缓冲补发）。
      // waitForBackendHealth 命中健康时已清零 backendRestartCount，此处显式复置以表达「恢复即清零」意图；
      // 同时复位 backendErrorDialogShown：后端已恢复健康，允许同会话后续失败再次弹「后端启动失败」
      // 对话框，避免「弹过一次后仅剩 IPC 推送、不再弹窗」的失败信号静默降级。
      state.backendRestartCount = 0;
      state.backendErrorDialogShown = false;
      notifyBackendReady();
      return;
    }
    // 预算内未就绪：先补发一次通用终态信号（已有更具体的后端错误时不覆盖），
    // 但超时不是终态——启动周期复查，后端恢复健康后自动推送 backend-ready。
    if (state.pendingBackendError === null) {
      notifyBackendError('后端未在预算时间内恢复健康，请检查端口占用或运行环境');
    }
    if (state.backendHealthRetryTimer === null) {
      // 上一轮 waitForBackendHealth 可能耗时约 10s（20 次 × 500ms 轮询），长于复查间隔：
      // 用 retryRunning 门闩跳过尚未结束的重叠 tick，避免对同一端点并发轮询。
      let retryRunning = false;
      state.backendHealthRetryTimer = setInterval(() => {
        if (state.isShuttingDown || state.backendHealthMonitorGeneration !== generation) {
          clearBackendHealthRetry();
          return;
        }
        if (retryRunning) {
          return;
        }
        retryRunning = true;
        void waitForBackendHealth().then((ok) => {
          retryRunning = false;
          if (state.isShuttingDown || state.backendHealthMonitorGeneration !== generation) {
            return;
          }
          if (ok) {
            // 预算后恢复健康：清除复查定时器、清零重启计数并推送 backend-ready（后端就绪终态）。
            // 同时复位 backendErrorDialogShown：恢复健康后允许同会话后续失败再次弹「后端启动失败」对话框。
            clearBackendHealthRetry();
            state.backendRestartCount = 0;
            state.backendErrorDialogShown = false;
            notifyBackendReady();
          }
        });
      }, BACKEND_HEALTH_RETRY_INTERVAL_MS);
    }
  });
}

/**
 * 停止后端并等待其完全退出（kill 为异步，须等 exit 事件后再覆盖 app.db，
 * 避免 SQLite 文件句柄/锁冲突）。结束时把 isShuttingDown 置真防止退出处理器自动重启，
 * 恢复完成后由调用方复位并手动重启。
 */
function stopBackendForRestore() {
  if (!state.backendProc) {
    // 后端已不在运行（如崩溃退出处理器正处于指数退避 sleep 中）：仍须标记停服，
    // 否则退避到期后的延迟重启会在 restore 覆盖 app.db 期间拉起新进程抢占 SQLite 锁。
    // 注意：不复位 isShuttingDown —— 若应用正在退出（before-quit 的 stopBackend 已置
    // isShuttingDown=true 并清空 backendProc），此处保留该标志，避免 restore 的 finally
    // 在退出期间 startBackend() 复活后端 spawn 出孤儿进程占用端口、与下次启动冲突。
    // 是否重启后端由 restoreBackupDir 的 finally 依据 quittingBeforeRestore 快照决定。
    state.backendStoppedForRestore = true;
    return Promise.resolve();
  }
  const proc = state.backendProc;
  state.isShuttingDown = true;
  state.backendStoppedForRestore = true;
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
      state.backendProc = null;
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
      state.backendProc = null;
      clearTimeout(timer);
      settle();
      return;
    }
  });
}

module.exports = {
  httpRequest,
  httpGet,
  httpPostText,
  sendToAppWindows,
  broadcast,
  reportBackendAuthFailure,
  getSettingsMtime,
  resolveBackendPort,
  ensurePackagedSettings,
  startBackend,
  stopBackend,
  notifyBackendError,
  notifyBackendReady,
  showBackendErrorDialog,
  waitForBackendHealth,
  clearBackendHealthRetry,
  waitBackendReadyOrRetry,
  stopBackendForRestore,
};
