import { theme } from 'antd';

export interface StatCardProps {
  title: string;
  value: number;
  /** 数值精度（如通过率 1 位小数）；省略按原值显示。 */
  precision?: number;
  /** 数值后缀（如 %）。 */
  suffix?: string;
  /** 大数字语义色（色值从 token 取，亮暗自适应，禁写死 hex）。 */
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'error';
  /** 点击下钻（看板统计卡可跳转记录页并预筛）。 */
  onClick?: () => void;
  /** 悬停提示（说明统计口径等）。 */
  titleTip?: string;
}

const TONES = ['default', 'primary', 'success', 'warning', 'error'] as const;

/**
 * 看板统计卡：小标签 + 大数字（tabular-nums）+ hover 上浮 + 点击下钻（DESIGN §5）。
 * 布局/hover 动效在 GlobalStyle .stat-card；此处只放 token 动态色值与数值。
 */
export default function StatCard({
  title,
  value,
  precision,
  suffix,
  tone = 'default',
  onClick,
  titleTip,
}: StatCardProps) {
  const { token } = theme.useToken();
  const toneColor: Record<(typeof TONES)[number], string> = {
    default: token.colorText,
    primary: token.colorPrimary,
    success: token.colorSuccess,
    warning: token.colorWarning,
    error: token.colorError,
  };
  const display = precision != null ? value.toFixed(precision) : String(value);

  return (
    <button
      type="button"
      className="stat-card"
      title={titleTip}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <span style={{ fontSize: 12, lineHeight: '18px', color: token.colorTextSecondary }}>{title}</span>
      <span
        style={{
          fontSize: 28,
          lineHeight: '36px',
          fontWeight: 800,
          color: toneColor[tone],
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {display}
        {suffix ? (
          <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 2, color: token.colorText }}>{suffix}</span>
        ) : null}
      </span>
    </button>
  );
}
