import { useEffect, useState } from 'react';

/** 系统是否偏好暗色（跟随 matchMedia；无 matchMedia 环境回退 false）。 */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
    );
  });

  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    setDark(mql.matches); // 挂载校准
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return dark;
}
