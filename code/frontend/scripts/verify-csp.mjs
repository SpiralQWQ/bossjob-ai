#!/usr/bin/env node
/**
 * verify-csp.mjs —— 快速 CSP 安全门禁（CI / 打包前快速自检，无需重编译）。
 *
 * 背景（csp-xss-defense）：
 *   - 源码 frontend/index.html 与生产产物 dist/index.html 均为严格 CSP：script-src 'self'（无 unsafe-inline/eval）。
 *     connect-src 必须收紧到显式端口，严禁裸 http://127.0.0.1 放行任意本地端口。
 *   - 生产产物 frontend/dist/index.html 的 script-src 必须为 'self'，严禁含 'unsafe-inline'/'unsafe-eval'
 *     （HTML/脚本注入 → 预加载桥 window.api → 后端 Bearer Token 的 XSS→后端全链在渲染层被斩断）。
 *     本脚本是 vite.config.ts strictCspBuild（构建期 throw）与 verify-dist.mjs（打包期重建比对）的
 *     轻量互补检查：直接断言当前源码与 dist 产物，不重编译、秒级失败，适合 CI 快速门禁。
 *
 * 用法（见 frontend/package.json 的 verify:csp，已并入 build 尾端）：
 *   cd frontend && node scripts/verify-csp.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.join(__dirname, '..');

/** 断言源码 index.html 的 CSP connect-src 不含裸 http://127.0.0.1（必须显式端口，防 rewrite 链回退）。 */
function verifySourceConnectSrc(sourceHtmlPath) {
  const html = readFileSync(sourceHtmlPath, 'utf-8');
  const m = html.match(/content="(default-src [^"]*)"/);
  if (!m) {
    throw new Error('[verify-csp] 源码 index.html 缺失 CSP meta，拒绝放行。');
  }
  const csp = m[1];
  // 源码 script-src 必须精确为 'self'（与产物同口径）：源码严格 CSP 被回退会重开 XSS→后端全链。
  const scriptSrc = (csp.match(/script-src [^;]*/) || [''])[0];
  if (scriptSrc.trim() !== "script-src 'self'") {
    throw new Error(
      `[verify-csp] 源码 CSP script-src 必须精确为 "script-src 'self'"（实际：${scriptSrc || '(缺失)'}），` +
        ' 源码严格 CSP 被回退，拒绝放行。'
    );
  }
  const connectSrc = (csp.match(/connect-src [^;]*/) || [''])[0];
  if (!connectSrc) {
    throw new Error('[verify-csp] 源码 CSP 缺少 connect-src 指令，拒绝放行。');
  }
  // 显式端口 http://127.0.0.1:<port> 后的下一个字符是 ':'（且跟数字），裸 host 后是空格/';'/结束 → 命中。
  const bareHostPattern = /http:\/\/127\.0\.0\.1(?![:\d])/;
  if (bareHostPattern.test(connectSrc)) {
    throw new Error(
      `[verify-csp] 源码 connect-src 含裸 http://127.0.0.1（放行任意本地端口）：${connectSrc.trim()}。` +
        ' 请收紧为显式端口（如 http://127.0.0.1:8675，与 electron/main.js buildCspPolicy 默认一致）。'
    );
  }
  console.log(`[verify-csp] 源码 connect-src OK（${connectSrc.trim()}）。`);
}

/** 断言 dist/index.html（若存在）script-src 不含 'unsafe-inline'/'unsafe-eval'，connect-src 已收紧到具体端口。 */
function verifyDistStrictCsp(distHtmlPath) {
  let html;
  try {
    html = readFileSync(distHtmlPath, 'utf-8');
  } catch {
    console.warn('[verify-csp] 未找到 dist/index.html（尚未构建），跳过产物校验。');
    return;
  }
  const m = html.match(/content="(default-src [^"]*)"/);
  if (!m) {
    throw new Error('[verify-csp] dist/index.html 缺失 CSP meta，拒绝放行。');
  }
  const csp = m[1];
  const scriptSrc = (csp.match(/script-src [^;]*/) || [''])[0];
  // 硬编码断言：产物 script-src 必须精确等于 "script-src 'self'"（无内联/eval/nonce/hash 等任何
  // 额外 token），strictCspBuild 重写链一旦回退，任何残留内联许可都会被此精确比对拦下。
  if (scriptSrc.trim() !== "script-src 'self'") {
    throw new Error(
      `[verify-csp] dist/index.html 的 script-src 必须精确为 "script-src 'self'"（实际：${scriptSrc || '(缺失)'}），` +
        " 生产 CSP 必须为 script-src 'self'，拒绝放行（strictCspBuild 重写链回退将重开 XSS→后端全链）。"
    );
  }
  const connectSrc = (csp.match(/connect-src [^;]*/) || [''])[0];
  if (!/^connect-src http:\/\/127\.0\.0\.1:\d+$/.test(connectSrc)) {
    throw new Error(
      `[verify-csp] dist/index.html 的 connect-src 未收紧到具体后端端口（${connectSrc || '(缺失)'}），拒绝放行。`
    );
  }
  console.log(`[verify-csp] dist/index.html 产物严格 CSP OK（${scriptSrc.trim()} / ${connectSrc.trim()}）。`);
}

/**
 * 源码样式注入审计（style-src 'unsafe-inline' 前置约束，xss-style-injection）：
 * 前端保留 style-src 'unsafe-inline'（React 内联 style 属性 + antd v5 cssinjs 运行时 <style>，
 * 无外部 CSS），故必须保证 src 中不存在把不可信内容写入 style 属性 / <style> 标签的代码路径；
 * 否则经 'unsafe-inline' 可执行注入 CSS（data: 规则、UI 遮蔽、CSS 外带）。
 * 命中任一高危模式即 throw（2026-08-04 审计：当前 src 无此类路径）。
 */
function verifyNoUntrustedStyleInterpolation() {
  const srcDir = path.join(frontendRoot, 'src');
  const patterns = [
    { re: /setAttribute\(\s*['"]style['"]/, desc: 'setAttribute("style")（整体写 style 属性）' },
    { re: /\.style\s*=\s*['"`]/, desc: 'style 整体赋值 CSS 字符串' },
    { re: /dangerouslySetInnerHTML/, desc: 'dangerouslySetInnerHTML（可注入含 style 属性的 HTML）' },
    { re: /insertAdjacentHTML\s*\(/, desc: 'insertAdjacentHTML（可注入含 style 属性的 HTML）' },
    { re: /createElement\(\s*['"]style['"]\)/, desc: 'createElement("style")（运行时 <style> 注入）' },
  ];
  const hits = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (/\.(tsx?|jsx?)$/.test(ent.name)) {
        const text = readFileSync(p, 'utf-8');
        for (const { re, desc } of patterns) {
          if (re.test(text)) {
            hits.push(`${path.relative(frontendRoot, p)}：${desc}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  if (hits.length > 0) {
    throw new Error(
      '[verify-csp] 源码存在把内容写入 style 属性/<style> 的高危路径（style-src \'unsafe-inline\' 前置约束）：\n' +
        hits.map((h) => `  - ${h}`).join('\n') +
        ' 请改为受控 React style 对象或经严格白名单过滤后再构建。'
    );
  }
  console.log('[verify-csp] 源码样式注入审计 OK（src 无 setAttribute(style)/style=字符串/dangerouslySetInnerHTML/<style> 注入）。');
}

let failed = false;
try {
  verifySourceConnectSrc(path.join(frontendRoot, 'index.html'));
  verifyDistStrictCsp(path.join(frontendRoot, 'dist', 'index.html'));
  verifyNoUntrustedStyleInterpolation();
} catch (err) {
  console.error('[verify-csp] 校验失败：', err && err.message ? err.message : String(err));
  failed = true;
}
process.exit(failed ? 1 : 0);
