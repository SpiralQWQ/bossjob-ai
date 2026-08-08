import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Key } from 'react';
import { Alert, Badge, Button, Card, DatePicker, Empty, Form, Input, message, Modal, Popconfirm, Select, Skeleton, Space, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { getBaseUrl } from '../lib/baseUrl';
import { openLogsModal, useUrlHostWarning } from '../lib/applyShared';
import { copyLink, renderApplicationDetail, useApplicationsStore, type ApplicationInput, type ApplicationItem } from './DataViews';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../constants';
import { STATUS_TEXT, STATUS_COLOR } from '../lib/applyStatus';

const { Title } = Typography;

// 投递状态映射集中在 lib/applyStatus.ts（与 DataViews/ApplyPage 共用单一事实来源）

/** 面试登记 note 约定段：v0.1 后端无独立面试表（P6 规划 InterviewSession），
 *  面试时间/形式在登记时结构化写入 note 的「【面试登记】」段，便于回显/检索/后续迁移。 */
const INTERVIEW_TAG = '【面试登记】';
const INTERVIEW_FORMS = ['线上', '电话', '视频', '现场'];

/** 从「【面试登记】」note 段解析出结构化面试字段（时间/形式）；无该段返回空字段。 */
function parseInterviewBlock(note?: string): { time: string; form: string } {
  const text = note ?? '';
  const lines = text.split('\n');
  // 定位「【面试登记】」标签行，仅解析其后的结构化「时间：/形式：」行，遇首个非结构化行即停止：
  // 避免普通备注中「时间：/形式：」子串（如「简历形式：PDF」「加班时间：不定」）被误解析。
  const tagIdx = lines.findIndex((l) => l.includes(INTERVIEW_TAG));
  if (tagIdx < 0) return { time: '', form: '' };
  let time = '';
  let form = '';
  for (let li = tagIdx + 1; li < lines.length; li++) {
    const line = lines[li];
    const mTime = line.match(/^\s*时间：(.*)$/);
    const mForm = line.match(/^\s*形式：(.*)$/);
    if (mTime) { time = mTime[1].trim(); continue; }
    if (mForm) { form = mForm[1].trim(); continue; }
    break; // 备注段或其他非结构化行：结构化字段已结束
  }
  return { time, form };
}

/** 从 note 中移除「【面试登记】」段：跳过段内的时间/形式行，保留段内「备注」内容与段外自由文本
 *  （编辑回填结构化字段时避免结构化字段与备注重复）。 */
function stripInterviewBlock(note?: string): string {
  const text = note ?? '';
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes(INTERVIEW_TAG)) {
      i += 1;
      let remarkStarted = false;
      while (i < lines.length) {
        const inner = lines[i];
        if (remarkStarted) {
          // 备注段开始后，后续行全部视为备注内容保留（多行备注的续行不再被剥离，防文本丢失）
          kept.push(inner.trim());
          i += 1;
          continue;
        }
        const mRemark = inner.match(/^\s*备注：(.+)/);
        if (mRemark && mRemark[1].trim()) {
          kept.push(mRemark[1].trim());
          remarkStarted = true;
          i += 1;
          continue;
        }
        if (/^\s*(时间|形式)：/.test(inner)) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    kept.push(line);
    i += 1;
  }
  return kept.join('\n').trim();
}

/** 把登记表单的面试时间/形式/备注序列化为「【面试登记】」note 段。 */
function buildInterviewNote(interviewTime: string, interviewForm: string, remark: string): string {
  // 仅写入非空字段：空值省略对应行，避免「时间：—」「形式：—」占位被解析成粘滞的假面试数据
  const lines = [INTERVIEW_TAG];
  if (interviewTime) lines.push(`时间：${interviewTime}`);
  if (interviewForm) lines.push(`形式：${interviewForm}`);
  if (remark.trim()) lines.push(`备注：${remark.trim()}`);
  return lines.join('\n');
}

/** /interview 面试页（v0.1 最小面试登记）：本页即「面试中」状态筛选视图 +
 *  登记入口——新建记录默认状态为「面试中」，面试时间/形式结构化写入备注（【面试登记】段）。 */
export default function InterviewPage() {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [form] = Form.useForm();
  // 链接宿主白名单内联警告（与 JobsPage/ApplyPage 共享同一套校验，消除跨页行为不一致）。
  const urlHostWarning = useUrlHostWarning(form, baseUrl ?? '');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // 编辑弹窗打开时「面试时间/形式是否分别成功回填」的标记（openEditModal 写入，handleSave 读取）。
  // 时间与形式独立记录：原块时间可能是手写格式（如「下周三」）dayjs 无法解析 → 时间未回填但形式回填，
  // 仅改备注保存时不得把原手写时间清掉；字段曾被回填后显式清空才剥离。合并成一个布尔会误判。
  const wasInterviewTimeBackfilledRef = useRef(false);
  const wasInterviewFormBackfilledRef = useRef(false);
  // 原面试块存在「dayjs 无法解析的手写时间」文本（如「下周三」「尽快」）时，弹窗内提供「移除」入口：
  // DatePicker 无法承载这类文本（回填为空），无此按钮则该手写时间永远无法通过 UI 删除（只能替换）。
  const [hasUnparseableTime, setHasUnparseableTime] = useState(false);
  const [removeHandwrittenTime, setRemoveHandwrittenTime] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [keyword, setKeyword] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');
  // 后端就绪信号计数器：主进程推送 backend-ready 时自增，驱动下方 fetch effect 重新拉取「面试中」列表
  const [backendReady, setBackendReady] = useState(0);
  // 最近一次行内改状态记录（供「撤销」使用）：行内 Select 把记录改成非「面试中」会立即移出本列表，
  // 误操作后用户可一键改回「面试中」恢复列表位置（与 ApplyPage 的撤销机制对齐，消除交互死胡同）。
  const [lastStatusChange, setLastStatusChange] = useState<{ id: number; jobTitle: string; next: string } | null>(null);
  // 批量操作选中的行 id 集合（对齐 JobsPage/ApplyPage 的 rowSelection + 批量改状态/批量删除工作流）。
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  // 分页/每页条数/搜索词变化时清空已选行（对齐 JobsPage/ApplyPage）：fetchList 刷新后 rows 跨页/跨筛选移动，
  // 保留旧 key 会让「已选 N 条」/批量操作指向上一页的不可见记录，造成误批量。
  useEffect(() => {
    setSelectedRowKeys([]);
  }, [page, pageSize, keyword]);

  const items = useApplicationsStore((s) => s.items);
  const total = useApplicationsStore((s) => s.total);
  const loading = useApplicationsStore((s) => s.loading);
  const error = useApplicationsStore((s) => s.listError);
  const fetchList = useApplicationsStore((s) => s.fetchList);

  // 后端就绪/失败订阅 + 窗口聚焦自愈（与 ApplyPage / JobsPage 同一套机制）。
  useEffect(() => {
    const unsubReady = window.api?.onBackendReady?.(() => {
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

  // 首帧防闪烁：useLayoutEffect 在绘制前同步执行，避免新挂载页先渲染兄弟页残留数据
  useLayoutEffect(() => {
    if (baseUrl) void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword });
  }, [baseUrl, page, pageSize, keyword, fetchList, backendReady]);

  /** 打开「登记面试」弹窗：新建记录默认状态为「面试中」。 */
  const openCreateModal = () => {
    form.resetFields();
    setEditingId(null);
    form.setFieldsValue({ status: 'interview' });
    setModalOpen(true);
  };

  /** 打开「编辑」弹窗：普通投递字段编辑；若 note 含「【面试登记】」段则回填结构化面试字段（时间/形式）
   *  并隐藏该段（避免结构化字段与备注重复）。 */
  const openEditModal = (record: ApplicationItem) => {
    setEditingId(record.id);
    const block = parseInterviewBlock(record.note);
    const dt = block.time ? dayjs(block.time) : undefined;
    // 分别记录面试时间/形式是否成功回填到表单：原块时间可能是手写格式（如「下周三」）
    // dayjs 无法解析 → 时间未回填、形式回填。handleSave 据此区分「从未回填（保留原手写时间）」
    // 与「曾被回填、用户显式清空（剥离）」，避免仅改备注保存时把原手写时间静默清掉。
    wasInterviewTimeBackfilledRef.current = Boolean(dt && dt.isValid());
    wasInterviewFormBackfilledRef.current = Boolean(block.form);
    // 手写时间（非空但 dayjs 无法解析）在弹窗内以只读提示 + 「移除」按钮暴露，用户可显式删除
    setHasUnparseableTime(Boolean(block.time && (!dt || !dt.isValid())));
    setRemoveHandwrittenTime(false);
    form.setFieldsValue({
      job_title: record.job_title,
      company: record.company,
      city: record.city,
      salary: record.salary,
      url: record.url,
      note: stripInterviewBlock(record.note),
      status: record.status,
      applied_at: record.applied_at ? dayjs(record.applied_at) : undefined,
      interviewTime: dt && dt.isValid() ? dt : undefined,
      interviewForm: block.form || undefined,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!baseUrl) return;
    interface InterviewFormValues {
      job_title?: string;
      company?: string;
      city?: string;
      salary?: string;
      url?: string;
      status?: string;
      note?: string;
      applied_at?: { format(fmt: string): string };
      interviewTime?: { format(fmt: string): string };
      interviewForm?: string;
    }
    let values: InterviewFormValues;
    try {
      values = (await form.validateFields()) as InterviewFormValues;
    } catch {
      return; // 表单校验未通过，antd 已给出提示
    }
    const appliedAt = values.applied_at ? values.applied_at.format('YYYY-MM-DDTHH:mm:ss') : null;
    // 新建（登记面试）：面试时间/形式结构化写入 note 的「【面试登记】」段；未填面试字段则保持普通备注。
    // 编辑时若记录仍为「面试中」，或原记录已含结构化面试数据（时间/形式），用最新值重建「【面试登记】」段：
    // 状态改离「面试中」也保留该段（与行内 Select 改状态不触碰 note 的语义一致），避免静默丢失面试时间/形式数据。
    // 仅在确有面试输入时重建「【面试登记】」段：编辑时用户显式清空面试字段即删除结构化段（不再粘滞重建占位块），
    // buildInterviewNote 空值省略行，避免「时间：—」占位被误当真实时间。
    const hasInterviewInput = Boolean(values.interviewTime || values.interviewForm);
    const originalNote = editingId !== null ? items.find((i) => i.id === editingId)?.note : undefined;
    const orig = originalNote && originalNote.includes(INTERVIEW_TAG) ? parseInterviewBlock(originalNote) : { time: '', form: '' };
    // 时间/形式各自的回填标记（openEditModal 写入）：区分「从未回填（保留原手写时间/形式）」
    // 与「曾被回填、用户显式清空（剥离）」。合并成一个布尔会把「时间手写无法解析但形式已回填」
    // 误判为整体已回填，仅改备注保存时静默丢失原手写时间。
    const timeBackfilled = wasInterviewTimeBackfilledRef.current;
    const formBackfilled = wasInterviewFormBackfilledRef.current;
    let note: string;
    // 本次有面试输入 → 用最新值重建「【面试登记】」段。
    // 时间：用户设了新时间用新值；用户未设时间但原时间从未回填（手写格式无法解析）→ 保留原手写时间；
    // 原时间曾被回填、用户显式清空 → 空（剥离）。
    const newTimeStr = values.interviewTime
      ? values.interviewTime.format('YYYY-MM-DD HH:mm')
      : (editingId !== null && !timeBackfilled && orig.time && !removeHandwrittenTime ? orig.time : '');
    // 形式：用户选了新形式用新值；未选且原形式从未回填 → 保留原形式；曾被回填后清空 → 空（剥离）。
    const newForm = values.interviewForm ?? (editingId !== null && !formBackfilled ? orig.form : '');
    if (hasInterviewInput || (editingId !== null && originalNote && originalNote.includes(INTERVIEW_TAG) && (newTimeStr || newForm))) {
      // 本次有输入、或原块仍保留有效时间/形式（含从未回填的手写值）→ 重建（合并备注编辑）
      note = buildInterviewNote(newTimeStr, newForm, values.note ?? '');
    } else {
      note = values.note ?? '';
    }
    const payload: ApplicationInput = {
      job_title: values.job_title ?? '',
      company: values.company ?? '',
      city: values.city,
      salary: values.salary,
      url: values.url,
      status: values.status ?? 'interview',
      note,
      applied_at: appliedAt,
    };
    setSaving(true);
    try {
      if (editingId !== null) {
        const res = await fetch(`${baseUrl}/api/applications/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { detail?: string } | null;
          message.error(`更新失败：${data?.detail ?? `HTTP ${res.status}`}`);
          return;
        }
        message.success('投递记录已更新');
      } else {
        const res = await fetch(`${baseUrl}/api/applications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { detail?: string } | null;
          message.error(`登记失败：${data?.detail ?? `HTTP ${res.status}`}`);
          return;
        }
        // 登记时可指定任意状态：按所选 status 分支提示，避免选了非「面试中」却恒提示「已登记为面试中」。
        const savedStatus = values.status ?? 'interview';
        message.success(
          savedStatus !== 'interview'
            ? `已登记为「${STATUS_TEXT[savedStatus] ?? savedStatus}」`
            : '已登记为「面试中」',
        );
      }
      setModalOpen(false);
      setEditingId(null);
      form.resetFields();
      // 编辑把记录状态改离「面试中」筛选时，若该记录是当前页最后一条，回退一页避免停在越界空页（与 handleStatusChange 同款 clamp）。
      const savedStatus = values.status ?? 'interview';
      const nextPage = editingId !== null && savedStatus !== 'interview' && items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'interview', page: nextPage, pageSize, keyword });
      }
    } catch (err) {
      const base = editingId !== null ? '更新失败' : '登记失败';
      message.error(`${base}：${err instanceof Error ? err.message : String(err)}`);
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

  const handleStatusChange = async (record: ApplicationItem, next: string) => {
    if (!baseUrl) return;
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
      if (next === 'interview') {
        message.success(`已将「${record.job_title}」标记为「面试中」`);
      } else {
        // 本页恒为「面试中」筛选：改成非 interview 会立即移出本列表——
        // 记录最近改动以提供一键撤销（与 ApplyPage 一致），避免误选后不知哪条被改走。
        setLastStatusChange({ id: record.id, jobTitle: record.job_title, next });
        message.success(`已将「${record.job_title}」标记为「${nextText}」，已移出面试列表`);
      }
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'interview', page: nextPage, pageSize, keyword });
      }
    } catch (err) {
      message.error(`更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 撤销最近一次行内改状态：把误改出的记录 PATCH 回「面试中」，恢复其在面试列表中的位置。 */
  const handleUndoStatusChange = async () => {
    if (!baseUrl || !lastStatusChange) return;
    const { id, jobTitle } = lastStatusChange;
    try {
      const res = await fetch(`${baseUrl}/api/applications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'interview' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { detail?: string } | null;
        message.error(`撤销失败：${data?.detail ?? `HTTP ${res.status}`}`);
        return;
      }
      setLastStatusChange(null);
      message.success(`已撤销：「${jobTitle}」恢复为「面试中」`);
      void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword });
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
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page;
      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        void fetchList(baseUrl, { status: 'interview', page: nextPage, pageSize, keyword });
      }
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 批量改状态：逐 id 串行调用 PATCH（沿用单条 handleStatusChange 语义），全部完成后清空选中并刷新。
   *  本页恒为 interview 筛选：批量把记录改出面试列表后 total 减少，按新 total 计算最大页并回退，避免停留在越界空页。 */
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
    const removed = next !== 'interview' ? ok : 0;
    const newTotal = Math.max(0, total - removed);
    const maxPage = Math.max(1, Math.ceil(newTotal / pageSize));
    if (removed > 0 && page > maxPage) {
      setPage(maxPage);
    } else {
      void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword });
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
      void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword });
    }
  };

  /** 导出 CSV：经 window.api.exportCsv（主进程原生「另存为」对话框）导出当前筛选的面试中记录，
   *  与「投递记录（全部）」页导出口径一致；后端不可达时自动降级离线导出最新自动备份。 */
  const handleExportCsv = async () => {
    if (!window.api?.exportCsv || !window.api?.exportBackupData) {
      message.error('Electron preload 桥接（window.api.exportCsv / exportBackupData）不可用，请通过 Electron 启动应用。');
      return;
    }
    try {
      const result = await window.api.exportCsv({ status: 'interview', keyword });
      if (result.canceled) return;
      if (result.ok) {
        message.success(`已导出 CSV：${result.path ?? ''}`);
        return;
      }
      const offline = await window.api.exportBackupData({ format: 'csv', status: 'interview', keyword });
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

  const columns: TableProps<ApplicationItem>['columns'] = [
    { title: '职位', dataIndex: 'job_title', ellipsis: true },
    { title: '公司', dataIndex: 'company', ellipsis: true },
    {
      title: '面试时间',
      key: 'interviewTime',
      width: 150,
      // 行内高亮：今天 / 未来 7 天内的面试分别标记「今天」「近7天」Badge，
      // 用户无需逐行扫原始备注即可定位最近一场面试（时间维度提醒）。
      render: (_: unknown, record: ApplicationItem) => {
        const timeStr = parseInterviewBlock(record.note).time || '—';
        const dt = dayjs(timeStr);
        if (!dt.isValid()) return timeStr;
        const now = dayjs();
        const isToday = dt.isSame(now, 'day');
        const withinSevenDays = !dt.isBefore(now) && dt.isBefore(now.add(7, 'day'));
        if (isToday) {
          return (
            <Space size={4}>
              <span>{timeStr}</span>
              <Badge color="volcano" text="今天" />
            </Space>
          );
        }
        if (withinSevenDays) {
          return (
            <Space size={4}>
              <span>{timeStr}</span>
              <Badge color="gold" text="近7天" />
            </Space>
          );
        }
        return timeStr;
      },
      // 基于解析出的面试时间排序（未填写/无法解析排最后），支持点击表头升序/降序
      sorter: (a: ApplicationItem, b: ApplicationItem) => {
        const ta = dayjs(parseInterviewBlock(a.note).time);
        const tb = dayjs(parseInterviewBlock(b.note).time);
        // 无效/未填时间视为「+∞」：在默认升序（点击表头第一下）下排到最后，
        // 与下方注释「未填写/无法解析排最后」语义一致（用 -∞ 会在升序时排到最前）。
        const va = ta.isValid() ? ta.valueOf() : Number.POSITIVE_INFINITY;
        const vb = tb.isValid() ? tb.valueOf() : Number.POSITIVE_INFINITY;
        // 双方均无有效时间时显式返回 0：若直接 va-vb 得 Infinity-Infinity=NaN（不一致比较器，
        // 仅被 V8 视为 0 侥幸可用），保证比较器总是全序一致。
        if (!Number.isFinite(va) && !Number.isFinite(vb)) return 0;
        return va - vb;
      },
    },
    {
      title: '面试形式',
      key: 'interviewForm',
      width: 90,
      render: (_: unknown, record: ApplicationItem) => parseInterviewBlock(record.note).form || '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Badge color={STATUS_COLOR[v] ?? '#d9d9d9'} text={STATUS_TEXT[v] ?? v} />,
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
      title={<Title level={4} style={{ margin: 0 }}>面试管理</Title>}
      extra={<Button onClick={() => navigate('/')}>返回工作台</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="面试登记 v0.1"
          description="本页仅展示状态为「面试中」的投递记录，并提供登记入口：新建记录默认进入「面试中」，面试时间/形式会结构化写入备注（【面试登记】段）。结构化面试字段（面试官、面试结果、面试日历等）规划在后续版本。若投递记录尚未标记「面试中」，可到「投递（手动登记）」或「投递记录（全部）」页改状态后回来查看。"
        />
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
                  if (baseUrl) void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword });
                }}
              >
                重试
              </Button>
            </Space>
          </>
        ) : (
          <>
            {error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
            <Space wrap>
              <Input.Search
                placeholder="搜索公司 / 职位"
                allowClear
                style={{ width: 240 }}
                value={keywordDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setKeywordDraft(v);
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
              <Button type="primary" onClick={openCreateModal}>
                登记面试
              </Button>
              <Button onClick={() => navigate('/jobs')}>查看全部投递记录</Button>
              <Button onClick={() => baseUrl && void fetchList(baseUrl, { status: 'interview', page, pageSize, keyword })}>刷新</Button>
              <Button onClick={() => void handleExportCsv()}>导出 CSV</Button>
              {lastStatusChange ? (
                <Button
                  danger
                  onClick={() => void handleUndoStatusChange()}
                  title={`将「${lastStatusChange.jobTitle}」恢复为面试中，重新进入面试列表`}
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
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无面试中的记录，登记第一条面试吧">
                    <Button type="primary" onClick={openCreateModal}>
                      登记面试
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
                showTotal: (t) => `共 ${t} 条面试中`,
                onChange: (p, ps) => {
                  setPageSize(ps);
                  setPage(Math.min(p, Math.max(1, Math.ceil(total / ps))));
                },
              }}
              columns={columns}
            />
            <Modal
              title={editingId ? '编辑投递记录' : '登记面试'}
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
                  initialValue="interview"
                  tooltip="登记时默认「面试中」；也可直接指定其他状态"
                >
                  <Select options={Object.keys(STATUS_TEXT).map((k) => ({ value: k, label: STATUS_TEXT[k] }))} />
                </Form.Item>
                <>
                  <Form.Item
                    name="interviewTime"
                    label="面试时间"
                    tooltip="面试时间（可选），将结构化写入备注（【面试登记】段）"
                  >
                    <DatePicker
                      showTime={{ format: 'HH:mm' }}
                      format="YYYY-MM-DD HH:mm"
                      style={{ width: '100%' }}
                      placeholder="面试时间（可选）"
                    />
                  </Form.Item>
                  {hasUnparseableTime && (
                    <Form.Item label=" " colon={false} style={{ marginBottom: 8 }}>
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        原记录含无法解析的手写面试时间（如「下周三」）：保存时默认保留；如需删除请点右侧按钮。
                        <Button
                          type="link"
                          size="small"
                          danger
                          style={{ padding: 0, marginLeft: 8 }}
                          onClick={() => setRemoveHandwrittenTime(true)}
                        >
                          移除手写时间
                        </Button>
                        {removeHandwrittenTime && (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            ✓ 将删除
                          </Typography.Text>
                        )}
                      </Typography.Text>
                    </Form.Item>
                  )}
                  <Form.Item name="interviewForm" label="面试形式">
                    <Select
                      placeholder="选择面试形式（可选）"
                      allowClear
                      options={INTERVIEW_FORMS.map((f) => ({ value: f, label: f }))}
                    />
                  </Form.Item>
                </>
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
                  <Input.TextArea rows={3} placeholder="备注（可选）；登记面试时请优先使用上方面试时间/形式字段" />
                </Form.Item>
              </Form>
            </Modal>
          </>
        )}
      </Space>
    </Card>
  );
}
