import { useMemo } from 'react';
import { theme } from 'antd';
import { CHART_ACCENT } from './designTokens';

/** buildChartPalette 所需的最小 token 结构（GlobalToken 是其超集，结构兼容）。 */
type TokenLike = {
  colorPrimary: string;
  colorSuccess: string;
  colorWarning: string;
  colorError: string;
  colorText: string;
  colorTextSecondary: string;
  colorBorder: string;
  colorBgContainer: string;
  colorSplit?: string;
};

export interface ChartPalette {
  /** 主序列（品牌主色，亮暗自适应）。 */
  primary: string;
  /** 对比强调色（DESIGN §6 固定值）。 */
  violet: string;
  teal: string;
  reject: string;
  success: string;
  warning: string;
  error: string;
  /** 文字 / 次级文字 / 坐标轴分隔线 / 容器底 / 边框（token 派生）。 */
  text: string;
  textSecondary: string;
  splitLine: string;
  bg: string;
  border: string;
  /** 分类色板（环形图等：主序列 + 对比 + 语义 + 中性）。 */
  category: string[];
}

/**
 * 从 Antd token 派生 ECharts 图表色板（DESIGN §6：暗色由 token 派生，禁写死第二套暗色板）。
 * 主序列/语义/文字走 token（亮暗自适应），对比强调色走 CHART_ACCENT 固定真源。
 */
export function buildChartPalette(token: TokenLike): ChartPalette {
  return {
    primary: token.colorPrimary,
    violet: CHART_ACCENT.violet,
    teal: CHART_ACCENT.teal,
    reject: CHART_ACCENT.reject,
    success: token.colorSuccess,
    warning: token.colorWarning,
    error: token.colorError,
    text: token.colorText,
    textSecondary: token.colorTextSecondary,
    splitLine: token.colorSplit ?? token.colorBorder,
    bg: token.colorBgContainer,
    border: token.colorBorder,
    category: [
      token.colorPrimary,
      CHART_ACCENT.violet,
      CHART_ACCENT.teal,
      token.colorWarning,
      token.colorError,
      token.colorBorder,
    ],
  };
}

/** 在组件里取当前主题下的图表色板（useToken 消费 ConfigProvider token；token 稳定时引用稳定，供 useMemo 依赖）。 */
export function useChartPalette(): ChartPalette {
  const { token } = theme.useToken();
  return useMemo(() => buildChartPalette(token), [token]);
}
