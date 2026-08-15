/** Electron 主进程 · 本地后端鉴权令牌（从 main.js 抽离：🔴 安全关键 —— 令牌生成/持久化/一次性文件注入/指纹校验）。
 *  依赖：state（authToken/指纹/令牌文件路径与 TTL 定时器）、constants（TTL/重试常量 + getDataDir）。
 *  注：reportBackendAuthFailure（鉴权 FAIL-OPEN 告警）因需 notify/dialog，随 backend.js（E-T6）一起拆出，避免 auth↔backend 循环依赖。 */

const { app, safeStorage } = require('electron');
const { spawnSync } = require('child_process');
const { randomBytes } = require('crypto');
const path = require('path');
const fs = require('fs');

const { state } = require('./state');
const { TOKEN_FILE_TTL_MS, TOKEN_FILE_WRITE_RETRIES, TOKEN_FILE_WRITE_RETRY_DELAY_MS, getDataDir } = require('./constants');
const { errMsg, sleepSync } = require('./utils');

/** 生成 256-bit 随机十六进制令牌（后端鉴权令牌 / CSRF 会话令牌复用）。 */
const newToken = () => randomBytes(32).toString('hex');

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

/** 删除当前一次性令牌文件（若仍存在）：幂等，失败仅告警。后端读后即删为正常路径，
 *  本函数仅兜底「后端启动即崩溃 / 读盘前异常退出」遗留的明文密钥，就绪后 / 退出时调用。
 *  调用时同时取消 TTL 兜底清理定时器（key-exposure 加固），避免定时器在文件已删除后空转。 */
function cleanupAuthTokenFile() {
  if (state.authTokenFileTtlTimer) {
    clearTimeout(state.authTokenFileTtlTimer);
    state.authTokenFileTtlTimer = null;
  }
  if (state.authTokenFilePath) {
    const p = state.authTokenFilePath;
    state.authTokenFilePath = null;
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
  if (state.authTokenFileTtlTimer) {
    clearTimeout(state.authTokenFileTtlTimer);
  }
  state.authTokenFileTtlTimer = setTimeout(() => {
    state.authTokenFileTtlTimer = null;
    cleanupAuthTokenFile();
  }, TOKEN_FILE_TTL_MS);
  if (state.authTokenFileTtlTimer.unref) {
    state.authTokenFileTtlTimer.unref();
  }
}

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
  if (!state.authTokenFingerprint) {
    return false;
  }
  // 与后端 health.py 口径一致：SHA-256(令牌) 十六进制前 16 位（64 bit，足够唯一性且不泄露完整令牌）。
  // 指纹在 whenReady 载入令牌时一次性预计算，此处仅做字符串比对，避免每轮 /api/health 轮询重复哈希。
  return healthPayload.auth_token_fingerprint === state.authTokenFingerprint;
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
  state.authTokenFilePath = null;
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
      state.authTokenFilePath = file; // 记录当前令牌文件路径，供后端就绪后兜底删除 / 退出清理
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

module.exports = {
  newToken,
  loadOrCreateAuthToken,
  cleanupAuthTokenFile,
  armAuthTokenFileTtlCleanup,
  verifyBackendTokenFingerprint,
  restrictTokenFileAcl,
  writeAuthTokenFile,
};
