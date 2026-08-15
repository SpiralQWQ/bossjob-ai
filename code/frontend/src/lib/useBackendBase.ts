import { useEffect, useState } from 'react';
import { getBaseUrl } from './baseUrl';

/**
 * 探活后端 /api/health：HTTP ok + 响应体 status==='ok' 才算就绪（与 Dashboard.checkBackend 同口径）。
 * 供 useBackendBase.reload 与 ApplyPage/InterviewPage 的「重新连接」按钮共用，
 * 消除跨页探活语义分歧（殊途同归必须同果：所有重连入口都先探活成功才切 base）。
 */
export async function probeHealth(url: string): Promise<boolean> {
  try {
    const probe = await fetch(`${url}/api/health`);
    if (!probe.ok) return false;
    const h = (await probe.json().catch(() => null)) as { status?: string } | null;
    return !!h && h.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * 统一的后端请求封装：所有「写操作」API（新增/登记/更新/删除）共用同一套
 * fetch + `!ok → json().catch(()=>null) → 错误串` + catch 兜底逻辑，避免四处复制。
 * 返回 null=成功，否则返回错误信息字符串。
 */
export async function apiCall(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { detail?: string } | null;
      return data?.detail ?? `HTTP ${res.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 新增投递记录（POST /api/applications，统一走 apiCall）：默认 status 兜底为 'pending'（待投递），
 * 错误前缀统一「新增失败」。ApplyPage/DataViews 共用，消除重复实现与口径漂移。
 */
export async function createApplication(
  baseUrl: string,
  payload: { status?: string } & object,
): Promise<string | null> {
  const err = await apiCall(baseUrl, 'POST', '/api/applications', { ...payload, status: payload.status ?? 'pending' });
  return err === null ? null : `新增失败：${err}`;
}

/**
 * 统一的「后端底座」hook：baseUrl 解析 + 主进程 onBackendReady/onBackendError 订阅 + 窗口聚焦自愈。
 * 供数据页（JobsPage/TrackerPage/ApplyPage 等）消费，消除各页手写 bootstrap 的语义分歧：
 * 就绪时统一重新解析 baseUrl（含从 '' 错误态恢复）并自增 refreshToken 驱动数据页重拉；
 * 失败时统一置空 base 走「无法连接后端」错误提示分支；卸载时统一清理全部订阅与监听。
 * 返回 { base, refreshToken } —— base 为 '' 表示后端不可用。
 */
export function useBackendBase(): {
  base: string | null;
  refreshToken: number;
  reload: () => void;
} {
  const [base, setBase] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getBaseUrl()
        .then((url) => {
          if (!cancelled) setBase(url);
        })
        .catch(() => {
          if (!cancelled) setBase('');
        });
    };

    // 冷启动首次解析
    load();

    // 后端就绪：重新解析 baseUrl（从 '' 错误态恢复）并触发刷新 —— 就绪/失败语义的唯一权威实现
    const unsubReady = window.api?.onBackendReady?.(() => {
      setRefreshToken((n) => n + 1);
      load();
    });

    // 后端启动失败/崩溃：置空 base，让数据页走错误提示分支
    const unsubError = window.api?.onBackendError?.(() => {
      if (!cancelled) setBase('');
    });

    // 窗口重新聚焦：重新解析 + 触发刷新（后端恢复后 UI 自愈）
    const handleFocus = () => {
      load();
      setRefreshToken((n) => n + 1);
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      unsubReady?.();
      unsubError?.();
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // 手动「重新连接」：重新解析 baseUrl 并从 '' 错误态恢复 + 自增 refreshToken 驱动数据页重拉，
  // 语义与 onBackendReady / 窗口聚焦自愈一致，供 baseUrl==='' 分支页内兜底（无需重启应用）。
  const reload = () => {
    getBaseUrl()
      .then(async (url) => {
        // 与 Dashboard checkBackend 同口径：先探活 /api/health 并校验响应体 status==='ok'，成功才切 base。
        // 否则后端仍宕机/响应异常时会把 baseUrl 从 '' 错误态切回缓存 URL，页面从清晰的
        // 「无法连接后端」翻转为列表级通用拉取错误（恢复只能靠窗口聚焦/onBackendReady，违背「就绪才置 base」语义）。
        if (await probeHealth(url)) {
          setBase(url);
        } else {
          setBase('');
        }
      })
      .catch(() => setBase(''));
    setRefreshToken((n) => n + 1);
  };

  return { base, refreshToken, reload };
}
