import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * theme-bootstrap.js（public/ 防闪脚本）逻辑测试：
 * 直接执行脚本文件（jsdom 环境），断言 data-theme / colorScheme / 首帧背景按持久化主题正确设置。
 */
const BOOTSTRAP_PATH = path.resolve(process.cwd(), 'public', 'theme-bootstrap.js');
const bootstrapSrc = readFileSync(BOOTSTRAP_PATH, 'utf-8');

function runBootstrap() {
  // eslint-disable-next-line no-new-func
  new Function(bootstrapSrc)();
}

describe('theme-bootstrap 防闪脚本（T-04）', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false, // 系统亮色
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.background = '';
  });

  it('无存储 → system（系统亮色）→ data-theme=light + colorScheme light', () => {
    runBootstrap();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('持久化 dark → data-theme=dark + 首帧背景 #111318', () => {
    localStorage.setItem('bj-theme', JSON.stringify({ state: { themeMode: 'dark' }, version: 1 }));
    runBootstrap();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    // jsdom 会把 hex 序列化为 rgb()：#111318 → rgb(17, 19, 24)
    expect(document.documentElement.style.background).toBe('rgb(17, 19, 24)');
  });

  it('持久化 light → data-theme=light + 首帧背景 #f7f8fa', () => {
    localStorage.setItem('bj-theme', JSON.stringify({ state: { themeMode: 'light' }, version: 1 }));
    runBootstrap();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // jsdom 把 hex 序列化为 rgb()：#f7f8fa → rgb(247, 248, 250)
    expect(document.documentElement.style.background).toBe('rgb(247, 248, 250)');
  });

  it('存储非法 themeMode → 回落 system（不崩）', () => {
    localStorage.setItem('bj-theme', JSON.stringify({ state: { themeMode: 'red' }, version: 1 }));
    expect(() => runBootstrap()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('存储损坏 JSON → 静默降级 system（不崩）', () => {
    localStorage.setItem('bj-theme', '{ broken json');
    expect(() => runBootstrap()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
