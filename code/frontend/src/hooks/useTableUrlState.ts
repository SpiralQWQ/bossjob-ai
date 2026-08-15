import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * 表格/列表状态 URL 化：把分页/筛选参数同步到 hash query，刷新/回退保留。
 * 设计（防循环）：只读 + 调用方在状态变化时主动 `setParam` 写回（replace，不进历史栈）；
 * 不在 hook 内监听 URL 写回 state，避免「state→URL→state」循环。
 */
export function useTableUrlState() {
  const location = useLocation();
  const navigate = useNavigate();

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);

  /** 读 URL 参数（无则 undefined）。 */
  const getParam = useCallback(
    (key: string): string | undefined => {
      const v = params.get(key);
      return v === null ? undefined : v;
    },
    [params]
  );

  /** 写单个参数（undefined/空删除），replace 不产生历史栈。 */
  const setParam = useCallback(
    (key: string, value: string | number | undefined | null) => {
      const next = new URLSearchParams(location.search);
      if (value === undefined || value === null || value === '') {
        next.delete(key);
      } else {
        next.set(key, String(value));
      }
      const qs = next.toString();
      // HashRouter 下 search 位于 hash 内，navigate({search}) 正确更新
      navigate({ search: qs ? `?${qs}` : '' }, { replace: true });
    },
    [location.search, navigate]
  );

  return { getParam, setParam, params };
}
