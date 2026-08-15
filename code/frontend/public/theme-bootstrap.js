/**
 * 主题防闪 bootstrap —— 在 React 挂载前同步应用持久化主题，避免暗色用户冷启动白闪。
 * 作为外部脚本（非 module）放在 <head>，解析期同步执行；CSP script-src 'self' 放行（同源文件）。
 *
 * 与 settingsStore persist 共用 localStorage key 'bj-theme'（partialize 仅存 themeMode，格式 {state:{themeMode},version}）。
 * ⚠️ 色值例外说明：html 背景为设计令牌 NEUTRAL_LIGHT.colorBgLayout / NEUTRAL_DARK.colorBgLayout 的同步值
 *    （#f7f8fa / #111318）。因需在 JS bundle 加载前运行，无法引用 designTokens；若改 designTokens 请同步此处。
 */
(function () {
  // 1) 解析持久化主题：存储损坏/非法 → 回落 'system'（不抛错，主题应用始终执行）
  var mode = 'system';
  try {
    var stored = localStorage.getItem('bj-theme');
    if (stored) {
      var parsed = JSON.parse(stored);
      if (parsed && parsed.state && ['light', 'dark', 'system'].indexOf(parsed.state.themeMode) !== -1) {
        mode = parsed.state.themeMode;
      }
    }
  } catch (e) {
    /* 存储异常（禁用/隐私模式）：保持默认 system */
  }

  // 2) 应用主题到 html：data-theme + colorScheme + 首帧底色（React 挂载后 GlobalStyle 以 token 覆盖为同值）
  try {
    var dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.style.background = dark ? '#111318' : '#f7f8fa';
  } catch (e) {
    /* 应用失败静默降级，不阻塞渲染 */
  }
})();
