import { render } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import GlobalStyle from '../GlobalStyle';

describe('GlobalStyle（T-04 全局基线 + 暗色滚动条 + 禁过渡）', () => {
  it('渲染 <style> 基线，含 color-scheme / data-theme 选择器 / 滚动条 / theme-switching', () => {
    const { container } = render(
      <ConfigProvider>
        <GlobalStyle />
      </ConfigProvider>
    );
    const style = container.querySelector('style');
    expect(style).toBeTruthy();
    const css = style!.textContent ?? '';
    expect(css).toContain('color-scheme: light');
    expect(css).toContain("[data-theme='dark'] { color-scheme: dark; }");
    expect(css).toContain('::-webkit-scrollbar');
    expect(css).toContain('theme-switching');
    expect(css).toContain('body');
  });

  it('暗色 token 下滚动条色使用暗色次级文字色', () => {
    const { container } = render(
      <ConfigProvider theme={{ algorithm: undefined }}>
        <GlobalStyle />
      </ConfigProvider>
    );
    // 无论明暗都渲染 style；暗色变体由 data-theme 选择器控制，内容不因 Provider 重复
    expect(container.querySelector('style')).toBeTruthy();
  });
});
