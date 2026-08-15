import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { useAppTheme } from './theme/useAppTheme';
import GlobalStyle from './theme/GlobalStyle';
import Notifications from './components/Notifications';
import ErrorBoundary from './components/ErrorBoundary';

/**
 * 应用根：Antd 全局中文 + 主题（读 settingsStore.themeMode，system 态跟随系统）+ 全局基线样式。
 * ConfigProvider 是唯一主题注入点，全站组件 token 由此生效（DESIGN §2）。
 */
function Root() {
  const { theme, resolvedMode } = useAppTheme();

  // 同步 html[data-theme]（防闪 bootstrap 已设初值，这里持续跟随用户后续切换），
  // 并在切换期间加 theme-switching 类禁用过渡（GlobalStyle 里 transition:none），防明暗切换卡顿。
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedMode;
    const el = document.documentElement;
    el.classList.add('theme-switching');
    const timer = setTimeout(() => el.classList.remove('theme-switching'), 250);
    return () => clearTimeout(timer);
  }, [resolvedMode]);

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <GlobalStyle />
      <ErrorBoundary>
        <Notifications />
        <App />
      </ErrorBoundary>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
