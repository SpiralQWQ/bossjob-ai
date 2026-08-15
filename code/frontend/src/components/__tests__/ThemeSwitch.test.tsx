import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeSwitch from '../ThemeSwitch';
import { useSettingsStore } from '../../stores/settingsStore';

describe('ThemeSwitch（T-03 顶栏明暗切换）', () => {
  beforeAll(() => {
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
    useSettingsStore.setState({ themeMode: 'system' });
  });

  it('点击按钮 → 打开三态菜单（跟随系统/亮色/暗色）', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    await user.click(screen.getByRole('button', { name: '切换主题' }));
    expect(await screen.findByText('跟随系统')).toBeTruthy();
    expect(screen.getByText('亮色')).toBeTruthy();
    expect(screen.getByText('暗色')).toBeTruthy();
  });

  it('选「暗色」→ store.themeMode = dark + 持久化到 localStorage', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    await user.click(screen.getByRole('button', { name: '切换主题' }));
    await user.click(await screen.findByText('暗色'));
    expect(useSettingsStore.getState().themeMode).toBe('dark');
    const raw = localStorage.getItem('bj-theme');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.themeMode).toBe('dark');
  });

  it('选「亮色」→ store.themeMode = light', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    await user.click(screen.getByRole('button', { name: '切换主题' }));
    await user.click(await screen.findByText('亮色'));
    expect(useSettingsStore.getState().themeMode).toBe('light');
  });

  it('选「跟随系统」→ store.themeMode = system', async () => {
    useSettingsStore.getState().setThemeMode('dark');
    const user = userEvent.setup();
    render(<ThemeSwitch />);
    await user.click(screen.getByRole('button', { name: '切换主题' }));
    await user.click(await screen.findByText('跟随系统'));
    expect(useSettingsStore.getState().themeMode).toBe('system');
  });
});
