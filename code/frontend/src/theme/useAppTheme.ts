import { useEffect, useMemo, useState } from 'react';
import type { ThemeConfig } from 'antd';
import { useSettingsStore, type ThemeMode } from '../stores/settingsStore';
import { buildLightThemeConfig, buildDarkThemeConfig } from './tokenBuilders';

/** 系统是否偏好暗色；无 matchMedia 环境（如旧 jsdom）回退 false。 */
function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

export interface AppTheme {
  /** 传给 <ConfigProvider theme> 的配置（亮/暗已选定）。 */
  theme: ThemeConfig;
  /** 当前实际生效模式（system 已解析为 light/dark）。 */
  resolvedMode: 'light' | 'dark';
}

/**
 * 主题消费 hook：读 settingsStore.themeMode（persist），system 态实时跟随系统偏好。
 * 返回的 theme 直接作为 ConfigProvider 的 theme 传入（见 main.tsx）。
 */
export function useAppTheme(): AppTheme {
  const themeMode: ThemeMode = useSettingsStore((s) => s.themeMode);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // system 态：订阅系统明暗变化，实时跟随
  useEffect(() => {
    if (themeMode !== 'system') return;
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    setSystemDark(mql.matches); // 挂载时校准（避免注册后首帧用旧值）
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [themeMode]);

  const resolvedMode: 'light' | 'dark' =
    themeMode === 'dark' || (themeMode === 'system' && systemDark) ? 'dark' : 'light';

  const theme = useMemo(
    () => (resolvedMode === 'dark' ? buildDarkThemeConfig(accentColor) : buildLightThemeConfig(accentColor)),
    [resolvedMode, accentColor]
  );

  return { theme, resolvedMode };
}
