import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import PageHero from '../PageHero';

const wrap = (node: React.ReactNode) => <ConfigProvider>{node}</ConfigProvider>;

describe('PageHero（T-14 首屏欢迎区）', () => {
  it('渲染标题 / 描述 / 操作区', () => {
    render(
      wrap(
        <PageHero title="求职投递助手" description="管理你的投递记录" actions={<button>快捷</button>} />
      )
    );
    expect(screen.getByText('求职投递助手')).toBeTruthy();
    expect(screen.getByText('管理你的投递记录')).toBeTruthy();
    expect(screen.getByText('快捷')).toBeTruthy();
  });

  it('无 actions 时正常渲染（仅标题 + 描述）', () => {
    render(wrap(<PageHero title="标题" description="描述" />));
    expect(screen.getByText('标题')).toBeTruthy();
    expect(screen.getByText('描述')).toBeTruthy();
  });

  it('无硬编码色：容器用 token 背景/边框（亮暗自适应）', () => {
    const { container } = render(wrap(<PageHero title="标题" description="描述" />));
    const hero = container.querySelector('.page-hero');
    expect(hero).toBeTruthy();
    // 样式来自 token（不写死 #hex）
    expect(hero?.getAttribute('style') ?? '').not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
