import { theme } from 'antd';
import { useMemo } from 'react';
import { SHADOWS } from './designTokens';

/**
 * 全局基线样式（CssBaseline + 暗色滚动条，DESIGN §4；MUI CssBaseline/darkScrollbar 思想）。
 *
 * 用 theme.useToken() 取当前 token 注入 <style>，色值单一真源（token），随主题自动重建；
 * 不使用外部 CSS 文件，契合项目"无外部 CSS"的 CSP 基线（style-src 'unsafe-inline'）。
 */
export default function GlobalStyle() {
  const { token } = theme.useToken();
  const css = useMemo(() => {
    // 次级文字色 + 8 位 hex alpha：滚动条 thumb（30%）/ hover（50%）
    const thumb = `${token.colorTextSecondary}4d`;
    const thumbHover = `${token.colorTextSecondary}80`;
    return `
      :root { color-scheme: light; }
      [data-theme='dark'] { color-scheme: dark; }
      body {
        margin: 0;
        background: ${token.colorBgLayout};
        font-family: ${token.fontFamily};
        -webkit-font-smoothing: antialiased;
      }
      /* 暗色滚动条（色走 token，亮色保留原生） */
      [data-theme='dark'] *::-webkit-scrollbar { width: 10px; height: 10px; }
      [data-theme='dark'] *::-webkit-scrollbar-track { background: transparent; }
      [data-theme='dark'] *::-webkit-scrollbar-thumb {
        background: ${thumb};
        border-radius: 5px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      [data-theme='dark'] *::-webkit-scrollbar-thumb:hover { background: ${thumbHover}; }
      /* 看板统计卡（DESIGN §5）：布局/动效在类，token 色走组件内联；hover 上浮 + 克制阴影 */
      .stat-card {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 16px 20px;
        border-radius: ${token.borderRadiusLG}px;
        background: ${token.colorBgContainer};
        border: 1px solid ${token.colorBorder};
        font-family: inherit;
        text-align: left;
        transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1), box-shadow 0.2s;
      }
      .stat-card:hover {
        transform: translateY(-2px);
        box-shadow: ${SHADOWS.cardHover};
      }
      .stat-card:active { transform: translateY(0); }
      .stat-card:focus-visible { outline: 2px solid ${token.colorPrimary}; outline-offset: 2px; }
      /* 主题切换期间禁用过渡（防明暗切换卡顿/蠕动） */
      html.theme-switching *, html.theme-switching *::before, html.theme-switching *::after {
        transition: none !important;
      }
    `;
  }, [token]);

  return <style>{css}</style>;
}
