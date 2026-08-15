import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHealth } from '../useBackendBase';

/**
 * probeHealth（⑨ 探活 + ② body 校验）：
 * HTTP ok + 响应体 status==='ok' 才算就绪；非 200 / 异常 body / 非 JSON / 网络错误 → false。
 */
describe('probeHealth 探活', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('200 + status:ok → true（后端就绪）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', version: '0.1.15' }),
    }));
    expect(await probeHealth('http://127.0.0.1:8675')).toBe(true);
  });

  it('200 + 异常 body（status:error）→ false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'error' }),
    }));
    expect(await probeHealth('http://127.0.0.1:8675')).toBe(false);
  });

  it('200 + 非 JSON body → false（不把 200 当成功）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('invalid json');
      },
    }));
    expect(await probeHealth('http://127.0.0.1:8675')).toBe(false);
  });

  it('非 200（如 500）→ false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await probeHealth('http://127.0.0.1:8675')).toBe(false);
  });

  it('网络错误 → false（不抛异常）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await probeHealth('http://127.0.0.1:8675')).toBe(false);
  });
});
