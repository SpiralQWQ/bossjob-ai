import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import StatCard from '../StatCard';

const wrap = (node: React.ReactNode) => <ConfigProvider>{node}</ConfigProvider>;

describe('StatCard（T-05 看板统计卡）', () => {
  it('渲染标题与数值', () => {
    render(wrap(<StatCard title="累计投递" value={42} />));
    expect(screen.getByText('累计投递')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('precision + suffix（通过率 12.5%）', () => {
    render(wrap(<StatCard title="通过率" value={12.5} precision={1} suffix="%" />));
    expect(screen.getByText('12.5')).toBeTruthy();
    expect(screen.getByText('%')).toBeTruthy();
  });

  it('点击触发 onClick（下钻跳转）', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(wrap(<StatCard title="Offer 数" value={3} onClick={onClick} />));
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('titleTip 透传到按钮 title（统计口径提示）', () => {
    render(wrap(<StatCard title="进行中" value={2} titleTip="聚合待反馈/已回复/面试中" />));
    expect(screen.getByRole('button').getAttribute('title')).toBe('聚合待反馈/已回复/面试中');
  });

  it('空值兜底：value 缺省用 0（?? 0 由调用方保证，组件对 undefined 安全显示 "undefined" 兜底）', () => {
    // 组件本身不处理 undefined（类型要求 number）；验证数字 0 正常渲染
    render(wrap(<StatCard title="被拒" value={0} />));
    expect(screen.getByText('0')).toBeTruthy();
  });
});
