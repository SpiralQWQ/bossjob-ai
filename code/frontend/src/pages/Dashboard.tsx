import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Descriptions, Skeleton, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '../stores/settingsStore';
import { getBaseUrl } from '../lib/baseUrl';
import { AppIcon } from '../components/AppIcon';
import PageHero from '../components/PageHero';
const { Title } = Typography;

// 后端健康轮询（含重试）统一由主进程 waitBackendReadyOrRetry 完成，就绪/失败经 backend-ready /
// backend-error IPC 推送；渲染层不重复轮询 /api/health，仅保留手动「重新连接」/ 窗口聚焦单次探测兜底。

/** GET /api/health 响应（与后端 schemas.HealthResponse 对齐）。 */
interface HealthInfo {
  status: string;
  version: string;
}

type BackendStatus = 'connecting' | 'connected' | 'disconnected';

const STATUS_TEXT: Record<BackendStatus, string> = {
  connecting: '连接中...',
  connected: '后端已连接',
  disconnected: '后端未连接',
};

const STATUS_BADGE: Record<BackendStatus, 'processing' | 'success' | 'error'> = {
  connecting: 'processing',
  connected: 'success',
  disconnected: 'error',
};

/**
 * 工作台 Dashboard。
 * 连接流程：
 *   1. 经 getBaseUrl()（内部走 getBootstrapInfo IPC，端口禁止硬编码）解析后端 baseUrl。
 *   2. 以 {BACKEND_HOST}:{port} 探测 /api/health，展示连接状态卡片。
 *   3. 连接成功后拉取 /api/settings 到 Zustand store。
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<BackendStatus>('connecting');
  const [version, setVersion] = useState<string>('');
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string>('');

  const settings = useSettingsStore((s) => s.settings);
  const settingsError = useSettingsStore((s) => s.error);
  const settingsLoading = useSettingsStore((s) => s.loading);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);

  // 记录连接成功后解析出的后端 baseUrl，供「目标城市」配置加载失败时重试复用
  const [settingsBaseUrl, setSettingsBaseUrl] = useState<string | null>(null);

  // 挂载守卫：卸载后不再触发 setState
  const mountedRef = useRef(true);
  // 最新连接状态，供 focus 监听器读取，避免陈旧闭包
  const statusRef = useRef<BackendStatus>('connecting');
  // 主进程是否已推送「后端启动失败」具体原因 → 健康检查轮询不得再覆盖该提示
  const backendErrorRef = useRef(false);
  // 后端崩溃自动重启是否进行中 → 手动重连 / 聚焦兜底探测不得覆盖「后端重启中(第n/3次)」进度提示
  const restartingRef = useRef(false);

  // 稳定的健康检查回调：冷启动三重试 + 手动「重新连接」/ 窗口聚焦时复用。
  const checkBackend = useCallback(async () => {
    try {
      const baseUrl = await getBaseUrl();
      if (!mountedRef.current) return;
      setPort(Number(new URL(baseUrl).port));
      setSettingsBaseUrl(baseUrl);
      // 冷启动健康轮询（含重试）统一由主进程 waitForBackendHealth 完成并推送 backend-ready，
      // 此处做单次探测兜底（手动重连 / 窗口聚焦 / 纯浏览器降级）。
      // 已收到主进程推送的后端启动失败原因（backendErrorRef）时，不得把状态回拨到「连接中」，
      // 否则探测的 catch 会因 backendErrorRef 守卫提前返回，徽章将永久停留在连接中的 spinner。
      // 同理，若上一次探测已判定「已断开」（statusRef.current === 'disconnected'），探测
      // 也不得把 error 徽章翻回「连接中」spinner —— 仅成功时再切回 connected；
      // 手动「重新连接」按钮已显式 setStatus('connecting')，不受此守卫影响。
      if (!backendErrorRef.current && statusRef.current !== 'disconnected') setStatus('connecting');
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (!res.ok) {
          throw new Error(`健康检查返回 HTTP ${res.status}`);
        }
        const data = (await res.json()) as HealthInfo;
        if (!mountedRef.current) return;
        // 健康检查必须校验后端契约（schemas.HealthResponse），HTTP 2xx 但 body 异常（如 {status:"error"}）不得视为就绪
        if (data.status !== 'ok' || typeof data.version !== 'string') {
          throw new Error(`健康检查返回异常状态：${data.status ?? 'unknown'}`);
        }
        backendErrorRef.current = false;
        restartingRef.current = false;
        setStatus('connected');
        setVersion(data.version);
        setError('');
        // 连接成功后再拉取配置，避免空跑；store 已有配置时跳过，避免每次重连重复 GET /api/settings
        if (!useSettingsStore.getState().settings) void fetchSettings(baseUrl);
      } catch (err) {
        if (!mountedRef.current) return;
        // 已收到主进程推送的具体失败原因（如 Python 不在 PATH）→ 不用通用 fetch 错误覆盖。
        if (backendErrorRef.current) return;
        // 后端自动重启进行中（restartingRef）：重启期间后端进程暂不可用，健康检查必然失败，
        // 探测不得把「进行中的重启」误判为「后端未连接」而覆盖「后端重启中(第n/m次)」进度。
        // 终态一律由主进程的 IPC 推送解决：耗尽时 backend-error、预算内未恢复健康时
        // backend-error（waitBackendReadyOrRetry）、恢复健康时 backend-ready —— 无需在此翻转。
        if (restartingRef.current) return;
        restartingRef.current = false;
        setStatus('disconnected');
        setError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      // 与内层 catch 相同的守卫：主进程已推送具体失败原因，或后端重启进行中时，
      // 不得用通用「未连接」错误覆盖，避免聚焦/手动重连探测覆盖精确失败原因或重启进度。
      if (backendErrorRef.current) return;
      if (restartingRef.current) return;
      setStatus('disconnected');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchSettings]);

  // 保持 statusRef 与最新状态同步
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;

    // 订阅主进程推送的后端就绪信号（携带版本）：主进程已完成 waitForBackendHealth 健康验证，
    // 故直接采用 payload 的状态/版本，不再重复 GET /api/health 的多余往返（checkBackend 仅保留给
    // 手动「重新连接」/ 窗口聚焦兜底）。仅同步端口/配置 baseUrl，并在 store
    // 尚无配置时补拉一次，避免停留在「连接失败」的 UI 无法自愈。
    const unsubscribeReady = window.api?.onBackendReady?.((payload) => {
      backendErrorRef.current = false;
      restartingRef.current = false;
      setError('');
      setStatus('connected');
      if (typeof payload?.version === 'string') {
        setVersion(payload.version);
      }
      void getBaseUrl()
        .then((baseUrl) => {
          if (!mountedRef.current) return;
          setPort(Number(new URL(baseUrl).port));
          setSettingsBaseUrl(baseUrl);
          if (!useSettingsStore.getState().settings) void fetchSettings(baseUrl);
        })
        .catch(() => {});
    });

    // 订阅主进程推送的后端启动失败原因（如 Python 不在 PATH / 打包 exe 缺失），
    // 给出可操作提示，而不是只显示「后端未连接」。
    const unsubscribe = window.api?.onBackendError?.((message) => {
      backendErrorRef.current = true;
      restartingRef.current = false;
      setStatus('disconnected');
      setError(message);
    });

    // 订阅主进程推送的后端崩溃自动重启进度：守护循环每次重启前展示「后端重启中(第n/3次)」。
    // 订阅顺序（决定 buffered 事件回放顺序）：ready 最先、error 次之、restarting 最后 ——
    // preload 的 subscribe 会在注册时同步回放各通道最近一次载荷，回放顺序即注册顺序。
    // 按「终态(ready/error)先回放、进度(restarting)最后回放」排列，再配合 restarting 处理器
    // 顶部的 backendErrorRef 守卫，可覆盖全部回放组合：
    //  - 陈旧 ready + 进行中 restarting：ready 先回放置 connected，随后被 restarting 回放
    //    纠正为「后端重启中(第n/m次)」，不会停留在错误的「已连接」；
    //  - 陈旧 error（重启已耗尽/预算未恢复健康）+ restarting：error 先回放置「已断开+具体原因」，
    //    restarting 回放被 backendErrorRef 守卫拦截，不会把终态覆盖回「重启中」。
    const unsubscribeRestarting = window.api?.onBackendRestarting?.(({ attempt, max }) => {
      // 已收到主进程推送的后端启动失败具体原因 → 不得用「重启中」覆盖该终端提示
      if (backendErrorRef.current) return;
      restartingRef.current = true;
      setStatus('connecting');
      setError(`后端重启中(第${attempt}/${max}次)，请稍候...`);
    });

    // 冷启动首次探测
    void checkBackend();

    // 窗口重新聚焦时自动重连：后端恢复后 UI 自愈（已连接则跳过）
    const handleFocus = () => {
      if (statusRef.current !== 'connected') {
        void checkBackend();
      }
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', handleFocus);
      unsubscribe?.();
      unsubscribeReady?.();
      unsubscribeRestarting?.();
    };
  }, [checkBackend]);

  return (
    <>
      <PageHero
        title="求职投递助手"
        description="管理你的投递 / 面试 / 简历；岗位库抓取、自动投递等 AI 自动化功能规划中"
        actions={
          <Space wrap>
            <Button type="primary" onClick={() => navigate('/apply', { state: { openApplyModal: true } })} icon={<AppIcon name="applyAdd" />}>登记投递</Button>
            <Button onClick={() => navigate('/jobs')} icon={<AppIcon name="jobs" />}>投递记录</Button>
            <Button onClick={() => navigate('/resume')} icon={<AppIcon name="resume" />}>简历</Button>
            <Button onClick={() => navigate('/tracker')} icon={<AppIcon name="tracker" />}>看板</Button>
          </Space>
        }
      />
      <Card
        style={{ maxWidth: 720, margin: '0 auto 24px' }}
        title={<Title level={4} style={{ margin: 0 }}>工作台</Title>}
        extra={<Button onClick={() => navigate('/settings')}>配置设置</Button>}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Card size="small" title="后端状态">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="连接状态">
              <Badge status={STATUS_BADGE[status]} text={STATUS_TEXT[status]} />
            </Descriptions.Item>
            <Descriptions.Item label="后端端口">
              {port ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="后端版本">
              {version || '—'}
            </Descriptions.Item>
          </Descriptions>
          {error && (
            <>
              <Alert type="warning" showIcon message={error} style={{ marginTop: 12 }} />
              <Button
                type="primary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  backendErrorRef.current = false;
                  setStatus('connecting');
                  setError(restartingRef.current ? '后端重启中，请稍候...' : '');
                  void checkBackend();
                }}
              >
                重新连接
              </Button>
            </>
          )}
        </Card>

        <Card size="small" title="目标城市">
          {settingsLoading ? (
            <Skeleton active paragraph={{ rows: 1 }} title={false} />
          ) : settingsError ? (
            <>
              <Alert
                type="error"
                showIcon
                message={`配置加载失败：${settingsError}`}
                style={{ marginBottom: 8 }}
              />
              <Button
                type="primary"
                size="small"
                disabled={!settingsBaseUrl}
                onClick={() => {
                  if (settingsBaseUrl) {
                    void fetchSettings(settingsBaseUrl);
                  }
                }}
              >
                重试
              </Button>
            </>
          ) : settings ? (
            (settings.cities ?? []).length > 0 ? (
              (settings.cities ?? []).join('、')
            ) : (
              <Space direction="vertical" size="small">
                <span>未配置</span>
                <Button size="small" onClick={() => navigate('/settings')}>去配置城市</Button>
              </Space>
            )
          ) : (
            '未加载'
          )}
        </Card>
      </Space>
      </Card>
    </>
  );
}
