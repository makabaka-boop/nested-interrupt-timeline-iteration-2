/** 测试共享小工具（非测试文件，供各 *.test.ts 复用）。 */

import { expect } from 'vitest';
import { Trace } from '../model.js';

/** 动作序列简表，便于手写期望。 */
export function actions(trace: Trace): Array<string> {
  return trace.ticks.map((r) => {
    switch (r.action.type) {
      case 'enter':
        return `enter:${r.action.lineId}`;
      case 'preempt':
        return `preempt:${r.action.by}>${r.action.resumed}`;
      case 'resume':
        return `resume:${r.action.lineId}`;
      case 'continue':
        return `cont:${r.action.lineId}`;
      case 'idle':
        return 'idle';
    }
  });
}

export function completes(trace: Trace): Array<[number, string]> {
  return trace.ticks.filter((r) => r.completed).map((r) => [r.tick, r.completed!.lineId]);
}

export function stackIdsAt(trace: Trace, t: number): string[] {
  return trace.ticks[t - 1].stack.map((f) => f.lineId);
}

/** 未配置临界区间时：每个 tick 都不应有门槛与阻挡证据（旧场景轨迹不变）。 */
export function expectNoCriticalState(trace: Trace): void {
  for (const r of trace.ticks) {
    expect(r.effectiveThreshold, `tick ${r.tick} 不应有有效门槛`).toBeNull();
    expect(r.thresholdSources, `tick ${r.tick} 不应有门槛来源`).toEqual([]);
    expect(r.blocked, `tick ${r.tick} 不应有被阻挡线`).toEqual([]);
  }
  expect(trace.logs.filter((l) => l.type === 'block')).toEqual([]);
}
