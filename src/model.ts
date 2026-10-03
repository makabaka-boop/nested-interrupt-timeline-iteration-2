/**
 * 中断控制器回放 —— 数据模型定义。
 * 该模块不依赖任何硬件接口与 DOM，可同时用于页面渲染与测试。
 */

/** 触发模式：edge = 边沿触发，level = 电平触发。 */
export type TriggerMode = 'edge' | 'level';

/** 外部可注入的事件类型。 */
export type EventKind =
  | 'raise' // 边沿：触发一次；电平：把输入线拉高（保持有效）
  | 'lower' // 仅电平：撤销电平（输入线拉低）
  | 'mask' // 屏蔽：禁止该线被调度（边沿待处理位保留）
  | 'unmask' // 解除屏蔽：线重新允许被调度
  | 'setPriority' // 在阶段 A 调整该线后续调度的优先级
  | 'setMode'; // 在阶段 A 切换触发模式

/**
 * 临界执行区间：设备处理程序写共享寄存器期间的不可抢占窗口。
 * 区间按该处理程序「已经实际执行的拍数」计数（1 起算，含端点），
 * 处理程序被抢占而挂起的拍不前进 —— 因此区间随帧挂起而冻结、随恢复而继续。
 */
export interface CriticalSection {
  /** 区间起点（含）：该处理程序实际执行的第 startTick 拍，>= 1。 */
  startTick: number;
  /** 区间终点（含）：须满足 startTick <= endTick <= handlerTicks。 */
  endTick: number;
  /**
   * 整数优先级门槛：区间生效期间，待处理线只有优先级「严格高于」该门槛，
   * 同时严格高于当前栈顶，才允许抢占（真正紧急的中断仍可进入）。
   */
  priorityFloor: number;
}

/** 一条中断线的静态配置。 */
export interface LineConfig {
  /** 唯一 ID（非空字符串，全部线之间不可重复）。 */
  id: string;
  /** 优先级，数字越大优先级越高。 */
  priority: number;
  /** 边沿 / 电平模式。 */
  mode: TriggerMode;
  /** 处理程序从进入到完成需要的 tick 数（>= 1）。 */
  handlerTicks: number;
  /** 初始是否处于屏蔽状态，默认 false。 */
  initiallyMasked?: boolean;
  /**
   * 临界执行区间配置（可选）。同一条线内各区间必须互不重叠
   * （允许相邻）；未配置时该线处理程序全程可被严格更高优先级抢占。
   */
  criticalSections?: CriticalSection[];
}

/** 外部事件：在 tick 等于 at 的时刻（阶段 A）按列表顺序应用。 */
export interface ScheduledEvent {
  at: number;
  lineId: string;
  kind: EventKind;
  priority?: number;
  mode?: TriggerMode;
}

/** 内部待处理条目（待处理证据）。 */
export interface PendingInfo {
  lineId: string;
  /** 待处理位最早置位的 tick；同优先级时先到先处理。 */
  since: number;
  /** 合并的触发次数（边沿屏蔽期间重复触发会合并为 1 位）。 */
  hits: number;
  kind: 'edge' | 'level';
}

/** 执行栈中的一帧。 */
export interface FrameInfo {
  lineId: string;
  /** 处理程序总共需要的 tick 数。 */
  total: number;
  /** 从被抢占的 tick 累计已执行的 tick 数（完成时等于 total）。 */
  elapsed: number;
  /** 本帧进入（enter）时的 tick。 */
  enteredAt: number;
  /** 该帧之后是否已有更高优先级帧压入（用于区分 resume / continue）。 */
  preempted: boolean;
}

/**
 * 单个待处理线未被准许抢占/调度时保留的阻挡证据。
 * 模型、模拟器、时间轴、逐拍表格与日志共用同一组原因。
 */
export type BlockedReason =
  | 'critical-gate' // 严格高于栈顶，但不严格高于当前临界门槛 → 被临界区间阻挡
  | 'below-top' // 优先级不严格高于当前栈顶
  | 'queue'; // 与获准候选同优先级，按 since/ID 排序后落选

export interface BlockedInfo {
  lineId: string;
  /** 阶段 A 之后该线的当前优先级（setPriority 当拍参与裁决）。 */
  priority: number;
  reason: BlockedReason;
  /** reason === 'critical-gate' 时：实际生效的门槛值。 */
  priorityFloor?: number;
  /** reason === 'critical-gate' 时：贡献该门槛的帧所属线（栈中可能是多层嵌套）。 */
  floorSourceLineId?: string;
}

/** 阶段 C 调度裁决证据（同一有效门槛同时供时间轴、表格与日志引用）。 */
export interface ArbitrationInfo {
  /** 裁决前栈顶线（栈空时为 null）。 */
  topLineId: string | null;
  /** 裁决前栈顶的当前优先级（栈空时为 null）。 */
  topPriority: number | null;
  /**
   * 当前有效门槛：执行栈中所有「已开始未结束」的临界区间的最高 priorityFloor；
   * 栈空或没有任何生效区间时为 null。
   */
  priorityFloor: number | null;
  /** 贡献该最高门槛的帧（帧所属线；栈中多层时取最大值）。 */
  floorSourceLineId: string | null;
  /** 裁决时所有仍生效的临界区间（按栈帧自底向上），用于时间轴标注。 */
  activeSections: Array<{ frameLineId: string; startTick: number; endTick: number; priorityFloor: number }>;
  /**
   * 未获准的可运行待处理线（未屏蔽、未在栈中），保持调度顺序
   * （优先级降序，再按 since、ID）；其待处理位与排序证据原样保留。
   */
  blocked: BlockedInfo[];
}

/** 单条执行日志（时间轴与表格共用同一条轨迹）。 */
export interface TraceLog {
  tick: number;
  /**
   * enter：处理程序进入；preempt：当前程序被更高优先级线抢占；
   * resume：被抢占帧在抢占者完成后恢复执行；continue：帧正常继续执行；
   * complete：处理完成；block：待处理线被当前有效门槛/栈顶挡下；
   * event：外部事件被应用。
   */
  type: 'enter' | 'preempt' | 'resume' | 'continue' | 'complete' | 'block' | 'event';
  lineId?: string;
  /** 关联事件（type === 'event' 时）。 */
  eventKind?: EventKind;
  /** 阻挡时的有效门槛（type === 'block' / 'preempt' 时，可能为 null）。 */
  priorityFloor?: number | null;
  detail: string;
}

/** 单个 tick 的完整快照（逐 tick 参考状态机核对的单位）。 */
export interface TickRecord {
  tick: number;
  /** 阶段 A 应用的事件（保持输入顺序）。 */
  eventsApplied: Array<{ lineId: string; kind: EventKind; priority?: number; mode?: TriggerMode }>;
  /** 阶段 B 的完成（本 tick 最多一个）。 */
  completed?: { lineId: string };
  /** 阶段 C/D：本 tick CPU 实际动作。 */
  action:
    | { type: 'enter'; lineId: string }
    | { type: 'preempt'; by: string; resumed: string }
    | { type: 'resume'; lineId: string }
    | { type: 'continue'; lineId: string }
    | { type: 'idle' };
  /** 本 tick 结束后（阶段 D 执行后）的执行栈，栈顶在末尾。 */
  stack: FrameInfo[];
  /** 本 tick 结束后的待处理位（已按 since、ID 排序）。 */
  pending: PendingInfo[];
  /** 本 tick 结束后的输入电平（仅 level 线为 true 时有条目）。 */
  levelAsserted: string[];
  /** 本 tick 结束后处于屏蔽状态的线。 */
  masked: string[];
  /** 本 tick 结束后栈顶帧剩余 tick（空闲时为 null）。 */
  topRemaining: number | null;
  /**
   * 阶段 C 的调度裁决（在应用当拍事件、上一拍完成之后，执行之前计算）：
   * 记录当前有效临界门槛、其来源与每个未获准待处理线的阻挡原因。
   * 时间轴 / 表格 / 日志均引用这里的同一份门槛与原因。
   */
  arbitration: ArbitrationInfo;
}

/** 一次完整回放的产物。 */
export interface Trace {
  ticks: TickRecord[];
  logs: TraceLog[];
  /** 是否因达到 500 tick 上限而被截断。 */
  truncated: boolean;
  /** 配置/事件层面的告警（不影响模拟，仅展示）。 */
  warnings: string[];
}

export const MAX_TICKS = 500;

/** 待处理位的标准排序：先按置位时刻，再按 ID。 */
export function comparePending(a: PendingInfo, b: PendingInfo): number {
  if (a.since !== b.since) return a.since - b.since;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}
