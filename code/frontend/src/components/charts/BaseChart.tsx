import * as echarts from 'echarts/core';
import { LineChart, PieChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import type { EChartsCoreOption } from 'echarts/core';

// 按需注册（DESIGN §6）：图表/组件/渲染器分面，控制包体增量（≤400KB）。缺某类型会在此缺失报错，而非运行时白屏。
echarts.use([
  LineChart,
  PieChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export interface BaseChartProps {
  /** ECharts option（主题色由调用方 useChartPalette 从 token 派生，主题切换时更新即换色）。 */
  option: EChartsCoreOption;
  /** 容器缩放自适应（默认 true，内部 ResizeObserver）。 */
  autoResize?: boolean;
  /** 图表高度（px，默认 300）。 */
  height?: number;
  className?: string;
  /** 图表点击事件（如趋势图点击日期下钻）。 */
  onClick?: (params: unknown) => void;
}

/**
 * ECharts 通用封装（DESIGN §6）：
 *  - init / setOption(notMerge) / dispose 生命周期管理（卸载必 dispose 防泄漏）；
 *  - ResizeObserver 自适应（可关）；
 *  - 主题切换 = 上层传新 option（色板从 token 派生），setOption 原地更新，无需重建实例。
 * 不引 echarts-for-react 等第三方包装层（自建 ~60 行，可控）。
 */
export default function BaseChart({ option, autoResize = true, height = 300, className, onClick }: BaseChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // 挂载：init + ResizeObserver；卸载：disconnect + dispose（防内存泄漏）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    let ro: ResizeObserver | null = null;
    if (autoResize) {
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [autoResize]);

  // option 更新：notMerge 全量替换（主题切换时色板整体换新）
  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  // 点击事件（下钻等）：on/off 同步清理（off 返回 this，块体包一层保证 cleanup 返回 void）
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onClick) return;
    chart.on('click', onClick);
    return () => {
      chart.off('click', onClick);
    };
  }, [onClick]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height }} />;
}
