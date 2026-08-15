/** 数据管理工具条（从 pages/DataViews.tsx 抽离：瘦身解耦）。
 *  仅依赖 Electron preload 的 window.api 主进程文件快照能力，不依赖投递列表 API，
 *  因此在列表加载失败 / 后端未连接的错误态下也必须保持可用（此时用户最需要恢复/备份数据）。 */
import type { ReactNode } from 'react';
import { Badge, Button, Card, Modal, Space, Table, Typography, message } from 'antd';
import { confirmRestore } from '../lib/applicationShared';

const { Title } = Typography;

/** 数据页公共外层卡片。 */
export function DataPageCard(props: { title: string; onBack: () => void; children: ReactNode }) {
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
            // 在线导出（依赖 GET /api/export）失败（后端崩溃/端口冲突）→ 自动降级离线导出最新自动备份 app.db
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
        title="复用 /api/export 载荷中的 apply_logs 数组（previewExportData 已能取到），跨记录聚合浏览全部投递操作日志，按时间倒序渲染全局时间线"
        onClick={async () => {
          if (!window.api?.previewExportData || !window.api?.previewBackupExport) {
            message.error('Electron preload 桥接（window.api.previewExportData / previewBackupExport）不可用，请通过 Electron 启动应用。');
            return;
          }
          try {
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
            const appById = new Map<number, Record<string, unknown>>();
            for (const a of apps) {
              if (a && typeof a === 'object') {
                const rec = a as Record<string, unknown>;
                if (typeof rec.id === 'number') appById.set(rec.id, rec);
              }
            }
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
                      { title: '动作', dataIndex: 'action', width: 96, render: (v: string) => <Badge color="blue" text={v} /> },
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
              return;
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
              return;
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
              return;
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
