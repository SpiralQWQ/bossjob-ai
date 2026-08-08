/**
 * 单一事实源：默认后端端口。
 *
 * 被两处共同引用，使「默认端口」只在全项目出现一次，杜绝三文件静默漂移：
 *   - electron/main.js（CJS require）→ DEFAULT_PORT（运行时端口兜底值）；
 *   - frontend/vite.config.ts（ESM import）→ 注入 frontend/index.html CSP 的 connect-src 后端端口
 *     （strictCspBuild 构建烘焙 / strictCspDev 开发注入），不再手写字面量 8675。
 *
 * 修改默认端口：只需改本文件一处。与 backend/app/constants.py DEFAULT_PORT 对齐。
 */
'use strict';

/** 默认后端端口（与 backend/app/constants.py DEFAULT_PORT 一致）。 */
const DEFAULT_BACKEND_PORT = 8675;

module.exports = { DEFAULT_BACKEND_PORT };
