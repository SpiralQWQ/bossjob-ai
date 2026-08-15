/**
 * 表格列显隐工具：localStorage 持久化 + 防呆（损坏回落默认）。
 */

export interface ColumnDef {
  /** 列唯一键（与 Table columns 的 key/dataIndex 对齐）。 */
  key: string;
  /** 显示名（列设置面板文案）。 */
  title: string;
}

const STORAGE_KEY = 'bj-table-columns';

/**
 * 读取列显隐集合：缺失/损坏 → 回落全显示；只保留与 defs 匹配的 key（防陈旧数据污染）。
 */
export function loadVisibleKeys(columns: ColumnDef[]): Set<string> {
  const all = new Set(columns.map((c) => c.key));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as unknown;
      if (Array.isArray(saved)) {
        return new Set(saved.filter((k): k is string => typeof k === 'string' && all.has(k)));
      }
    }
  } catch {
    /* 存储损坏：回落默认 */
  }
  return all;
}

/** 持久化列显隐（存储失败静默，不阻塞）。 */
export function persistVisibleKeys(keys: ReadonlySet<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    /* 存储不可用：静默 */
  }
}
