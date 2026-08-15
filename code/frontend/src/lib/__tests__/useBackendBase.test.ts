import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBackendBase } from '../useBackendBase';

vi.mock('../baseUrl', () => ({
  getBaseUrl: vi.fn(),
}));

import { getBaseUrl } from '../baseUrl';

/**
 * useBackendBase.reload（⑨ 重连探活）：探活成功才切 base，失败保持 ''（停在「无法连接后端」分支）。
 */
describe('useBackendBase.reload 探活', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('探活成功 → reload 后 base = URL', async () => {
    vi.mocked(getBaseUrl).mockResolvedValue('http://127.0.0.1:8675');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    }));
    const { result } = renderHook(() => useBackendBase());
    await waitFor(() => expect(result.current.base).toBe('http://127.0.0.1:8675'));
    await act(async () => {
      result.current.reload();
    });
    // 探活成功 → base 保持 URL
    await waitFor(() => expect(result.current.base).toBe('http://127.0.0.1:8675'));
  });

  it('探活失败（后端宕机）→ reload 后 base 置空（停在错误态）', async () => {
    vi.mocked(getBaseUrl).mockResolvedValue('http://127.0.0.1:8675');
    // 先成功挂载（base=URL），然后 reload 时后端宕机
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { result } = renderHook(() => useBackendBase());
    await waitFor(() => expect(result.current.base).toBe('http://127.0.0.1:8675'));
    await act(async () => {
      result.current.reload();
    });
    // reload 探活失败 → base 置空（不切回 URL，避免「无法连接」翻转为列表错误）
    await waitFor(() => expect(result.current.base).toBe(''));
  });

  it('探活 body 异常（200 但 status≠ok）→ reload 后 base 置空', async () => {
    vi.mocked(getBaseUrl).mockResolvedValue('http://127.0.0.1:8675');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error' }),
    }));
    const { result } = renderHook(() => useBackendBase());
    await waitFor(() => expect(result.current.base).toBe('http://127.0.0.1:8675'));
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.base).toBe(''));
  });
});
