import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PRESET_COLORS } from '../theme/designTokens';

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

/** 界面主题模式：亮 / 暗 / 跟随系统（DESIGN §7；三态为改造共识增强）。 */
export type ThemeMode = 'light' | 'dark' | 'system';

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
  /** 界面主题模式（持久化，见下方 partialize）。默认跟随系统。 */
  themeMode: ThemeMode;
  /** 显式设置主题模式（三态）。 */
  setThemeMode: (mode: ThemeMode) => void;
  /** 亮/暗二态快速切换（供顶栏按钮；system 态经显式选择进入，不参与二态切换）。 */
  toggleTheme: () => void;
  /** 主色（PRESET_COLORS 预设，持久化；品牌蓝默认）。 */
  accentColor: string;
  setAccentColor: (color: string) => void;
}

/**
 * 全局状态：后端配置 + 界面主题。
 * 主题模式独立持久化到 localStorage `bj-theme`（partialize 只存 themeMode，后端配置不入库，
 * 避免与服务器 settings 冲突）。version:1 为未来加字段预留迁移点：存储 version 不匹配时 zustand
 * 自动丢弃持久化、回落初始值（老用户天然得 system，不会崩）。
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: null,
      loading: false,
      saving: false,
      error: null,
      themeMode: 'system',
      setThemeMode: (themeMode) => set({ themeMode }),
      toggleTheme: () => set((s) => ({ themeMode: s.themeMode === 'dark' ? 'light' : 'dark' })),
      accentColor: PRESET_COLORS.blue,
      setAccentColor: (accentColor) => set({ accentColor }),
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
    }),
    {
      name: 'bj-theme',
      version: 1,
      partialize: (s) => ({ themeMode: s.themeMode, accentColor: s.accentColor }),
    }
  )
);
