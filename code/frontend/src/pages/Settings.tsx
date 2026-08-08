import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '../stores/settingsStore';
import type { AppSettings } from '../stores/settingsStore';
import { getBaseUrl } from '../lib/baseUrl';
import { DAILY_LIMIT_DEFAULTS } from '../constants';

const { Title } = Typography;

/** 随机投递间隔（秒）默认下限/上限：表单回填、保存归一化、界面提示统一引用，禁止散落魔数。 */
const INTERVAL_DEFAULT_MIN = 45;
const INTERVAL_DEFAULT_MAX = 120;

/** 配置编辑表单字段（api_key 为只写字段，绝不从 GET 接口回显）。 */
interface SettingsFormValues {
  cities: string[];
  llm_provider: string;
  llm_model: string;
  llm_base_url: string;
  llm_api_key: string;
  apply_daily_limit: number;
  apply_interval_min: number;
  apply_interval_max: number;
  apply_halt_on_risk: boolean;
  browser_user_data_dir: string;
  browser_headless: boolean;
  blacklist_companies: string[];
  blacklist_keywords: string[];
  security_external_url_hosts: string[];
}

/**
 * 尚未接入 P3-P5 引擎的功能分区（LLM 配置 / 浏览器 Profile / 投递合规 / 黑名单）：
 * 应用内尚无任何运行时消费，为避免用户误以为配置已生效，统一置灰 + 「尚未上线」提示。
 * 待对应引擎接入后移除该包装即可恢复可编辑状态。
 */
function ComingSoonCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  // 用 ConfigProvider componentDisabled 统一禁用本卡全部「尚未上线」控件（含嵌套 noStyle Form.Item）：
  // disabled 控件无法被 Tab 聚焦/键盘修改，杜绝“改动静默落盘却无运行时效果”。
  // 注意：绝不在此嵌套第二个 <Form form={form}> —— rc-field-form 的 setCallbacks 是整体替换共享
  // store 回调，内层 Form 晚于外层挂载会用空 onFinish/onFinishFailed 覆盖外层 Settings Form 注册的
  // 保存回调，导致「保存配置」按钮静默失效。子控件直接挂接唯一外层 <Form>，store 回调始终由外层持有。
  return (
    <Card
      size="small"
      title={
        <Space size="small">
          <span>{title}</span>
          <Tag color="warning">尚未上线</Tag>
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      <Alert
        type="warning"
        showIcon
        message={hint}
        description="保存后仅存储、暂不生效：对应引擎接入前，此处改动不会产生任何运行时效果。"
        style={{ marginBottom: 12 }}
      />
      <div style={{ opacity: 0.55, pointerEvents: 'none' }}>
        <ConfigProvider componentDisabled>
          {children}
        </ConfigProvider>
      </div>
    </Card>
  );
}

/**
 * 自动备份设置卡片：直连 Electron 主进程（window.api.getBackupInfo / updateBackupSettings），
 * 与本地后端 HTTP settings 无关，独立于上方 Form 保存。非 Electron 环境（桥接缺失）静默不渲染。
 * - 开关：启用/停用定时自动备份；
 * - 保留份数上限：1~60（保存后主进程立即按新上限轮转裁剪旧备份）；
 * - 备份间隔：1~1440 分钟（null 表示取消定时）。
 */
/**
 * 备份设置模块级共享槽：BackupSettingsCard 仅在初始加载完成后写入当前值，
 * 主「保存配置」onFinish 依据 loaded 标记决定是否随主保存一起持久化
 * （否则只点主按钮时备份改动静默丢失；加载完成前槽内是硬编码默认值，不得落盘）。
 * 仅单卡实例，渲染期写入幂等，无并发问题。
 */
const backupCardState: {
  loaded: boolean;
  maxBackups: number;
  autoBackupEnabled: boolean;
  intervalMinutes: number | null;
} = { loaded: false, maxBackups: 7, autoBackupEnabled: true, intervalMinutes: 60 };

function BackupSettingsCard() {
  const [enabled, setEnabled] = useState(true);
  const [maxBackups, setMaxBackups] = useState(7);
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(60);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 同步当前值到模块级共享槽，供主「保存配置」按钮读取。
  // 仅在 loaded（getBackupInfo 已返回）后写入：加载完成前不写槽，
  // 主「保存配置」按钮依据 backupCardState.loaded 跳过持久化，避免把渲染期初始
  // 默认值（true/7/60）当成用户配置落盘；同时消除 load() 回填覆盖用户编辑的竞态。
  // 副作用放入 useEffect 而非 render 体：render 应为纯函数（StrictMode 双调用/并发渲染安全）。
  useEffect(() => {
    if (loaded) {
      backupCardState.loaded = true;
      backupCardState.maxBackups = maxBackups;
      backupCardState.autoBackupEnabled = enabled;
      backupCardState.intervalMinutes = intervalMinutes;
    }
  }, [loaded, maxBackups, enabled, intervalMinutes]);

  const load = useCallback(async () => {
    if (!window.api?.getBackupInfo) return;
    // 新一轮加载开始即复位槽内 loaded 哨兵：backupCardState 是模块级缓存，跨挂载存活。
    // 若上次挂载已把 loaded 置 true，而本次 getBackupInfo 尚未返回（重挂载竞态），主「保存配置」
    // 会依据 backupCardState.loaded=true 误把上一轮的陈旧备份值落盘；先复位则跳过同步直到新值就绪。
    backupCardState.loaded = false;
    setLoadError(null);
    try {
      const info = await window.api.getBackupInfo();
      setEnabled(info.autoBackupEnabled);
      setMaxBackups(info.maxBackups);
      setIntervalMinutes(info.intervalMinutes);
      // 仅在成功回填真实配置后解锁：失败（getBackupInfo reject）时保持 loaded=false，
      // 槽内哨兵不置位，主「保存配置」跳过备份同步、own 保存按钮保持禁用，
      // 杜绝「以默认值 {7,true,60} 覆盖磁盘上真实备份配置」的失败路径。
      setLoaded(true);
    } catch (err) {
      console.error('[Settings] 读取备份配置失败', err);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Electron 桥接缺失（纯浏览器模式）时不渲染该卡片，避免误导
  if (!window.api?.getBackupInfo || !window.api?.updateBackupSettings) return null;

  const handleSave = async () => {
    if (!window.api?.updateBackupSettings) return;
    if (!loaded) return; // 加载完成前禁用：防止以预加载默认值覆盖真实备份配置
    setSaving(true);
    try {
      const res = await window.api.updateBackupSettings({
        maxBackups,
        autoBackupEnabled: enabled,
        intervalMinutes,
      });
      if (!res || !res.ok) {
        message.error(`保存备份配置失败：${res?.error ?? '未知错误'}`);
        return;
      }
      message.success('备份配置已保存');
      void load();
    } catch (err) {
      message.error(`保存备份配置失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card size="small" title="自动备份" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* 加载完成前禁用全部控件：阻止用户在 getBackupInfo() 回填真实配置前编辑，
            避免用户改动随后被 info.* 覆盖（async-race），也避免主按钮持久化预加载默认值。 */}
        <ConfigProvider componentDisabled={!loaded}>
          <Space size="middle" wrap>
            <Space size="small">
              <Typography.Text>启用定时自动备份</Typography.Text>
              <Switch checked={enabled} onChange={setEnabled} />
            </Space>
            <Space size="small">
              <Typography.Text>保留份数上限</Typography.Text>
              <InputNumber
                min={1}
                max={60}
                value={maxBackups}
                onChange={(v) => setMaxBackups(Number(v) || 7)}
                style={{ width: 90 }}
              />
            </Space>
            <Space size="small">
              <Typography.Text>备份间隔（分钟）</Typography.Text>
              <InputNumber
                min={1}
                max={1440}
                value={intervalMinutes}
                onChange={(v) => setIntervalMinutes(v ?? null)}
                style={{ width: 110 }}
              />
            </Space>
            <Button type="primary" size="small" loading={saving} onClick={() => void handleSave()}>
              保存备份配置
            </Button>
          </Space>
        </ConfigProvider>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {loaded
            ? '自动备份保存在应用备份目录（打包模式：%APPDATA%/BossJobAI/backups）。关闭开关仅停止定时备份，「立即备份」与手动备份不受影响；调整保留上限将立即裁剪多余备份。'
            : loadError
              ? `读取备份配置失败（已锁定备份保存，防止以默认值覆盖真实配置）：${loadError}`
              : '正在读取主进程备份配置...'}
        </Typography.Text>
      </Space>
    </Card>
  );
}

/**
 * 配置设置页。
 * - GET /api/settings 拉取当前配置并回填表单（api_key 刻意不回填，保持只写）。
 * - PUT /api/settings 合并保存；api_key 留空表示保留后端已存的 Key。
 * 后端保存时保留 env 覆盖优先级：env 设过的字段（如 BOSS_LLM__PROVIDER）
 * 在重启后仍以 env 为准，页面内修改仅落盘 settings.json。
 */
export default function Settings() {
  const navigate = useNavigate();
  const [form] = Form.useForm<SettingsFormValues>();

  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const saving = useSettingsStore((s) => s.saving);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  // 解析后端端口得到 baseUrl（模块级缓存，整段会话复用首次 IPC 结果）。
  // 抽成稳定回调：成功时设置 baseUrl；失败时设置 error 并关闭 loading。
  const resolveBaseUrl = useCallback(async (): Promise<string | null> => {
    try {
      const url = await getBaseUrl();
      setBaseUrl(url);
      return url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      return null;
    }
  }, []);

  // 将配置快照回填表单；api_key 恒置空，只写不回显
  const fillFormFromSnapshot = (snapshot: AppSettings) => {
    const llm = (snapshot.llm ?? {}) as Record<string, string>;
    const apply = (snapshot.apply ?? {}) as Record<string, unknown>;
    const browser = (snapshot.browser ?? {}) as Record<string, unknown>;
    const blacklist = (snapshot.blacklist ?? {}) as Record<string, string[]>;
    const security = (snapshot.security ?? {}) as Record<string, string[]>;
    const interval = Array.isArray(apply.interval_seconds)
      ? (apply.interval_seconds as number[])
      : [INTERVAL_DEFAULT_MIN, INTERVAL_DEFAULT_MAX];
    form.setFieldsValue({
      cities: snapshot.cities ?? [],
      llm_provider: llm.provider ?? '',
      llm_model: llm.model ?? '',
      llm_base_url: llm.base_url ?? '',
      llm_api_key: '',
      apply_daily_limit: (apply.daily_limit as number) ?? DAILY_LIMIT_DEFAULTS.fallback,
      apply_interval_min: interval[0] ?? INTERVAL_DEFAULT_MIN,
      apply_interval_max: interval[1] ?? INTERVAL_DEFAULT_MAX,
      apply_halt_on_risk: apply.halt_on_risk !== false,
      browser_user_data_dir: (browser.user_data_dir as string) ?? '',
      browser_headless: browser.headless === true,
      blacklist_companies: blacklist.companies ?? [],
      blacklist_keywords: blacklist.keywords ?? [],
      security_external_url_hosts: security.external_url_hosts ?? [],
    });
  };

  // 拉取配置并回填：始终从后端重新拉取，确保外部修改 settings.json 能反映到表单
  const reload = async () => {
    let url = baseUrl;
    if (!url) {
      // baseUrl 未解析成功（window.api 缺失 / 端口解析失败）时先重新解析再加载，
      // 否则错误卡片上的「重试」按钮会因 reload 提前 return 而成为死控件。
      url = await resolveBaseUrl();
      if (!url) return; // 解析失败：resolveBaseUrl 已设置 error 并关闭 loading
    }
    setLoading(true);
    setError(null);
    try {
      await fetchSettings(url);
      // fetch 失败但 store 残留上次成功快照时，禁止静默回填陈旧配置：
      // 需把 store.error 上抛到错误卡片，提示重新加载实际失败。
      const storeError = useSettingsStore.getState().error;
      if (storeError) {
        setError(storeError);
        return;
      }
      const snapshot = useSettingsStore.getState().settings;
      if (!snapshot) {
        setError('配置加载失败');
        return;
      }
      fillFormFromSnapshot(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 首次挂载：reload 内部会在 baseUrl 为空时自行解析端口，成功后加载一次配置。
  // 不再依赖 baseUrl，避免解析成功后再触发一次重复加载。
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFinish = async (values: SettingsFormValues) => {
    if (!baseUrl) return;
    try {
      // LLM 引擎尚未接入（ComingSoonCard 整体禁用，字段不可编辑）：不把回填的 llm 段写回——
      // 否则早期版本持久化的非白名单 base_url 会在「保存配置」时经后端/main.js 白名单校验 400，
      // 阻断 cities/安全/备份等一切可编辑配置的保存（配置保存死锁），且禁用字段让用户无法在页面修复。
      // 引擎接入后（P3-P5）此卡启用，将 LLM_COMING_SOON 置 false 即恢复 llm 段回传。
      const LLM_COMING_SOON = true;
      const llm: Record<string, unknown> = LLM_COMING_SOON
        ? {}
        : {
            provider: values.llm_provider.trim(),
            model: values.llm_model.trim(),
            base_url: values.llm_base_url.trim(),
          };
      // api_key 只写：留空默认保留后端已存 Key（省略字段，避免空串覆盖）。
      // 清除已存 Key 由独立的 clearStoredKey（卡片下方幽灵按钮）显式提交
      // llm.api_key='' 完成，此处不重复处理，避免误删用户新填入的 Key。
      const apiKey = values.llm_api_key?.trim();
      if (apiKey) {
        llm.api_key = apiKey;
      }
      const intervalMin = Math.max(1, Number(values.apply_interval_min) || INTERVAL_DEFAULT_MIN);
      const intervalMax = Math.max(1, Number(values.apply_interval_max) || INTERVAL_DEFAULT_MAX);
      const interval =
        intervalMin <= intervalMax ? [intervalMin, intervalMax] : [intervalMax, intervalMin];
      const snapshot = await saveSettings(baseUrl, {
        cities: values.cities ?? [],
        llm,
        apply: {
          daily_limit: Number(values.apply_daily_limit) || DAILY_LIMIT_DEFAULTS.fallback,
          interval_seconds: interval,
          halt_on_risk: !!values.apply_halt_on_risk,
        },
        browser: {
          user_data_dir: values.browser_user_data_dir ?? '',
          headless: !!values.browser_headless,
        },
        blacklist: {
          companies: values.blacklist_companies ?? [],
          keywords: values.blacklist_keywords ?? [],
        },
        security: {
          external_url_hosts: values.security_external_url_hosts ?? [],
        },
      });
      fillFormFromSnapshot(snapshot);
      // 保存成功文案按生效范围区分，避免非技术用户误以为预留分区已生效：
      // 仅外部链接白名单保存即生效；目标城市、投递合规、黑名单、浏览器 Profile、LLM
      // 为「预留配置」（仅存储不生效），自动投递引擎接入前改动不会产生运行时效果。
      message.success('已保存。外部链接白名单已生效；目标城市、投递合规、黑名单、浏览器 Profile 为预留配置，自动投递引擎接入前仅存储、无运行时效果。');
      // 主保存同时持久化自动备份设置：否则只点「保存配置」时备份卡片改动静默丢失。
      // 仅当卡片已完成初始加载（backupCardState.loaded）才同步：加载未完成时槽内仍是
      // 硬编码默认值，强行持久化会把预加载默认值覆盖到真实备份配置。
      // 备份保存失败不阻塞主保存，仅降级提示（成功仍以卡片 own 保存按钮为准）。
      if (window.api?.updateBackupSettings && backupCardState.loaded) {
        try {
          const backupRes = await window.api.updateBackupSettings({
            maxBackups: backupCardState.maxBackups,
            autoBackupEnabled: backupCardState.autoBackupEnabled,
            intervalMinutes: backupCardState.intervalMinutes,
          });
          if (backupRes && !backupRes.ok) {
            message.warning(`备份配置未同步：${backupRes.error ?? '未知错误'}`);
          }
        } catch (err) {
          message.warning(`备份配置未同步：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 保存成功后通知主进程刷新外部链接白名单缓存：无需重启，「打开」即可放行新配置的域名
      void window.api?.reloadExternalAllowlist?.();
      // 同步前端内联白名单警告（useExternalHosts 监听该事件后重拉 /api/settings）
      window.dispatchEvent(new Event('boss-allowlist-updated'));
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  // 「清除已存 Key」：LLM 引擎接入前主字段保持禁用，但早期版本可能已存过 Key，
  // 提供独立于禁用上下文的清除入口，以空串覆盖 llm.api_key（后端合并时 '' 覆盖旧密文，
  // DPAPI 对空值原样落盘），成功即移除存量密钥，不影响表单其余字段。
  const [clearingKey, setClearingKey] = useState(false);
  const clearStoredKey = () => {
    if (!baseUrl) return;
    Modal.confirm({
      title: '清除已存的 LLM API Key？',
      content:
        '清除后旧 Key 将无法恢复，且引擎接入前无法在页面重新录入；仅清除存储，不影响其余配置。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setClearingKey(true);
        try {
          await saveSettings(baseUrl, { llm: { api_key: '' } });
          // 该操作只改 llm.api_key，与表单其余字段无关：不再 fillFormFromSnapshot 整表回填，
          // 避免静默清掉用户尚未保存的表单编辑（如刚输入的「目标城市」「外部链接白名单」）。
          // 仅通知主进程刷新白名单缓存，保持一致（allowlist 本身未被本操作改动）。
          void window.api?.reloadExternalAllowlist?.();
          message.success('已清除已存的 API Key');
        } catch (err) {
          message.error(err instanceof Error ? err.message : String(err));
        } finally {
          setClearingKey(false);
        }
      },
    });
  };

  if (loading) {
    return (
      <Card style={{ maxWidth: 720, margin: '24px auto' }}>
        <Spin tip="正在加载配置...">
          <div style={{ padding: 48 }} />
        </Spin>
      </Card>
    );
  }

  if (error) {
    return (
      <Card style={{ maxWidth: 720, margin: '24px auto' }} title="配置设置">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert type="error" showIcon message={error} />
          <Space>
            <Button type="primary" onClick={() => void reload()}>
              重试
            </Button>
            <Button onClick={() => navigate('/')}>返回工作台</Button>
          </Space>
        </Space>
      </Card>
    );
  }

  return (
    <Card
      style={{ maxWidth: 720, margin: '24px auto' }}
      title={<Title level={4} style={{ margin: 0 }}>配置设置</Title>}
      extra={
        <Space>
          <Button onClick={() => void reload()}>重新加载</Button>
          <Button onClick={() => navigate('/')}>返回工作台</Button>
        </Space>
      }
    >
      <Form<SettingsFormValues>
        form={form}
        layout="vertical"
        onFinish={(values) => {
          void onFinish(values);
        }}
      >
        <Card size="small" title="目标城市" style={{ marginBottom: 16 }}>
          <Alert
            type="warning"
            showIcon
            message="当前仅保存，不参与任何自动行为：自动投递引擎接入前，此处配置不会影响任何职位筛选或投递动作。"
            style={{ marginBottom: 12 }}
          />
          <Form.Item name="cities" label="目标城市" extra="回车或逗号分隔添加多个城市。">
            <Select mode="tags" placeholder="输入城市名后回车添加" open={false} suffixIcon={null} />
          </Form.Item>
        </Card>

        <Card size="small" title="外部链接白名单" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            message="职位「打开」仅放行 BOSS直聘（*.zhipin.com）及此处配置的域名后缀；未放行的域名点击打开会被拒绝。此处配置保存后立即生效，无需重启。"
            style={{ marginBottom: 12 }}
          />
          <Form.Item
            name="security_external_url_hosts"
            label="放行域名后缀"
            extra="回车添加，如 example.com（其子域名自动放行）；不在此列的宿主无法经系统浏览器打开链接。"
            rules={[
              {
                validator: (_rule, value) => {
                  const hosts: unknown[] = Array.isArray(value) ? value : [];
                  // 格式校验（xss：防止误配放行任意域名）：拒绝含协议（http://）、含端口/路径
                  // （:/）、裸 TLD / 无点号单标签（如 "com"，会放行任意 .com 宿主）的条目。
                  const invalid = hosts.filter((h): h is string => {
                    if (typeof h !== 'string') return true;
                    const host = h.trim();
                    // 归一化去掉首尾点号（如 ".com" / "com."）：后端缓存仅去前导点（replace(/^\./,'')），
                    // 若直接放行 ".com"，缓存会把它归一成裸 TLD "com"，等效放行任意 .com 宿主。
                    const normalized = host.replace(/^\.+/, '').replace(/\.+$/, '');
                    return (
                      host.length === 0 ||
                      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host) ||
                      /[\/:]/.test(host) ||
                      normalized.split('.').length < 2
                    );
                  });
                  return invalid.length === 0
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error(
                          `无效的域名后缀（拒绝裸 TLD / 含协议 / 含端口路径）：${invalid.join('、 ')}`
                        )
                      );
                },
              },
            ]}
          >
            <Select mode="tags" placeholder="输入域名后缀后回车添加" open={false} suffixIcon={null} />
          </Form.Item>
        </Card>

        <BackupSettingsCard />

        <ComingSoonCard
          title="LLM 配置"
          hint="AI 能力引擎尚未接入，此处的服务商/模型/Key 配置暂不生效（P3-P5 接入后再启用）。"
        >
          <Form.Item name="llm_provider" label="服务商（Provider）">
            <Input placeholder="deepseek / qwen / ..." />
          </Form.Item>
          <Form.Item name="llm_model" label="模型名（Model）">
            <Input placeholder="deepseek-chat" />
          </Form.Item>
          <Form.Item
            name="llm_base_url"
            label="接口地址（Base URL）"
            extra="OpenAI 兼容接口地址，可留空使用官方默认地址。"
          >
            <Input placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item
            name="llm_api_key"
            label="API Key（只写）"
            extra="仅保存时写入，接口与页面均不会回显；留空表示保留已保存的 Key。（LLM 引擎尚未接入，此卡整体置灰不可修改；如需清除已存 Key，请使用下方「清除已存 Key」按钮。）"
          >
            <Space.Compact block>
              {/* 双重保险：ConfigProvider componentDisabled 经 context 下发 disabled（Space.Compact 不阻断），
                  此处再显式 disabled，确保键盘 Tab 无法聚焦/改动 LLM Key 而静默写入 settings.json。 */}
              <Input.Password
                placeholder="如需修改请输入新 Key"
                autoComplete="new-password"
                disabled
              />
            </Space.Compact>
          </Form.Item>
        </ComingSoonCard>

        <Space direction="vertical" size={0} style={{ width: '100%', marginBottom: 16 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            早期版本若已保存过 LLM API Key，可在引擎接入前单独清除（清除后无法在页面重新录入）。
          </Typography.Text>
          <Button type="dashed" danger size="small" loading={clearingKey} onClick={clearStoredKey}>
            清除已存 Key
          </Button>
        </Space>

        <ComingSoonCard
          title="浏览器 Profile"
          hint="DrissionPage 自动化投递尚未接入，登录态/无头模式配置暂不生效（P3-P5 接入后再启用）。"
        >
          <Form.Item
            name="browser_user_data_dir"
            label="浏览器用户数据目录（user_data_dir）"
            extra="DrissionPage 登录会话持久化目录；填写已登录过的 Chrome 用户目录可复用登录态。"
          >
            <Input placeholder="如 C:\\Users\\<user>\\AppData\\Local\\Google\\Chrome\\User Data" />
          </Form.Item>
          <Form.Item
            name="browser_headless"
            label="无头模式（headless）"
            valuePropName="checked"
            extra="开启后浏览器后台静默运行，不弹出窗口。"
          >
            <Switch />
          </Form.Item>
        </ComingSoonCard>

        <ComingSoonCard
          title="投递合规"
          hint="自动投递引擎尚未接入，每日上限/随机间隔/风控熔断配置暂不生效（P3-P5 接入后再启用）。"
        >
          <Form.Item name="apply_daily_limit" label="每日投递上限">
            <InputNumber min={DAILY_LIMIT_DEFAULTS.min} max={DAILY_LIMIT_DEFAULTS.max} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="随机投递间隔（秒）"
            extra={`每次投递间的随机等待区间，推荐 [${INTERVAL_DEFAULT_MIN}, ${INTERVAL_DEFAULT_MAX}] 秒；保存时自动归一化（min ≤ max）。`}
          >
            <Space>
              <Form.Item name="apply_interval_min" noStyle>
                <InputNumber min={1} max={3600} placeholder="最小" style={{ width: 140 }} />
              </Form.Item>
              <span>~</span>
              <Form.Item name="apply_interval_max" noStyle>
                <InputNumber min={1} max={3600} placeholder="最大" style={{ width: 140 }} />
              </Form.Item>
            </Space>
          </Form.Item>
          <Form.Item
            name="apply_halt_on_risk"
            label="风控熔断（halt_on_risk）"
            valuePropName="checked"
            extra="检测到风控/异常时自动暂停投递，避免账号风险。"
          >
            <Switch />
          </Form.Item>
        </ComingSoonCard>

        <ComingSoonCard
          title="黑名单"
          hint="黑名单过滤逻辑尚未接入，屏蔽公司/关键词配置暂不生效（P3-P5 接入后再启用）。"
        >
          <Form.Item
            name="blacklist_companies"
            label="屏蔽公司"
            extra="回车添加要屏蔽的公司名。"
          >
            <Select mode="tags" placeholder="输入公司名后回车添加" open={false} suffixIcon={null} />
          </Form.Item>
          <Form.Item
            name="blacklist_keywords"
            label="屏蔽关键词"
            extra="职位含关键词则自动跳过，如：外包 / 猎头 / 培训。"
          >
            <Select mode="tags" placeholder="输入关键词后回车添加" open={false} suffixIcon={null} />
          </Form.Item>
        </ComingSoonCard>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存配置
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
