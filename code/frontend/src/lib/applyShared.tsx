import { useEffect, useMemo, useState } from 'react';
import { Badge, Form, Modal, Space, Typography, message } from 'antd';
import type { FormInstance } from 'antd';

/** 外部链接默认放行后缀（与 electron/main.js DEFAULT_EXTERNAL_HOST_SUFFIXES 对齐）。 */
export const DEFAULT_EXTERNAL_HOST_SUFFIXES = ['zhipin.com'];

/** 解析 url 的 host（小写）；非 http/https 或非法 URL 返回 null。 */
export function parseUrlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 宿主是否命中白名单后缀：精确匹配或子域名匹配（同 electron main.js isExternalHostAllowed）。 */
export function isHostAllowed(host: string, allowlist: string[]): boolean {
  const h = String(host).toLowerCase().replace(/\.+$/, '');
  return allowlist.some((suffix) => {
    const s = String(suffix).toLowerCase().replace(/^\./, '').replace(/\.+$/, '');
    return h === s || h.endsWith('.' + s);
  });
}

/**
 * 外部链接宿主白名单（默认 *.zhipin.com + 设置页 security.external_url_hosts 扩展配置，
 * 与 electron main.js 口径一致）。
 * 在 baseUrl 变化 / 全局事件 `boss-allowlist-updated`（设置页保存成功后触发）时重拉，
 * 保证内联警告与主进程 open-external 白名单同步，避免设置页新增域名后警告仍显示旧值。
 */
export function useExternalHosts(baseUrl: string | null): string[] {
  const [externalHosts, setExternalHosts] = useState<string[]>(DEFAULT_EXTERNAL_HOST_SUFFIXES);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!baseUrl) return;
      try {
        const r = await fetch(`${baseUrl}/api/settings`);
        if (!r.ok) return;
        const d = (await r.json()) as { security?: { external_url_hosts?: unknown } } | null;
        const list = d?.security?.external_url_hosts;
        if (!Array.isArray(list) || cancelled) return;
        // 与 electron/main.js loadUserExternalHostAllowlist 同口径校验：拒绝含协议/端口/路径、去首尾点后无点号的裸单标签，
        // 否则前端提示「放行」而主进程实际拒绝，双端口径漂移。
        const isValidHost = (x: string): boolean => {
          const h = x.trim();
          if (h.length === 0) return false;
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h) || /[\/:]/.test(h)) return false;
          return h.replace(/^\.+/, '').replace(/\.+$/, '').split('.').length >= 2;
        };
        setExternalHosts([
          ...DEFAULT_EXTERNAL_HOST_SUFFIXES,
          ...list.filter((x): x is string => typeof x === 'string' && isValidHost(x)).map((x) => x.trim()),
        ]);
      } catch {
        /* 拉取失败时保持现有白名单 */
      }
    };
    void refresh();
    const onAllowlistUpdated = () => void refresh();
    window.addEventListener('boss-allowlist-updated', onAllowlistUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('boss-allowlist-updated', onAllowlistUpdated);
    };
  }, [baseUrl]);
  return externalHosts;
}

/**
 * 链接输入即校验宿主是否在白名单内（默认 *.zhipin.com + 设置页 security.external_url_hosts 扩展配置，
 * 与 electron main.js 口径一致），给出警告而非打开时才失败。
 * 返回 null=放行；否则为警告文案（非法协议 / 白名单外宿主）。JobsPage/ApplyPage 表单共用，消除两页行为不一致。
 */
export function useUrlHostWarning(form: FormInstance, baseUrl: string): string | null {
  const externalHosts = useExternalHosts(baseUrl);

  const urlValue = Form.useWatch('url', form);
  const urlHostWarning = useMemo(() => {
    if (!urlValue) return null;
    const host = parseUrlHost(urlValue);
    if (host === null) return '仅支持 http/https 链接';
    if (!isHostAllowed(host, externalHosts)) {
      return `宿主 ${host} 不在外部链接白名单，点击「打开」会被拒绝；可在设置页「外部链接白名单」中添加。`;
    }
    return null;
  }, [urlValue, externalHosts]);
  return urlHostWarning;
}

/** openLogsModal 的最小参数结构（ApplicationItem 兼容子集，避免与 pages 层循环依赖）。 */
export interface LoggableRecord {
  id: number;
  job_title: string;
  company: string;
}

/** 日志弹窗实例引用：重复打开时先销毁上一个，避免弹窗堆叠（Modal.info 无 key 类型声明，故用实例控制）。 */
let logsModalInstance: { destroy: () => void } | null = null;

/** GET /api/applications/{id}/logs → 弹窗时间线展示投递操作日志（登记 / 状态变更 / 字段更新）。 */
export async function openLogsModal(baseUrl: string, record: LoggableRecord): Promise<void> {
  if (!baseUrl) return;
  try {
    const res = await fetch(`${baseUrl}/api/applications/${record.id}/logs`);
    if (!res.ok) {
      message.error(`日志接口返回 HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as {
      items: Array<{ id: number; action: string; detail: string; created_at: string }>;
    };
    const items = data.items ?? [];
    if (items.length === 0) {
      message.info('暂无操作日志');
      return;
    }
    if (logsModalInstance) logsModalInstance.destroy();
    logsModalInstance = Modal.info({
      title: `操作日志：${record.company} · ${record.job_title}`,
      width: 560,
      content: (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {items.map((log) => (
            <div key={log.id} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Space>
                <Typography.Text type="secondary">
                  {log.created_at.replace('T', ' ').slice(0, 19)}
                </Typography.Text>
                <Badge color="#1677ff" text={log.action} />
              </Space>
              <div style={{ color: 'rgba(0,0,0,0.88)', whiteSpace: 'pre-wrap' }}>{log.detail}</div>
            </div>
          ))}
        </div>
      ),
      okText: '关闭',
    });
  } catch (err) {
    message.error(`日志加载失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
