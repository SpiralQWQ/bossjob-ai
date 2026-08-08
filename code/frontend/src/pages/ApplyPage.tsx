import { useEffect, useLayoutEffect, useState } from 'react';
import type { Key } from 'react';
import { Alert, Badge, Button, Card, DatePicker, Empty, Form, Input, message, Modal, Popconfirm, Select, Skeleton, Space, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import dayjs from 'dayjs';
import { useLocation, useNavigate } from 'react-router-dom';
import { getBaseUrl } from '../lib/baseUrl';
import { openLogsModal, useUrlHostWarning } from '../lib/applyShared';
import { createApplication } from '../lib/useBackendBase';
import { copyLink, renderApplicationDetail, useApplicationsStore, DataTools, type ApplicationInput, type ApplicationItem } from './DataViews';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../constants';
import { STATUS_TEXT, STATUS_COLOR } from '../lib/applyStatus';

const { Title } = Typography;

// 投递状态映射集中在 lib/applyStatus.ts（与 DataViews/InterviewPage 共用单一事实来源）

/** POST /api/applications 登记一条投递记录（默认进入待投递队列）。返回 null=成功，否则返回错误信息。 */
/**
 * 本地简历存储 key（与 ResumePage.tsx 保持一致）：简历仅存本机浏览器 localStorage。
 * 数据孤岛修复：登记投递表单打开时读取该 key 自动回填期望城市/薪资，让简历数据被投递登记真正消费。
 */
const RESUME_STORAGE_KEY = 'bossjobai.resume';

/** 简历快照字段（与 ResumePage.tsx 的 ResumeData 字段名一致，兼容 localStorage 直读）。 */
interface ResumeSnapshot {
  name: string;
  phone: string;
  email: string;
  city: string;
  salary: string;
  education: string;
  skills: string;
  summary: string;
}

/** 读取简历页本地保存的整份简历；localStorage 缺失或损坏时返回 null（不回填）。 */
function loadResumeFull(): Partial<ResumeSnapshot> | null {
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<ResumeSnapshot>;
  } catch {
    return null;
  }
}

/** 将整份简历渲染为备注快照文本（仅 openApplyModal「用此简历登记投递」显式流程写入 note）：
 *  缺失字段按空串处理并整体跳过，不再渲染 '—' 占位符，避免无意义文本污染备注。 */
function buildResumeSnapshot(r: Partial<ResumeSnapshot>): string {
  const pick = (v?: string) => (v && v.trim() ? v.trim() : '');
  const personal: Array<[string, string]> = [
    ['姓名', pick(r.name)],
    ['手机', pick(r.phone)],
    ['邮箱', pick(r.email)],
    ['学历', pick(r.education)],
  ];
  const head = personal
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}：${v}`)
    .join(' / ');
  const lines = [`【简历快照】${head || '未填基本信息'}`];
  const skills = pick(r.skills);
  const summary = pick(r.summary);
  if (skills) lines.push(`技能：${skills}`);
  if (summary) lines.push(`简介：${summary}`);
  return lines.join('\n');
}

/** /apply 投递页（最小可交付）：待投递队列列表 + 手动登记投递表单。 */
export default function ApplyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  // 分页每页条数（可切换 10/20/50）：对齐 DataViews「投递记录（全部）」页，默认取 constants.ts 的 DEFAULT_PAGE_SIZE。
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // 已提交的搜索词：useLayoutEffect 重拉的唯一 keyword 来源，仅在 Enter/搜索按钮/清空时更新。
  const [keyword, setKeyword] = useState('');
  // 搜索框本地输入草稿：受控 Input 的 value 绑定此值，onChange 只更新草稿，
  // 避免每次击键都改 keyword → 触发 fetchList 全量重拉（表格反复闪空 + 高频打后端）。与 DataViews 的 draft + onSearch 模式一致。
  const [keywordDraft, setKeywordDraft] = useState('');
  // 批量操作选中的行 id 集合（对齐 JobsPage 的 rowSelection + 批量改状态/批量删除工作流）。
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  // 最近一次行内改状态记录（供「撤销」使用）：行内 Select 把记录改成非 pending 会将其移出待投递队列，
  // 误操作后用户可一键改回「待反馈」恢复队列位置（交互死胡同修复：明确告知 + 可撤销）。
  const [lastStatusChange, setLastStatusChange] = useState<{ id: number; jobTitle: string; next: string } | null>(null);
  // 后端就绪信号计数器：主进程推送 backend-ready 时自增，驱动下方 fetch effect 重新拉取待投递队列
  // （对齐 JobsPage/TrackerPage 的 onBackendReady 自愈机制，避免 ready 后列表停留在陈旧/空状态）。
  const [backendReady, setBackendReady] = useState(0);
  // 链接宿主白名单内联警告（与 JobsPage/DataViews 共享同一套校验，消除两页行为不一致）。
  const urlHostWarning = useUrlHostWarning(form, baseUrl ?? '');

  /**
   * 打开「新建登记」弹窗：清空表单并回填简历的非 PII 字段（期望城市/薪资）。
   * 仅在 backfillResume=true（来自简历页「用此简历登记投递」的显式流程）且 note 为空时，
   * 才把整份简历快照写入备注——普通「登记投递」不再无条件覆盖 note：
   * 既避免用户自定义备注被整份快照顶掉，也避免姓名/手机/邮箱等 PII 被持久化进每一条投递记录并随导出/备份扩散。
   */
  const openCreateModal = (backfillResume = false) => {
    form.resetFields();
    setEditingId(null);
    // 数据孤岛修复：打开登记表单时读取简历页本地整份简历——自动回填期望城市/薪资（非 PII），用户无需重复填写。
    const resume = loadResumeFull();
    if (resume) {
      form.setFieldsValue({ city: resume.city ?? '', salary: resume.salary ?? '' });
      if (backfillResume && !form.getFieldValue('note')) {
        form.setFieldsValue({ note: buildResumeSnapshot(resume) });
      }
    }
    setModalOpen(true);
  };

  // 跨页主流程减一步：从简历页「用此简历登记投递」跳转（location.state.openApplyModal）后，
  // 自动打开登记表单并沿用简历回填逻辑，用户无需再点一次「登记投递」。
  useEffect(() => {
    if ((location.state as { openApplyModal?: boolean } | null)?.openApplyModal) {
      // 「用此简历登记投递」显式流程：登记时把简历快照写入备注，让投递记录携带所用简历（用户显式意图，PII 仅在此流程持久化）。
      openCreateModal(true);
      // 消费掉该标记：置空 location.state，避免浏览器前进/后退回到该历史条目时登记弹窗再次意外弹出。
      navigate(location.pathname, { replace: true, state: undefined });
    }
    // 依赖 location.key：仅路由切换（新跳转/前进/后退）时触发，避免同页重复打开
    // 依赖 navigate（useNavigate 返回的稳定引用）：用于 replace 清空已消费的 openApplyModal 标记
  }, [location.key, navigate]);

  const items = useApplicationsStore((s) => s.items);
  const total = useApplicationsStore((s) => s.total);
  const loading = useApplicationsStore((s) => s.loading);
  const error = useApplicationsStore((s) => s.listError);
  const fetchList = useApplicationsStore((s) => s.fetchList);

  // 后端就绪/失败订阅 + 窗口聚焦自愈：后端重启后自动重解析 baseUrl 并重拉待投递队列
  // （对齐 JobsPage/TrackerPage 的 onBackendReady/onBackendError 机制）。
  useEffect(() => {
    const unsubReady = window.api?.onBackendReady?.(() => {
      // 后端就绪：禁止再把 base 置空（置空会杀死 fetch effect，留下空/陈旧列表且无法自愈），
      // 改为自增计数器驱动重拉 + 重新解析 baseUrl 以从 '' error 态恢复（对齐 JobsPage/TrackerPage）。
      setBackendReady((n) => n + 1);
      void getBaseUrl()
        .then((url) => setBaseUrl(url))
        .catch(() => setBaseUrl(''));
    });
    const unsubError = window.api?.onBackendError?.(() => setBaseUrl(''));
    const handleFocus = () => {
      void getBaseUrl()
        .then((url) => setBaseUrl(url))
        .catch(() => setBaseUrl(''));
      setBackendReady((n) => n + 1);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      unsubReady?.();
      unsubError?.();
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // 分页/每页条数/搜索词变化时清空已选行（对齐 JobsPage/DataViews）：fetchList 刷新后 rows 跨页/跨筛选移动，
  // 保留旧 key 会让「已选 N 条」/批量操作指向上一页的不可见记录，造成误批量。
  useEffect(() => {
    setSelectedRowKeys([]);
  }, [page, pageSize, keyword]);

  useEffect(() => {
    let cancelled = false;
    getBaseUrl()
      .then((url) => {
        if (!cancelled) setBaseUrl(url);
      })
      .catch(() => {
        if (!cancelled) setBaseUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 首帧防闪烁：useLayoutEffect 在绘制前同步执行，fetchList 内部的 set({ items: [], loading: true })
  // 先于表格渲染生效，避免 /apply 共享 store 时首个可见帧渲染 /jobs 残留的非 pending 查询结果。
  useLayoutEffect(() => {
    if (baseUrl) void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword });
  }, [baseUrl, page, pageSize, keyword, fetchList, backendReady]);

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
      if (editingId !== null) {
        try {
          const res = await fetch(`${baseUrl}/api/applications/${editingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => null)) as { detail?: string } | null;
            message.error(`更新失败：${data?.detail ?? `HTTP ${res.status}`}`);
            return;
          }
          message.success('投递记录已更新');
        } catch (err) {
          message.error(`更新失败：${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      } else {
        const err = await createApplication(baseUrl, values);
        if (err) {
          message.error(err);
          return;
        }
        // 登记时可选任意状态：按所选 status 分支提示，避免选了非 pending 却提示「已登记到待投递队列」，
        // 与列表实际去向（非 pending 记录会进全部投递记录页而非本待投递队列）保持一致。
        const savedStatus = values.status ?? 'pending';
        message.success(
          savedStatus !== 'pending'
            ? `已登记为「${STATUS_TEXT[savedStatus] ?? savedStatus}」`
            : '已登记到待投递队列',
        );
      }
      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
      // 编辑把记录状态改离「待投递」筛选时，若该记录是当前页最后一条，回退一页避免停在越界空页（与 handleStatusChange 同款 clamp）。
      const savedStatus = values.status ?? 'pending';
      const nextPage = editingId !== null && savedStatus !== 'pending' && items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'pending', page: nextPage, pageSize, keyword });
      }
    } finally {
      setSaving(false);
    }
  };

  const openExternal = async (url: string) => {
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
  };

  const openEditModal = (record: ApplicationItem) => {
    setEditingId(record.id);
    form.setFieldsValue({
      job_title: record.job_title,
      company: record.company,
      city: record.city,
      salary: record.salary,
      url: record.url,
      note: record.note,
      status: record.status,
      applied_at: record.applied_at ? dayjs(record.applied_at) : undefined,
    });
    setModalOpen(true);
  };

  const handleStatusChange = async (record: ApplicationItem, next: string) => {
    if (!baseUrl) return;
    // 目标状态与当前一致时直接返回：避免重复 PATCH + 无意义刷新（Select 可能对相同值回调）。
    if (next === record.status) return;
    try {
      const res = await fetch(`${baseUrl}/api/applications/${record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        message.error(`更新失败：${data?.detail ?? `HTTP ${res.status}`}`);
        return;
      }
      const nextText = STATUS_TEXT[next] ?? next;
      if (next === 'pending') {
        message.success(`已将「${record.job_title}」标记为「待反馈」`);
      } else {
        // 交互死胡同修复：本页恒为待投递队列，改成非 pending 会立即移出队列——
        // 明确把目标状态名写进 toast，并记录最近改动以提供一键撤销，避免误选「Offer/被拒」后不知哪条被改走。
        setLastStatusChange({ id: record.id, jobTitle: record.job_title, next });
        message.success(`已将「${record.job_title}」标记为「${nextText}」，已移出待投递队列`);
      }
      // 当前页只剩这一条且非第一页时，改状态会使本页清空，回退一页避免空页。
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'pending', page: nextPage, pageSize, keyword });
      }
    } catch (err) {
      message.error(`更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 撤销最近一次行内改状态：把误改出的记录 PATCH 回「待反馈」，恢复其在待投递队列中的位置。 */
  const handleUndoStatusChange = async () => {
    if (!baseUrl || !lastStatusChange) return;
    const { id, jobTitle } = lastStatusChange;
    try {
      const res = await fetch(`${baseUrl}/api/applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        message.error(`撤销失败：${data?.detail ?? `HTTP ${res.status}`}`);
        return;
      }
      setLastStatusChange(null);
      message.success(`已撤销：「${jobTitle}」恢复为「待反馈」`);
      void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword });
    } catch (err) {
      message.error(`撤销失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDelete = async (record: ApplicationItem) => {
    if (!baseUrl) return;
    try {
      const res = await fetch(`${baseUrl}/api/applications/${record.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        message.error(`删除失败：${data?.detail ?? `HTTP ${res.status}`}`);
        return;
      }
      message.success(`已删除：${record.job_title}`);
      // 从选中集移除已删除记录，避免工具条「已选 N 条」及后续批量操作包含已删 id（对齐 JobsPage）
      setSelectedRowKeys((keys) => keys.filter((k) => Number(k) !== record.id));
      // 删除当前页最后一条且非第一页时，本页会清空，回退一页避免空页。
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'pending', page: nextPage, pageSize, keyword });
      }
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 批量改状态：逐 id 串行调用 PATCH（沿用单条 handleStatusChange 语义），全部完成后清空选中并刷新。
   *  本页恒为 pending 筛选：批量把记录改出待反馈后 total 减少，按新 total 计算最大页并回退，避免停留在越界空页。 */
  const handleBatchStatusChange = async (next: string) => {
    if (!baseUrl || selectedRowKeys.length === 0) return;
    let ok = 0;
    let fail = 0;
    for (const key of selectedRowKeys) {
      let err: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/api/applications/${Number(key)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { detail?: string } | null;
          err = data?.detail ?? `HTTP ${res.status}`;
        }
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      if (err) fail += 1;
      else ok += 1;
    }
    if (fail > 0) {
      message.error(`批量改状态完成：成功 ${ok} 条，失败 ${fail} 条`);
    } else {
      message.success(`已批量更新 ${ok} 条记录状态为「${STATUS_TEXT[next] ?? next}」`);
    }
    setSelectedRowKeys([]);
    const removed = next !== 'pending' ? ok : 0;
    const newTotal = Math.max(0, total - removed);
    const maxPage = Math.max(1, Math.ceil(newTotal / pageSize));
    if (removed > 0 && page > maxPage) {
      setPage(maxPage);
    } else {
      void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword });
    }
  };

  /** 批量删除：逐 id 串行调用 DELETE（沿用单条 handleDelete 语义），全部完成后清空选中；删除后 total 减少，回退分页到新的最大页。 */
  const handleBatchDelete = async () => {
    if (!baseUrl || selectedRowKeys.length === 0) return;
    let ok = 0;
    let fail = 0;
    for (const key of selectedRowKeys) {
      let err: string | null = null;
      try {
        const res = await fetch(`${baseUrl}/api/applications/${Number(key)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { detail?: string } | null;
          err = data?.detail ?? `HTTP ${res.status}`;
        }
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      if (err) fail += 1;
      else ok += 1;
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
      void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword });
    }
  };

  const columns: TableProps<ApplicationItem>['columns'] = [
    { title: '职位', dataIndex: 'job_title', ellipsis: true },
    { title: '公司', dataIndex: 'company', ellipsis: true },
    { title: '城市', dataIndex: 'city', width: 90, render: (v: string) => v || '—' },
    { title: '薪资', dataIndex: 'salary', width: 110, render: (v: string) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Badge color={STATUS_COLOR[v] ?? '#d9d9d9'} text={STATUS_TEXT[v] ?? v} />,
    },
    {
      title: '链接',
      dataIndex: 'url',
      ellipsis: true,
      render: (v: string) =>
        v ? (
          <Typography.Link title={v} onClick={() => void openExternal(v)}>
            {v}
          </Typography.Link>
        ) : (
          '—'
        ),
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
            options={Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }))}
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
  ];

  return (
    <Card
      style={{ maxWidth: 960, margin: '24px auto' }}
      title={<Title level={4} style={{ margin: 0 }}>投递管理</Title>}
      extra={<Button onClick={() => navigate('/')}>返回工作台</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="投递自动执行尚未上线"
          description="此处「登记投递」仅将职位加入待投递队列（状态为「待反馈」），不会自动投递。本页仅展示待投递队列；全部投递记录请前往「投递记录（全部）」页查看。请在操作列打开职位链接完成人工投递后，将状态改为「已回复」即可推进队列。"
          style={{ marginBottom: 8 }}
        />
        {/* 数据管理工具条恒常渲染：备份/恢复/导出仅依赖主进程文件快照（window.api），不依赖投递列表 API，
            后端未连接 / 列表拉取失败的错误态下仍可用——用户停在待投递页也能就近备份/恢复数据，无需切到「投递记录（全部）」页 */}
        <DataTools />
        {baseUrl === '' ? (
          <>
            <Alert type="error" showIcon message="无法连接后端，请通过 Electron 启动应用。可返回工作台点「重新连接」，或直接点下方「重新连接」重试。" />
            <Space>
              <Button
                onClick={() => {
                  void getBaseUrl()
                    .then((url) => setBaseUrl(url))
                    .catch(() => setBaseUrl(''));
                  setBackendReady((n) => n + 1);
                }}
              >
                重新连接
              </Button>
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
                  if (baseUrl) void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword });
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
              <Button type="primary" onClick={() => openCreateModal()}>
                登记投递
              </Button>
              <Button onClick={() => navigate('/jobs')}>查看全部投递记录</Button>
              <Button onClick={() => baseUrl && void fetchList(baseUrl, { status: 'pending', page, pageSize, keyword })}>刷新</Button>
              {lastStatusChange ? (
                <Button
                  danger
                  onClick={() => void handleUndoStatusChange()}
                  title={`将「${lastStatusChange.jobTitle}」恢复为待反馈，重新进入待投递队列`}
                >
                  撤销：「{lastStatusChange.jobTitle}」
                </Button>
              ) : null}
            </Space>
            {selectedRowKeys.length > 0 ? (
              <Space wrap style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary">已选 {selectedRowKeys.length} 条</Typography.Text>
                <Select
                  style={{ width: 140 }}
                  placeholder="批量改状态"
                  options={Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }))}
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
              rowSelection={{
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
              }}
              loading={loading}
              dataSource={items}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="待投递队列为空，登记第一条投递开始吧"
                  >
                    <Button type="primary" onClick={() => openCreateModal()}>
                      登记投递
                    </Button>
                  </Empty>
                ),
              }}
              expandable={{ expandedRowRender: renderApplicationDetail }}
              pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                pageSizeOptions: PAGE_SIZE_OPTIONS,
                showTotal: (t) => `共 ${t} 条待投递`,
                onChange: (p, ps) => {
                  setPageSize(ps);
                  setPage(Math.min(p, Math.max(1, Math.ceil(total / ps))));
                },
              }}
              columns={columns}
            />
            <Modal
              title={editingId ? '编辑投递记录' : '手动登记投递'}
              open={modalOpen}
              onOk={() => void handleSave()}
              onCancel={() => setModalOpen(false)}
              confirmLoading={saving}
              okText={editingId ? '保存' : '登记'}
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
                  name="status"
                  label="状态"
                  initialValue="pending"
                  tooltip="登记时可直接指定投递状态（如已投递/面试中/Offer），与 JobsPage 编辑行为一致；留空默认「待反馈」"
                >
                  <Select
                    options={Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }))}
                  />
                </Form.Item>
                <Form.Item
                  name="url"
                  label="链接"
                  extra={urlHostWarning ? <Typography.Text type="warning">{urlHostWarning}</Typography.Text> : 'http/https 职位链接（可选）'}
                >
                  <Input placeholder="http/https 职位链接（可选）" />
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
          </>
        )}
      </Space>
    </Card>
  );
}
