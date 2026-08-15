/** Electron 主进程 · 通用工具（从 main.js 抽离：纯函数，无共享可变状态，零安全敏感）。 */
const { BrowserWindow, dialog } = require('electron');

/** 端口合法区间（固定协议值，与后端 constants.PORT_MIN/PORT_MAX 对齐；非配置漂移源）。 */
const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** 当前时间格式化为 YYYYMMDD-HHmm（本地时间），用于导出文件名 / 备份目录命名。 */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** 对话框父窗口：优先聚焦窗口，其次任意已打开窗口；无窗口时返回 undefined（由调用方走无父窗口变体）。 */
function getDialogParent() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

/** 「打开文件/目录」对话框封装（backup-data / import-data / restore-data 共用）。 */
async function openDialog(options) {
  const win = getDialogParent();
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

/** 「另存为」对话框封装（export-data / export-data-csv 共用）。 */
async function saveDialog(options) {
  const win = getDialogParent();
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

/** 错误消息归一化：Error 实例取 message，其余值转字符串。 */
const errMsg = (e) => (e instanceof Error ? e.message : String(e));

/** 同步睡眠（Node 无原生 sync sleep）：仅在令牌文件重试的同步写路径使用。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** settings.json 结构判断辅助。 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 端口合法性校验（与后端 PORT_MIN/PORT_MAX 对齐）。 */
function isValidPort(value) {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX;
}

module.exports = {
  timestamp,
  getDialogParent,
  openDialog,
  saveDialog,
  errMsg,
  sleepSync,
  isPlainObject,
  isValidPort,
};
