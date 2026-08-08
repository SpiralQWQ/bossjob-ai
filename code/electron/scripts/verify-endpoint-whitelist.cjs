#!/usr/bin/env node
/**
 * verify-endpoint-whitelist.cjs —— BACKEND_ENDPOINT_WHITELIST 正则回归测试（防白名单演进回归）。
 *
 * 背景（hardening）：
 *   backend-request 是渲染层访问本地后端的【唯一】鉴权通道（main.js），其端点白名单正则
 *   （BACKEND_ENDPOINT_WHITELIST，收口于 ../endpoint-whitelist.cjs）若在未来功能需求中扩充
 *   （新增文件读写 / 路径参数端点）而放松锚定或校验，可能引入 SSRF / 任意路径访问。
 *   本测试对白名单正则做边界输入回归防护：
 *     - 路径注入（../ 向上穿越、重复路径段）
 *     - 编码绕过（%2e / %2f / %252e 等）
 *     - CRLF / 控制字符注入
 *     - 绝对 URL / 协议相对 URL（SSRF 面）
 *     - 多余路径段（尾缀追加、中间插入）
 *     - 方法不匹配、查询串剥离、非数字 ID
 *   任一用例失败 → 退出码非 0，可接入打包门禁 / CI，防止未来白名单演进引入回归。
 *
 * 运行：node scripts/verify-endpoint-whitelist.cjs
 */

'use strict';

const assert = require('node:assert');
const { BACKEND_ENDPOINT_WHITELIST, isEndpointAllowed } = require('../endpoint-whitelist.cjs');

let failed = 0;
let passed = 0;

/** 断言某 (method, path) 必须被白名单放行。 */
function expectAllowed(method, path, label) {
  assert.strictEqual(
    isEndpointAllowed(method, path),
    true,
    `${label || `${method} ${path}`} 应被白名单放行`
  );
  passed += 1;
}

/** 断言某 (method, path) 必须被白名单拒绝。 */
function expectRejected(method, path, label) {
  assert.strictEqual(
    isEndpointAllowed(method, path),
    false,
    `${label || `${method} ${path}`} 应被白名单拒绝`
  );
  passed += 1;
}

/** 断言白名单结构本身安全：所有 pattern 必须严格锚定（^ 开头 /api/、$ 结尾），杜绝前缀宽松匹配。 */
function checkWhitelistStructure() {
  assert.ok(Array.isArray(BACKEND_ENDPOINT_WHITELIST) && BACKEND_ENDPOINT_WHITELIST.length > 0, '白名单不应为空');
  for (const entry of BACKEND_ENDPOINT_WHITELIST) {
    assert.ok(entry && typeof entry.method === 'string' && entry.pattern instanceof RegExp, '白名单条目须含 method + pattern');
    // regex .source 保留转义斜杠（^\/api\/health\/?$），先归一化 \/ → / 再做前缀/后缀锚定断言
    const src = entry.pattern.source.replace(/\\\//g, '/');
    assert.ok(
      src.startsWith('^/api/'),
      `pattern 必须以 ^/api/ 开头（防止放宽为任意路径前缀）：${entry.method} ${entry.pattern}`
    );
    assert.ok(
      src.endsWith('$'),
      `pattern 必须以 $ 结尾（防止后缀注入 / 多余路径段匹配）：${entry.method} ${entry.pattern}`
    );
    assert.ok(
      !src.includes('(?=.*') && !src.includes('|'),
      `pattern 不应含 OR 分支 / 前瞻（保持窄锚定，防 SSRF/路径注入面扩大）：${entry.method} ${entry.pattern}`
    );
  }
  passed += 1;
}

// ---------------------------------------------------------------------------
// 结构守卫：白名单自身必须保持严格锚定（未来扩充端点时的第一道防线）
// ---------------------------------------------------------------------------
checkWhitelistStructure();

// ---------------------------------------------------------------------------
// 正向用例：合法端点必须始终放行（防止未来收紧过度 / 误伤功能）
// ---------------------------------------------------------------------------

// 每个白名单条目对应的「基准合法路径」映射（用于自动生成正向用例）
const LEGAL_PATHS = {
  'GET /api/health': ['/api/health', '/api/health/'],
  'GET /api/settings': ['/api/settings', '/api/settings/'],
  'PUT /api/settings': ['/api/settings', '/api/settings/'],
  'GET /api/applications': ['/api/applications', '/api/applications/', '/api/applications?status=active', '/api/applications/?page=2'],
  'GET /api/applications/ids': ['/api/applications/ids', '/api/applications/ids/', '/api/applications/ids?limit=100'],
  'POST /api/applications': ['/api/applications', '/api/applications/'],
  'GET /api/applications/1/logs': ['/api/applications/1/logs', '/api/applications/1/logs/', '/api/applications/42/logs'],
  'PATCH /api/applications/1': ['/api/applications/1', '/api/applications/1/', '/api/applications/42'],
  'DELETE /api/applications/1': ['/api/applications/1', '/api/applications/1/'],
  'GET /api/stats': ['/api/stats', '/api/stats/'],
  'POST /api/import': ['/api/import', '/api/import/'],
};

for (const [key, paths] of Object.entries(LEGAL_PATHS)) {
  const [method, ...rest] = key.split(' ');
  const legalPath = rest.join(' ');
  for (const p of paths) {
    expectAllowed(method, p, `合法端点应放行：${method} ${p}`);
  }
}

// ---------------------------------------------------------------------------
// 负向用例：边界输入必须一律拒绝
// ---------------------------------------------------------------------------

// 1) 路径注入 / 向上穿越（.. 、./ 、重复路径段）
expectRejected('GET', '/api/settings/../etc/passwd');
expectRejected('GET', '/api/settings/..');
expectRejected('GET', '/api/../settings');
expectRejected('GET', '/../api/settings');
expectRejected('GET', '/api/./settings');
expectRejected('GET', '/api/settings/./');
expectRejected('GET', '/api/applications/1/../../settings');
expectRejected('GET', '/api/applications/1/../2/logs');
expectRejected('GET', '/api/settings/../../../../etc/passwd');
expectRejected('GET', '/api/settings..');

// 2) 编码绕过（%2e=%2e=. / %2f=/ / %252e 双重编码）
expectRejected('GET', '/api/%2e%2e/settings');
expectRejected('GET', '/api/%2e/settings');
expectRejected('GET', '/api/settings%2f..%2f..%2fetc');
expectRejected('GET', '/api/%2fetc%2fpasswd');
expectRejected('GET', '/api/%252e%252e/settings');
expectRejected('GET', '/api/settings%2e%2e');
expectRejected('GET', '/api/%2E%2E/settings');
expectRejected('GET', '/api/settings%2F');
expectRejected('GET', '/api/applications/%2e%2e/settings');

// 3) CRLF / 控制字符注入（请求走私 / 头注入）
expectRejected('GET', '/api/settings\r\nX-Evil: 1');
expectRejected('GET', '/api/settings\nX-Evil: 1');
expectRejected('GET', '/api/settings\r');
expectRejected('GET', '/api/settings\n');
expectRejected('GET', '/api/settings\t');
expectRejected('GET', '/api/settings\x00');
expectRejected('GET', '/api/settings\r\n');
expectRejected('GET', '/api/applications/1/logs\r\nX-Evil: 1');

// 4) 绝对 URL / 协议相对 URL / 伪路径（SSRF 面）
expectRejected('GET', 'http://127.0.0.1:8675/api/settings');
expectRejected('GET', 'https://evil.com/api/settings');
expectRejected('GET', '//evil.com/api/settings');
expectRejected('GET', 'file:///etc/passwd');
expectRejected('GET', 'javascript:alert(1)');
expectRejected('GET', '/api/1/api/settings');
expectRejected('GET', '1/api/settings');

// 5) 多余路径段（尾缀追加 / 中间插入 / 前缀伪装）
expectRejected('GET', '/api/settings/extra');
expectRejected('GET', '/api/settings/anything');
expectRejected('GET', '/api/health/extra');
expectRejected('GET', '/api/applications/1/logs/extra');
expectRejected('GET', '/api/applications/1/extra');
expectRejected('GET', '/api/applications/1/logs/1');
expectRejected('GET', '/api/extra/settings');
expectRejected('GET', '/api/applications/extra');
expectRejected('GET', '/api/applications/1/logs/2/3');
expectRejected('GET', '/apix/settings');
expectRejected('GET', '/apifoo/api/settings');

// 6) 方法不匹配（同路径换方法必须拒绝）
expectRejected('POST', '/api/settings');
expectRejected('DELETE', '/api/settings');
expectRejected('PATCH', '/api/settings');
expectRejected('GET', '/api/import');
expectRejected('DELETE', '/api/import');
expectRejected('GET', '/api/settings/1');
expectRejected('POST', '/api/health');
expectRejected('PUT', '/api/health');
expectRejected('POST', '/api/applications/1/logs');
expectRejected('GET', '/api/applications/1');
expectRejected('PUT', '/api/applications');

// 7) 非数字 ID / 非法数字形态（路径参数端点的正则必须是 \d+ 窄锚定）
expectRejected('GET', '/api/applications/abc/logs');
expectRejected('GET', '/api/applications/1.5');
expectRejected('GET', '/api/applications/-1');
expectRejected('GET', '/api/applications/1e3');
expectRejected('GET', '/api/applications/0x1F');
expectRejected('GET', '/api/applications/ 1');
expectRejected('GET', '/api/applications/99999999999999999999');

// 8) 空路径 / 缺失路径 / 非字符串（类型防御）
expectRejected('GET', '');
expectRejected('GET', '/');
expectRejected('GET', '/api');
expectRejected('GET', '/api/');
expectRejected('GET', null);
expectRejected('GET', undefined);
expectRejected('GET', 42);
expectRejected('GET', { path: '/api/settings' });
expectRejected(null, '/api/settings');
expectRejected('', '/api/settings');

// 9) 查询串剥离：仅 pathname 参与匹配，查询串中的伪路径不放大白名单
//    （? 后内容被 split('?')[0] 剥离，不会命中其它端点）
expectAllowed('GET', '/api/settings?redirect=/api/import');
expectRejected('GET', '/api/import?x=/api/health');
expectAllowed('GET', '/api/applications/1/logs?from=..%2f..');

// ---------------------------------------------------------------------------
// 汇总输出
// ---------------------------------------------------------------------------
console.log(`[verify-endpoint-whitelist] 通过 ${passed} 项断言（白名单 ${BACKEND_ENDPOINT_WHITELIST.length} 条，全部严格锚定）。`);

if (failed > 0) {
  console.error(`[verify-endpoint-whitelist] 失败 ${failed} 项：BACKEND_ENDPOINT_WHITELIST 正则存在边界回归，请检查 endpoint-whitelist.cjs 的锚定/校验。`);
  process.exit(1);
}
