import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// echarts mock（vi.hoisted 保证变量在 vi.mock 工厂前可用）
const echartsMock = vi.hoisted(() => {
  const setOption = vi.fn();
  const resize = vi.fn();
  const dispose = vi.fn();
  const on = vi.fn();
  const off = vi.fn();
  const init = vi.fn(() => ({ setOption, resize, dispose, on, off }));
  return { setOption, resize, dispose, init, on, off, use: vi.fn() };
});

vi.mock('echarts/core', () => ({
  init: echartsMock.init,
  use: echartsMock.use,
}));
vi.mock('echarts/charts', () => ({ LineChart: class {}, PieChart: class {}, BarChart: class {} }));
vi.mock('echarts/components', () => ({
  GridComponent: class {},
  TooltipComponent: class {},
  LegendComponent: class {},
  TitleComponent: class {},
  DataZoomComponent: class {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: class {} }));

// jsdom 无 ResizeObserver：注入桩，仅验证 observe/disconnect 调用不崩
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import BaseChart from '../BaseChart';

describe('BaseChart（T-06 ECharts 生命周期封装）', () => {
  beforeEach(() => {
    echartsMock.init.mockClear();
    echartsMock.setOption.mockClear();
    echartsMock.dispose.mockClear();
    echartsMock.resize.mockClear();
    echartsMock.on.mockClear();
    echartsMock.off.mockClear();
  });

  it('挂载 → init + setOption(notMerge)', () => {
    render(<BaseChart option={{ series: [] }} />);
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    expect(echartsMock.setOption).toHaveBeenCalledWith({ series: [] }, true);
  });

  it('option 变化 → setOption 更新，不重建实例', () => {
    const { rerender } = render(<BaseChart option={{ series: [] }} />);
    expect(echartsMock.init).toHaveBeenCalledTimes(1);
    rerender(<BaseChart option={{ series: [{ type: 'line' }] }} />);
    expect(echartsMock.init).toHaveBeenCalledTimes(1); // 不重建
    expect(echartsMock.setOption).toHaveBeenCalledTimes(2);
  });

  it('卸载 → dispose（防内存泄漏）', () => {
    const { unmount } = render(<BaseChart option={{ series: [] }} />);
    unmount();
    expect(echartsMock.dispose).toHaveBeenCalledTimes(1);
  });

  it('渲染容器高度 = prop（默认 300）', () => {
    const { container } = render(<BaseChart option={{ series: [] }} height={200} />);
    const div = container.querySelector('div');
    expect(div?.style.height).toBe('200px');
  });

  it('onClick 传入 → chart.on(\'click\') 注册，卸载 → off 清理', () => {
    const onClick = vi.fn();
    const { unmount } = render(<BaseChart option={{ series: [] }} onClick={onClick} />);
    expect(echartsMock.on).toHaveBeenCalledWith('click', onClick);
    unmount();
    expect(echartsMock.off).toHaveBeenCalledWith('click', onClick);
  });
});
