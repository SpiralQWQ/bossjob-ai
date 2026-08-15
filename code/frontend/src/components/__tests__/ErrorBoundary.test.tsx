import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import ErrorBoundary from '../ErrorBoundary';

function Boom(): ReactNode {
  throw new Error('boom');
}
function Good() {
  return <div>正常内容</div>;
}

describe('ErrorBoundary（T-12 全局错误兜底）', () => {
  it('子组件渲染抛错 → 显示兜底而非白屏', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('页面出现异常')).toBeTruthy();
  });

  it('正常子组件不被拦截', () => {
    render(
      <ErrorBoundary>
        <Good />
      </ErrorBoundary>
    );
    expect(screen.getByText('正常内容')).toBeTruthy();
  });

  it('兜底页含「重试」按钮（原生，恢复入口存在）', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
