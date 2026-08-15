import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useTableUrlState } from '../useTableUrlState';

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/jobs']}>{children}</MemoryRouter>
);

describe('useTableUrlState（T-17 表格 URL 化）', () => {
  it('无参数时 getParam 返回 undefined', () => {
    const { result } = renderHook(() => useTableUrlState(), { wrapper });
    expect(result.current.getParam('page')).toBeUndefined();
  });

  it('有初始参数时 getParam 读到', () => {
    const w = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/jobs?page=2&status=pending']}>{children}</MemoryRouter>
    );
    const { result } = renderHook(() => useTableUrlState(), { wrapper: w });
    expect(result.current.getParam('page')).toBe('2');
    expect(result.current.getParam('status')).toBe('pending');
  });

  it('setParam 写回 → getParam 读到新值（URL 同步）', () => {
    const { result, rerender } = renderHook(() => useTableUrlState(), { wrapper });
    act(() => result.current.setParam('page', 3));
    rerender(); // useLocation 随 router 更新
    expect(result.current.getParam('page')).toBe('3');
  });

  it('setParam 传空/undefined → 删除该参数', () => {
    const { result, rerender } = renderHook(() => useTableUrlState(), { wrapper });
    act(() => result.current.setParam('status', 'offer'));
    rerender();
    expect(result.current.getParam('status')).toBe('offer');
    act(() => result.current.setParam('status', undefined));
    rerender();
    expect(result.current.getParam('status')).toBeUndefined();
  });

  it("数字参数序列化（setParam('page', 3) → '3'）", () => {
    const { result, rerender } = renderHook(() => useTableUrlState(), { wrapper });
    act(() => result.current.setParam('page', 3));
    rerender();
    expect(result.current.getParam('page')).toBe('3');
  });
});
