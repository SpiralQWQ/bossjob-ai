import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
// 单一事实源：默认后端端口由 electron/backend-default-port.cjs 提供（与 electron/main.js DEFAULT_PORT 同源）。
// 构建/开发链不再手写 8675 字面量——修改默认端口只需改该 cjs 一处，杜绝 index.html / dist / main.js 三处静默漂移。
// 实际注入 CSP 的端口优先取 BOSS_PORT 环境变量（与 main.js resolveBackendPort 同优先级），未设置则回落默认值；
// 打包态最终由 main.js interceptFileProtocol 运行时按 backendPort 重写，构建期烘焙值仅作兜底基线。
import backendDefaults from '../electron/backend-default-port.cjs';
const DEFAULT_BACKEND_PORT = backendDefaults.DEFAULT_BACKEND_PORT;
const CSP_BACKEND_PORT = Number(process.env.BOSS_PORT) || DEFAULT_BACKEND_PORT;

// Vite 配置（Electron 渲染进程）
// - base './'：生产构建产物以相对路径引用，兼容 Electron loadFile(file://) 加载。
// - port 5173：与 electron/main.js 的开发模式 DEV_SERVER_URL 保持一致。
//   strictPort 确保端口被占用时立即报错而不是静默漂移，避免后端加载到错误的 dev server。
//
// CSP 三层防御（2026-08-05 csp-hardening）：
//   1) 源码基线即严格：frontend/index.html 的 CSP meta 为 script-src 'self'（无 'unsafe-inline'）+
//      form-action 'none'，即使 strictCspBuild / verify-dist.mjs 失效，产物也不含内联脚本许可。
//   2) 构建期 strictCspBuild（下方）：断言 script-src 无 inline/eval、connect-src 收紧为具体后端端口、
//      form-action 'none' 存在；任一断言失败直接 throw 使构建失败，绝不允许宽松 CSP 产物发布。
//   3) 运行时 electron/main.js interceptFileProtocol：打包态主文档整体重写为进程内严格生产策略
//      （script-src 'self' + form-action 'none' + connect-src 当前端口），覆盖任何陈旧/宽松产物。
//
// 开发模式（vite dev）由 strictCspDev 用一次性 nonce 替代 'unsafe-inline'：Vite 5.4 内置
// html.cspNonce 会给 html 内所有 script/style/link 注入 nonce 属性（含 @vitejs/plugin-react 注入的
// Fast Refresh 内联预置脚本，applyHtmlTransforms 会先把插件返回的 tag 注入 html 再跑 nonce 钩子），
// 本插件再把同一 nonce 并入 CSP meta 的 script-src。构建（apply:'serve' 排除）不含 nonce，产物保持严格。
const strictCspBuild = {
  name: 'strict-csp-build',
  apply: 'build',
  transformIndexHtml(html: string) {
    // 提取 index.html 中 CSP meta 的 content 值（[^"]* 可跨换行，属性值内不含双引号）。
    const cspMeta = /content="(default-src [^"]*)"/;
    const matched = html.match(cspMeta);
    if (!matched) {
      throw new Error(
        '[strict-csp-build] index.html 缺失 CSP meta（content 未以 default-src 开头），构建中止。'
      );
    }
    const oldCsp = matched[1];
    let csp = oldCsp;

    // 1) script-src：剔除 'unsafe-inline' / 'unsafe-eval'（源码已严格，此处为防回归的幂等清洗）。
    const scriptSrc = /script-src [^;]*/;
    if (!scriptSrc.test(csp)) {
      throw new Error('[strict-csp-build] index.html 的 CSP 缺少 script-src 指令，构建中止。');
    }
    csp = csp.replace(scriptSrc, (seg) =>
      seg
        .split(' ')
        .filter((tok) => tok !== "'unsafe-inline'" && tok !== "'unsafe-eval'")
        .join(' ')
    );
    // 断言：script-src 必须已收紧为 'self'（不含任何内联/eval/nonce 许可）。若源码 CSP 被改写导致
    // 替换未命中，此处 throw 使构建失败，杜绝宽松 CSP 静默发布。
    const scriptSrcResult = csp.match(scriptSrc)?.[0] ?? '';
    if (
      scriptSrcResult.includes("'unsafe-inline'") ||
      scriptSrcResult.includes("'unsafe-eval'")
    ) {
      throw new Error(
        `[strict-csp-build] 构建产物 script-src 仍含 inline/eval 许可（${scriptSrcResult}），拒绝发布宽松 CSP，构建中止。`
      );
    }

    // 2) connect-src：收紧为具体后端端口（默认值取自单一事实源 backend-default-port.cjs），不再放行裸 http://127.0.0.1。
    const connectSrc = /connect-src [^;]*/;
    if (!connectSrc.test(csp)) {
      throw new Error('[strict-csp-build] index.html 的 CSP 缺少 connect-src 指令，构建中止。');
    }
    csp = csp.replace(connectSrc, `connect-src http://127.0.0.1:${CSP_BACKEND_PORT}`);

    // 3) form-action：必须存在且为 'none'（防跨源 <form> 外发数据；form-action 不受
    //    default-src / connect-src 管辖，显式断言杜绝遗漏）。
    const formAction = /form-action [^;]*/;
    const formActionResult = csp.match(formAction)?.[0] ?? '';
    if (formActionResult.trim() !== "form-action 'none'") {
      throw new Error(
        `[strict-csp-build] 构建产物 CSP 缺失 form-action 'none'（实际：${formActionResult || '(缺失)'}），拒绝发布，构建中止。`
      );
    }

    return html
      .replace(cspMeta, () => `content="${csp}"`)
      .replace(
        /<!-- CSP 基线[\s\S]*?-->/,
        '<!-- 生产模式严格 CSP：打包产物仅单个外部 <script type=module>，script-src 已收紧为 \'self\'（无 \'unsafe-inline\'）、\n' +
          `         connect-src 已收紧为 http://127.0.0.1:${CSP_BACKEND_PORT}（具体后端端口，取自 backend-default-port.cjs）、form-action 'none'；\n` +
          '         防 HTML/脚本注入利用预加载桥与后端 Bearer Token，阻断对任意本地端口的横向探测与跨源表单外发。\n' +
          "         style-src 保留 'unsafe-inline'：React 内联 style 属性 + antd v5 cssinjs 运行时 <style>（无外部 CSS），\n" +
          '         前提是严禁把不可信 job/导入内容插值进 style 属性或 <style> 内容（verify-csp.mjs 源码扫描门禁兜底）。 -->'
      );
  },
};

// 开发模式（仅 vite dev）严格 CSP 的 nonce 化：源码 meta 不再含 'unsafe-inline'，Vite Fast Refresh
// 内联预置脚本通过一次性 nonce 放行。hex 编码避免 base64 的 '+'/'/'/'=' 在 CSP token 解析的边界问题。
const cspDevNonce = randomBytes(16).toString('hex');
const strictCspDev = {
  name: 'strict-csp-dev',
  apply: 'serve',
  config(_config, { command }) {
    // 仅 serve 注入静态 nonce；build 不设，避免产物携带可复用的 nonce 源。
    return command === 'serve' ? { html: { cspNonce: cspDevNonce } } : undefined;
  },
  transformIndexHtml(html: string) {
    const cspMeta = /content="(default-src [^"]*)"/;
    const matched = html.match(cspMeta);
    if (!matched) return html;
    const csp = matched[1]
      .replace(/script-src [^;]*/, (s) => `${s} 'nonce-${cspDevNonce}'`)
      // 把源码 connect-src 中的 __BACKEND_PORT__ 占位符替换为实际端口（单一事实源注入，避免字面量漂移）。
      .replace('__BACKEND_PORT__', String(CSP_BACKEND_PORT));
    return html.replace(cspMeta, () => `content="${csp}"`);
  },
};

export default defineConfig({
  plugins: [react(), strictCspBuild, strictCspDev],
  base: './',
  build: {
    // code-split（遗留-2）：react 全家桶拆独立 vendor；antd 不显式拆分——
    // vite5 + antd5 默认 ESM tree-shaking 按需摇树（全量锁单 chunk 反而阻止摇树）。
    // 页面已路由懒加载（router.tsx），首屏只加载 react-vendor + 当前页面 chunk。
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
