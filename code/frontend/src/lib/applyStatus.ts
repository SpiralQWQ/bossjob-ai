/**
 * 投递状态映射单一事实来源：文案 / Badge 颜色 / 下拉选项。
 * 后端 status 枚举、README §6 与三处页面（DataViews/ApplyPage/InterviewPage）此前各自维护
 * 一份同内容常量，改状态枚举/颜色需改三处、易静默漂移；集中到此共享模块，页面统一 import。
 */

/** 投递状态 → Badge 颜色。 */
export const STATUS_COLOR: Record<string, string> = {
  pending: '#1677ff',
  replied: 'blue',
  interview: 'gold',
  offer: 'green',
  rejected: 'red',
  closed: '#d9d9d9',
};

/** 投递状态 → 文案。 */
export const STATUS_TEXT: Record<string, string> = {
  pending: '待反馈',
  replied: '已回复',
  interview: '面试中',
  offer: 'Offer',
  rejected: '被拒',
  closed: '已关闭',
};

/** 状态下拉选项（value/label）：模块级静态数组，只依赖 STATUS_TEXT，避免每次渲染重建，保证 AntD Select/Table memo 生效。 */
export const STATUS_OPTIONS = Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }));
