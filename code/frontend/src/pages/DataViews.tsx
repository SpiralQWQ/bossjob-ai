import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { Key, ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import dayjs from 'dayjs';
import { create } from 'zustand';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiCall, useBackendBase, createApplication } from '../lib/useBackendBase';
import { openLogsModal, useUrlHostWarning } from '../lib/applyShared';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../constants';
import { STATUS_TEXT, STATUS_COLOR, STATUS_OPTIONS } from '../lib/applyStatus';

const { Title } = Typography;

/** 把字节数格式化为人类可读大小（如 1.2 MB）；非有限数字返回空串。 */
function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit += 1;
  }
  const text = v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** 恢复确认弹窗：内置「仅恢复投递记录，保留当前设置/LLM 配置与简历」勾选项（默认关）。
 *  勾选时透传 includeSettings=false → 主进程仅覆盖 app.db（投递记录），保留当前 settings.json/LLM 配置与简历快照
 *  （含 external_url_hosts 白名单 / browser_user_data_dir / provider 重定向等，避免误破坏现有浏览器配置）；
 *  未勾选时按原逻辑恢复 settings.json（主进程安全剥离 LLM 密钥/白名单等，见 restoreSettingsSafely）并一并恢复简历快照。 */
function confirmRestore(opts: {
  title: string;
  description: string;
  /** 应用内备份列表给出的备份目录绝对路径（listBackups 的 path），缺省时走系统「打开目录」对话框。 */
  dir?: string;
  /** 成功 toast 前缀（含恢复来源说明）。 */
  successLabel: string;
}) {
  let keepSettings = false; // 勾选「仅恢复投递记录」→ true → includeSettings=false
  Modal.confirm({
    title: opts.title,
    content: (
      <div>
        <div style={{ fontSize: 13, lineHeight: '22px', marginBottom: 8 }}>{opts.description}</div>
        <Checkbox onChange={(e) => { keepSettings = e.target.checked; }}>
          仅恢复投递记录，保留当前设置/LLM 配置与简历
        </Checkbox>
      </div>
    ),
    okText: '确认恢复',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      if (!window.api?.restoreData) {
        message.error(
          'Electron preload 桥接（window.api.restoreData）不可用，请通过 Electron 启动应用。'
        );
        return;
      }
      try {
        const result = await window.api.restoreData(
          opts.dir ? { dir: opts.dir, includeSettings: !keepSettings } : { includeSettings: !keepSettings }
        );
        if (result.canceled) {
          return; // 用户取消「选择备份目录」对话框
        }
        if (result.ok) {
          // settingsStatus 为主进程对本次恢复中 settings.json 处理结果的如实汇报（统一词汇表：
          // 'restored' | 'retained_credentials_stripped' | 'backup_missing' | 'parse_failed' | 'retained'）
          const retainedTxt =
            result.settingsStatus === 'retained_credentials_stripped'
              ? '；配置已还原（当前 LLM 密钥已保留）'
              : result.settingsStatus === 'parse_failed'
                ? '；配置解析失败，已保留当前配置'
                : result.settingsStatus === 'backup_missing'
                  ? '；备份无配置，保留当前配置'
                    : result.settingsStatus === 'retained'
                      ? '；已保留当前配置'
                      : result.settingsStatus === 'restored'
                        ? '；配置已合并'
                        : '';
          // preRestoreSnapshot 为覆盖前自动快照（可回滚点）：透出名称告知用户误恢复时仍可从此备份回滚
          const snapshotTxt = result.preRestoreSnapshot
            ? `；已创建可回滚点：${result.preRestoreSnapshot.name}`
            : '';
          message.success(`${opts.successLabel}：${result.path ?? ''}${retainedTxt}${snapshotTxt}`);
          // 恢复是破坏性覆盖，后端已重启完成；与 toast 生命周期解耦，稍后立即刷新让看板/列表展示还原后的数据
          setTimeout(() => window.location.reload(), 300);
        } else {
          message.error(`恢复失败：${result.error ?? '未知错误'}`);
        }
      } catch (err) {
        message.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

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

// 投递状态映射集中在 lib/applyStatus.ts（STATUS_TEXT/STATUS_COLOR/STATUS_OPTIONS 单一事实来源，
// 与 ApplyPage/InterviewPage 共用，避免三处副本漂移）；下方引用由 import 提供。

/** 展开行详情（JobsPage / ApplyPage 共用）：以 Descriptions 展示记录完整内容。
 *  备注列单行省略号截断，而 ApplyPage 登记时把整份简历快照（姓名/手机/邮箱/学历/技能/简介，多行）写入 note，
 *  展开行保留 pre-wrap 换行，让「投递记录可随时回看所用简历」真正可读，同时回显原始 applied_at / updated_at。 */
export function renderApplicationDetail(record: ApplicationItem) {
  return (
    <Descriptions size="small" column={1} bordered style={{ maxWidth: 760 }}>
      <Descriptions.Item label="职位">{record.job_title || '—'}</Descriptions.Item>
      <Descriptions.Item label="公司">{record.company || '—'}</Descriptions.Item>
      <Descriptions.Item label="城市">{record.city || '—'}</Descriptions.Item>
      <Descriptions.Item label="薪资">{record.salary || '—'}</Descriptions.Item>
      <Descriptions.Item label="状态">{STATUS_TEXT[record.status] ?? record.status ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="链接">{record.url || '—'}</Descriptions.Item>
      <Descriptions.Item label="投递时间">
        {record.applied_at ? record.applied_at.replace('T', ' ').slice(0, 19) : '—'}
      </Descriptions.Item>
      <Descriptions.Item label="更新时间">
        {record.updated_at ? record.updated_at.replace('T', ' ').slice(0, 19) : '—'}
      </Descriptions.Item>
      <Descriptions.Item label="备注">
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{record.note || '—'}</div>
      </Descriptions.Item>
    </Descriptions>
  );
}

// parseUrlHost / isHostAllowed 已复用 ../lib/applyShared 导出（见顶部 import），此处不再本地重复实现，避免漂移。

/** 复制文本到剪贴板：优先 navigator.clipboard（需安全上下文，Electron 渲染进程通常可用），
 *  失败时降级 textarea + document.execCommand('copy') 兜底（旧内核 / 非安全上下文）。返回是否成功。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落入下方 execCommand 降级
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // 移出可视区并隐藏，避免复制时闪现或触发滚动
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  try {
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (textarea.parentNode === document.body) {
      document.body.removeChild(textarea);
    }
  }
}

/** 复制职位链接到剪贴板并按结果提示：成功 → 「职位链接已复制」，失败 → 提示手动复制。
 *  非 BOSS 白名单链接「打开」必失败，复制是唯一可行的取链方式（粘贴到简历 / 发给别人）。 */
export async function copyLink(url: string) {
  const ok = await copyToClipboard(url);
  if (ok) {
    message.success('职位链接已复制');
  } else {
    message.error('复制失败，请手动选择链接复制');
  }
}

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

/** 模块级单调计数器：防止 /apply 与 /jobs 并发 fetch 的过期响应覆盖最新 items/total/loading（与 dist 已修复的 index-zPZ0V-2j.js 一致）。 */
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

/** 新增/编辑投递记录的输入（POST / PATCH /api/applications）。 */
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

/** PATCH /api/applications/{id} 更新投递记录（走共享 apiCall）。返回 null=成功，否则返回错误信息。 */
async function updateApplication(
  baseUrl: string,
  id: number,
  patch: Partial<ApplicationInput>,
): Promise<string | null> {
  const err = await apiCall(baseUrl, 'PATCH', `/api/applications/${id}`, patch);
  return err === null ? null : `更新失败：${err}`;
}

/** DELETE /api/applications/{id} 删除投递记录（走共享 apiCall）。返回 null=成功，否则返回错误信息。 */
async function deleteApplication(baseUrl: string, id: number): Promise<string | null> {
  const err = await apiCall(baseUrl, 'DELETE', `/api/applications/${id}`);
  return err === null ? null : `删除失败：${err}`;
}

/** 单条导入记录校验：job_title / company 必须为非空字符串，否则视为格式非法行（跳过不入库）。 */
function isValidImportRecord(r: unknown): r is { job_title: string; company: string } {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const rec = r as { job_title?: unknown; company?: unknown; id?: unknown };
  // 有有效 id 的行视为「更新既有记录」：后端 update 分支对空 job_title/company 走 preserve-if-empty，
  // 这里放行（与文件导入路径一致）；仅无 id（新建）行才强制 job_title/company 非空
  const hasId = typeof rec.id === 'number' || (typeof rec.id === 'string' && rec.id.trim() !== '' && Number.isInteger(Number(rec.id)));
  if (hasId) return true;
  return (
    typeof rec.job_title === 'string' && rec.job_title.trim() !== '' &&
    typeof rec.company === 'string' && rec.company.trim() !== ''
  );
}

/** 导入内容大小上限（约 5MB 文本），超限直接拒绝，避免超大 JSON 拖垮前端与后端。 */
const IMPORT_MAX_CHARS = 5_000_000;

/** POST /api/import 导入导出 JSON（需包含 applications 数组）。
 *  逐条校验 job_title / company 必填非空，非法行自动跳过，防止脏数据写入库中。 */
async function importApplications(
  baseUrl: string,
  jsonText: string,
): Promise<{ ok: boolean; error?: string; imported?: number; created?: number; updated?: number; skipped?: number }> {
  if (jsonText.length > IMPORT_MAX_CHARS) {
    return { ok: false, error: `导入失败：内容超过大小上限（约 ${Math.round(IMPORT_MAX_CHARS / 1e6)}MB），请拆分后分批导入` };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: '导入失败：JSON 解析错误，请检查粘贴内容' };
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Array.isArray((payload as { applications?: unknown[] }).applications)
  ) {
    return { ok: false, error: '导入失败：格式不符合导出 JSON（应包含 applications 数组）' };
  }
  const applications = (payload as { applications: unknown[] }).applications;
  // 逐条校验 job_title / company 必填非空，跳过非法行，避免脏数据原样 POST /api/import。
  // dropped 为本地预过滤丢弃数：这些行根本没 POST 给后端，后端 skipped 不含它们，
  // 须由本函数并回返回，否则「跳过 N 条格式非法记录」提示永不出现（静默丢弃）。
  const valid = applications.filter(isValidImportRecord);
  const dropped = applications.length - valid.length;
  if (valid.length === 0) {
    return { ok: false, error: '导入失败：applications 中没有任何格式合法的记录（job_title / company 不能为空）' };
  }
  try {
    const res = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, applications: valid }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { detail?: string } | null;
      return { ok: false, error: `导入失败：${data?.detail ?? `HTTP ${res.status}`}` };
    }
    const result = (await res.json()) as { imported?: number; created?: number; updated?: number; skipped?: number };
    return {
      ok: true,
      imported: result.imported ?? 0,
      // created 旧后端回退（与 main.js 同款）：无 created 字段时 imported - updated 即新增数
      created: result.created ?? Math.max(0, (result.imported ?? 0) - (result.updated ?? 0)),
      updated: result.updated ?? 0,
      skipped: (result.skipped ?? 0) + dropped,
    };
  } catch (err) {
    return { ok: false, error: `导入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 数据页公共外层卡片。 */
function DataPageCard(props: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <Card
      style={{ maxWidth: 960, margin: '24px auto' }}
      title={<Title level={4} style={{ margin: 0 }}>{props.title}</Title>}
      extra={<Button onClick={props.onBack}>返回工作台</Button>}
    >
      {props.children}
    </Card>
  );
}

/** 数据管理工具条（手动备份 / 恢复数据 / 打开备份目录 / 导出数据）。
 *  仅依赖 Electron preload 的 window.api 主进程文件快照能力，不依赖投递列表 API，
 *  因此在列表加载失败 / 后端未连接的错误态下也必须保持可用（此时用户最需要恢复/备份数据）。
 *  恒常渲染于错误分支之外，避免错误态下陷入无法恢复数据的死胡同。 */
export function DataTools({ onBackupNow }: { onBackupNow?: () => void }) {
  return (
    <Space wrap>
      <Button
        title="导出用于查看/归档，恢复需用备份"
        onClick={async () => {
          if (!window.api?.exportData || !window.api?.exportBackupData) {
            message.error('Electron preload 桥接（window.api.exportData / exportBackupData）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            // 在线导出（依赖 GET /api/export）失败（后端崩溃/端口冲突）→ 自动降级离线导出最新自动备份 app.db，
            // 使「导出」在错误态下仍可用（工具条契约：导出仅依赖主进程文件快照）。
            const result = await window.api.exportData();
            if (result.canceled) {
              return; // 用户取消「另存为」对话框
            }
            if (result.ok && result.path) {
              message.success(`数据已导出到：${result.path}（导出仅用于查看/归档，不作为恢复依据）`);
              return;
            }
            const offline = await window.api.exportBackupData();
            if (offline.canceled) {
              return;
            }
            if (offline.ok && offline.path) {
              message.warning(
                `后端不可达，已从最新自动备份离线导出（${offline.backupName ?? ''}）：${offline.path}（备份快照数据，导出仅用于查看/归档，不作为恢复依据）`,
              );
              return;
            }
            message.error(`导出失败：${result.error ?? offline.error ?? '未知错误'}`);
          } catch (err) {
            message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        导出数据
      </Button>
      <Button
        title="导出前预览文件实际包含的内容（记录数 / 简历快照 / 脱敏配置摘要），不落盘"
        onClick={async () => {
          if (!window.api?.previewExportData || !window.api?.previewBackupExport) {
            message.error('Electron preload 桥接（window.api.previewExportData / previewBackupExport）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            // 在线预览（依赖 GET /api/export）失败（后端不可达/端口冲突）→ 自动降级离线预览最新自动备份 app.db
            let r = await window.api.previewExportData();
            let fromBackup = false;
            if (!r.ok) {
              const off = await window.api.previewBackupExport();
              if (!off.ok) {
                message.error(`预览失败：${off.error ?? r.error ?? '未知错误'}`);
                return;
              }
              r = off as { ok: boolean; payload?: Record<string, unknown>; error?: string };
              fromBackup = true;
            }
            const pl = (r.payload ?? {}) as Record<string, unknown>;
            const apps = Array.isArray(pl.applications) ? pl.applications : [];
            const logs = Array.isArray(pl.apply_logs) ? pl.apply_logs : [];
            const resumeObj =
              pl.resume && typeof pl.resume === 'object' ? (pl.resume as Record<string, unknown>) : null;
            const settingsObj =
              pl.settings && typeof pl.settings === 'object' ? (pl.settings as Record<string, unknown>) : null;
            Modal.info({
              title: fromBackup ? '导出内容预览（离线备份）' : '导出内容预览',
              width: 560,
              content: (
                <div style={{ fontSize: 13, lineHeight: '22px' }}>
                  <div>投递记录：<b>{apps.length}</b> 条</div>
                  <div>投递日志：{logs.length} 条</div>
                  <div>
                    简历快照：
                    {resumeObj
                      ? `包含（${[resumeObj.name, resumeObj.phone, resumeObj.email]
                          .filter((v) => typeof v === 'string' && v)
                          .join(' · ') || '未填写姓名/联系方式'}）`
                      : '不含'}
                  </div>
                  <div>
                    配置摘要（脱敏）：{settingsObj ? Object.keys(settingsObj).join('、') : '不含 settings 配置段'}
                  </div>
                  {fromBackup ? (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      后端不可达，以上内容来自最新自动备份快照（非实时数据），供导出前确认。
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      以上与「导出数据」实际写入文件的内容一致，供导出前确认。
                    </Typography.Text>
                  )}
                </div>
              ),
              okText: '知道了',
            });
          } catch (err) {
            message.error(`预览导出失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        预览导出内容
      </Button>
      <Button
        title="复用 /api/export 载荷中的 apply_logs 数组（previewExportData 已能取到），跨记录聚合浏览全部投递操作日志，按时间倒序渲染全局时间线（投递→约面→offer 全程复盘）"
        onClick={async () => {
          if (!window.api?.previewExportData || !window.api?.previewBackupExport) {
            message.error('Electron preload 桥接（window.api.previewExportData / previewBackupExport）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            // 在线预览（依赖 GET /api/export）失败（后端不可达/端口冲突）→ 自动降级离线预览最新自动备份 app.db
            let r = await window.api.previewExportData();
            let fromBackup = false;
            if (!r.ok) {
              const off = await window.api.previewBackupExport();
              if (!off.ok) {
                message.error(`投递日志加载失败：${off.error ?? r.error ?? '未知错误'}`);
                return;
              }
              r = off as { ok: boolean; payload?: Record<string, unknown>; error?: string };
              fromBackup = true;
            }
            const pl = (r.payload ?? {}) as Record<string, unknown>;
            const apps = Array.isArray(pl.applications) ? pl.applications : [];
            const logs = Array.isArray(pl.apply_logs) ? pl.apply_logs : [];
            if (logs.length === 0) {
              message.info('暂无投递日志（apply_logs 为空）');
              return;
            }
            // 以 application_id 关联投递记录，为每条日志补齐 公司 / 职位 上下文
            const appById = new Map<number, Record<string, unknown>>();
            for (const a of apps) {
              if (a && typeof a === 'object') {
                const rec = a as Record<string, unknown>;
                if (typeof rec.id === 'number') appById.set(rec.id, rec);
              }
            }
            // 全局时间线：按 created_at 倒序聚合（「投递→约面→offer」全量日志可整体复盘）
            const rows = (logs as Array<Record<string, unknown>>)
              .slice()
              .sort((x, y) => String(y.created_at ?? '').localeCompare(String(x.created_at ?? '')))
              .map((log, idx) => {
                const app = appById.get(Number(log.application_id));
                return {
                  key: log.id ?? idx,
                  time: String(log.created_at ?? '').replace('T', ' ').slice(0, 19),
                  action: String(log.action ?? ''),
                  company: app ? String(app.company ?? '') : '—',
                  job: app ? String(app.job_title ?? '') : '—',
                  detail: String(log.detail ?? ''),
                };
              });
            Modal.info({
              title: `全局投递日志（apply_logs 聚合时间线 · 共 ${rows.length} 条${fromBackup ? ' · 来自最新自动备份快照' : ''}）`,
              width: 860,
              content: (
                <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                  <Table
                    size="small"
                    rowKey="key"
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    dataSource={rows}
                    columns={[
                      { title: '时间', dataIndex: 'time', width: 148 },
                      { title: '动作', dataIndex: 'action', width: 96, render: (v: string) => <Badge color="#1677ff" text={v} /> },
                      { title: '公司', dataIndex: 'company', width: 140, ellipsis: true },
                      { title: '职位', dataIndex: 'job', width: 180, ellipsis: true },
                      { title: '详情', dataIndex: 'detail', ellipsis: true },
                    ]}
                  />
                </div>
              ),
              okText: '关闭',
            });
          } catch (err) {
            message.error(`投递日志加载失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        投递日志
      </Button>
      <Button
        title="把自动备份目录里最新一份备份（含 app.db + settings.json + 简历快照）打包为单一 .zip，便于跨机器 / 移动介质迁移"
        onClick={async () => {
          if (!window.api?.exportBackup) {
            message.error('Electron preload 桥接（window.api.exportBackup）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            const result = await window.api.exportBackup();
            if (result.canceled) {
              return; // 用户取消「另存为」对话框
            }
            if (result.ok && result.path) {
              message.success(`备份归档已导出：${result.path}（${result.name ?? ''}）`);
            } else {
              message.error(`导出备份归档失败：${result.error ?? '未知错误'}`);
            }
          } catch (err) {
            message.error(`导出备份归档失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        导出备份归档(.zip)
      </Button>
      <Button
        title="导入「导出备份归档」生成的 .zip，解压后按与应用内恢复同一安全口径落库并重启后端"
        onClick={async () => {
          if (!window.api?.importBackup) {
            message.error('Electron preload 桥接（window.api.importBackup）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            const result = await window.api.importBackup();
            if (result.canceled) {
              return; // 用户取消「打开文件」对话框
            }
            if (result.ok) {
              const settingsTxt =
                result.settingsStatus === 'restored' || result.settingsStatus === 'retained_credentials_stripped'
                  ? '；配置已合并'
                  : result.settingsStatus === 'retained'
                    ? '；已保留当前配置'
                    : result.settingsStatus === 'parse_failed'
                      ? '；配置解析失败，已保留当前配置'
                      : '';
              const snapshotTxt = result.preRestoreSnapshot ? `；可回滚点：${result.preRestoreSnapshot.name}` : '';
              message.success(
                `备份归档导入成功：${result.importedBackupName ?? result.path ?? ''}${settingsTxt}${snapshotTxt}`
              );
              setTimeout(() => window.location.reload(), 300);
            } else {
              message.error(`导入备份归档失败：${result.error ?? '未知错误'}`);
            }
          } catch (err) {
            message.error(`导入备份归档失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        导入备份归档(.zip)
      </Button>
      <Button
        onClick={async () => {
          if (!window.api?.backupData) {
            message.error('Electron preload 桥接（window.api.backupData）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            const result = await window.api.backupData();
            if (result.canceled) {
              return; // 用户取消「另存为」对话框
            }
            if (result.ok && result.path) {
              message.success(`已备份到 ${result.path}`);
            } else {
              message.error(`备份失败：${result.error ?? '未知错误'}`);
            }
          } catch (err) {
            message.error(`备份失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        手动备份
      </Button>
      <Button
        title="立即备份到应用内自动备份目录（不走文件夹选择器，与自动备份同源，受保留上限管理）"
        onClick={async () => {
          if (!window.api?.backupNow) {
            message.error('Electron preload 桥接（window.api.backupNow）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            const result = await window.api.backupNow();
            if (result.ok) {
              message.success(`已立即备份：${result.name}`);
              onBackupNow?.();
            } else {
              message.error(`立即备份失败：${result.error ?? '未知错误'}`);
            }
          } catch (err) {
            message.error(`立即备份失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        立即备份
      </Button>
      <Button
        danger
        onClick={() =>
          confirmRestore({
            title: '确认恢复数据？',
            description:
              '将用备份覆盖当前 app.db、settings.json 与简历快照，当前数据（含简历）将被替换。勾选下方选项可仅恢复投递记录，保留当前设置/LLM 配置与简历。',
            successLabel: '数据已从备份恢复',
          })
        }
      >
        恢复数据
      </Button>
      <Button
        onClick={async () => {
          if (!window.api?.openBackupDir) {
            message.error('Electron preload 桥接（window.api.openBackupDir）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
            const result = await window.api.openBackupDir();
            if (!result.ok) {
              message.error(`打开备份目录失败：${result.error ?? '未知错误'}`);
            }
          } catch (err) {
            message.error(`打开备份目录失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        打开备份目录
      </Button>
    </Space>
  );
}

/** /jobs 求职投递记录页：antd Table + Badge 展示记录，支持新增/编辑/改状态/删除/导入，分页 + 状态筛选 + 关键词跨页搜索。 */
export function JobsPage() {
  const navigate = useNavigate();
  // 后端底座（baseUrl 解析 + IPC 就绪/失败订阅 + 聚焦自愈 + 卸载清理）统一由 useBackendBase 处理；
  // refreshToken 自增即触发下方 fetch effect 重拉，语义与 Dashboard 对齐。
  const { base: baseUrl, refreshToken: backendReady, reload: reconnect } = useBackendBase();
  const location = useLocation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // 看板统计卡片/趋势柱下钻：TrackerPage 导航到 /jobs?status=… / ?keyword=… 时从 URL 预筛选初始化。
  // /jobs 由 / 路由全新挂载，mount 时读一次 useLocation().search 即可，无需订阅路由变更。
  // 注意必须用 useLocation() 而非 window.location.search：应用为 HashRouter，查询串位于 hash 片段内，
  // window.location.search 恒为空串，否则看板下钻的状态预筛将永远不生效。
  const [status, setStatus] = useState<string | undefined>(() => {
    const s = new URLSearchParams(location.search).get('status');
    return s && s.trim() !== '' ? s : undefined;
  });
  // 看板趋势柱按日下钻 + 记录页日期区间筛选：URL 支持 date_from/date_to（RangePicker 区间，周/月/自定义）
  // 与旧版 date（单日下钻），页面预筛该区间投递记录（后端 func.date(applied_at) >= date_from / <= date_to 过滤）。
  const [date, setDate] = useState<{ from: string | null; to: string | null } | null>(() => {
    const q = new URLSearchParams(location.search);
    const f = q.get('date_from');
    const t = q.get('date_to');
    const d = q.get('date');
    // 仅当至少一端非空才构造区间；缺失端归一化为 null（而非 ''），避免空串被 dayjs 解析成 Invalid Date
    if ((f && f.trim() !== '') || (t && t.trim() !== '')) {
      return { from: f && f.trim() !== '' ? f : null, to: t && t.trim() !== '' ? t : null };
    }
    if (d && d.trim() !== '') return { from: d, to: d }; // 兼容看板单日下钻（/jobs?date=YYYY-MM-DD）
    return null;
  });
  // 已提交的搜索词：useLayoutEffect 重拉的唯一 keyword 来源，仅在 Enter/搜索按钮/清空时更新。
  const [keyword, setKeyword] = useState(() => new URLSearchParams(location.search).get('keyword') ?? '');
  // 搜索框本地输入草稿：受控 Input 的 value 绑定此值，onChange 只更新草稿，
  // 避免每次击键都改 keyword → 触发 fetchList 全量重拉（表格反复闪空 + 高频打后端）。
  // 初始值同步读 URL keyword，避免 /jobs?keyword=… 下钻挂载首帧搜索框闪空（路由同步 effect 在绘制后才补填）。
  const [keywordDraft, setKeywordDraft] = useState(
    () => new URLSearchParams(location.search).get('keyword') ?? '',
  );

  const [form] = Form.useForm();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  // 批量操作已选行 id（rowKey="id"）；分页 / 筛选 / 搜索词变化时清空，避免陈旧 key 指向不可见记录造成误批量操作。
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

  /** 分页 / 筛选 / 搜索词变化时清空已选行（fetchList 刷新后 rows 会跨页/跨筛选移动，保留旧 key 易误批量）。 */
  useEffect(() => {
    setSelectedRowKeys([]);
  }, [page, pageSize, status, keyword, date]);

  /** 路由级预筛同步：同一路由内 search 变化（浏览器返回 / 侧栏再点 /jobs）时，用 useLocation().search
   *  重新驱动 status/keyword 状态，保证 URL 驱动的筛选与实际渲染一致；仅 location.search 变化时触发。
   *  HashRouter 下 window.location.search 恒为空，必须经 useLocation 取；setState 值相同则 React 自动跳过重渲染，无循环风险。 */
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const s = q.get('status');
    const kw = q.get('keyword') ?? '';
    const f = q.get('date_from');
    const t = q.get('date_to');
    const d = q.get('date');
    setStatus(s && s.trim() !== '' ? s : undefined);
    setKeyword(kw);
    // 区间值相等时复用原对象引用，避免 useLayoutEffect（deps 含 date）对同名新对象误判为变化而重复拉取
    setDate((prev) => {
      let next: { from: string | null; to: string | null } | null = null;
      if ((f && f.trim() !== '') || (t && t.trim() !== '')) {
        next = { from: f && f.trim() !== '' ? f : null, to: t && t.trim() !== '' ? t : null };
      } else if (d && d.trim() !== '') {
        next = { from: d, to: d }; // 兼容看板单日下钻（/jobs?date=YYYY-MM-DD）
      }
      if (next === null && prev === null) return prev;
      if (next && prev && next.from === prev.from && next.to === prev.to) return prev;
      return next;
    });
    // URL 驱动的 keyword 需同步到搜索框草稿：否则 /jobs?keyword=… 下钻后输入框显示空，
    // 而列表已被该关键词过滤，输入框展示值与实际生效筛选不一致。
    setKeywordDraft(kw);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  /** 自动备份健康状态（get-backup-info：备份目录/最近备份时间/保留份数/保留上限），供「数据」页按钮旁展示。 */
  const [backupInfo, setBackupInfo] = useState<{
    backupDir: string;
    lastBackupAt: string | null;
    totalBackups: number;
    maxBackups: number;
    autoBackupEnabled: boolean;
  } | null>(null);
  /** 自动备份目录内可见的备份列表（list-backups，最新在前），供每个备份渲染删除按钮。 */
  const [backupList, setBackupList] = useState<
    Array<{
      name: string;
      path: string;
      createdAt: string | null;
      sizeBytes: number;
      fileCount: number;
      hasResume: boolean;
      checksumOk: boolean | null;
    }>
  >([]);
  /** 每个备份的完整性校验结果缓存（name → checksumOk）：false=校验未通过（禁止恢复）；true/null=正常或旧版无 manifest。 */
  const [checksumOkMap, setChecksumOkMap] = useState<Record<string, boolean | null | undefined>>({});

  /** 拉取备份健康状态 + 备份列表（Electron preload 桥接，非 Electron 环境静默跳过）。 */
  const refreshBackups = useCallback(async () => {
    if (!window.api?.getBackupInfo || !window.api?.listBackups) return;
    try {
      const [info, list] = await Promise.all([window.api.getBackupInfo(), window.api.listBackups()]);
      setBackupInfo(info);
      setBackupList(list);
      // 主进程 listBackups 已返回 checksumOk（带 mtime+size 签名缓存），列表加载即并入完整性缓存：
      // 损坏备份在列表首帧就标红/禁用恢复，而非等用户点过「预览」后才有正确状态
      setChecksumOkMap((m) => {
        const next = { ...m };
        for (const b of list) next[b.name] = b.checksumOk ?? null;
        return next;
      });
    } catch (err) {
      console.error('[DataViews] 读取备份状态失败', err);
    }
  }, []);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  const items = useApplicationsStore((s) => s.items);
  const total = useApplicationsStore((s) => s.total);
  const loading = useApplicationsStore((s) => s.loading);
  const error = useApplicationsStore((s) => s.listError);
  const fetchList = useApplicationsStore((s) => s.fetchList);

  /** 关键词搜索：透传给后端 GET /api/applications?keyword=…（对 job_title/company/city LIKE 过滤），
   *  分页 total 与搜索词一致，可跨页检索全部记录，而非仅过滤当前已加载页。 */
  // 首帧防闪烁：useLayoutEffect 在浏览器绘制前同步执行，fetchList 内部的 set({ items: [], loading: true })
  // 先于表格渲染生效，避免 /jobs ↔ /apply 共享 store 时新页首个可见帧渲染兄弟页的旧查询结果。
  useLayoutEffect(() => {
    if (baseUrl) {
      void fetchList(baseUrl, { page, pageSize, status, keyword, date });
    }
  }, [baseUrl, page, pageSize, status, keyword, date, backendReady, fetchList]);

  const openExternal = useCallback(async (url: string) => {
    if (!window.api?.openExternal) {
      message.error('Electron preload 桥接（window.api.openExternal）不可用，请通过 Electron 启动应用。');
      return;
    }
    try {
      const res = await window.api.openExternal(url);
      if (res && !res.ok) {
        message.error(res.error ?? '打开链接失败');
      }
    } catch (err) {
      message.error(`打开链接失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const openCreateModal = () => {
    setEditingId(null);
    form.resetFields();
    // JobsPage 是「投递记录（全部）」归档页：从这里补录/新建投递记录时，若静默默认 status='pending'，
    // 会让记录误入 ApplyPage 待投递队列并在看板被计入「进行中」，与归档补录意图不符。
    // 故这里不设默认 status，弹窗内状态字段必选实际状态（见下方状态 Form.Item 的 required 校验）；
    // 待投递队列默认 pending 的语义仅由 ApplyPage 自己的登记入口承担。
    // 投递时间默认取当前时间，可在弹窗内改为历史投递日期
    form.setFieldsValue({ applied_at: dayjs() });
    setModalOpen(true);
  };

  const openEditModal = useCallback((record: ApplicationItem) => {
    setEditingId(record.id);
    form.setFieldsValue({
      job_title: record.job_title,
      company: record.company,
      city: record.city,
      salary: record.salary,
      url: record.url,
      status: record.status,
      note: record.note,
      applied_at: record.applied_at ? dayjs(record.applied_at) : undefined,
    });
    setModalOpen(true);
  }, [form]);

  const handleSave = async () => {
    if (!baseUrl) return;
    let values: ApplicationInput;
    try {
      // DatePicker 表单值为 dayjs 对象，提交前转本地时间字符串（用 format 而非 toISOString，避免转 UTC 造成时区偏移 + 编辑往返漂移）；留空时保持缺省（后端取当前时间）
      const raw = (await form.validateFields()) as ApplicationInput & {
        applied_at?: { format(fmt: string): string };
      };
      // 清空投递时间也发送 applied_at:null（JSON.stringify 保留 null，后端存 NULL=未设置），否则键被丢弃静默保留旧值
      values = { ...raw, applied_at: raw.applied_at ? raw.applied_at.format('YYYY-MM-DDTHH:mm:ss') : null };
    } catch {
      return; // 表单校验未通过，antd 已给出提示
    }
    setSaving(true);
    try {
      const err = editingId
        ? await updateApplication(baseUrl, editingId, values)
        : await createApplication(baseUrl, values);
      if (err) {
        message.error(err);
        return;
      }
      message.success(editingId ? '投递记录已更新' : '投递记录已新增');
      setModalOpen(false);
      // 仅编辑（非新建）时评估 willLeaveView：新建记录本不在筛选列表内，筛选 total 不变，
      // 加 editingId 守卫避免「新建恰好落在当前页只有 1 条且 page>1」时误退页（对齐 ApplyPage/InterviewPage）。
      const willLeaveView =
        editingId !== null && status !== undefined && values.status !== undefined && values.status !== status;
      const nextPage = willLeaveView && items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { page: nextPage, pageSize, status, keyword, date });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = useCallback(async (record: ApplicationItem, next: string) => {
    if (!baseUrl) return;
    const err = await updateApplication(baseUrl, record.id, { status: next });
    if (err) {
      message.error(err);
      return;
    }
    // 状态筛选下把当前筛选内的最后一条记录改到筛选外时回退一页，避免 Table 停留在越界空页；
    // 无状态筛选时记录仍在页内（改状态不改变 total），不能误退页。
    const willLeaveView =
      status !== undefined && record.status === status && next !== status;
    const nextPage =
      willLeaveView && items.length === 1 && page > 1 ? page - 1 : page;
    if (nextPage !== page) {
      // 回退一页后由 useLayoutEffect（deps 含 page）以新页码重拉；此处 return 避免与 effect
      // 各发一次 fetchList —— 两个网络往返 + 表格闪空两次（与 handleDelete 的 if/else 分支语义一致）。
      setPage(nextPage);
      return;
    }
    void fetchList(baseUrl, { page: nextPage, pageSize, status, keyword, date });
  }, [baseUrl, page, pageSize, status, keyword, date, fetchList, items.length, setPage]);

  const handleDelete = useCallback(async (record: ApplicationItem) => {
    if (!baseUrl) return;
    const err = await deleteApplication(baseUrl, record.id);
    if (err) {
      message.error(err);
      return;
    }
    message.success(`已删除：${record.job_title}`);
    // 从选中集中移除已删除记录，避免工具条「已选 N 条」及后续批量操作包含已删 id
    setSelectedRowKeys((keys) => keys.filter((k) => Number(k) !== record.id));
    // 删除最后一页最后一条时，回退分页到新的最大页，避免 Table 停留在越界页码
    const newTotal = Math.max(0, total - 1);
    const maxPage = Math.max(1, Math.ceil(newTotal / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    } else {
      void fetchList(baseUrl, { page, pageSize, status, keyword, date });
    }
  }, [baseUrl, total, page, pageSize, status, keyword, date, fetchList, setPage]);

  /** 批量改状态：逐 id 串行调用 PATCH，全部完成后清空选中并沿用现有 fetchList 刷新语义。 */
  const handleBatchStatusChange = useCallback(async (next: string) => {
    if (!baseUrl || selectedRowKeys.length === 0) return;
    let ok = 0;
    let fail = 0;
    for (const key of selectedRowKeys) {
      const err = await updateApplication(baseUrl, Number(key), { status: next });
      if (err) {
        fail += 1;
      } else {
        ok += 1;
      }
    }
    if (fail > 0) {
      message.error(`批量改状态完成：成功 ${ok} 条，失败 ${fail} 条`);
    } else {
      message.success(`已批量更新 ${ok} 条记录状态为「${STATUS_TEXT[next] ?? next}」`);
    }
    setSelectedRowKeys([]);
    // 状态筛选下批量把筛选内记录改到筛选外时，按新 total 计算最大页并回退，避免 Table 停留在越界空页；
    // 无状态筛选（或改到同一状态、全部失败）时 total 不变，记录仍在页内，不能误退页。
    if (status !== undefined && next !== status && ok > 0 && page > 1) {
      const maxPage = Math.max(1, Math.ceil((total - ok) / pageSize));
      if (page > maxPage) {
        setPage(maxPage);
        return;
      }
    }
    void fetchList(baseUrl, { page, pageSize, status, keyword, date });
  }, [baseUrl, selectedRowKeys, total, page, pageSize, status, keyword, date, fetchList, setPage]);

  /** 批量删除：逐 id 串行调用 DELETE，全部完成后清空选中；删除后 total 减少，回退分页到新的最大页（与单条删除一致）。 */
  const handleBatchDelete = useCallback(async () => {
    if (!baseUrl || selectedRowKeys.length === 0) return;
    let ok = 0;
    let fail = 0;
    for (const key of selectedRowKeys) {
      const err = await deleteApplication(baseUrl, Number(key));
      if (err) {
        fail += 1;
      } else {
        ok += 1;
      }
    }
    if (fail > 0) {
      message.error(`批量删除完成：成功 ${ok} 条，失败 ${fail} 条`);
    } else {
      message.success(`已批量删除 ${ok} 条记录`);
    }
    setSelectedRowKeys([]);
    const newTotal = Math.max(0, total - ok);
    const maxPage = Math.max(1, Math.ceil(newTotal / pageSize));
    if (page > maxPage) {
      setPage(maxPage);
    } else {
      void fetchList(baseUrl, { page, pageSize, status, keyword, date });
    }
  }, [baseUrl, selectedRowKeys, total, page, pageSize, status, keyword, date, fetchList, setPage]);

  /** 导入成功后统一处理（粘贴导入与文件导入共用）：提示成功 + 关闭粘贴导入弹窗 + 回到第 1 页刷新列表。
   *  导入后数据总量变化，回到第 1 页避免 Table 分页 current 停留在导入前的页码（新总量更小导致页码越界空表）。 */
  const handleImportSuccess = (successMsg: string) => {
    message.success(successMsg);
    setImportOpen(false);
    setImportText('');
    if (!baseUrl) return;
    if (page !== 1) {
      setPage(1);
    } else {
      void fetchList(baseUrl, { page: 1, pageSize, status, keyword, date });
    }
  };

  /** 粘贴 JSON 导入（备选方式）：解析并逐条校验后 POST /api/import。 */
  const handleImport = async () => {
    if (!baseUrl) return;
    setImporting(true);
    try {
      const result = await importApplications(baseUrl, importText);
      if (!result.ok) {
        message.error(result.error ?? '导入失败');
        return;
      }
      const created = result.created ?? 0;
      const updated = result.updated ?? 0;
      const skipped = result.skipped ?? 0;
      // 与文件导入（handleImportFile）同口径：created/updated/skipped 分离展示，不再把总数当「新增」
      handleImportSuccess(
        `导入成功：新增 ${created} 条 / 更新 ${updated} 条${skipped > 0 ? ` / 跳过 ${skipped} 条格式非法记录` : ''}`,
      );
    } finally {
      setImporting(false);
    }
  };

  /** 从「导出数据」JSON 文件直接导入（首选方式）：
   *  先经 previewImportData（preview-import-data IPC）打开文件对话框并读取校验（不落库），
   *  弹出『导入前确认』弹窗展示 applications 数 / 将覆盖的已有 id 数 / 是否含 settings 段
   *  （与「预览导出内容」对称），用户确认后再用返回的 path 调 importData(path) 真正落库——
   *  覆盖既有记录不再静默发生。 */
  const handleImportFile = async () => {
    if (!window.api?.previewImportData || !window.api?.importData) {
      message.error('Electron preload 桥接（window.api.previewImportData / importData）不可用，请通过 Electron 启动应用。');
      return;
    }
    try {
      // 第一步：预览（打开文件对话框 + 读取校验 + 统计覆盖 id），不落库、不 POST
      const preview = await window.api.previewImportData();
      if (preview.canceled) {
        return; // 用户取消「打开文件」对话框
      }
      if (!preview.ok) {
        message.error(`导入文件预览失败：${preview.error ?? '未知错误'}`);
        return;
      }
      const pv = (preview.preview ?? {}) as {
        applications?: number;
        applyLogs?: number;
        hasSettings?: boolean;
        overwriteIds?: number;
      };
      const appCount = typeof pv.applications === 'number' ? pv.applications : 0;
      const logCount = typeof pv.applyLogs === 'number' ? pv.applyLogs : 0;
      const overwriteCount = typeof pv.overwriteIds === 'number' ? pv.overwriteIds : 0;
      const hasSettings = pv.hasSettings === true;
      // 第二步：导入前确认弹窗（与「预览导出内容」对称），明示覆盖量，杜绝静默覆盖
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '确认导入该文件？',
          width: 560,
          content: (
            <div style={{ fontSize: 13, lineHeight: '22px' }}>
              <div>
                投递记录：<b>{appCount}</b> 条
              </div>
              <div>投递日志：{logCount} 条</div>
              <div>
                将覆盖已有 id：<b style={{ color: overwriteCount > 0 ? '#ff4d4f' : undefined }}>{overwriteCount}</b> 条
                {overwriteCount > 0 ? '（同 id 记录将被替换）' : '（全部为新增）'}
              </div>
              <div>{hasSettings ? '载荷含 settings 配置段，导入时合并配置' : '载荷不含 settings 配置段'}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                确认后将直接导入该文件，无需再次选择。
              </Typography.Text>
            </div>
          ),
          okText: overwriteCount > 0 ? '确认覆盖导入' : '确认导入',
          okButtonProps: overwriteCount > 0 ? { danger: true } : undefined,
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) {
        return;
      }
      // 第三步：用预览返回的 path 直接导入（跳过二次文件选择）
      const result = await window.api.importData(preview.path);
      if (result.canceled) {
        return;
      }
      if (result.ok && result.path) {
        const hasCounts =
          typeof result.importedCount === 'number' ||
          typeof result.updatedCount === 'number' ||
          typeof result.skippedCount === 'number';
        const counts = hasCounts
          ? `（新增 ${result.importedCount ?? 0} 条 / 更新 ${result.updatedCount ?? 0} 条 / 跳过 ${result.skippedCount ?? 0} 条）`
          : '';
        // importData 的 settingsStatus（'restored' | 'retained_credentials_stripped' | 'parse_failed' | 'missing'）
        // 汇报本次导入对 settings.json 的处理结果，如实提示用户 LLM 配置是合并、剥离还是保留。
        const settingsTxt =
          result.settingsStatus === 'retained_credentials_stripped'
            ? '；配置已还原（当前 LLM 密钥已保留）'
            : result.settingsStatus === 'parse_failed'
              ? '；配置解析失败，已保留当前配置'
              : result.settingsStatus === 'missing'
                ? '；无配置可恢复，保留当前配置'
                : result.settingsStatus === 'restored'
                  ? '；配置已合并'
                  : '';
        // importData 的 resumeStatus（'restored' | 'missing' | 'write_failed'）汇报简历快照 resume.json 的恢复结果：
        // 'restored' 时主进程已双写数据目录权威副本，这里经 getResumeSnapshot 回灌渲染层 localStorage（bossjobai.resume），
        // 避免 ResumePage 下次保存用旧 localStorage 覆盖写回磁盘（静默丢失被恢复的简历）；与 ResumePage 挂载回灌互为兜底。
        const resumeTxt =
          result.resumeStatus === 'restored'
            ? '；简历已一并恢复'
            : result.resumeStatus === 'write_failed'
              ? '；简历快照写入失败，请到「简历」页重新保存'
              : '';
        if (result.resumeStatus === 'restored' && window.api?.getResumeSnapshot) {
          try {
            const snap = await window.api.getResumeSnapshot();
            if (snap?.ok && snap.resume && typeof snap.resume === 'object') {
              localStorage.setItem('bossjobai.resume', JSON.stringify(snap.resume));
            }
          } catch (_err) {
            // 回灌失败不阻塞导入提示（磁盘副本仍在，ResumePage 挂载时会再回灌）
          }
        }
        handleImportSuccess(`从 JSON 文件导入成功：${result.path}${counts}${settingsTxt}${resumeTxt}`);
      } else {
        message.error(`导入失败：${result.error ?? '未知错误'}`);
      }
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 导出 CSV：唯一导出路径 —— 经 window.api.exportCsv（主进程原生「另存为」对话框，
   *  主进程从 /api/export 原子全量拉取后按当前 status/keyword/日期区间筛选），与「导出数据」同数据源，
   *  不再维护客户端 Blob 降级路径（避免两套 CSV 语义漂移）。 */
  const handleExportCsv = async () => {
    if (!window.api?.exportCsv || !window.api?.exportBackupData) {
      message.error('Electron preload 桥接（window.api.exportCsv / exportBackupData）不可用，请通过 Electron 启动应用。');
      return;
    }
    try {
      // 透传当前筛选（status + keyword + date_from/date_to 日期区间），主进程 export-data-csv 按同口径过滤后导出 CSV
      const csvFilter = {
        status,
        keyword,
        date_from: date?.from ?? undefined,
        date_to: date?.to ?? undefined,
      };
      const result = await window.api.exportCsv(csvFilter);
      if (result.canceled) return;
      if (result.ok) {
        message.success(`已导出 CSV：${result.path ?? ''}`);
        return;
      }
      // 在线 CSV 导出失败（后端不可达/端口冲突）→ 自动降级离线导出最新自动备份 app.db 为 CSV
      const offline = await window.api.exportBackupData({ format: 'csv', ...csvFilter });
      if (offline.canceled) return;
      if (offline.ok && offline.path) {
        message.warning(
          `后端不可达，已从最新自动备份离线导出 CSV（${offline.backupName ?? ''}）：${offline.path}（备份快照数据）`,
        );
        return;
      }
      throw new Error(offline.error ?? result.error ?? '导出失败');
    } catch (err) {
      message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 解析薪资字符串的数字前缀（如 '20-40K' → 20）用于 sorter 数值比较；无前缀返回 -1。 */
  const parseSalaryNum = (s: string | undefined | null): number => {
    const m = /^\s*(\d+(?:\.\d+)?)/.exec(s ?? '');
    return m ? parseFloat(m[1]) : -1;
  };

  /** 链接输入即校验宿主是否在白名单内（共享 useUrlHostWarning，与 JobsPage/ApplyPage/InterviewPage 同口径，消除复刻漂移）。 */
  const urlHostWarning = useUrlHostWarning(form, baseUrl ?? '');

  const columns = useMemo<TableProps<ApplicationItem>['columns']>(
    () => [
    {
      title: '职位',
      dataIndex: 'job_title',
      ellipsis: true,
      sorter: (a, b) => (a.job_title || '').localeCompare(b.job_title || ''),
    },
    {
      title: '公司',
      dataIndex: 'company',
      ellipsis: true,
      sorter: (a, b) => (a.company || '').localeCompare(b.company || ''),
    },
    {
      title: '城市',
      dataIndex: 'city',
      width: 80,
      sorter: (a, b) => (a.city || '').localeCompare(b.city || ''),
    },
    {
      title: '薪资',
      dataIndex: 'salary',
      width: 110,
      sorter: (a, b) => parseSalaryNum(a.salary) - parseSalaryNum(b.salary),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Badge color={STATUS_COLOR[v] ?? '#d9d9d9'} text={STATUS_TEXT[v] ?? v} />
      ),
    },
    {
      title: '投递时间',
      dataIndex: 'applied_at',
      width: 160,
      sorter: (a, b) => (a.applied_at || '').localeCompare(b.applied_at || ''),
      render: (v: string) => (v ? v.replace('T', ' ').slice(0, 16) : '—'),
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_: unknown, record: ApplicationItem) => (
        <Space size="small" wrap>
          <Select
            size="small"
            style={{ width: 96 }}
            value={record.status}
            onChange={(v) => void handleStatusChange(record, v)}
            options={STATUS_OPTIONS}
          />
          <Button size="small" type="link" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Button size="small" type="link" onClick={() => void openLogsModal(baseUrl ?? '', record)}>
            日志
          </Button>
          <Popconfirm
            title={`删除「${record.job_title}」？`}
            description="删除后不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
          {record.url ? (
            <>
              <Button size="small" type="link" onClick={() => void openExternal(record.url)}>
                打开
              </Button>
              <Button size="small" type="link" onClick={() => void copyLink(record.url)}>
                复制
              </Button>
            </>
          ) : null}
        </Space>
      ),
    },
    ],
    [handleStatusChange, openEditModal, openLogsModal, baseUrl, handleDelete, openExternal],
  );

  return (
    <DataPageCard title="投递记录（全部）" onBack={() => navigate('/')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="当前为手动记录管理"
          description="岗位库抓取、简历自动解析、自动投递等 AI 自动化功能规划中，尚未上线。此处展示全部投递记录（新增 / 编辑 / 状态推进 / 导入导出）；登记待投递队列请前往「投递（手动登记）」页。"
          style={{ marginBottom: 8 }}
        />
        {/* 数据管理工具条恒常渲染：备份/恢复/导出仅依赖主进程文件快照，错误态（后端未连接 / 列表拉取失败）下仍应可用 */}
        <DataTools onBackupNow={refreshBackups} />
        {baseUrl === '' ? (
          <>
            <Alert type="error" showIcon message="无法连接后端，请通过 Electron 启动应用。可返回工作台点「重新连接」，或直接点下方「重新连接」重试。" />
            <Space>
              <Button onClick={reconnect}>重新连接</Button>
            </Space>
          </>
        ) : baseUrl === null ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : error && items.length === 0 ? (
          <>
            <Alert type="error" showIcon message={error} />
            <Space>
              <Button
                onClick={() => {
                  if (baseUrl) void fetchList(baseUrl, { page, pageSize, status, keyword, date });
                }}
              >
                重试
              </Button>
            </Space>
          </>
        ) : (
          <>
            {error ? (
              <Alert type="warning" showIcon message={error} style={{ marginBottom: 8 }} />
            ) : null}
            <Typography.Text type="secondary">
              职位链接仅允许 http/https 放行，且宿主须在外部链接白名单内（默认 *.zhipin.com，可在设置页扩展）。
            </Typography.Text>
            <Space wrap>
              <Input.Search
                placeholder="搜索公司 / 职位 / 城市"
                allowClear
                style={{ width: 260 }}
                value={keywordDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setKeywordDraft(v);
                  // allowClear 点击清空只触发 onChange（不触发 onSearch）：立即提交空查询恢复全量，
                  // 保持「清空即重置」原行为；普通击键仅更新草稿，待 Enter/搜索按钮提交后再搜索。
                  if (v === '') {
                    setKeyword(v);
                    setPage(1);
                  }
                }}
                onSearch={(v) => {
                  setKeyword(v);
                  setPage(1);
                }}
              />
              <Select
                placeholder="按状态筛选"
                allowClear
                style={{ width: 160 }}
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
              />
              <DatePicker.RangePicker
                placeholder={['开始日期', '结束日期']}
                allowClear
                style={{ width: 260 }}
                value={date ? [date.from ? dayjs(date.from) : null, date.to ? dayjs(date.to) : null] : null}
                presets={[
                  // 本周起点取周一且 Sunday-safe：dayjs 默认 en locale 的 startOf('week') 是周日，
                  // 周日当天 startOf('week') 返回当天、+1 天成「下周一（明天）」造成 from>to 倒置
                  // （后端 date 区间过滤恒空）。周日应取本周一（周日前 6 天），其余取上周日+1 天。
                  {
                    label: '本周',
                    value: [
                      dayjs().day() === 0
                        ? dayjs().subtract(6, 'day')
                        : dayjs().startOf('week').add(1, 'day'),
                      dayjs(),
                    ],
                  },
                  { label: '本月', value: [dayjs().startOf('month'), dayjs()] },
                  { label: '近7天', value: [dayjs().subtract(6, 'day'), dayjs()] },
                  { label: '近30天', value: [dayjs().subtract(29, 'day'), dayjs()] },
                ]}
                onChange={(range) => {
                  const from = range && range[0] ? range[0].format('YYYY-MM-DD') : undefined;
                  const to = range && range[1] ? range[1].format('YYYY-MM-DD') : undefined;
                  const next = from && to ? { from, to } : null;
                  setDate(next);
                  setPage(1);
                  // 页内选择/清除日期区间必须回写 query（date_from/date_to），否则区间筛选在页内不可见、
                  // 也无法解除，残留 ?date_from=… 会持续过滤直到侧栏重进；看板单日下钻仍走旧 ?date= 参数，
                  // 路由同步 effect 统一兼容两者（date 单日 → {from:date,to:date}）。
                  // 清除（allowClear）即移除日期参数回全量，保留其余参数（status/keyword）不变。
                  // 关键：query 必须基于当前内存中的 status/keyword 状态拼接，而非 location.search——
                  // 状态筛选 Select / 关键词搜索框提交后只写 state 不写 URL，location.search 可能滞后于
                  // 用户刚做的选择；若读取 location.search 触发 navigate → 路由同步 effect 会用旧 URL
                  // 把用户当前生效的状态/关键词筛选悄悄重置为空（列表瞬间回到全量），属隐性丢筛 bug。
                  const q = new URLSearchParams();
                  if (status) q.set('status', status);
                  if (keyword) q.set('keyword', keyword);
                  if (from) q.set('date_from', from);
                  if (to) q.set('date_to', to);
                  const qs = q.toString();
                  navigate(qs ? `/jobs?${qs}` : '/jobs');
                }}
              />
              <Button type="primary" onClick={openCreateModal}>
                新增投递记录
              </Button>
              <Button onClick={() => setImportOpen(true)}>导入数据</Button>
              <Button
                title="选择「导出数据」生成的 JSON 文件直接导入，免手工复制粘贴；粘贴导入（导入数据）仍可作备选"
                onClick={() => void handleImportFile()}
              >
                从 JSON 文件导入
              </Button>
              <Button
                onClick={() => {
                  if (baseUrl) void fetchList(baseUrl, { page, pageSize, status, keyword, date });
                }}
              >
                刷新
              </Button>
              <Button onClick={() => navigate('/apply')}>去待投递队列</Button>
              <Button title="导出当前筛选结果的 CSV，用于 HR/复盘查看" onClick={() => void handleExportCsv()}>
                导出 CSV
              </Button>
            </Space>
            {backupInfo ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                自动备份：{backupInfo.autoBackupEnabled === false ? '已关闭' : '已开启'} · 最近备份{' '}
                {backupInfo.lastBackupAt ? backupInfo.lastBackupAt.replace('T', ' ').slice(0, 19) : '无'}
                ，已保留 {backupInfo.totalBackups}/{backupInfo.maxBackups} 份
                {backupInfo.backupDir ? `（目录：${backupInfo.backupDir}）` : ''}
              </Typography.Text>
            ) : null}
            {backupInfo && backupInfo.autoBackupEnabled === false ? (
              <Alert
                type="warning"
                showIcon
                message="自动备份未开启，数据仅靠手动备份保护"
                style={{ marginBottom: 8 }}
              />
            ) : null}
            {backupList.length > 0 ? (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  应用内管理备份（删除不可恢复）：
                </Typography.Text>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                  {backupList.map((b) => (
                    <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: `路径：${b.path}` }}>
                        {b.name}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {b.createdAt ? b.createdAt.replace('T', ' ').slice(0, 16) : ''}
                      </Typography.Text>
                      {/* 备份体量：sizeBytes/fileCount 由 listBackups 主进程统计，便于在列表直接判断每个备份的规模 */}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatBytes(b.sizeBytes)}
                        {typeof b.fileCount === 'number' ? ` · ${b.fileCount} 个文件` : ''}
                      </Typography.Text>
                      {/* hasResume：listBackups 主进程统计的该备份简历快照覆盖情况，帮助用户确认每个备份是否捕获了简历 */}
                      <Typography.Text
                        type={b.hasResume ? 'success' : 'warning'}
                        style={{ fontSize: 12 }}
                      >
                        简历：{b.hasResume ? '含' : '缺'}
                      </Typography.Text>
                      <Button
                        size="small"
                        type="link"
                        onClick={async () => {
                          if (!window.api?.previewBackup) {
                            message.error('Electron preload 桥接（window.api.previewBackup）不可用，请通过 Electron 启动应用。');
                            return;
                          }
                          try {
                            const p = await window.api.previewBackup(b.name);
                            // 错误契约：损坏/越界/权限等失败一律 {ok:false, error}，先判错再返回，
                            // 否则损坏备份会被渲染成「0 条记录 / 无样本」空预览掩盖真实故障
                            if (p.ok === false || p.error) {
                              message.error(`备份预览失败：${p.error || '备份无法读取'}`);
                              return;
                            }
                            // 记录校验结果：false=完整性校验未通过（恢复被主进程拒绝）；true/null=正常/旧版无 manifest
                            setChecksumOkMap((m) => ({ ...m, [b.name]: p.checksumOk ?? null }));
                            const latest = p.latestRecordAt
                              ? String(p.latestRecordAt).replace('T', ' ').slice(0, 19)
                              : '无';
                            const settingsTxt =
                              p.hasSettings === false
                                ? '缺失（恢复时保留当前配置）'
                                : p.settingsStatus === 'ok'
                                  ? '正常（恢复时安全保留当前 LLM 密钥）'
                                  : '文件无效（恢复时忽略该文件）';
                            const samples = Array.isArray(p.samples) ? p.samples : [];
                            Modal.info({
                              title: `备份预览：${b.name}`,
                              width: 560,
                              content: (
                                <div style={{ fontSize: 13, lineHeight: '22px' }}>
                                  <div>投递记录：<b>{p.appCount}</b> 条</div>
                                  <div>最近投递：{latest}</div>
                                  <div>Schema 版本：{p.schemaVersion}</div>
                                  <div>settings.json：{settingsTxt}</div>
                                  <div>
                                    简历快照：
                                    {p.resumeSummary ? (
                                      <span>
                                        含 —— 姓名：<b>{p.resumeSummary.name || '未填写'}</b>
                                        {p.resumeSummary.phone ? ` · 手机：${p.resumeSummary.phone}` : ''}
                                        {p.resumeSummary.email ? ` · 邮箱：${p.resumeSummary.email}` : ''}
                                      </span>
                                    ) : p.hasResume ? (
                                      <Typography.Text type="warning">含（但 resume.json 摘要不可用）</Typography.Text>
                                    ) : (
                                      '不含（恢复后保留当前简历）'
                                    )}
                                  </div>
                                  <div>
                                    校验状态：
                                    {p.checksumOk === true ? (
                                      <Typography.Text type="success">校验通过</Typography.Text>
                                    ) : p.checksumOk === false ? (
                                      <Typography.Text type="danger">校验失败（备份可能已损坏）</Typography.Text>
                                    ) : (
                                      <Typography.Text type="secondary">旧版备份，无校验和</Typography.Text>
                                    )}
                                  </div>
                                  {p.checksumOk === false ? (
                                    <Alert
                                      type="error"
                                      showIcon
                                      style={{ marginTop: 8 }}
                                      message="备份完整性校验未通过（文件可能损坏），恢复将被拒绝"
                                    />
                                  ) : null}
                                  {samples.length > 0 ? (
                                    <div style={{ marginTop: 8 }}>
                                      <div style={{ marginBottom: 4 }}>最新投递记录样本（{samples.length} 条）：</div>
                                      <div
                                        style={{
                                          maxHeight: 260,
                                          overflowY: 'auto',
                                          border: '1px solid #f0f0f0',
                                          borderRadius: 4,
                                          padding: 4,
                                        }}
                                      >
                                        {samples.map((s, i) => (
                                          <div
                                            key={i}
                                            style={{
                                              padding: '2px 4px',
                                              borderBottom: i < samples.length - 1 ? '1px dashed #f0f0f0' : 'none',
                                            }}
                                          >
                                            <Typography.Text strong>{s.job_title || '（无职位名）'}</Typography.Text>
                                            {s.company ? ` · ${s.company}` : ''}
                                            <Typography.Text type="secondary">　状态：{s.status || '-'}</Typography.Text>
                                            {s.applied_at ? (
                                              <Typography.Text type="secondary">
                                                　投递：{String(s.applied_at).replace('T', ' ').slice(0, 16)}
                                              </Typography.Text>
                                            ) : null}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div style={{ marginTop: 8, color: '#999' }}>（该备份内无投递记录样本）</div>
                                  )}
                                </div>
                              ),
                              okText: '知道了',
                            });
                          } catch (err) {
                            message.error(`备份预览失败：${err instanceof Error ? err.message : String(err)}`);
                          }
                        }}
                      >
                        预览
                      </Button>
                      <Button
                        size="small"
                        type="link"
                        disabled={checksumOkMap[b.name] === false}
                        onClick={() =>
                          confirmRestore({
                            title: `恢复备份「${b.name}」？`,
                            description:
                              '将用该备份覆盖当前数据，建议先手动备份当前数据以防误恢复。勾选下方选项可仅恢复投递记录，保留当前设置/LLM 配置与简历。',
                            dir: b.path,
                            successLabel: '已从备份恢复',
                          })
                        }
                      >
                        恢复
                      </Button>
                      <Popconfirm
                        title={`删除备份「${b.name}」？`}
                        description="删除后不可恢复。"
                        okText="删除"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={async () => {
                          if (!window.api?.deleteBackup) {
                            message.error(
                              'Electron preload 桥接（window.api.deleteBackup）不可用，请通过 Electron 启动应用。'
                            );
                            return;
                          }
                          try {
                            const res = await window.api.deleteBackup(b.name);
                            if (res && !res.ok) {
                              message.error(`删除备份失败：${res.error ?? '未知错误'}`);
                              return;
                            }
                            message.success(`已删除备份：${b.name}`);
                            void refreshBackups();
                          } catch (err) {
                            message.error(`删除备份失败：${err instanceof Error ? err.message : String(err)}`);
                          }
                        }}
                      >
                        <Button size="small" type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「导出数据」仅用于查看/归档，恢复需用备份；「恢复数据」需选择包含 app.db、settings.json 与简历快照（resume.json）的备份目录进行还原。
              自动备份保存在应用备份目录（打包模式：%APPDATA%/BossJobAI/backups，保留最近 {backupInfo?.maxBackups ?? 7} 份）。
            </Typography.Text>
            {selectedRowKeys.length > 0 ? (
              <Space wrap style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">已选 {selectedRowKeys.length} 条</Typography.Text>
                <Select
                  style={{ width: 140 }}
                  placeholder="批量改状态"
                  options={STATUS_OPTIONS}
                  onChange={(v) => void handleBatchStatusChange(v)}
                />
                <Popconfirm
                  title={`确认删除选中的 ${selectedRowKeys.length} 条记录？`}
                  description="删除后不可恢复。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => void handleBatchDelete()}
                >
                  <Button danger>批量删除</Button>
                </Popconfirm>
                <Button onClick={() => setSelectedRowKeys([])}>取消选择</Button>
              </Space>
            ) : null}
            <Table<ApplicationItem>
              rowKey="id"
              size="middle"
              loading={loading}
              dataSource={items}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有投递记录，从下方入口添加第一条吧"
                  >
                    <Space wrap>
                      <Button type="primary" onClick={openCreateModal}>
                        新增投递记录
                      </Button>
                      <Button onClick={() => void handleImportFile()}>从 JSON 文件导入</Button>
                    </Space>
                  </Empty>
                ),
              }}
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
              expandable={{ expandedRowRender: renderApplicationDetail }}
              pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                pageSizeOptions: PAGE_SIZE_OPTIONS,
                onChange: (p, ps) => {
                  setPageSize(ps);
                  setPage(Math.min(p, Math.max(1, Math.ceil(total / ps))));
                },
              }}
              columns={columns}
            />
            <Modal
              title={editingId ? '编辑投递记录' : '新增投递记录'}
              open={modalOpen}
              onOk={() => void handleSave()}
              onCancel={() => setModalOpen(false)}
              confirmLoading={saving}
              okText={editingId ? '保存' : '新增'}
              cancelText="取消"
            >
              <Form form={form} labelCol={{ span: 5 }} wrapperCol={{ span: 18 }} style={{ marginTop: 16 }}>
                <Form.Item
                  name="job_title"
                  label="职位"
                  rules={[{ required: true, whitespace: true, message: '请输入职位名称' }]}
                >
                  <Input placeholder="如：前端工程师" maxLength={255} />
                </Form.Item>
                <Form.Item
                  name="company"
                  label="公司"
                  rules={[{ required: true, whitespace: true, message: '请输入公司名称' }]}
                >
                  <Input placeholder="如：某科技公司" maxLength={255} />
                </Form.Item>
                <Form.Item name="city" label="城市">
                  <Input placeholder="如：北京" maxLength={64} />
                </Form.Item>
                <Form.Item name="salary" label="薪资">
                  <Input placeholder="如：20-40K" maxLength={128} />
                </Form.Item>
                <Form.Item
                  name="url"
                  label="链接"
                  extra={urlHostWarning ? <Typography.Text type="warning">{urlHostWarning}</Typography.Text> : 'http/https 职位链接（可选）'}
                >
                  <Input placeholder="http/https 职位链接（可选）" />
                </Form.Item>
                <Form.Item
                  name="status"
                  label="状态"
                  rules={[{ required: true, message: '请选择该记录的实际投递状态' }]}
                  tooltip="补录/新建时请显式选择实际状态，避免记录误入「待投递」队列（归档页不再默认选 pending）"
                >
                  <Select
                    placeholder="请选择状态"
                    options={Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }))}
                  />
                </Form.Item>
                <Form.Item
                  name="applied_at"
                  label="投递时间"
                  tooltip="补录历史投递时可指定实际投递时间；留空=未设置（仅新建缺省取当前时间）"
                >
                  <DatePicker
                    showTime={{ format: 'HH:mm' }}
                    format="YYYY-MM-DD HH:mm"
                    style={{ width: '100%' }}
                    placeholder="投递时间（可选，留空=未设置）"
                    allowClear
                  />
                </Form.Item>
                <Form.Item name="note" label="备注">
                  <Input.TextArea rows={3} placeholder="备注（可选）" />
                </Form.Item>
              </Form>
            </Modal>
            <Modal
              title="导入数据"
              open={importOpen}
              onOk={() => void handleImport()}
              onCancel={() => setImportOpen(false)}
              confirmLoading={importing}
              okText="导入"
              cancelText="取消"
            >
              <Typography.Paragraph type="secondary">
                粘贴「导出数据」生成的 JSON 内容（需包含 applications 数组，每项 job_title / company 必填非空）。
                每项可选字段可一并回填（如 applied_at 投递时间、status、city、salary、note、url），用于历史数据修正。
                格式非法的记录会自动跳过不入库，导入将按 id 覆盖或新增合法记录。
              </Typography.Paragraph>
              <Input.TextArea
                rows={10}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="粘贴 BossJobAI 导出的 JSON 内容…"
                maxLength={IMPORT_MAX_CHARS}
              />
            </Modal>
          </>
        )}
      </Space>
    </DataPageCard>
  );
}

/** /tracker 求职看板页：统计卡片 + 近 30 天投递趋势。 */
export function TrackerPage() {
  const navigate = useNavigate();
  // 后端底座（baseUrl 解析 + IPC 就绪/失败订阅 + 聚焦自愈 + 卸载清理）统一由 useBackendBase 处理；
  // refreshToken 自增即触发下方 fetch effect 重拉。
  const { base: baseUrl, refreshToken: backendReady, reload: reconnect } = useBackendBase();

  const stats = useApplicationsStore((s) => s.stats);
  const statsError = useApplicationsStore((s) => s.statsError);
  const statsLoading = useApplicationsStore((s) => s.statsLoading);
  const fetchStats = useApplicationsStore((s) => s.fetchStats);

  useEffect(() => {
    if (baseUrl) void fetchStats(baseUrl);
  }, [baseUrl, backendReady, fetchStats]);

  // maxCount 用 Math.max(0, …) 而非 Math.max(1, …)：近 30 天全零趋势时 maxCount=0，
  // 下方「峰值」标签与满刻度参考线据此隐藏，避免渲染出误导性的「峰值 1」。
  const maxCount = useMemo(
    () => Math.max(0, ...(stats?.daily_trend ?? []).map((d) => d.count)),
    [stats],
  );

  return (
    <DataPageCard title="求职看板" onBack={() => navigate('/')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {baseUrl === '' ? (
          <>
            <Alert type="error" showIcon message="无法连接后端，请通过 Electron 启动应用。可返回工作台点「重新连接」，或直接点下方「重新连接」重试。" />
            <Space>
              <Button onClick={reconnect}>重新连接</Button>
            </Space>
          </>
        ) : ((baseUrl === null || statsLoading) && !stats) || (stats === null && !statsError) ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : statsError && !stats ? (
          <>
            <Alert type="error" showIcon message={statsError} />
            <Space size="large" wrap>
              <Button
                onClick={() => {
                  if (baseUrl) void fetchStats(baseUrl);
                }}
              >
                重试
              </Button>
            </Space>
          </>
        ) : stats ? (
          <>
            {statsError ? (
              <Alert type="warning" showIcon message={statsError} style={{ marginBottom: 8 }} />
            ) : null}
            <Space size="large" wrap>
              <Button
                onClick={() => {
                  if (baseUrl) void fetchStats(baseUrl);
                }}
              >
                刷新
              </Button>
              {/* 统计卡片可点击下钻到 /jobs 记录页并按状态预筛选（JobsPage 从 URL ?status= 预筛）。
                  「进行中」聚合 pending/replied/interview，但后端 status 筛选为单选，取待反馈(pending)为代表态，
                  完整聚合可在记录页状态筛选处二次选择。 */}
              <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => navigate('/jobs')}>
                <Statistic title="累计投递" value={stats.total} />
              </Button>
              <Button
                type="link"
                style={{ padding: 0, height: 'auto' }}
                title="卡片统计含待反馈/已回复/面试中；点击仅跳转「待反馈」明细，已回复/面试中请在记录页状态筛选处选择"
                onClick={() => navigate('/jobs?status=pending')}
              >
                <Statistic title="进行中" value={stats.applying} />
              </Button>
              <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => navigate('/jobs?status=offer')}>
                <Statistic title="Offer 数" value={stats.offer_count} valueStyle={{ color: '#52c41a' }} />
              </Button>
              <Button
                type="link"
                style={{ padding: 0, height: 'auto' }}
                title="卡片统计含被拒/已关闭；点击仅跳转「被拒」明细，已关闭请在记录页状态筛选处选择"
                onClick={() => navigate('/jobs?status=rejected')}
              >
                <Statistic title="被拒" value={stats.rejected} valueStyle={{ color: '#ff4d4f' }} />
              </Button>
              <Button
                type="link"
                style={{ padding: 0, height: 'auto' }}
                title="通过率 = Offer / 累计投递；点击跳转「Offer」明细"
                onClick={() => navigate('/jobs?status=offer')}
              >
                <Statistic title="通过率" value={stats.pass_rate * 100} precision={1} suffix="%" />
              </Button>
            </Space>
            <Card size="small" title="近 30 天投递趋势">
              <div style={{ position: 'relative' }}>
                {/* 最大值/满刻度参考线：顶到柱子的满高位置，帮助估读相对比例。
                    全零趋势（maxCount=0）时不渲染，避免 0 次投递却显示满刻度虚线 +「峰值 0」标签。 */}
                {maxCount > 0 ? (
                  <>
                    <div
                      style={{
                        position: 'absolute',
                        top: 16,
                        left: 0,
                        right: 0,
                        borderTop: '1px dashed rgba(0,0,0,0.18)',
                      }}
                    />
                    <span
                      style={{
                        position: 'absolute',
                        top: 16,
                        left: 0,
                        transform: 'translateY(-50%)',
                        fontSize: 10,
                        lineHeight: 1,
                        color: 'rgba(0,0,0,0.45)',
                        background: 'rgba(255,255,255,0.9)',
                        padding: '0 4px',
                        borderRadius: 2,
                      }}
                    >
                      峰值 {maxCount}
                    </span>
                  </>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 106 }}>
                  {stats.daily_trend.map((d, i) => {
                    // 趋势数组固定 30 天、按日期升序排列，最后一项即今日（后端 data.py 保证）
                    const isToday = i === stats.daily_trend.length - 1;
                    const barH = d.count === 0 ? 2 : Math.max(4, Math.round((d.count / maxCount) * 90));
                    return (
                      <div
                        key={d.date}
                        title={`${d.date} · 投递 ${d.count} 次${isToday ? '（今日）' : ''}（点击下钻查看该日投递记录）`}
                        onClick={() => navigate(`/jobs?date=${d.date}`)}
                        style={{
                          flex: 1,
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'flex-end',
                          alignItems: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        {d.count > 0 ? (
                          <span
                            style={{
                              fontSize: 9,
                              lineHeight: '14px',
                              color: isToday ? '#d4380d' : '#1677ff',
                              fontWeight: isToday ? 600 : 400,
                            }}
                          >
                            {d.count}
                          </span>
                        ) : null}
                        <div
                          style={{
                            width: '100%',
                            height: barH,
                            borderRadius: 2,
                            background: d.count === 0 ? '#f0f0f0' : isToday ? '#fa8c16' : '#1677ff',
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                {/* 稀疏 x 轴日期刻度：每 5 天一个 + 末尾今日，避免 30 个标签挤在一起 */}
                <div style={{ display: 'flex', marginTop: 4 }}>
                  {stats.daily_trend.map((d, i) => {
                    const isToday = i === stats.daily_trend.length - 1;
                    const show = i % 5 === 0 || isToday;
                    return (
                      <div
                        key={d.date}
                        style={{
                          flex: 1,
                          textAlign: 'center',
                          fontSize: 10,
                          lineHeight: '16px',
                          color: isToday ? '#d4380d' : 'rgba(0,0,0,0.45)',
                          fontWeight: isToday ? 600 : 400,
                        }}
                      >
                        {show ? (isToday ? `今日 ${d.date.slice(5)}` : d.date.slice(5)) : ''}
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          </>
        ) : (
          <Alert type="info" showIcon message="暂无统计数据" />
        )}
      </Space>
    </DataPageCard>
  );
}
