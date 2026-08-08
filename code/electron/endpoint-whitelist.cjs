/**
 * endpoint-whitelist.cjs —— 本地后端端点白名单 + 匹配函数（单一事实来源）。
 *
 * 背景：backend-request 是渲染层访问本地后端 /api/* 的【唯一】代理通道（见 main.js 对应注释）。
 * 其端点白名单（method + 锚定正则）若在将来演进（新增端点 / 参数化路径 / 放宽锚定）时放松校验，
 * 可能引入 SSRF / 任意路径访问。为防白名单演进回归，白名单与匹配函数收口于此模块：
 *   - main.js 运行时 require 本模块执行白名单校验；
 *   - scripts/verify-endpoint-whitelist.cjs 对同一份白名单做边界输入回归测试
 *     （路径注入 ../、%2e/%2f 编码、CRLF、绝对 URL、多余路径段、错误 HTTP 方法等）。
 * 白名单一旦变更，main.js 与测试自动共享新行为，杜绝「测试仍在测旧清单」的漂移。
 *
 * 匹配语义（与 main.js 原 inline 逻辑逐字节等价）：
 *   - 路径必须先以 /api/ 开头（与 pattern 的 ^ 双重锚定）；
 *   - 查询串剥离（path.split('?')[0]）后再匹配，避免查询串内容干扰正则（亦防正则爆涨）；
 *   - method 先 toUpperCase 再与白名单方法精确比较。
 */

const BACKEND_ENDPOINT_WHITELIST = [
  { method: 'GET', pattern: /^\/api\/health\/?$/ },
  { method: 'GET', pattern: /^\/api\/settings\/?$/ },
  { method: 'PUT', pattern: /^\/api\/settings\/?$/ },
  { method: 'GET', pattern: /^\/api\/applications\/?$/ },
  { method: 'GET', pattern: /^\/api\/applications\/ids\/?$/ },
  { method: 'POST', pattern: /^\/api\/applications\/?$/ },
  { method: 'GET', pattern: /^\/api\/applications\/\d+\/logs\/?$/ },
  { method: 'PATCH', pattern: /^\/api\/applications\/\d+\/?$/ },
  { method: 'DELETE', pattern: /^\/api\/applications\/\d+\/?$/ },
  { method: 'GET', pattern: /^\/api\/stats\/?$/ },
  { method: 'POST', pattern: /^\/api\/import\/?$/ },
];

/**
 * 判断「HTTP 方法 + 请求路径」是否命中白名单（查询串剥离、/api/ 前缀 + 方法精确匹配 + 正则锚定）。
 * @param {string} method HTTP 方法（大小写不敏感，内部统一 toUpperCase）
 * @param {string} path   请求路径（可含查询串；非字符串一律拒绝）
 * @returns {boolean}
 */
function isEndpointAllowed(method, path) {
  const m = typeof method === 'string' ? method.toUpperCase() : '';
  const pathname = typeof path === 'string' ? path.split('?')[0] : '';
  if (!pathname.startsWith('/api/')) return false;
  return BACKEND_ENDPOINT_WHITELIST.some(
    (r) => r.method === m && r.pattern.test(pathname)
  );
}

module.exports = { BACKEND_ENDPOINT_WHITELIST, isEndpointAllowed };
