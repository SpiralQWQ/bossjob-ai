import { theme } from 'antd';
import type { ReactNode } from 'react';

export interface PageHeroProps {
  title: string;
  description: ReactNode;
  /** 操作区（快捷入口按钮等，可选）。 */
  actions?: ReactNode;
}

/**
 * 页面首屏欢迎区（DESIGN 克制 SaaS 质感：标题 + 副文案 + 操作入口）。
 * 颜色/边框/圆角全走 token（亮暗自适应，无硬编码色）。
 */
export default function PageHero({ title, description, actions }: PageHeroProps) {
  const { token } = theme.useToken();
  return (
    <div
      className="page-hero"
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        padding: '20px 24px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: token.colorText, lineHeight: '28px' }}>
          {title}
        </div>
        <div style={{ fontSize: 14, color: token.colorTextSecondary, marginTop: 4 }}>{description}</div>
      </div>
      {actions ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>{actions}</div>
      ) : null}
    </div>
  );
}
