/** 投递记录共享工具（从 pages/DataViews.tsx 抽离：瘦身解耦，跨页复用单一来源）。 */
import { Checkbox, Descriptions, Modal, message } from 'antd';
import type { ApplicationInput, ApplicationItem } from '../types/application';
import { apiCall } from './useBackendBase';
import { STATUS_TEXT } from './applyStatus';

/** 导入 JSON 文本域的最大字符数（防超大粘贴拖垮浏览器）。 */
export const IMPORT_MAX_CHARS = 2_000_000;

/** 把字节数格式化为人类可读大小（如 1.2 MB）；非有限数字返回空串。 */
export function formatBytes(bytes?: number): string {
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

/** 恢复确认弹窗：内置「仅恢复投递记录，保留当前设置/LLM 配置与简历」勾选项（默认关）。 */
export function confirmRestore(opts: {
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

/** 展开行详情（JobsPage / ApplyPage 共用）：以 Descriptions 展示记录完整内容。 */
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

/** 复制职位链接到剪贴板并按结果提示。 */
export async function copyLink(url: string) {
  const ok = await copyToClipboard(url);
  if (ok) {
    message.success('职位链接已复制');
  } else {
    message.error('复制失败，请手动选择链接复制');
  }
}

/** PATCH /api/applications/{id} 更新投递记录（走共享 apiCall）。返回 null=成功，否则返回错误信息。 */
export async function updateApplication(
  baseUrl: string,
  id: number,
  patch: Partial<ApplicationInput>,
): Promise<string | null> {
  const err = await apiCall(baseUrl, 'PATCH', `/api/applications/${id}`, patch);
  return err === null ? null : `更新失败：${err}`;
}

/** DELETE /api/applications/{id} 删除投递记录（走共享 apiCall）。返回 null=成功，否则返回错误信息。 */
export async function deleteApplication(baseUrl: string, id: number): Promise<string | null> {
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

/** 导入导出 JSON：本地预过滤非法行 + POST /api/import（返回统计）。 */
export async function importApplications(
  baseUrl: string,
  payload: unknown,
): Promise<{ ok: boolean; imported?: number; created?: number; updated?: number; skipped?: number; error?: string }> {
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
