import { Card, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

export interface ChartCardProps {
  title: ReactNode;
  /** 卡片右上操作区。 */
  extra?: ReactNode;
  /** 头部大数字（可选）。 */
  total?: ReactNode;
  /** 图表区。 */
  children: ReactNode;
  /** 底部说明/趋势（可选）。 */
  footer?: ReactNode;
  /** 传给 Card 的样式（图表卡宽度/弹性布局）。 */
  style?: CSSProperties;
}

/**
 * 图表卡：标题 + 操作 + 大数字 + 图表区 + 底部说明（DESIGN §5/§6，ChartCard 范式）。
 * 卡片容器用 Antd Card（token 驱动亮暗背景/边框），色值不在此写死。
 */
export default function ChartCard({ title, extra, total, children, footer, style }: ChartCardProps) {
  const { token } = theme.useToken();
  return (
    <Card title={title} extra={extra} style={style} styles={{ body: { paddingTop: total ? 12 : 24 } }}>
      {total ? (
        <div
          style={{
            fontSize: 28,
            lineHeight: '36px',
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            marginBottom: 12,
            color: token.colorText,
          }}
        >
          {total}
        </div>
      ) : null}
      {children}
      {footer ? (
        <div style={{ marginTop: 12, fontSize: 12, color: token.colorTextSecondary }}>{footer}</div>
      ) : null}
    </Card>
  );
}
