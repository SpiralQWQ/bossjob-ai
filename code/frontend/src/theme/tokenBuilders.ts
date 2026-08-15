import { theme } from 'antd';
import type { ThemeConfig } from 'antd';
import {
  BRAND_COLORS,
  NEUTRAL_LIGHT,
  NEUTRAL_DARK,
  FONT_FAMILY,
  RADIUS,
  COMPONENT_TOKENS,
} from './designTokens';

/**
 * 亮/暗共用全局 token（字体栈 / 圆角）。对齐 DESIGN §3/§4。
 */
export const SHARED_DESIGN_TOKENS = {
  borderRadius: RADIUS.base,
  borderRadiusSM: RADIUS.sm,
  borderRadiusLG: RADIUS.lg,
  fontFamily: FONT_FAMILY,
} as const;

/** Sider 深色菜单选中项高亮底 + 表格选中行底（色值唯一真源在 designTokens.COMPONENT_TOKENS）。 */
const MENU_SELECTED_LIGHT = COMPONENT_TOKENS.menuSelectedLight;
const MENU_SELECTED_DARK = COMPONENT_TOKENS.menuSelectedDark;
const TABLE_ROW_SELECTED_LIGHT = COMPONENT_TOKENS.tableRowSelectedLight;
const TABLE_ROW_SELECTED_DARK = COMPONENT_TOKENS.tableRowSelectedDark;

/**
 * 亮色主题：defaultAlgorithm + DESIGN 亮色 token + 组件级 token。
 * @param accentColor 主色（默认品牌蓝；设置页「外观」主色预设传入）。
 */
export function buildLightThemeConfig(accentColor: string = BRAND_COLORS.primary): ThemeConfig {
  return {
    algorithm: theme.defaultAlgorithm,
    token: {
      ...SHARED_DESIGN_TOKENS,
      colorPrimary: accentColor,
      colorInfo: accentColor,
      colorSuccess: BRAND_COLORS.success,
      colorWarning: BRAND_COLORS.warning,
      colorError: BRAND_COLORS.error,
      ...NEUTRAL_LIGHT,
    },
    components: {
      Menu: {
        // 深色 Sider 内菜单：选中项高亮底 + 高亮文字
        darkItemSelectedBg: MENU_SELECTED_LIGHT,
        darkItemSelectedColor: '#ffffff',
      },
      Table: {
        rowSelectedBg: TABLE_ROW_SELECTED_LIGHT,
      },
      // 表单质感统一（DESIGN §5：输入圆角 8 / 标签次级色）
      Input: { borderRadius: RADIUS.base },
      Select: { borderRadius: RADIUS.base },
      InputNumber: { borderRadius: RADIUS.base },
      DatePicker: { borderRadius: RADIUS.base },
      Form: { labelColor: NEUTRAL_LIGHT.colorTextSecondary },
      Button: {
        // 默认组件阴影去除（DESIGN §4：Button 无阴影）
        boxShadow: 'none',
        primaryShadow: 'none',
      },
    },
  };
}

/**
 * 暗色主题：darkAlgorithm + DESIGN 暗色 token（色值只在此派生，禁写第二套死色）。
 * @param accentColor 主色（默认暗色品牌蓝；设置页「外观」主色预设传入）。
 */
export function buildDarkThemeConfig(accentColor: string = BRAND_COLORS.primaryDark): ThemeConfig {
  return {
    algorithm: theme.darkAlgorithm,
    token: {
      ...SHARED_DESIGN_TOKENS,
      colorPrimary: accentColor,
      colorInfo: accentColor,
      colorSuccess: BRAND_COLORS.success,
      colorWarning: BRAND_COLORS.warning,
      colorError: BRAND_COLORS.error,
      ...NEUTRAL_DARK,
    },
    components: {
      Menu: {
        darkItemSelectedBg: MENU_SELECTED_DARK,
        darkItemSelectedColor: '#ffffff',
      },
      Table: {
        rowSelectedBg: TABLE_ROW_SELECTED_DARK,
      },
      // 表单质感统一（DESIGN §5：输入圆角 8 / 标签次级色——暗色用暗色次级文字）
      Input: { borderRadius: RADIUS.base },
      Select: { borderRadius: RADIUS.base },
      InputNumber: { borderRadius: RADIUS.base },
      DatePicker: { borderRadius: RADIUS.base },
      Form: { labelColor: NEUTRAL_DARK.colorTextSecondary },
      Button: {
        boxShadow: 'none',
        primaryShadow: 'none',
      },
    },
  };
}
