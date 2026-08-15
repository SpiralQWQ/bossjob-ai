import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Notifications from '../Notifications';
import { notifyError, notifyWarning, notifySuccess, clearNoticeRenderer } from '../../stores/notificationsStore';

const apiCalls = vi.fn();

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    notification: {
      ...actual.notification,
      useNotification: () => [
        {
          success: (c: unknown) => apiCalls('success', c),
          info: (c: unknown) => apiCalls('info', c),
          warning: (c: unknown) => apiCalls('warning', c),
          error: (c: unknown) => apiCalls('error', c),
        },
        null,
      ],
    },
  };
});

describe('Notifications（T-12 事件式通知桥接）', () => {
  it('挂载后 notifyError → Antd error 通知（message + description）', () => {
    render(<Notifications />);
    notifyError('保存失败', '接口超时');
    expect(apiCalls).toHaveBeenCalledWith('error', { message: '保存失败', description: '接口超时' });
  });

  it('notifyWarning / notifySuccess 类型正确路由', () => {
    render(<Notifications />);
    notifyWarning('即将到期');
    expect(apiCalls).toHaveBeenCalledWith('warning', { message: '即将到期', description: undefined });
    notifySuccess('已保存');
    expect(apiCalls).toHaveBeenCalledWith('success', { message: '已保存', description: undefined });
  });

  it('未挂载时调用静默不抛错（防呆）', () => {
    clearNoticeRenderer();
    expect(() => notifyError('x')).not.toThrow();
    expect(() => notifyWarning('y')).not.toThrow();
  });
});
