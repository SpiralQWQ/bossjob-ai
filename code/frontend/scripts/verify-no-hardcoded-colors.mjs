#!/usr/bin/env node
/**
 * verify-no-hardcoded-colors.mjs —— 禁硬编码色门禁（DESIGN §10）。
 *
 * 扫描 src 下全部 ts/tsx/js/jsx 文件（排除 __tests__ 与色值真源文件），命中裸 hex / rgb(a) 即失败。
 * 把「禁硬编码色」从靠自觉变成机器断言（Grafana themes:usage 思路的轻量版），
 * 防止后续改动把色值写回组件。
 *
 * 用法：cd frontend && npm run verify:colors
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, '..', 'src');

/** 色值唯一真源文件（允许写色值）——若新增真源文件，需同步这里。 */
const TOKEN_SOURCE = [
  /^theme[/\\]designTokens\.ts$/,
  /^theme[/\\]tokenBuilders\.ts$/,
  /^theme[/\\]GlobalStyle\.tsx$/,
  /^theme[/\\]chartTheme\.ts$/,
];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_RE = /rgba?\(/;

const hits = [];
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(tsx?|jsx?)$/.test(ent.name)) continue;
    const rel = path.relative(srcRoot, p).replace(/\\/g, '/');
    if (TOKEN_SOURCE.some((re) => re.test(rel))) continue;
    const text = readFileSync(p, 'utf-8');
    text.split('\n').forEach((line, i) => {
      if (HEX_RE.test(line) || RGB_RE.test(line)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}
walk(srcRoot);

if (hits.length > 0) {
  console.error(`[verify:colors] 发现 ${hits.length} 处硬编码色（DESIGN §10 禁止；色值只允许出现在 designTokens.ts）：`);
  hits.forEach((h) => console.error(`  - ${h}`));
  process.exit(1);
}
console.log('[verify:colors] OK：src 无硬编码色（色值单一真源 designTokens）。');
