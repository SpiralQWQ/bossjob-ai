import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefersDark } from '../usePrefersDark';
import { useDebouncedValue } from '../useDebouncedValue';
import { useInterval } from '../useInterval';
import { useCopyToClipboard } from '../useCopyToClipboard';

describe('usePrefersDark（T-18 系统暗色偏好）', () => {
  it('跟随 matchMedia matches（无环境守卫回退）', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(true);
  });
});

describe('useDebouncedValue（T-18 防抖值）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('值稳定 delay 毫秒后才更新；期间保持旧值', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: 'a' },
    });
    expect(result.current).toBe('a');
    rerender({ v: 'b' });
    act(() => vi.advanceTimersByTime(199));
    expect(result.current).toBe('a'); // 未到 delay
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b'); // 到达 delay
  });
});

describe('useInterval（T-18 定时轮询）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('每 delay 调用一次；delay=null 暂停', () => {
    const cb = vi.fn();
    const { rerender } = renderHook<void, { d: number | null }>(
      ({ d }) => useInterval(cb, d),
      { initialProps: { d: 100 } }
    );
    act(() => vi.advanceTimersByTime(300));
    expect(cb).toHaveBeenCalledTimes(3);
    rerender({ d: null });
    act(() => vi.advanceTimersByTime(300));
    expect(cb).toHaveBeenCalledTimes(3); // 暂停后不再调
  });
});

describe('useCopyToClipboard（T-18 复制）', () => {
  it('clipboard 可用 → 复制成功 + copied 短暂为 true 后复位', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { result } = renderHook(() => useCopyToClipboard());
    let ok = false;
    await act(async () => {
      ok = await result.current[1]('hello');
    });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current[0]).toBe(true);
    await waitFor(() => expect(result.current[0]).toBe(false), { timeout: 3000 });
  });
});
