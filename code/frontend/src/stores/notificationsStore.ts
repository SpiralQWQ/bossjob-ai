/**
 * 事件式通知 store：让非组件代码（fetch catch / 业务逻辑）也能弹 Antd 通知。
 * 渲染器由 Notifications 组件挂载时注册（连接 Antd notification API），
 * 未挂载时调用静默无害（防呆：渲染器未就绪不抛错）。
 */
export type NoticeType = 'success' | 'info' | 'warning' | 'error';

export interface NoticePayload {
  type: NoticeType;
  message: string;
  description?: string;
}

/** 通知渲染器（由 Notifications 组件注册）。 */
let renderNotice: ((n: NoticePayload) => void) | null = null;

export function setNoticeRenderer(fn: (n: NoticePayload) => void) {
  renderNotice = fn;
}

export function clearNoticeRenderer() {
  renderNotice = null;
}

function emit(payload: NoticePayload) {
  renderNotice?.(payload);
}

/** 非组件代码统一发错误通知。 */
export function notifyError(message: string, description?: string) {
  emit({ type: 'error', message, description });
}

export function notifyWarning(message: string, description?: string) {
  emit({ type: 'warning', message, description });
}

export function notifySuccess(message: string, description?: string) {
  emit({ type: 'success', message, description });
}
