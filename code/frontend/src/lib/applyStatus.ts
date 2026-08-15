/**
 * 投递状态映射单一事实来源：文案 / Badge 颜色 / 下拉选项。
 * 后端 status 枚举、README §6 与三处页面（DataViews/ApplyPage/InterviewPage）此前各自维护
 * 一份同内容常量，改状态枚举/颜色需改三处、易静默漂移；集中到此共享模块，页面统一 import。
 */

import { STATUS_HEX } from '../theme/designTokens';

/** 投递状态 → Badge 颜色（色值唯一真源 designTokens.STATUS_HEX；换色只改那里，亮暗可读性统一）。 */
export const STATUS_COLOR: Record<string, string> = {
  pending: STATUS_HEX.pending,
  replied: STATUS_HEX.replied,
  interview: STATUS_HEX.interview,
  offer: STATUS_HEX.offer,
  rejected: STATUS_HEX.rejected,
  closed: STATUS_HEX.closed,
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
