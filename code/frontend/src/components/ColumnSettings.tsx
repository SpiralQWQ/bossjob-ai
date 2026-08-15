import { Button, Checkbox, Dropdown } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { ColumnDef } from '../lib/columnSettings';

interface ColumnSettingsProps {
  columns: ColumnDef[];
  /** 当前可见列 key 集合（受控）。 */
  visibleKeys: ReadonlySet<string>;
  /** 列显隐变化回调（父组件负责 setState + 持久化）。 */
  onChange: (keys: Set<string>) => void;
}

/**
 * 表格列设置（受控组件）：Dropdown 展开列勾选清单，勾选控制列显隐。
 * 防呆：至少保留一列（隐藏唯一列时忽略，避免表格空无一列）。
 */
export default function ColumnSettings({ columns, visibleKeys, onChange }: ColumnSettingsProps) {
  const toggle = (key: string) => {
    const next = new Set(visibleKeys);
    if (next.has(key)) {
      // 防呆：至少保留一列
      if (next.size <= 1) return;
      next.delete(key);
    } else {
      next.add(key);
    }
    onChange(next);
  };

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: columns.map((c) => ({
          key: c.key,
          label: (
            <Checkbox checked={visibleKeys.has(c.key)} onChange={() => toggle(c.key)}>
              {c.title}
            </Checkbox>
          ),
        })),
      }}
    >
      <Button type="text" icon={<SettingOutlined />} title="列设置" aria-label="列设置" />
    </Dropdown>
  );
}
