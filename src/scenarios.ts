/** 页面预置演示配置与事件。 */

import { LineConfig, ScheduledEvent } from './model.js';

export interface Demo {
  name: string;
  description: string;
  lines: LineConfig[];
  events: ScheduledEvent[];
}

export const DEMOS: Demo[] = [
  {
    name: '三层嵌套抢占',
    description: '低优先级 A 运行中先后被 B、C 抢占；C、B 依次完成后 A 恢复，被抢占的 tick 不消耗处理时间。',
    lines: [
      { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
      { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
      { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 3, lineId: 'C', kind: 'raise' },
    ],
  },
  {
    name: '同优先级排队（since + ID）',
    description: 'Y、X 同一 tick 触发，按 ID 先执行 X；Z 从 tick2 起等待，最后按 since 顺序处理。',
    lines: [
      { id: 'X', priority: 2, mode: 'edge', handlerTicks: 1 },
      { id: 'Y', priority: 2, mode: 'edge', handlerTicks: 1 },
      { id: 'Z', priority: 2, mode: 'edge', handlerTicks: 2 },
    ],
    events: [
      { at: 1, lineId: 'Y', kind: 'raise' },
      { at: 1, lineId: 'X', kind: 'raise' },
      { at: 2, lineId: 'Z', kind: 'raise' },
    ],
  },
  {
    name: '边沿屏蔽保留 + 重复合并',
    description: 'E 在屏蔽期间被触发 3 次，只保留 1 个待处理位（hits=3），解除屏蔽后仅执行一次。',
    lines: [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }],
    events: [
      { at: 1, lineId: 'E', kind: 'mask' },
      { at: 2, lineId: 'E', kind: 'raise' },
      { at: 3, lineId: 'E', kind: 'raise' },
      { at: 3, lineId: 'E', kind: 'raise' },
      { at: 4, lineId: 'E', kind: 'unmask' },
    ],
  },
  {
    name: '电平重入 + 屏蔽/解除',
    description: '电平线 L 持续有效时处理完成即重入；随后屏蔽使其挂起，解除屏蔽后凭仍有效的电平再次进入。',
    lines: [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }],
    events: [
      { at: 1, lineId: 'L', kind: 'raise' },
      { at: 4, lineId: 'L', kind: 'lower' },
      { at: 5, lineId: 'L', kind: 'raise' },
      { at: 7, lineId: 'L', kind: 'mask' },
      { at: 9, lineId: 'L', kind: 'unmask' },
      { at: 10, lineId: 'L', kind: 'lower' },
    ],
  },
  {
    name: '模式切换 + 运行中调级',
    description:
      'E 屏蔽期合并的边沿待处理位在切成电平模式时失效（不凭旧位进入）；A 运行中被调低优先级后，等待中的 B 当 tick 即可抢占。',
    lines: [
      { id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 },
      { id: 'A', priority: 3, mode: 'edge', handlerTicks: 4 },
      { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'E', kind: 'mask' },
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'E', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 3, lineId: 'A', kind: 'setPriority', priority: 1 },
      { at: 4, lineId: 'E', kind: 'setMode', mode: 'level' },
      { at: 4, lineId: 'E', kind: 'unmask' },
    ],
  },
  {
    name: '临界区间：共享寄存器保护',
    description:
      'D 写共享寄存器的第 2～4 执行拍是临界区（门槛 8）：M(p5) 被挡，Q(p8) 等于门槛也不算严格更高仍被挡，' +
      '只有真正紧急的 U(p9) 能进入；U 完成后 D 的临界区继续生效，退出后 Q、M 才按优先级依次抢占。',
    lines: [
      { id: 'D', priority: 2, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 8 }] },
      { id: 'M', priority: 5, mode: 'edge', handlerTicks: 1 },
      { id: 'Q', priority: 8, mode: 'edge', handlerTicks: 1 },
      { id: 'U', priority: 9, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'D', kind: 'raise' },
      { at: 2, lineId: 'M', kind: 'raise' },
      { at: 2, lineId: 'Q', kind: 'raise' },
      { at: 4, lineId: 'U', kind: 'raise' },
    ],
  },
  {
    name: '临界区间：跨帧门槛 + 当拍调级',
    description:
      'G 的临界区（门槛 7）被 H(p9) 抢占后仍然生效；H 在 tick3 被调低到 3 后，C(p5) 虽高于栈顶，' +
      '却未严格高于 G 悬挂帧的门槛而被挡，直到 G 恢复并走出临界区才获准抢占。',
    lines: [
      { id: 'G', priority: 1, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 7 }] },
      { id: 'H', priority: 9, mode: 'edge', handlerTicks: 3 },
      { id: 'C', priority: 5, mode: 'edge', handlerTicks: 1 },
    ],
    events: [
      { at: 1, lineId: 'G', kind: 'raise' },
      { at: 2, lineId: 'H', kind: 'raise' },
      { at: 3, lineId: 'H', kind: 'setPriority', priority: 3 },
      { at: 3, lineId: 'C', kind: 'raise' },
    ],
  },
];
