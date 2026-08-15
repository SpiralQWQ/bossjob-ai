import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { BulbOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useSettingsStore, type ThemeMode } from '../stores/settingsStore';
import { useAppTheme } from '../theme/useAppTheme';

/** 主题三态菜单项（DESIGN §7：跟随系统 / 亮色 / 暗色）。 */
const THEME_ITEMS: MenuProps['items'] = [
  { key: 'system', label: '跟随系统', icon: <DesktopOutlined /> },
  { key: 'light', label: '亮色', icon: <SunOutlined /> },
  { key: 'dark', label: '暗色', icon: <MoonOutlined /> },
];

/**
 * 顶栏主题切换（三态）。按钮图标随当前生效模式变化（system 态显示灯泡），
 * 点击弹三态菜单，选中即写 store（persist 持久化，刷新/重启保持）。
 */
export default function ThemeSwitch() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const { resolvedMode } = useAppTheme();

  const currentIcon =
    resolvedMode === 'dark' ? (
      <MoonOutlined />
    ) : resolvedMode === 'light' ? (
      <SunOutlined />
    ) : (
      <BulbOutlined />
    );

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: THEME_ITEMS,
        selectedKeys: [themeMode],
        onClick: ({ key }) => setThemeMode(key as ThemeMode),
      }}
    >
      <Button type="text" icon={currentIcon} aria-label="切换主题" title="切换主题" />
    </Dropdown>
  );
}
