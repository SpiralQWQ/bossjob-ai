import { useEffect, useState } from 'react';

/** 防抖值：value 稳定 delay 毫秒后返回最新值（用于搜索输入等，减少高频请求）。 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
