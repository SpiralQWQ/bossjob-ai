/**
 * 设计令牌唯一真源（DESIGN_BossJobAI.md §2/§3/§4/§5）。
 *
 * 铁律：所有颜色/字体/圆角/阴影只允许在此文件出现；组件一律经 tokenBuilders 或
 * `theme.useToken()` 消费，禁止在组件里硬编码颜色（DESIGN §10「禁止事项」）。
 * 色值变更只改这里，全站联动。
 */

/** 品牌色 + 语义色（DESIGN §2.1 亮色 / §2.2 暗色）。 */
export const BRAND_COLORS = {
  /** 亮色品牌主色（稳重蓝，比 Antd 默认蓝更沉、更职业）。 */
  primary: '#2563eb',
  /** 暗色品牌主色（略提亮，对比度更舒服）。 */
  primaryDark: '#3b82f6',
  info: '#2563eb',
  success: '#16a34a',
  warning: '#f59e0b',
  error: '#dc2626',
} as const;

/** 亮色中性色（DESIGN §2.1）。 */
export const NEUTRAL_LIGHT = {
  colorBgLayout: '#f7f8fa',
  colorBgContainer: '#ffffff',
  colorText: '#1f2430',
  colorTextSecondary: '#5c6470',
  colorBorder: '#e4e7ec',
} as const;

/** 暗色中性色（DESIGN §2.2）。 */
export const NEUTRAL_DARK = {
  colorBgLayout: '#111318',
  colorBgContainer: '#1a1d24',
  colorText: '#e8eaf0',
  colorTextSecondary: '#9aa3b2',
  colorBorder: '#2a2f3a',
} as const;

/**
 * 投递状态 → Antd 语义色名（DESIGN §2.3 状态色；是 lib/applyStatus.ts STATUS_COLOR 的 token 化来源，
 * T-09 接入）。含义勿改：待反馈=蓝 / 已回复=处理中蓝 / 面试中=geekblue / Offer=绿 / 被拒=红 / 已关闭=中性。
 */
export const STATUS_SEMANTIC = {
  pending: 'info',
  replied: 'blue',
  interview: 'geekblue',
  offer: 'success',
  rejected: 'error',
  closed: 'default',
} as const;

/** 字体栈（DESIGN §3）——中文优先，Segoe UI 置后（126 报告：置于最前会导致 emoji 字体冲突）。 */
export const FONT_FAMILY =
  "-apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";

/** 圆角（DESIGN §4）：基础 8 / 小 6 / 大 12。 */
export const RADIUS = { sm: 6, base: 8, lg: 12 } as const;

/** 阴影（DESIGN §4）：悬浮卡克制上浮阴影 / 弹层阴影。 */
export const SHADOWS = {
  cardHover: '0 4px 12px rgba(15,23,42,.06)',
  modal: '0 8px 30px rgba(15,23,42,.12)',
} as const;

/** 状态色 hex 族（供图表色板/非 Antd 语义元素派生；语义勿改）。 */
export const STATUS_HEX = {
  pending: '#1677ff',
  replied: '#1677ff',
  interview: '#2f54eb',
  offer: '#16a34a',
  rejected: '#dc2626',
  closed: '#d9d9d9',
} as const;

/** 组件级 token 色（品牌主色半透明派生，DESIGN §5）：深色菜单选中项底 / 表格选中行底。 */
export const COMPONENT_TOKENS = {
  menuSelectedLight: 'rgba(37,99,235,.15)',
  menuSelectedDark: 'rgba(59,130,246,.15)',
  tableRowSelectedLight: 'rgba(37,99,235,.06)',
  tableRowSelectedDark: 'rgba(59,130,246,.10)',
} as const;

/** 图表对比/强调色（DESIGN §6：紫/绿/拒绝红）；主序列亮暗自适应走 token.colorPrimary，禁写死第二套暗色板。 */
export const CHART_ACCENT = {
  violet: '#8b5cf6',
  teal: '#10b981',
  reject: '#ef4444',
} as const;

/** 主色预设（设置页「外观」可选主题色；品牌蓝默认 + 4 备选，换色只改这里）。 */
export const PRESET_COLORS = {
  blue: '#2563eb',
  cyan: '#0891b2',
  teal: '#0d9488',
  violet: '#7c3aed',
  amber: '#d97706',
} as const;
export type PresetKey = keyof typeof PRESET_COLORS;
