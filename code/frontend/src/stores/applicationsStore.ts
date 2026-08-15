/** 投递记录业务 store（从 pages/DataViews.tsx 抽离：瘦身解耦，全局状态单一来源）。 */
import { create } from 'zustand';
import type { ApplicationItem, ApplicationListResponse, StatsResponse } from '../types/application';

/** 业务数据 store：复用 settingsStore 的 fetch 模式（baseUrl 由调用方传入，禁止硬编码端口）。 */
interface ApplicationsState {
  items: ApplicationItem[];
  total: number;
  stats: StatsResponse | null;
  loading: boolean;
  listError: string | null;
  statsError: string | null;
  statsLoading: boolean;
  fetchList: (baseUrl: string, params?: { page?: number; pageSize?: number; status?: string; keyword?: string; date?: { from?: string | null; to?: string | null } | null }) => Promise<void>;
  fetchStats: (baseUrl: string) => Promise<void>;
}

/** 模块级单调计数器：防止 /apply 与 /jobs 并发 fetch 的过期响应覆盖最新 items/total/loading。 */
let fetchListSeq = 0;
let fetchStatsSeq = 0;

export const useApplicationsStore = create<ApplicationsState>((set) => ({
  items: [],
  total: 0,
  stats: null,
  loading: false,
  listError: null,
  statsError: null,
  statsLoading: false,
  fetchList: async (baseUrl, params = {}) => {
    const seq = ++fetchListSeq;
    // 立即清空 items 并置 loading，避免路由切换后新挂载页（/jobs ↔ /apply）先渲染兄弟页的旧查询结果；
    // 直到本次 fetch 解析完成前，表格展示空列表 + spinner 占位，而非陈旧的异页数据。
    set({ items: [], total: 0, loading: true, listError: null });
    try {
      const qs = new URLSearchParams();
      if (params.page) qs.set('page', String(params.page));
      if (params.pageSize) qs.set('page_size', String(params.pageSize));
      if (params.status) qs.set('status', params.status);
      if (params.keyword) qs.set('keyword', params.keyword);
      // 日期区间筛选：前端 RangePicker 以 { from, to } 传递，序列化为 date_from/date_to 查询参数（后端 >= / <= 过滤）
      if (params.date?.from) qs.set('date_from', params.date.from);
      if (params.date?.to) qs.set('date_to', params.date.to);
      const q = qs.toString();
      const res = await fetch(`${baseUrl}/api/applications${q ? `?${q}` : ''}`);
      if (!res.ok) {
        throw new Error(`投递记录接口返回 HTTP ${res.status}`);
      }
      const data = (await res.json()) as ApplicationListResponse;
      if (seq !== fetchListSeq) return;
      set({ items: data.items, total: data.total, loading: false });
    } catch (err) {
      if (seq !== fetchListSeq) return;
      // 拉取失败时清空旧列表，避免陈旧的 items 被误认为最新结果（配合渲染层错误横幅提示）
      set({ loading: false, listError: err instanceof Error ? err.message : String(err), items: [], total: 0 });
    }
  },
  fetchStats: async (baseUrl) => {
    const seq = ++fetchStatsSeq;
    set({ statsLoading: true, statsError: null });
    try {
      const res = await fetch(`${baseUrl}/api/stats`);
      if (!res.ok) {
        throw new Error(`统计接口返回 HTTP ${res.status}`);
      }
      const data = (await res.json()) as StatsResponse;
      if (seq !== fetchStatsSeq) return;
      set({ stats: data, statsLoading: false });
    } catch (err) {
      if (seq !== fetchStatsSeq) return;
      // 拉取失败时清空旧统计，避免陈旧的 stats 被误认为最新结果（配合渲染层错误横幅提示）
      set({ statsLoading: false, statsError: err instanceof Error ? err.message : String(err), stats: null });
    }
  },
}));
