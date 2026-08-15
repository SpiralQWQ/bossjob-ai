import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppTheme } from '../useAppTheme';
import { useSettingsStore } from '../../stores/settingsStore';

describe('useAppTheme（T-02 主题消费 hook）', () => {
  beforeAll(() => {
    // jsdom 无 matchMedia：mock 使 system 态可测（默认 matches=false = 系统亮色）
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    localStorage.clear();
    // 重置主题 + 主色（防测试间污染）
    useSettingsStore.setState({ themeMode: 'system', accentColor: '#2563eb' });
  });

  it('system 态（系统亮色）→ resolvedMode=light + 亮色 token', () => {
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.resolvedMode).toBe('light');
    expect(result.current.theme.token?.colorPrimary).toBe('#2563eb');
  });

  it('dark 态 → resolvedMode=dark + 暗色 token（主色走 accentColor，背景走暗色 token）', () => {
    useSettingsStore.getState().setThemeMode('dark');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.resolvedMode).toBe('dark');
    // 主色来自 accentColor（默认品牌蓝 #2563eb）；暗色中性色独立
    expect(result.current.theme.token?.colorPrimary).toBe('#2563eb');
    expect(result.current.theme.token?.colorBgLayout).toBe('#111318');
  });

  it('light 态 → resolvedMode=light', () => {
    useSettingsStore.getState().setThemeMode('light');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.resolvedMode).toBe('light');
  });

  it('store 变更驱动 theme 重建（darkMode 切换生效）', () => {
    const { result, rerender } = renderHook(() => useAppTheme());
    expect(result.current.resolvedMode).toBe('light');
    useSettingsStore.getState().setThemeMode('dark');
    rerender();
    expect(result.current.resolvedMode).toBe('dark');
  });

  it('accentColor 变更 → theme 主色跟随（主色预设）', () => {
    useSettingsStore.getState().setAccentColor('#0891b2');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.theme.token?.colorPrimary).toBe('#0891b2');
  });
});
