import { useEffect, useRef } from 'react';

/**
 * 定时轮询：每 delay 毫秒调用 callback；delay 传 null 暂停。
 * callback 用 ref 保存（不因每次渲染重建而重启 interval）。
 */
export function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
