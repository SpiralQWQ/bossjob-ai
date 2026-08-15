#!/usr/bin/env node
/**
 * verify-prepack.cjs —— electron-builder 打包前置强制门禁（beforePack hook）。
 *
 * 安全红线（csp-xss-defense）：
 *   源码 frontend/index.html 的 CSP 含 script-src 'unsafe-inline'（开发模式 Vite Fast Refresh/HMR
 *   所需），生产严格版 script-src 'self' 完全依赖构建期 vite.config.ts strictCspBuild 重写 +
 *   verify-dist.mjs / verify-csp.mjs 的断言。任何打包链路若漏跑这些校验（或把源码 html 直接打进
 *   安装包），生产将保留 'unsafe-inline'，存储型 XSS 即可内联执行并调用 window.api
 *   （backend-request 白名单端点 + PUT /api/settings + openExternal + deleteBackup）。
 *
 *   本 hook 经 electron-builder 的 config.beforePack 挂入（见 packaging/electron-builder.yml），
 *   无论经 `npm run dist` / `npm run pack` 还是 BUILD.md §6 直接 `npx electron-builder --config ...`，
 *   都会在打包开始前强制执行：
 *     - verify-dist.mjs：dist 与源码同步（防陈旧产物）+ 产物严格 CSP 断言；
 *     - verify-csp.mjs：源码/dist 严格 CSP + 源码样式注入审计；
 *     - verify-endpoint-whitelist.cjs：BACKEND_ENDPOINT_WHITELIST 正则边界回归测试
 *       （路径注入 ../、%2e/%2f 编码、CRLF、绝对 URL、多余路径段等，防白名单演进放宽
 *       引入 SSRF / 任意路径访问，见 endpoint-whitelist.cjs）。
 *   任一校验失败（非零退出）即 throw，electron-builder 打包立即中止，
 *   拒绝宽松 CSP / 放宽白名单的产物进安装包。
 *
 * 由 packaging/electron-builder.yml 的 beforePack 自动加载，无需手动调用。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// __dirname = code/electron/scripts；frontendScripts = code/frontend/scripts
const frontendScripts = path.join(__dirname, '..', '..', 'frontend', 'scripts');

/** 运行单个 Node 校验脚本；退出码非 0 或启动失败时抛出异常使打包中止。 */
function runGate(scriptName) {
  const scriptPath = path.join(frontendScripts, scriptName);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(frontendScripts, '..'), // frontend 根目录（脚本内部已用 __dirname 定位，cwd 仅为兜底）
    stdio: 'inherit',
  });
  if (res.error) {
    throw new Error(`[verify-prepack] 无法执行 ${scriptName}（${res.error.message}），打包中止。`);
  }
  if (res.status !== 0) {
    throw new Error(
      `[verify-prepack] ${scriptName} 校验失败（exit ${res.status}）：` +
        `dist/index.html 的 script-src 必须精确为 "script-src 'self'"、connect-src 必须为具体后端端口 ` +
        `（http://127.0.0.1:8675）。请先 cd frontend && npm run build 修复后再打包。` +
        `打包已中止，拒绝保留 'unsafe-inline' 的宽松 CSP 产物进入安装包。`
    );
  }
  console.log(`[verify-prepack] ${scriptName} 通过。`);
}

/** 运行 electron/scripts 下的本地校验脚本（如端点白名单回归测试）；失败即抛出使打包中止。 */
function runLocalGate(scriptName) {
  const scriptPath = path.join(__dirname, scriptName); // __dirname = code/electron/scripts
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'), // electron/ 根目录
    stdio: 'inherit',
  });
  if (res.error) {
    throw new Error(`[verify-prepack] 无法执行 ${scriptName}（${res.error.message}），打包中止。`);
  }
  if (res.status !== 0) {
    throw new Error(
      `[verify-prepack] ${scriptName} 校验失败（exit ${res.status}）：` +
        `BACKEND_ENDPOINT_WHITELIST 正则存在边界回归（路径注入 / 编码绕过 / 绝对 URL 等），` +
        `请检查 endpoint-whitelist.cjs 的锚定与校验后重新打包。` +
        `打包已中止，拒绝端点白名单被放宽的产物进入安装包。`
    );
  }
  console.log(`[verify-prepack] ${scriptName} 通过。`);
}

/**
 * 把前端构建产物 frontend/dist 同步到 electron/frontend/dist（打包可见的 asar 路径）。
 * 背景（packaging-fix 2026-08-13）：electron-builder 的 files glob 不支持越出 app 目录的
 * 上一级相对路径模式（会被静默忽略），导致 asar 里没有 UI（打包态白屏）。
 * 修法：打包前把已通过 verify-dist 校验的 frontend/dist 复制进 electron/frontend/dist，
 * 打包配置 files 改用应用内路径 frontend/dist（→ app.asar 根/frontend/dist/），
 * 与 main.js 打包态 FRONTEND_DIST_INDEX 的路径推导对齐。
 * 每次打包都重新同步（先清后拷），保证安装包内的 UI 与本次校验的产物一致。
 */
function syncFrontendDist() {
  const electronRoot = path.join(__dirname, '..'); // code/electron
  const src = path.join(electronRoot, '..', 'frontend', 'dist'); // code/frontend/dist
  const dest = path.join(electronRoot, 'frontend', 'dist'); // code/electron/frontend/dist
  if (!fs.existsSync(path.join(src, 'index.html'))) {
    throw new Error('[verify-prepack] frontend/dist 缺失 index.html，请先 cd frontend && npm run build。');
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[verify-prepack] 已同步 frontend/dist → electron/frontend/dist（${fs.readdirSync(dest).length} 项）。`);
}

/**
 * electron-builder beforePack hook：打包开始前强制跑完整 CSP 门禁。
 * 任一脚本失败即 throw（electron-builder 将中止打包），绝不让宽松 CSP 产物进安装包。
 * 门禁全部通过后同步 frontend/dist 到打包可见路径（见 syncFrontendDist）。
 */
module.exports = async function verifyPrepack() {
  runGate('verify-dist.mjs');
  runGate('verify-csp.mjs');
  runLocalGate('verify-endpoint-whitelist.cjs');
  syncFrontendDist();
  console.log('[verify-prepack] 打包前置 CSP + 端点白名单门禁全部通过，继续打包。');
};
