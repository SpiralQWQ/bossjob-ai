import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppIcon, APP_ICONS } from '../AppIcon';

describe('AppIcon（T-08 统一图标出口）', () => {
  it('渲染对应 tabler 图标（svg）', () => {
    const { container } = render(<AppIcon name="home" />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('全部注册图标均可渲染（无缺漏/无崩溃）', () => {
    (Object.keys(APP_ICONS) as Array<keyof typeof APP_ICONS>).forEach((name) => {
      const { container } = render(<AppIcon name={name} />);
      expect(container.querySelector('svg'), `图标 ${name} 应渲染 svg`).toBeTruthy();
    });
  });

  it('size 生效（宽高 = size）', () => {
    const { container } = render(<AppIcon name="settings" size={20} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
  });

  it('aria-hidden（装饰性图标不干扰读屏）', () => {
    const { container } = render(<AppIcon name="tracker" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
