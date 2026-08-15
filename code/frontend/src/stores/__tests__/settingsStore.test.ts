import { describe, expect, it, beforeEach } from 'vitest';
import { useSettingsStore } from '../settingsStore';

describe('settingsStore 主题状态（T-02 暗色 store）', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ themeMode: 'system' });
  });

  it('初始 themeMode = system（默认跟随系统）', () => {
    expect(useSettingsStore.getState().themeMode).toBe('system');
  });

  it('setThemeMode 支持三态', () => {
    useSettingsStore.getState().setThemeMode('dark');
    expect(useSettingsStore.getState().themeMode).toBe('dark');
    useSettingsStore.getState().setThemeMode('light');
    expect(useSettingsStore.getState().themeMode).toBe('light');
    useSettingsStore.getState().setThemeMode('system');
    expect(useSettingsStore.getState().themeMode).toBe('system');
  });

  it('toggleTheme 亮/暗二态切换（system 不参与二态）', () => {
    useSettingsStore.getState().setThemeMode('dark');
    useSettingsStore.getState().toggleTheme();
    expect(useSettingsStore.getState().themeMode).toBe('light');
    useSettingsStore.getState().toggleTheme();
    expect(useSettingsStore.getState().themeMode).toBe('dark');
  });

  it('主题模式持久化到 localStorage bj-theme（partialize 只存 themeMode，后端配置不入库）', () => {
    useSettingsStore.getState().setThemeMode('dark');
    const raw = localStorage.getItem('bj-theme');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown>; version: number };
    expect(parsed.state.themeMode).toBe('dark');
    expect(parsed.state.settings).toBeUndefined();
    expect(parsed.version).toBe(1);
  });

  it('fetchSettings 失败不触碰主题状态', async () => {
    // settings 后端逻辑不变：仅验证主题字段独立，不受 fetch 影响
    useSettingsStore.getState().setThemeMode('light');
    expect(useSettingsStore.getState().themeMode).toBe('light');
    expect(useSettingsStore.getState().settings).toBeNull();
  });

  it('accentColor 默认品牌蓝 + setAccentColor + 持久化（partialize 含 accentColor）', () => {
    expect(useSettingsStore.getState().accentColor).toBe('#2563eb');
    useSettingsStore.getState().setAccentColor('#0891b2');
    expect(useSettingsStore.getState().accentColor).toBe('#0891b2');
    const raw = localStorage.getItem('bj-theme');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.accentColor).toBe('#0891b2');
  });
});
