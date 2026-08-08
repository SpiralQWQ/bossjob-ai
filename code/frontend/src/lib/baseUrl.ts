/**
 * 后端绑定地址：后端固定监听 127.0.0.1，端口一律经 window.api 获取，禁止硬编码。
 * 端口在整段会话中恒定，故启动时一次性经 get-bootstrap-info IPC 获取并模块级 memoize ——
 * 单次往返得到 baseUrl，替代拆分 get-backend-port / get-csrf-token 多次独立 invoke，
 * 削减启动延迟与 IPC 流量。（CSRF 令牌已随 webRequest 鉴权门退役：主进程仅下发端口，
 * 渲染层访问后端的唯一通道为主进程代理 backend-request。）
 */
type BootstrapInfo = { port: number };
let cachedBootstrap: BootstrapInfo | null = null;
/** baseUrl 缓存（port>0 后生成）；null=尚未解析。 */
let cachedBaseUrl: string | null = null;
/** window.fetch 已挂上「本地后端走主进程代理」补丁的标志（只补一次）。 */
let fetchPatched = false;

// backend-ready 载荷可能携带主进程重新解析后的端口（restore-data / import-backup-archive
// 恢复 settings.json 后后端端口可能变化，main.js notifyBackendReady 会以最新 backendPort 补推）：
// 模块加载即挂一个全局监听同步缓存，确保各页面 onBackendReady 自愈路径（getBaseUrl）拿到的是
// 新端口而非失效的旧端口，避免「端口已变但渲染层仍拨旧地址」的陈旧绑定（port<=0 载荷忽略）。
if (typeof window !== 'undefined' && window.api?.onBackendReady) {
  window.api.onBackendReady((payload) => {
    const port = (payload as { version: string | null; port?: number }).port;
    if (port && port > 0) {
      cachedBootstrap = { port };
      cachedBaseUrl = `http://127.0.0.1:${port}`;
    }
  });
}

/**
 * 一次性经 preload 桥接获取会话级启动信息（后端端口），结果缓存复用。
 * 纯浏览器 / 桥接缺失时返回 null，由调用方按降级语义处理。
 */
async function getBootstrapInfo(): Promise<BootstrapInfo | null> {
  // 仅缓存「已拿到有效端口」的结果；port<=0（后端尚未启动/解析失败）不缓存，
  // 使「重新连接」/ onBackendReady / 聚焦自愈路径能重新经 IPC 探测到后端真正就绪的端口，
  // 否则一次失败会被永久缓存，baseUrl==='' 错误态将永远无法自愈（后端稍后启动也连不上）。
  if (cachedBootstrap && cachedBootstrap.port > 0) return cachedBootstrap;
  if (!window.api?.getBootstrapInfo) return null;
  try {
    const info = await window.api.getBootstrapInfo();
    if (info && info.port > 0) {
      cachedBootstrap = { port: info.port };
      return cachedBootstrap;
    }
    // 后端尚未就绪：返回临时结果但不写入缓存，下次调用重新探测
    return { port: info?.port ?? 0 };
  } catch (err) {
    console.error('[baseUrl] 获取启动信息失败，本地后端请求将无法连接', err);
    return { port: 0 };
  }
}

/** backend-request 代理请求/响应形状（与 electron/preload.js backendRequest 对齐）。 */
type BackendProxyReq = { method: string; path: string; body?: string | null };
type BackendProxyRes = { ok: boolean; status: number; body: string | null };

/**
 * 给 window.fetch 挂上统一的「本地后端走主进程代理」补丁（认证加固的渲染层半段）：
 * 所有指向本地后端（http://127.0.0.1:*）的请求改经 window.api.backendRequest 代理转发 ——
 * 主进程按端点白名单强制校验并附加 Bearer 鉴权令牌，渲染层直连后端不再携带任何凭证，
 * 杜绝「同主世界脚本取令牌 → 直连 fetch → 全量后端 API」的提权路径（webRequest 的
 * X-CSRF-Token / Bearer 附加逻辑均已退役，主进程是唯一鉴权收口）。
 * 仅对本地后端请求生效，其它 URL 原样透传。
 */
function patchFetchWithCsrf(): void {
  if (fetchPatched || typeof window === 'undefined') return;
  fetchPatched = true;
  const origFetch = window.fetch.bind(window);
  (window as { fetch: typeof window.fetch }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('http://127.0.0.1:')) {
      const backendRequest = (
        window.api as
          | { backendRequest?: (req: BackendProxyReq) => Promise<BackendProxyRes> }
          | undefined
      )?.backendRequest;
      if (backendRequest) {
        try {
          const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
          const body = init?.body;
          const res = await backendRequest({
            method: init?.method ?? 'GET',
            path,
            body: body != null ? String(body) : null,
          });
          if (res.status === 0) {
            // status 0 = 主进程代理失败（不可达/超时/响应体超限），body 携带结构化 detail
            let msg = '后端不可达';
            try {
              msg = (JSON.parse(res.body ?? '') as { detail?: string }).detail || msg;
            } catch {
              /* body 非 JSON 时保留默认提示 */
            }
            throw new Error(msg);
          }
          // 构造与原生 Response 兼容的响应对象（前端仅消费 ok/status/json()）。
          // 204/205 空响应体不得携带 body，否则 Response 构造器抛错。
          const resp =
            res.status === 204 || res.status === 205
              ? new Response(null, { status: res.status })
              : new Response(res.body ?? '', { status: res.status >= 200 && res.status <= 599 ? res.status : 500 });
          Object.defineProperty(resp, 'ok', { value: res.ok });
          return resp;
        } catch (err) {
          // 代理通道异常：不得回退直连 —— 主进程代理是唯一的鉴权/端点白名单/响应体上限/
          // 超时收口，直连会绕过这些护栏（RESPONSE_TOO_LARGE_ERR 已映射为 status 0 上抛）。
          // 上抛结构化代理错误，让调用方进入既有的「无法连接/错误」分支。
          throw err;
        }
      }
      // 旧 preload 无 backendRequest：直接回退直连（不再附加 CSRF 头——令牌已随
      // webRequest 鉴权门退役，直连请求由后端按缺省鉴权以 401 拒绝，进入错误分支）。
    }
    return origFetch(input, init);
  };
}

/** 解析后端端口得到 baseUrl（preload 桥接缺失时抛出可读错误）。 */
export async function getBaseUrl(): Promise<string> {
  // 确保 fetch 补丁在首次请求前就位（页面所有请求都先经 getBaseUrl 取 baseUrl）
  patchFetchWithCsrf();
  if (cachedBaseUrl) return cachedBaseUrl;
  const info = await getBootstrapInfo();
  if (!info || info.port <= 0) {
    throw new Error('Electron preload 桥接（window.api）不可用，请通过 Electron 启动应用。');
  }
  cachedBaseUrl = `http://127.0.0.1:${info.port}`;
  return cachedBaseUrl;
}
