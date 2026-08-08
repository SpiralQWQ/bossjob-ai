import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Form, Input, message, Modal, Popconfirm, Space, Typography } from 'antd';
import { useBlocker, useNavigate } from 'react-router-dom';

const { Title } = Typography;

/** 本地存储 key：简历信息仅存本机浏览器（localStorage），不随后端同步。 */
const STORAGE_KEY = 'bossjobai.resume';

/** 简历基本信息（最小可交付：填表 + 本地保存）。 */
export interface ResumeData {
  name: string;
  phone: string;
  email: string;
  city: string;
  salary: string;
  education: string;
  skills: string;
  summary: string;
}

const EMPTY: ResumeData = {
  name: '',
  phone: '',
  email: '',
  city: '',
  salary: '',
  education: '',
  skills: '',
  summary: '',
};

/** 读取本地简历；数据损坏时回退空表单。 */
function loadResume(): ResumeData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Partial<ResumeData>) };
  } catch {
    // 本地存储损坏时忽略，返回空表单
  }
  return EMPTY;
}

/** /resume 简历页（最小可交付）：简历信息填写表单，保存到本地。 */
export default function ResumePage() {
  const navigate = useNavigate();
  const [form] = Form.useForm();

  // 最近一次「已保存」的简历快照（脏检查基准），初始为本地已保存内容
  const savedRef = useRef<ResumeData>(loadResume());
  const [dirty, setDirty] = useState(false);

  // 「导入简历 JSON」弹窗状态：粘贴「备份简历 JSON」导出的独立简历文件内容后解析回填
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');

  /** 脏检查：表单当前值 ≠ 最近一次已保存快照 → 存在未保存修改。 */
  const updateDirty = useCallback(() => {
    setDirty(JSON.stringify(form.getFieldsValue()) !== JSON.stringify(savedRef.current));
  }, [form]);

  useEffect(() => {
    const saved = loadResume();
    savedRef.current = saved;
    form.setFieldsValue(saved);
    setDirty(false);
    // 恢复/导入备份后磁盘 resume.json 是权威副本（主进程 writeRendererResume 双写）：
    // 挂载时（及后端就绪后）经 getResumeSnapshot 拉取磁盘快照回灌 localStorage 与表单，
    // 避免 UI 仍显示旧 localStorage 简历、下一次保存用过期内容覆盖写回磁盘（静默丢失被恢复的简历）；
    // 磁盘副本缺失 / 桥接不可用 / 读取失败时静默保留上面的 localStorage 初始化结果。
    const hydrateFromDisk = () => {
      // 纯浏览器（无 preload 桥）下 window.api 为 undefined，getResumeSnapshot?.() 短路返回 undefined，
      // 故 .then/.catch 前同样用可选链守卫，避免对 undefined 调用 then 抛 TypeError 崩溃整个页面
      // （与下方 onBackendReady 订阅、handleSave 的 notifyResumeSaved?.().catch 降级口径保持一致）。
      window.api?.getResumeSnapshot?.()?.then((res) => {
        if (res?.ok && res.resume && typeof res.resume === 'object') {
          const snapshot: ResumeData = { ...EMPTY, ...(res.resume as Partial<ResumeData>) };
          // 脏检查：表单存在未保存修改（当前值 ≠ 最近已保存快照）→ 用户正在编辑，
          // 后端就绪/重启触发的磁盘快照回灌不得覆盖表单，否则会静默丢弃未保存的编辑。
          // 此时仅同步 localStorage 与 savedRef（磁盘副本仍是最新已保存状态），
          // 跳过 form.setFieldsValue 与 setDirty(false)，保留正在编辑的内容（dirty 维持 true）。
          const current = form.getFieldsValue();
          const hasUnsavedChanges = JSON.stringify(current) !== JSON.stringify(savedRef.current);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
          savedRef.current = snapshot;
          if (hasUnsavedChanges) return;
          form.setFieldsValue(snapshot);
          setDirty(false);
        }
      })?.catch(() => {
        /* 读取失败：保持 localStorage 初始化结果 */
      });
    };
    hydrateFromDisk();
    const unsubscribeReady = window.api?.onBackendReady?.(hydrateFromDisk);
    return () => unsubscribeReady?.();
  }, [form]);

  // 路由切换守卫：有未保存修改时拦截导航并弹 Modal 确认，防止侧边栏/返回按钮切走时静默丢失
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      // 主动保存后跳转（如「用此简历登记投递」）：setDirty(false) 已在此次渲染生效，
      // 此阻塞来自渲染竞态（路由器仍持有脏状态的旧 blocker 判定）。此时无未保存修改，
      // 直接放行，避免弹出误导性的「未保存修改」确认框。
      if (!dirty) {
        blocker.proceed();
        return;
      }
      Modal.confirm({
        title: '有未保存的修改',
        content: '当前简历存在未保存的修改，离开后修改将丢失。确定要离开吗？',
        okText: '离开',
        cancelText: '留下',
        onOk: () => blocker.proceed(),
        onCancel: () => blocker.reset(),
      });
    }
  }, [blocker, dirty]);

  // 关闭标签页 / 刷新守卫：有未保存修改时触发浏览器原生离开确认
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleSave = async () => {
    let values: ResumeData;
    try {
      values = (await form.validateFields()) as ResumeData;
    } catch {
      return; // 校验未通过，antd 已给出提示
    }
    try {
      // 保存即通知主进程把 resume.json 写入数据目录（经 preload 桥 window.api.notifyResumeSaved），
      // 使备份/导出/恢复有权威磁盘副本；非 Electron / 桥接不可用时静默跳过（localStorage 仍是本地唯一事实源）。
      // 契约（preload.js）：调用方【必须】await 并检查 {ok,error} —— ok:false 表示磁盘快照未落盘，
      // 不得写 localStorage / 显示「已保存」/ 更新 savedRef / 清除脏标记，否则后续备份/导出会捕获过期 resume.json。
      const res = await window.api?.notifyResumeSaved?.(values);
      if (res && res.ok === false) {
        message.error(res.error || '简历快照落盘失败');
        return; // 落盘失败：不写 localStorage / 不更新已保存快照 / 不清脏标记 / 不显示成功提示，避免假保存
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      savedRef.current = values;
      setDirty(false);
      message.success('简历已保存到本地');
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 将简历渲染为 Markdown 简历模板文本（导出用）。 */
  const toMarkdown = (r: ResumeData): string =>
    [
      `# ${r.name || '（未填写姓名）'}`,
      '',
      '## 基本信息',
      `- 手机号：${r.phone || '—'}`,
      `- 邮箱：${r.email || '—'}`,
      `- 期望城市：${r.city || '—'}`,
      `- 期望薪资：${r.salary || '—'}`,
      `- 学历：${r.education || '—'}`,
      '',
      '## 技能',
      r.skills || '（未填写）',
      '',
      '## 个人简介',
      r.summary || '（未填写）',
      '',
    ].join('\n');

  /** 导出为 Markdown 模板：优先 navigator.clipboard，降级 textarea + execCommand（兼容纯浏览器直开）。 */
  const handleExport = async () => {
    let values: ResumeData;
    try {
      values = (await form.validateFields()) as ResumeData;
    } catch {
      return; // 校验未通过，antd 已给出提示
    }
    const md = toMarkdown(values);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(md);
        message.success('已复制 Markdown 简历模板到剪贴板');
      } else {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        try {
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const ok = document.execCommand('copy');
          if (ok) {
            message.success('已复制 Markdown 简历模板到剪贴板');
          } else {
            message.error('复制失败，请手动复制');
          }
        } finally {
          if (ta.parentNode === document.body) {
            document.body.removeChild(ta);
          }
        }
      }
    } catch (err) {
      message.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 重置：恢复上次保存的简历（不清除本地存储），并同步已保存快照避免误报脏状态。 */
  const handleReset = () => {
    const saved = loadResume();
    savedRef.current = saved;
    form.setFieldsValue(saved);
    setDirty(false);
  };

  /** 导入「备份简历 JSON」导出的独立简历文件：解析并校验顶层对象（含 name/phone 等字段）后
   *  回填表单，并同步 localStorage（bossjobai.resume）与数据目录 resume.json（notifyResumeSaved），
   *  闭合「备份简历 JSON → 导入」回路。注意：本入口只消费独立简历 JSON；含 applications 数组的
   *  完整「导出全部数据」JSON 请走「数据」页的「从 JSON 文件导入」（DataViews 无法消费独立简历文件）。 */
  const handleImport = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      message.error('导入失败：不是有效的 JSON 内容');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      message.error('导入失败：简历文件顶层必须是对象');
      return;
    }
    const obj = parsed as Record<string, unknown>;
    // 独立简历结构校验：顶层需含 name / phone 等简历字段（与「备份简历 JSON」导出格式一致）
    if (typeof obj.name !== 'string' || typeof obj.phone !== 'string') {
      message.error('导入失败：不是有效的简历 JSON（顶层缺少 name / phone 字段）');
      return;
    }
    const values: ResumeData = { ...EMPTY, ...(obj as Partial<ResumeData>) };
    try {
      // 与 handleSave 同契约：await 并检查 {ok,error}，ok:false 时不写 localStorage / 不回填 / 不清脏 / 不关闭，避免假导入
      const res = await window.api?.notifyResumeSaved?.(values);
      if (res && res.ok === false) {
        message.error(res.error || '简历快照落盘失败');
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      savedRef.current = values;
      form.setFieldsValue(values);
      setDirty(false);
      setImportOpen(false);
      setImportText('');
      message.success('简历已导入并保存到本地');
    } catch (err) {
      message.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 清空：将表单置空并直接清除本地存储（清空即生效），与「重置（恢复上次保存）」语义区分。 */
  const handleClear = async () => {
    // 清空简历：先同步通知主进程删除数据目录 resume.json，确认成功后再清空本地 UI 状态。
    // 契约（preload.js）：调用方【必须】await 并检查 {ok,error} —— ok:false 表示磁盘上旧 resume.json
    // 未被删除，备份/导出/恢复仍会读到过期快照；此时不得清空 localStorage/表单，须保留本地现状，
    // 避免出现「已清空」UI 与残留磁盘快照不一致（下次自动备份/导出会捕获这份「已删除」简历）。
    try {
      const res = await window.api?.notifyResumeSaved?.(null);
      if (res && res.ok === false) {
        message.error(res.error || '清空失败，本地简历未变更');
        return;
      }
    } catch (err) {
      message.error(`清空失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    savedRef.current = EMPTY;
    form.setFieldsValue(EMPTY);
    localStorage.removeItem(STORAGE_KEY);
    setDirty(false);
    message.success('简历已清空，本地存储已删除');
  };

  /** 下载为 .md 文件：Blob + a.download 生成 简历_<姓名>_<日期>.md。 */
  const handleDownloadMd = async () => {
    let values: ResumeData;
    try {
      values = (await form.validateFields()) as ResumeData;
    } catch {
      return; // 校验未通过，antd 已给出提示
    }
    const md = toMarkdown(values);
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `简历_${values.name || '未填写姓名'}_${ymd}.md`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 延迟 revoke：立即回收会使下载导航尚未完成就失效，导致文件被静默丢弃。
    setTimeout(() => URL.revokeObjectURL(url), 0);
    message.success(`已下载 ${fileName}`);
  };

  /** 用此简历登记投递：先保存当前简历快照到本地，再跳转投递页；登记表单打开时会读取本地简历回填期望城市/薪资，并把整份简历写入备注快照。 */
  const handleApplyWithResume = async () => {
    let values: ResumeData;
    try {
      values = (await form.validateFields()) as ResumeData;
    } catch {
      return; // 校验未通过，antd 已给出提示
    }
    try {
      // 保存即通知主进程把 resume.json 写入数据目录（经 preload 桥 window.api.notifyResumeSaved），
      // 使备份/导出/恢复有权威磁盘副本；非 Electron / 桥接不可用时静默跳过（localStorage 仍是本地唯一事实源）。
      // 契约（preload.js）：调用方【必须】await 并检查 {ok,error} —— ok:false 表示磁盘快照未落盘，
      // 不得写 localStorage / 提示「已保存」/ 更新 savedRef / 清除脏标记，也不得继续跳转登记（登记快照会引用过期磁盘副本）。
      const res = await window.api?.notifyResumeSaved?.(values);
      if (res && res.ok === false) {
        message.error(res.error || '简历快照落盘失败');
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      savedRef.current = values;
      setDirty(false);
      message.success('简历已保存，跳转投递页登记');
      // 携带 openApplyModal 标记：ApplyPage 挂载后读到该标记自动打开登记弹窗并回填简历，
      // 跨页主流程减一步，用户无需再点一次「登记投递」。
      navigate('/apply', { state: { openApplyModal: true } });
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Card
      style={{ maxWidth: 960, margin: '24px auto' }}
      title={<Title level={4} style={{ margin: 0 }}>简历信息</Title>}
      extra={<Button onClick={() => navigate('/')}>返回工作台</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="简历只保存在本机浏览器（localStorage）——清除浏览器数据或换机前请务必备份，否则将永久丢失。"
          description={
            <>
              简历不会随后端同步。数据页的「手动备份全部数据 / 立即备份」与定时自动备份都会在备份目录写入简历快照（resume.json），
              「导出全部数据」的 JSON 也会携带简历，恢复 / 导入时会一并还原；但历史备份与启动瞬间的自动备份可能不含简历，
              且任何备份都不会在清除浏览器数据后自行恢复。点击右上角「备份简历 JSON」可单独把当前简历保存为文件，
              之后用同位置的「导入简历 JSON」粘贴文件内容即可一键回填并还原本表单（闭合备份→导入回路）。
              用此简历登记投递时会跳转投递页，登记表单自动回填期望城市/薪资，并把整份简历写入备注快照，投递记录可随时回看所用简历。
            </>
          }
          action={
            <>
              <Button
                size="small"
                type="primary"
                onClick={async () => {
                  let values: ResumeData;
                  try {
                    values = (await form.validateFields()) as ResumeData;
                  } catch {
                    return; // 校验未通过，antd 已给出提示
                  }
                  const now = new Date();
                  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
                  const fileName = `简历备份_${values.name || '未填写姓名'}_${ymd}.json`;
                  const blob = new Blob([JSON.stringify(values, null, 2)], {
                    type: 'application/json;charset=utf-8',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = fileName;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  // 延迟 revoke：立即回收会使下载导航尚未完成就失效，导致文件被静默丢弃。
                  setTimeout(() => URL.revokeObjectURL(url), 0);
                  message.success(`已备份简历到 ${fileName}`);
                }}
              >
                备份简历 JSON
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setImportText('');
                  setImportOpen(true);
                }}
              >
                导入简历 JSON
              </Button>
            </>
          }
        />
        <Form
          form={form}
          labelCol={{ span: 5 }}
          wrapperCol={{ span: 18 }}
          style={{ maxWidth: 640 }}
          onValuesChange={updateDirty}
        >
          <Form.Item name="name" label="姓名">
            <Input maxLength={64} placeholder="如：张三" />
          </Form.Item>
          <Form.Item name="phone" label="手机号">
            <Input maxLength={32} placeholder="如：13800000000" />
          </Form.Item>
          <Form.Item name="email" label="邮箱">
            <Input maxLength={128} placeholder="如：name@example.com" />
          </Form.Item>
          <Form.Item name="city" label="期望城市">
            <Input maxLength={64} placeholder="如：北京" />
          </Form.Item>
          <Form.Item name="salary" label="期望薪资">
            <Input maxLength={64} placeholder="如：20-40K" />
          </Form.Item>
          <Form.Item name="education" label="学历">
            <Input maxLength={64} placeholder="如：本科 / 计算机科学" />
          </Form.Item>
          <Form.Item name="skills" label="技能">
            <Input.TextArea rows={3} placeholder="如：React、Node.js、Python（逗号分隔）" />
          </Form.Item>
          <Form.Item name="summary" label="个人简介">
            <Input.TextArea rows={4} placeholder="一句话介绍自己（可选）" />
          </Form.Item>
          <Form.Item wrapperCol={{ offset: 5, span: 18 }}>
            <Space>
              <Button type="primary" onClick={() => void handleApplyWithResume()}>
                用此简历登记投递
              </Button>
              <Button onClick={() => void handleSave()}>保存</Button>
              <Button onClick={() => void handleExport()}>复制 Markdown 模板</Button>
              <Button onClick={() => void handleDownloadMd()}>下载 .md</Button>
              <Button onClick={handleReset}>重置</Button>
              <Popconfirm
                title="确定清空全部简历信息？"
                description="清空后将立即生效并删除本地保存的简历，此操作不可撤销。"
                onConfirm={handleClear}
                okText="清空"
                okButtonProps={{ danger: true }}
                cancelText="取消"
              >
                <Button danger>清空</Button>
              </Popconfirm>
            </Space>
          </Form.Item>
        </Form>
        <Modal
          title="导入简历 JSON"
          open={importOpen}
          okText="导入并保存"
          cancelText="取消"
          width={480}
          onOk={() => void handleImport()}
          onCancel={() => {
            setImportOpen(false);
            setImportText('');
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="粘贴「备份简历 JSON」导出的文件内容"
            description="校验通过后将回填本表单并覆盖本地已保存的简历。注意：本入口只接受独立简历 JSON（顶层含 name / phone 等字段），完整的「导出全部数据」JSON 请走「数据」页的「从 JSON 文件导入」。"
          />
          <Input.TextArea
            rows={8}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'{\n  "name": "张三",\n  "phone": "13800000000",\n  "email": "name@example.com"\n}'}
          />
        </Modal>
      </Space>
    </Card>
  );
}
