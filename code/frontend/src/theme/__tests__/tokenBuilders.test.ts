import { describe, expect, it } from 'vitest';
import {
  buildLightThemeConfig,
  buildDarkThemeConfig,
  SHARED_DESIGN_TOKENS,
} from '../tokenBuilders';
import { BRAND_COLORS, NEUTRAL_LIGHT, NEUTRAL_DARK } from '../designTokens';

/** 设计规范锁定值（DESIGN §2/§4）。改了规范必须同步改这里 + designTokens.ts。 */
const DESIGN_LOCK = {
  lightPrimary: '#2563eb',
  darkPrimary: '#3b82f6',
  success: '#16a34a',
  warning: '#f59e0b',
  error: '#dc2626',
  radiusSm: 6,
  radiusBase: 8,
  radiusLg: 12,
  menuSelectedLight: 'rgba(37,99,235,.15)',
  menuSelectedDark: 'rgba(59,130,246,.15)',
} as const;

describe('tokenBuilders 亮色主题', () => {
  it('品牌色/语义色 = DESIGN §2.1（且与 designTokens 源一致）', () => {
    const t = buildLightThemeConfig().token!;
    expect(t.colorPrimary).toBe(BRAND_COLORS.primary);
    expect(BRAND_COLORS.primary).toBe(DESIGN_LOCK.lightPrimary);
    expect(t.colorInfo).toBe(BRAND_COLORS.info);
    expect(t.colorSuccess).toBe(BRAND_COLORS.success);
    expect(BRAND_COLORS.success).toBe(DESIGN_LOCK.success);
    expect(t.colorWarning).toBe(BRAND_COLORS.warning);
    expect(BRAND_COLORS.warning).toBe(DESIGN_LOCK.warning);
    expect(t.colorError).toBe(BRAND_COLORS.error);
    expect(BRAND_COLORS.error).toBe(DESIGN_LOCK.error);
  });

  it('中性色 = DESIGN §2.1（且与 designTokens 源一致）', () => {
    const t = buildLightThemeConfig().token!;
    expect(t.colorBgLayout).toBe(NEUTRAL_LIGHT.colorBgLayout);
    expect(t.colorBgContainer).toBe(NEUTRAL_LIGHT.colorBgContainer);
    expect(t.colorText).toBe(NEUTRAL_LIGHT.colorText);
    expect(t.colorTextSecondary).toBe(NEUTRAL_LIGHT.colorTextSecondary);
    expect(t.colorBorder).toBe(NEUTRAL_LIGHT.colorBorder);
  });
});

describe('tokenBuilders 暗色主题', () => {
  it('主色提亮 + 中性色 = DESIGN §2.2', () => {
    const t = buildDarkThemeConfig().token!;
    expect(t.colorPrimary).toBe(BRAND_COLORS.primaryDark);
    expect(BRAND_COLORS.primaryDark).toBe(DESIGN_LOCK.darkPrimary);
    expect(t.colorBgLayout).toBe(NEUTRAL_DARK.colorBgLayout);
    expect(t.colorBgContainer).toBe(NEUTRAL_DARK.colorBgContainer);
    expect(t.colorText).toBe(NEUTRAL_DARK.colorText);
    expect(t.colorTextSecondary).toBe(NEUTRAL_DARK.colorTextSecondary);
    expect(t.colorBorder).toBe(NEUTRAL_DARK.colorBorder);
  });

  it('暗色主色 ≠ 亮色主色（提亮生效）', () => {
    expect(DESIGN_LOCK.darkPrimary).not.toBe(DESIGN_LOCK.lightPrimary);
  });
});

describe('tokenBuilders 共用', () => {
  it('圆角 = DESIGN §4（8/6/12）', () => {
    expect(SHARED_DESIGN_TOKENS.borderRadius).toBe(DESIGN_LOCK.radiusBase);
    expect(SHARED_DESIGN_TOKENS.borderRadiusSM).toBe(DESIGN_LOCK.radiusSm);
    expect(SHARED_DESIGN_TOKENS.borderRadiusLG).toBe(DESIGN_LOCK.radiusLg);
  });

  it('亮暗算法均已配置（defaultAlgorithm/darkAlgorithm 非空）', () => {
    expect(buildLightThemeConfig().algorithm).toBeTruthy();
    expect(buildDarkThemeConfig().algorithm).toBeTruthy();
  });

  it('组件级 token：深色菜单选中项 / 表格选中行 / 按钮去阴影', () => {
    const light = buildLightThemeConfig().components!;
    const dark = buildDarkThemeConfig().components!;
    expect(light.Menu?.darkItemSelectedBg).toBe(DESIGN_LOCK.menuSelectedLight);
    expect(dark.Menu?.darkItemSelectedBg).toBe(DESIGN_LOCK.menuSelectedDark);
    expect(light.Button?.boxShadow).toBe('none');
    expect(light.Button?.primaryShadow).toBe('none');
    expect(dark.Button?.boxShadow).toBe('none');
    expect(light.Table?.rowSelectedBg).toBeTruthy();
    expect(dark.Table?.rowSelectedBg).toBeTruthy();
  });

  it('accentColor 参数覆盖主色（设置页主色预设）', () => {
    const light = buildLightThemeConfig('#0891b2').token!;
    expect(light.colorPrimary).toBe('#0891b2');
    expect(light.colorInfo).toBe('#0891b2');
    const dark = buildDarkThemeConfig('#7c3aed').token!;
    expect(dark.colorPrimary).toBe('#7c3aed');
  });

  it('表单质感：输入圆角 8 / 表单标签次级色（亮暗各自）', () => {
    const light = buildLightThemeConfig().components!;
    const dark = buildDarkThemeConfig().components!;
    expect(light.Input?.borderRadius).toBe(8);
    expect(light.Select?.borderRadius).toBe(8);
    expect(light.Form?.labelColor).toBe('#5c6470'); // 亮色次级文字
    expect(dark.Form?.labelColor).toBe('#9aa3b2'); // 暗色次级文字
  });
});
