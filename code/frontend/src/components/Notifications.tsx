import { notification } from 'antd';
import { useEffect } from 'react';
import { setNoticeRenderer, clearNoticeRenderer } from '../stores/notificationsStore';

/**
 * 事件式通知桥接：挂载时注册渲染器，此后任何非组件代码（notifyError/notifyWarning/notifySuccess）
 * 都能弹 Antd 通知；卸载时清渲染器（防呆：未挂载调用静默）。
 */
export default function Notifications() {
  const [api, contextHolder] = notification.useNotification();

  useEffect(() => {
    setNoticeRenderer((n) => api[n.type]({ message: n.message, description: n.description }));
    return () => clearNoticeRenderer();
  }, [api]);

  return contextHolder;
}
