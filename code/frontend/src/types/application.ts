/** 投递记录相关类型（从 pages/DataViews.tsx 抽离：瘦身解耦，共享类型单一来源）。 */

/** GET /api/applications 单条记录（与后端 data 路由 ApplicationItem 对齐）。 */
export interface ApplicationItem {
  id: number;
  job_title: string;
  company: string;
  city: string;
  salary: string;
  url: string;
  status: string;
  note: string;
  applied_at: string | null;
  updated_at: string;
}

/** GET /api/applications 分页响应。 */
export interface ApplicationListResponse {
  total: number;
  page: number;
  page_size: number;
  items: ApplicationItem[];
}

/** GET /api/stats 响应。 */
export interface StatsResponse {
  total: number;
  applying: number;
  offer_count: number;
  rejected: number;
  pass_rate: number;
  daily_trend: Array<{ date: string; count: number }>;
}

/** 新增/更新投递记录载荷（与后端 ApplicationCreate/ApplicationUpdate 对齐）。 */
export interface ApplicationInput {
  job_title: string;
  company: string;
  city?: string;
  salary?: string;
  url?: string;
  status?: string;
  note?: string;
  /** 投递时间（ISO 字符串）；缺省/未传时后端取当前时间，显式 null 表示「清空=未设置」（后端存 NULL）。 */
  applied_at?: string | null;
}
