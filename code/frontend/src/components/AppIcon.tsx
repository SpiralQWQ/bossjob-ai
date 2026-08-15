import {
  IconBriefcase,
  IconCalendarEvent,
  IconChartLine,
  IconCircle,
  IconClipboardText,
  IconFileText,
  IconHome2,
  IconSend,
  IconSettings,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';

/**
 * 业务图标注册表（DESIGN §8：统一线性 tabler 图标，语义集中管理；换图标只改这里，全站联动）。
 * 禁止组件散引 @tabler/icons-react 直接写图标名——统一经 AppIcon 出口，换源只改注册表。
 */
export const APP_ICONS = {
  /** 工作台 */
  home: IconHome2,
  /** 简历 */
  resume: IconFileText,
  /** 投递记录 */
  jobs: IconSend,
  /** 投递（手动登记） */
  apply: IconBriefcase,
  /** 面试 */
  interview: IconCalendarEvent,
  /** 看板 */
  tracker: IconChartLine,
  /** 设置 */
  settings: IconSettings,
  /** 登记投递（按钮） */
  applyAdd: IconClipboardText,
} as const;

export type AppIconName = keyof typeof APP_ICONS;

export interface AppIconProps {
  name: AppIconName;
  /** 像素尺寸（默认 16）。 */
  size?: number;
  className?: string;
}

/**
 * 统一图标出口：业务图标一律经此渲染（stroke=1.5 线性风格，与 Antd 协调）；
 * 未知 name 防御性回落默认圆点（TS 强类型下正常不可达）。
 */
export function AppIcon({ name, size = 16, className }: AppIconProps) {
  const Icon: Icon = APP_ICONS[name] ?? IconCircle;
  return <Icon size={size} stroke={1.5} className={className} aria-hidden="true" />;
}
