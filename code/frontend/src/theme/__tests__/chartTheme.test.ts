import { describe, expect, it } from 'vitest';
import { buildChartPalette } from '../chartTheme';

const fakeToken = {
  colorPrimary: '#2563eb',
  colorSuccess: '#16a34a',
  colorWarning: '#f59e0b',
  colorError: '#dc2626',
  colorText: '#1f2430',
  colorTextSecondary: '#5c6470',
  colorBorder: '#e4e7ec',
  colorBgContainer: '#ffffff',
  colorSplit: '#f0f0f0',
};

describe('buildChartPalette（T-06 图表色板 token 派生）', () => {
  it('主序列/语义/文字/分隔线走 token', () => {
    const p = buildChartPalette(fakeToken);
    expect(p.primary).toBe('#2563eb');
    expect(p.success).toBe('#16a34a');
    expect(p.error).toBe('#dc2626');
    expect(p.text).toBe('#1f2430');
    expect(p.textSecondary).toBe('#5c6470');
    expect(p.bg).toBe('#ffffff');
    expect(p.border).toBe('#e4e7ec');
    expect(p.splitLine).toBe('#f0f0f0');
  });

  it('分类色板首项 = 主色 + 含 DESIGN §6 对比强调色', () => {
    const p = buildChartPalette(fakeToken);
    expect(p.category[0]).toBe('#2563eb');
    expect(p.category).toContain('#8b5cf6');
    expect(p.category).toContain('#10b981');
  });

  it('colorSplit 缺失回退 colorBorder', () => {
    const t = { ...fakeToken, colorSplit: undefined };
    const p = buildChartPalette(t);
    expect(p.splitLine).toBe('#e4e7ec');
  });
});
