import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import ChartCard from '../ChartCard';

describe('ChartCard（T-05 图表卡容器）', () => {
  it('渲染标题 / 大数字 / 图表区 / 底部说明', () => {
    render(
      <ConfigProvider>
        <ChartCard
          title="近 30 天投递趋势"
          total={128}
          footer="点击柱子下钻当日记录"
        >
          <div>图表区域</div>
        </ChartCard>
      </ConfigProvider>
    );
    expect(screen.getByText('近 30 天投递趋势')).toBeTruthy();
    expect(screen.getByText('128')).toBeTruthy();
    expect(screen.getByText('图表区域')).toBeTruthy();
    expect(screen.getByText('点击柱子下钻当日记录')).toBeTruthy();
  });

  it('extra 操作区渲染', () => {
    render(
      <ConfigProvider>
        <ChartCard title="标题" extra={<button>导出</button>}>
          <div>内容</div>
        </ChartCard>
      </ConfigProvider>
    );
    expect(screen.getByText('导出')).toBeTruthy();
  });

  it('无 total/footer 时正常渲染（仅图表）', () => {
    render(
      <ConfigProvider>
        <ChartCard title="仅图表">
          <div>图</div>
        </ChartCard>
      </ConfigProvider>
    );
    expect(screen.getByText('仅图表')).toBeTruthy();
    expect(screen.getByText('图')).toBeTruthy();
  });
});
