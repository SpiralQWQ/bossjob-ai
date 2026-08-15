import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalSearch from '../GlobalSearch';

const navigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));
vi.mock('../../lib/baseUrl', () => ({
  getBaseUrl: vi.fn(async () => 'http://127.0.0.1:8675'),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const sampleItems = [
  { id: 1, job_title: '前端开发', company: 'A公司', city: '北京', status: 'pending', salary: '', url: '', note: '', applied_at: null, updated_at: '' },
  { id: 2, job_title: '后端开发', company: 'B公司', city: '上海', status: 'offer', salary: '', url: '', note: '', applied_at: null, updated_at: '' },
];

describe('GlobalSearch（T-11 Cmd+K 全局搜索）', () => {
  beforeAll(() => {
    // Antd Modal 内部 useBreakpoint 需要 matchMedia（jsdom 缺失）
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    navigate.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: sampleItems }) });
  });

  it('Ctrl+K 打开搜索框', async () => {
    render(<GlobalSearch />);
    expect(screen.queryByPlaceholderText('搜公司 / 职位，回车跳转记录页')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页')).toBeTruthy();
  });

  it('输入关键词 → 防抖后请求后端并展示结果', async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '前端');
    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/applications?keyword='));
      },
      { timeout: 2000 }
    );
    expect(await screen.findByText('A公司 · 前端开发')).toBeTruthy();
  });

  it('点击条目 → 跳转记录页预筛 + 关闭', async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '前端');
    const item = await screen.findByText('A公司 · 前端开发');
    await userEvent.click(item);
    // 跳转用条目完整职位名「前端开发」编码
    expect(navigate).toHaveBeenCalledWith('/jobs?keyword=%E5%89%8D%E7%AB%AF%E5%BC%80%E5%8F%91');
  });

  it('空关键词不请求后端', async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '   ');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('无匹配 → 空态提示', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '不存在');
    expect(await screen.findByText(/无「不存在」相关投递记录/)).toBeTruthy();
  });

  it('再次 Ctrl+K 走关闭分支（不清空），再按走打开分支（清空）——验证 open 翻转', async () => {
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByText('全局搜索');
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '前端');
    expect(input).toHaveValue('前端');

    // 第二次 Ctrl+K：openRef=true → 走「关闭」分支（不清空关键词），Modal 关闭（rc-motion 在 jsdom 动画不结束、DOM 残留，故用 value 断言）
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(input).toHaveValue('前端');

    // 第三次 Ctrl+K：openRef=false → 走「打开」分支（清空关键词），重开清空
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('搜索接口失败 → 不崩，显示空态', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    render(<GlobalSearch />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByPlaceholderText('搜公司 / 职位，回车跳转记录页');
    await userEvent.type(input, '测试');
    await waitFor(
      () => {
        expect(screen.queryByText(/无「测试」相关投递记录/)).toBeTruthy();
      },
      { timeout: 2000 }
    );
  });
});
