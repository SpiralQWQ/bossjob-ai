import { create } from 'zustand';

/** GET /api/settings 响应（与后端 schemas.SettingsResponse 对齐）。 */
export interface AppSettings {
  port: number;
  llm: Record<string, unknown>;
  apply: Record<string, unknown>;
  browser: Record<string, unknown>;
  blacklist: Record<string, unknown>;
  security: Record<string, unknown>;
  cities: string[];
}

interface SettingsState {
  /** 最近一次成功拉取的配置快照；未加载为 null。 */
  settings: AppSettings | null;
  loading: boolean;
  /** PUT 保存进行中。 */
  saving: boolean;
  error: string | null;
  /** 拉取后端配置。baseUrl 由调用方提供（端口经 window.api 获取，禁止硬编码）。 */
  fetchSettings: (baseUrl: string) => Promise<void>;
  /** PUT /api/settings 保存配置；返回保存后的公开快照（api_key 不参与响应），失败抛出错误。 */
  saveSettings: (baseUrl: string, payload: Partial<AppSettings>) => Promise<AppSettings>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  loading: false,
  saving: false,
  error: null,
  fetchSettings: async (baseUrl: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${baseUrl}/api/settings`);
      if (!res.ok) {
        throw new Error(`配置接口返回 HTTP ${res.status}`);
      }
      const data = (await res.json()) as AppSettings;
      set({ settings: data, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  saveSettings: async (baseUrl: string, payload: Partial<AppSettings>) => {
    set({ saving: true, error: null });
    try {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // 后端 400/422（base_url 白名单拒绝 / pydantic 校验失败）返回结构化 detail，
        // 尽力解析并用 detail 覆盖泛化文案，给用户可执行的失败原因。
        let detail: unknown = null;
        try {
          detail = (await res.json()).detail;
        } catch {
          // 响应体非 JSON 时忽略，回退到泛化文案
        }
        throw new Error(detail ? String(detail) : `保存配置接口返回 HTTP ${res.status}`);
      }
      const data = (await res.json()) as AppSettings;
      set({ settings: data, saving: false });
      return data;
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
}));
