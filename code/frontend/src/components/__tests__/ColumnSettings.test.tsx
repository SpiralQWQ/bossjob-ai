import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ColumnSettings from '../ColumnSettings';
import { loadVisibleKeys, persistVisibleKeys } from '../../lib/columnSettings';
import type { ColumnDef } from '../../lib/columnSettings';

const DEFS: ColumnDef[] = [
  { key: 'a', title: 'A列' },
  { key: 'b', title: 'B列' },
];

describe('ColumnSettings（T-13 表格列显隐）', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it('点击「列设置」→ 展开列勾选清单（勾选态正确）', async () => {
    const user = userEvent.setup();
    render(<ColumnSettings columns={DEFS} visibleKeys={new Set(['a', 'b'])} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '列设置' }));
    expect(screen.getByText('A列')).toBeTruthy();
    expect(screen.getByText('B列')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'A列' })).toHaveProperty('checked', true);
  });

  it('取消勾选一列 → onChange 收到移除后的 keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColumnSettings columns={DEFS} visibleKeys={new Set(['a', 'b'])} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '列设置' }));
    await user.click(screen.getByRole('checkbox', { name: 'A列' }));
    expect(onChange).toHaveBeenCalledWith(new Set(['b']));
  });

  it('勾选隐藏列 → onChange 收到添加后的 keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColumnSettings columns={DEFS} visibleKeys={new Set(['a'])} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '列设置' }));
    await user.click(screen.getByRole('checkbox', { name: 'B列' }));
    expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b']));
  });

  it('防呆：取消唯一可见列被忽略（至少保留一列）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColumnSettings columns={DEFS} visibleKeys={new Set(['b'])} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '列设置' }));
    await user.click(screen.getByRole('checkbox', { name: 'B列' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('columnSettings 工具（T-13 localStorage 持久化）', () => {
  it('loadVisibleKeys：无存储 → 全显示', () => {
    localStorage.removeItem('bj-table-columns');
    expect(loadVisibleKeys(DEFS)).toEqual(new Set(['a', 'b']));
  });

  it('persist → load 往返一致（只保留合法 key）', () => {
    persistVisibleKeys(new Set(['a']));
    expect(loadVisibleKeys(DEFS)).toEqual(new Set(['a']));
    // 陈旧/非法 key 被过滤
    persistVisibleKeys(new Set(['a', 'zzz']));
    expect(loadVisibleKeys(DEFS)).toEqual(new Set(['a']));
  });

  it('存储损坏 → 回落默认（不抛）', () => {
    localStorage.setItem('bj-table-columns', '{ broken');
    expect(() => loadVisibleKeys(DEFS)).not.toThrow();
    expect(loadVisibleKeys(DEFS)).toEqual(new Set(['a', 'b']));
  });
});
