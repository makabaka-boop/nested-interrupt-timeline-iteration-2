/**
 * 手写期望序列（Vitest）：嵌套抢占、同优先级等待、边沿屏蔽保留/合并、
 * 电平重入、电平屏蔽/解除、严格高优先级门槛、运行期边沿重入、
 * 模式切换、运行中调级、500 tick 截断、输入校验。
 *
 * 这些场景均未配置临界区间：除原有断言外，还核对每个 tick 的
 * effectiveThreshold 恒为 null、blocked 恒为空 —— 即旧场景轨迹不变。
 */
import { describe, expect, test } from 'vitest';
import { runReplay, validateInput } from '../simulator.js';
import { DEMOS } from '../scenarios.js';
import { actions, completes, expectNoCriticalState, stackIdsAt } from './helpers.js';
describe('嵌套抢占：A(4t,p1) ← B(2t,p2) ← C(1t,p3)', () => {
    const lines = [
        { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'C', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('动作序列与完成时刻', () => {
        expect(actions(trace)).toEqual([
            'enter:A',
            'preempt:B>A',
            'preempt:C>B',
            'resume:B',
            'resume:A',
            'cont:A',
            'cont:A',
            'idle',
        ]);
        expect(completes(trace)).toEqual([
            [4, 'C'],
            [5, 'B'],
            [8, 'A'],
        ]);
    });
    test('执行栈形状（被抢占 tick 不计耗时）', () => {
        expect(stackIdsAt(trace, 3)).toEqual(['A', 'B', 'C']);
        expect(stackIdsAt(trace, 4)).toEqual(['A', 'B']);
        expect(trace.ticks[3].stack[1].elapsed).toBe(2);
        expect(trace.ticks[4].stack[0].elapsed).toBe(2);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('同优先级排队：同 tick 按 ID，跨 tick 按 since', () => {
    const lines = [
        { id: 'X', priority: 2, mode: 'edge', handlerTicks: 1 },
        { id: 'Y', priority: 2, mode: 'edge', handlerTicks: 1 },
        { id: 'Z', priority: 2, mode: 'edge', handlerTicks: 2 },
    ];
    const events = [
        { at: 1, lineId: 'Y', kind: 'raise' },
        { at: 1, lineId: 'X', kind: 'raise' },
        { at: 2, lineId: 'Z', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('同 tick 的 X 排在 Y 前（ID 序），Z 因 since=2 最后', () => {
        expect(actions(trace)).toEqual(['enter:X', 'enter:Y', 'enter:Z', 'cont:Z', 'idle']);
        expect(trace.ticks[1].pending.map((p) => p.lineId)).toEqual(['Z']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('边沿：屏蔽期保留 1 个待处理位，重复触发合并', () => {
    const lines = [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }];
    const events = [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 4, lineId: 'E', kind: 'unmask' },
    ];
    const trace = runReplay(lines, events);
    test('合并证据与解除屏蔽后进入', () => {
        expect(trace.ticks[2].pending.find((p) => p.lineId === 'E')).toEqual({
            lineId: 'E',
            since: 2,
            hits: 3,
            kind: 'edge',
        });
        expect(actions(trace)).toEqual(['idle', 'idle', 'idle', 'enter:E', 'idle']);
        expect(trace.ticks[3].pending.length).toBe(0);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('电平重入：持续有效反复进入；lower 停止重入', () => {
    const lines = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 4, lineId: 'L', kind: 'lower' },
        { at: 5, lineId: 'L', kind: 'raise' },
        { at: 7, lineId: 'L', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    test('完成即重入（t3、t5），t7 完成时电平已撤销', () => {
        expect(actions(trace)).toEqual(['enter:L', 'cont:L', 'enter:L', 'cont:L', 'enter:L', 'cont:L', 'idle']);
        expect(completes(trace)).toEqual([
            [3, 'L'],
            [5, 'L'],
            [7, 'L'],
        ]);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('电平：屏蔽挂起调度，解除屏蔽恢复（输入电平不丢失）', () => {
    const lines = [{ id: 'M', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'M', kind: 'raise' },
        { at: 3, lineId: 'M', kind: 'mask' },
        { at: 5, lineId: 'M', kind: 'unmask' },
        { at: 6, lineId: 'M', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    test('t3 完成时被屏蔽 → 不重入；t5 解除屏蔽重新进入', () => {
        expect(actions(trace)).toEqual(['enter:M', 'cont:M', 'idle', 'idle', 'enter:M', 'cont:M', 'idle']);
        expect(trace.ticks[2].masked).toEqual(['M']);
        expect(trace.ticks[2].levelAsserted).toEqual(['M']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('抢占门槛：低优先级等待，高优先级抢占，恢复后低优先级才进入', () => {
    const lines = [
        { id: 'P', priority: 2, mode: 'edge', handlerTicks: 3 },
        { id: 'Q', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'R', priority: 3, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'P', kind: 'raise' },
        { at: 2, lineId: 'Q', kind: 'raise' },
        { at: 3, lineId: 'R', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('Q 等待；R 抢占；P 完成后 Q 才进入', () => {
        expect(actions(trace)).toEqual(['enter:P', 'cont:P', 'preempt:R>P', 'resume:P', 'enter:Q', 'idle']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('边沿：运行期触发挂起，完成后重入一次', () => {
    const lines = [{ id: 'S', priority: 1, mode: 'edge', handlerTicks: 3 }];
    const events = [
        { at: 1, lineId: 'S', kind: 'raise' },
        { at: 2, lineId: 'S', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('运行期边沿只挂 1 位，t4 完成后再入，不会无限重入', () => {
        expect(actions(trace)).toEqual(['enter:S', 'cont:S', 'cont:S', 'enter:S', 'cont:S', 'cont:S', 'idle']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('屏蔽正在运行的线：当前处理程序跑完；屏蔽期边沿解除后生效', () => {
    const lines = [{ id: 'K', priority: 1, mode: 'edge', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'K', kind: 'raise' },
        { at: 2, lineId: 'K', kind: 'mask' },
        { at: 3, lineId: 'K', kind: 'unmask' },
    ];
    const trace = runReplay(lines, events);
    test('屏蔽不打断 K；解除屏蔽不会补出边沿', () => {
        expect(actions(trace)).toEqual(['enter:K', 'cont:K', 'idle']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('模式切换：边沿屏蔽期合并的待处理位在切成电平时丢弃', () => {
    const lines = [{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }];
    const events = [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 3, lineId: 'E', kind: 'raise' },
        { at: 4, lineId: 'E', kind: 'setMode', mode: 'level' },
        { at: 4, lineId: 'E', kind: 'unmask' },
        { at: 6, lineId: 'E', kind: 'raise' },
        { at: 8, lineId: 'E', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    test('旧边沿待处理位被丢弃，不凭旧位进入', () => {
        expect(trace.ticks[2].pending).toEqual([{ lineId: 'E', since: 2, hits: 3, kind: 'edge' }]);
        expect(trace.ticks[3].pending).toEqual([]);
        expect(trace.ticks[3].levelAsserted).toEqual([]);
        expect(actions(trace)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle', 'enter:E', 'enter:E', 'idle']);
        expect(completes(trace)).toEqual([
            [7, 'E'],
            [8, 'E'],
        ]);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('模式切换：运行中的电平线切成边沿，处理程序继续完成且不重入', () => {
    const lines = [{ id: 'L', priority: 1, mode: 'level', handlerTicks: 2 }];
    const events = [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 2, lineId: 'L', kind: 'setMode', mode: 'edge' },
    ];
    const trace = runReplay(lines, events);
    test('切换模式不杀运行中的处理程序', () => {
        expect(actions(trace)).toEqual(['enter:L', 'cont:L', 'idle']);
        expect(completes(trace)).toEqual([[3, 'L']]);
        expect(trace.ticks[1].levelAsserted).toEqual([]);
        expect(trace.ticks[2].pending).toEqual([]);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('调级：运行中线被调低后，等待中的高优先级线当 tick 抢占', () => {
    const lines = [
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 1 },
    ];
    const trace = runReplay(lines, events);
    test('t3 调低 A 至 1 后，B(2) 当 tick 即可抢占', () => {
        expect(actions(trace)).toEqual(['enter:A', 'cont:A', 'preempt:B>A', 'resume:A', 'cont:A', 'idle']);
        expect(completes(trace)).toEqual([
            [4, 'B'],
            [6, 'A'],
        ]);
    });
    test('抢占日志与调度决策使用同一组（当前）优先级', () => {
        const preemptLogs = trace.logs.filter((l) => l.type === 'preempt');
        expect(preemptLogs.length).toBe(1);
        expect(preemptLogs[0].tick).toBe(3);
        expect(preemptLogs[0].detail).toContain('优先级 2');
        expect(preemptLogs[0].detail).toContain('优先级 1');
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('调级：调到相同优先级仍不抢占（严格更高门槛）', () => {
    const lines = [
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 3 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 2 },
    ];
    const trace = runReplay(lines, events);
    test('A 调到与 B 相同的 2：同优先级不抢占，A 跑完后 B 才进入', () => {
        expect(actions(trace)).toEqual(['enter:A', 'cont:A', 'cont:A', 'enter:B', 'idle']);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('回放窗口：至多 500 tick，超出截断并标记', () => {
    const trace = runReplay([{ id: 'H', priority: 1, mode: 'level', handlerTicks: 2 }], [
        { at: 1, lineId: 'H', kind: 'raise' },
    ]);
    test('持续电平重入恰好在 500 tick 处停止', () => {
        expect(trace.ticks.length).toBe(500);
        expect(trace.truncated).toBe(true);
        expect(trace.ticks[499].tick).toBe(500);
    });
    test('无临界区间状态（旧轨迹不变）', () => expectNoCriticalState(trace));
});
describe('预置演示场景：全部未配置临界区间，轨迹中无门槛/阻挡', () => {
    for (const d of DEMOS.filter((d) => d.lines.every((l) => !l.criticalSections?.length))) {
        test(`${d.name}：effectiveThreshold 恒 null、blocked 恒空`, () => {
            expectNoCriticalState(runReplay(d.lines, d.events));
        });
    }
});
describe('配置校验：1～8 线、唯一 ID、handlerTicks >= 1、越界事件告警', () => {
    test('线数量与 ID 校验', () => {
        expect(validateInput([], []).errors.length).toBe(1);
        expect(validateInput(Array.from({ length: 9 }, (_, i) => ({ id: 'X' + i, priority: 1, mode: 'edge', handlerTicks: 1 })), []).errors.length).toBe(1);
        expect(validateInput([
            { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
            { id: 'D', priority: 1, mode: 'edge', handlerTicks: 1 },
        ], []).errors.length).toBeGreaterThanOrEqual(1);
        expect(validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 0 }], []).errors.length).toBeGreaterThanOrEqual(1);
        expect(validateInput([{ id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 }], [{ at: 501, lineId: 'E', kind: 'raise' }])
            .warnings.length).toBe(1);
    });
});
