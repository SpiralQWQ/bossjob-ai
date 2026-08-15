import { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * 全局错误边界：未捕获的渲染异常 → 显示兜底而非白屏。
 * 兜底页刻意用**原生 HTML**（不依赖组件库）：渲染出错时组件库本身也可能不可用，
 * 原生元素保证兜底永远能显示；点击「重试」重置边界并重新渲染子树。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary] 捕获渲染异常：', error);
  }

  handleReset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" style={{ padding: 48, textAlign: 'center' }}>
          <h2 style={{ margin: 0 }}>页面出现异常</h2>
          <p>渲染出错，已阻止白屏。可点击下方按钮重试。</p>
          <button type="button" onClick={this.handleReset}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
