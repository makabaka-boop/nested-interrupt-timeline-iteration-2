/**
 * 临界执行区间（criticalSections）手写期望序列：
 *  - 基本阻挡与放行（严格高于门槛才可抢占，等于门槛不算）；
 *  - 区间边界：按已执行拍数 [from, to) 生效/退出，挂起期间不前进；
 *  - 跨帧门槛：被抢占挂起帧的未结束区间仍参与最高门槛；
 *  - 阶段 A 调级当拍参与裁决；
 *  - 电平线 / 边沿合并 / 屏蔽与临界区间的交互；
 *  - 配置校验（互不重叠、落在 handlerTicks 内、整数门槛）。
 */
import { describe, expect, test } from 'vitest';
import { runReplay, validateInput } from '../simulator.js';
import { actions, completes } from './helpers.js';
describe('临界区间：不足够高优先级被挡，真正紧急的可进入', () => {
    // D 的第 2～4 执行拍（elapsed ∈ [1,4)）写共享寄存器，门槛 8。
    const lines = [
        { id: 'D', priority: 2, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 8 }] },
        { id: 'M', priority: 5, mode: 'edge', handlerTicks: 1 },
        { id: 'Q', priority: 8, mode: 'edge', handlerTicks: 1 },
        { id: 'U', priority: 9, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'D', kind: 'raise' },
        { at: 2, lineId: 'M', kind: 'raise' },
        { at: 2, lineId: 'Q', kind: 'raise' },
        { at: 4, lineId: 'U', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('动作序列：临界区内 M/Q 被挡、U 进入，退出后按优先级补抢', () => {
        expect(actions(trace)).toEqual([
            'enter:D',
            'cont:D', // t2：M(p5)、Q(p8) 均未严格高于门槛 8
            'cont:D', // t3：仍被挡
            'preempt:U>D', // t4：U(p9) 严格高于门槛 8，真正紧急可进入
            'resume:D', // t5：U 完成；D 的临界区（elapsed=3）仍在生效
            'preempt:Q>D', // t6：D 走出临界区（elapsed=4），Q 立即抢占
            'preempt:M>D', // t7：Q 完成后 M 抢占
            'resume:D',
            'idle',
        ]);
        expect(completes(trace)).toEqual([
            [5, 'U'],
            [7, 'Q'],
            [8, 'M'],
            [9, 'D'],
        ]);
    });
    test('有效门槛与阻挡证据（t2/t3/t5 同一数值）', () => {
        for (const t of [2, 3, 5]) {
            const rec = trace.ticks[t - 1];
            expect(rec.effectiveThreshold, `t${t} 有效门槛`).toBe(8);
            expect(rec.thresholdSources, `t${t} 门槛来源`).toEqual([{ lineId: 'D', from: 1, to: 4, threshold: 8 }]);
            expect(rec.blocked, `t${t} 被挡线`).toEqual([
                { lineId: 'Q', priority: 8, topPriority: 2, threshold: 8 },
                { lineId: 'M', priority: 5, topPriority: 2, threshold: 8 },
            ]);
        }
        // 等于门槛（Q p8）也不算严格更高 → 被挡
        expect(trace.ticks[1].blocked.map((b) => b.lineId)).toContain('Q');
    });
    test('被挡者保留原待处理位与排序证据（since 不推移）', () => {
        for (const t of [2, 3, 4, 5]) {
            const pend = trace.ticks[t - 1].pending;
            expect(pend.find((p) => p.lineId === 'M'), `t${t} M 待处理位`).toMatchObject({ since: 2, hits: 1 });
            expect(pend.find((p) => p.lineId === 'Q'), `t${t} Q 待处理位`).toMatchObject({ since: 2, hits: 1 });
        }
    });
    test('挂起期间区间不前进：D 被 U 抢占时停在 elapsed=3', () => {
        const t4 = trace.ticks[3];
        expect(t4.stack.map((f) => [f.lineId, f.elapsed, f.total])).toEqual([
            ['D', 3, 5],
            ['U', 1, 1],
        ]);
        // t5 U 完成出栈后，D 的临界区（elapsed 仍为 3）继续生效
        expect(trace.ticks[4].effectiveThreshold).toBe(8);
        // t6 D 已执行 4 拍，区间退出
        expect(trace.ticks[5].effectiveThreshold).toBeNull();
        expect(trace.ticks[5].blocked).toEqual([]);
    });
    test('日志：阻挡原因与门槛、抢占放行使用同一数值', () => {
        const blockLogs = trace.logs.filter((l) => l.type === 'block');
        expect(blockLogs.map((l) => l.tick)).toEqual([2, 3, 5]);
        for (const l of blockLogs) {
            expect(l.detail).toContain('有效门槛 8');
            expect(l.detail).toContain('D 临界区[1,4)');
            expect(l.detail).toContain('待处理位保留');
        }
        const preemptU = trace.logs.find((l) => l.type === 'preempt' && l.lineId === 'U');
        expect(preemptU.tick).toBe(4);
        expect(preemptU.detail).toContain('有效门槛 8');
    });
});
describe('临界区间边界：按已执行拍数 [from, to) 生效与退出', () => {
    test('from 之前不生效、to 当拍退出', () => {
        const lines = [
            { id: 'A', priority: 1, mode: 'edge', handlerTicks: 3, criticalSections: [{ from: 1, to: 2, threshold: 5 }] },
            { id: 'B', priority: 3, mode: 'edge', handlerTicks: 1 },
        ];
        const events = [
            { at: 1, lineId: 'A', kind: 'raise' },
            { at: 2, lineId: 'B', kind: 'raise' },
        ];
        const trace = runReplay(lines, events);
        expect(actions(trace)).toEqual(['enter:A', 'cont:A', 'preempt:B>A', 'resume:A', 'idle']);
        // t1 进入当拍：阶段 C 时栈为空，无门槛
        expect(trace.ticks[0].effectiveThreshold).toBeNull();
        // t2：A 已执行 1 拍，落入 [1,2) → 门槛 5，B(p3) 被挡
        expect(trace.ticks[1].effectiveThreshold).toBe(5);
        expect(trace.ticks[1].blocked).toEqual([{ lineId: 'B', priority: 3, topPriority: 1, threshold: 5 }]);
        // t3：A 已执行 2 拍，到达 to → 区间退出，B 当拍即可抢占
        expect(trace.ticks[2].effectiveThreshold).toBeNull();
        expect(trace.ticks[2].action).toEqual({ type: 'preempt', by: 'B', resumed: 'A' });
    });
    test('from=0：首个执行拍后即生效，完成当拍退出', () => {
        const lines = [
            { id: 'E', priority: 1, mode: 'edge', handlerTicks: 2, criticalSections: [{ from: 0, to: 2, threshold: 9 }] },
            { id: 'F', priority: 5, mode: 'edge', handlerTicks: 1 },
        ];
        const events = [
            { at: 1, lineId: 'E', kind: 'raise' },
            { at: 2, lineId: 'F', kind: 'raise' },
        ];
        const trace = runReplay(lines, events);
        expect(actions(trace)).toEqual(['enter:E', 'cont:E', 'enter:F', 'idle']);
        expect(trace.ticks[1].effectiveThreshold).toBe(9);
        expect(trace.ticks[1].blocked.map((b) => b.lineId)).toEqual(['F']);
        // t3：E 完成出栈（阶段 B），门槛随之消失，F 进入
        expect(trace.ticks[2].completed).toEqual({ lineId: 'E' });
        expect(trace.ticks[2].effectiveThreshold).toBeNull();
    });
    test('多个互不重叠区间：各自拍段生效，间隙无门槛', () => {
        const lines = [
            {
                id: 'A',
                priority: 1,
                mode: 'edge',
                handlerTicks: 5,
                criticalSections: [
                    { from: 1, to: 2, threshold: 4 },
                    { from: 3, to: 5, threshold: 6 },
                ],
            },
            { id: 'B', priority: 4, mode: 'edge', handlerTicks: 1 },
            { id: 'C', priority: 6, mode: 'edge', handlerTicks: 1 },
        ];
        const events = [
            { at: 1, lineId: 'A', kind: 'raise' },
            { at: 2, lineId: 'B', kind: 'raise' },
            { at: 5, lineId: 'C', kind: 'raise' },
        ];
        const trace = runReplay(lines, events);
        expect(actions(trace)).toEqual([
            'enter:A',
            'cont:A', // t2：第一区间 [1,2) 门槛 4，B(p4) 等于门槛被挡
            'preempt:B>A', // t3：两区间间隙（elapsed=2）无门槛，B 抢占
            'resume:A', // t4
            'cont:A', // t5：第二区间 [3,5) 门槛 6，C(p6) 等于门槛被挡
            'cont:A', // t6：仍被挡
            'enter:C', // t7：A 完成，C 进入
            'idle',
        ]);
        expect(trace.ticks[1].effectiveThreshold).toBe(4);
        expect(trace.ticks[1].thresholdSources).toEqual([{ lineId: 'A', from: 1, to: 2, threshold: 4 }]);
        expect(trace.ticks[2].effectiveThreshold).toBeNull();
        expect(trace.ticks[4].effectiveThreshold).toBe(6);
        expect(trace.ticks[4].thresholdSources).toEqual([{ lineId: 'A', from: 3, to: 5, threshold: 6 }]);
        expect(trace.ticks[4].blocked).toEqual([{ lineId: 'C', priority: 6, topPriority: 1, threshold: 6 }]);
    });
});
describe('临界区间：跨帧门槛 + 阶段 A 调级当拍参与裁决', () => {
    // G 的临界区（门槛 7）被 H 抢占后仍然生效；H 调低到 3 后，
    // C(p5) 高于栈顶却未过 G 悬挂帧的门槛。
    const lines = [
        { id: 'G', priority: 1, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 7 }] },
        { id: 'H', priority: 9, mode: 'edge', handlerTicks: 3 },
        { id: 'C', priority: 5, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'G', kind: 'raise' },
        { at: 2, lineId: 'H', kind: 'raise' },
        { at: 3, lineId: 'H', kind: 'setPriority', priority: 3 },
        { at: 3, lineId: 'C', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('动作序列：悬挂帧门槛挡住 C，G 走出区间后才放行', () => {
        expect(actions(trace)).toEqual([
            'enter:G',
            'preempt:H>G', // H(p9) 严格高于门槛 7
            'cont:H', // t3：H 当拍被调低到 3；C(p5)>3 但 <= 7 被挡
            'cont:H', // t4：仍被挡
            'resume:G', // t5：H 完成；G 的临界区（elapsed=1）继续生效
            'cont:G', // t6：elapsed=2，C 仍被挡
            'cont:G', // t7：elapsed=3，C 仍被挡
            'preempt:C>G', // t8：elapsed=4，区间退出，C 获准
            'resume:G',
            'idle',
        ]);
        expect(completes(trace)).toEqual([
            [5, 'H'],
            [9, 'C'],
            [10, 'G'],
        ]);
    });
    test('有效门槛来自被抢占挂起的帧（非栈顶）', () => {
        for (const t of [3, 4]) {
            const rec = trace.ticks[t - 1];
            expect(rec.effectiveThreshold, `t${t}`).toBe(7);
            expect(rec.thresholdSources, `t${t}`).toEqual([{ lineId: 'G', from: 1, to: 4, threshold: 7 }]);
            expect(rec.stack[rec.stack.length - 1].lineId, `t${t} 栈顶是 H`).toBe('H');
        }
        // t3：阶段 A 调级当拍生效 —— 阻挡证据中的栈顶优先级是调低后的 3
        expect(trace.ticks[2].blocked).toEqual([{ lineId: 'C', priority: 5, topPriority: 3, threshold: 7 }]);
        expect(trace.ticks[2].eventsApplied).toContainEqual({ lineId: 'H', kind: 'setPriority', priority: 3 });
    });
});
describe('临界区间：被挡线当拍调高优先级，当拍即可进入', () => {
    test('阶段 A 把 M 调到 9 → 当拍严格高于门槛 8 而抢占', () => {
        const lines = [
            { id: 'D', priority: 2, mode: 'edge', handlerTicks: 4, criticalSections: [{ from: 1, to: 4, threshold: 8 }] },
            { id: 'M', priority: 5, mode: 'edge', handlerTicks: 1 },
        ];
        const events = [
            { at: 1, lineId: 'D', kind: 'raise' },
            { at: 2, lineId: 'M', kind: 'raise' },
            { at: 3, lineId: 'M', kind: 'setPriority', priority: 9 },
        ];
        const trace = runReplay(lines, events);
        expect(actions(trace)).toEqual(['enter:D', 'cont:D', 'preempt:M>D', 'resume:D', 'cont:D', 'idle']);
        expect(trace.ticks[1].blocked).toEqual([{ lineId: 'M', priority: 5, topPriority: 2, threshold: 8 }]);
        expect(trace.ticks[2].effectiveThreshold).toBe(8);
        expect(trace.ticks[2].blocked).toEqual([]);
    });
});
describe('临界区间与电平线：被挡期间电平待处理位保留，退出后进入', () => {
    const lines = [
        { id: 'D', priority: 2, mode: 'edge', handlerTicks: 3, criticalSections: [{ from: 1, to: 3, threshold: 6 }] },
        { id: 'L', priority: 4, mode: 'level', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'D', kind: 'raise' },
        { at: 2, lineId: 'L', kind: 'raise' },
        { at: 5, lineId: 'L', kind: 'lower' },
    ];
    const trace = runReplay(lines, events);
    test('电平线被挡不丢待处理位，D 走出区间后立即调度', () => {
        expect(actions(trace)).toEqual(['enter:D', 'cont:D', 'cont:D', 'enter:L', 'idle']);
        for (const t of [2, 3]) {
            const rec = trace.ticks[t - 1];
            expect(rec.effectiveThreshold, `t${t}`).toBe(6);
            expect(rec.blocked, `t${t}`).toEqual([{ lineId: 'L', priority: 4, topPriority: 2, threshold: 6 }]);
            expect(rec.pending.find((p) => p.lineId === 'L'), `t${t} 电平待处理位`).toMatchObject({ since: 2, kind: 'level' });
            expect(rec.levelAsserted, `t${t} 输入电平仍在`).toEqual(['L']);
        }
        expect(completes(trace)).toEqual([
            [4, 'D'],
            [5, 'L'],
        ]);
    });
});
describe('临界区间与边沿合并：被挡期间重复触发仍合并为 1 位', () => {
    const lines = [
        { id: 'D', priority: 2, mode: 'edge', handlerTicks: 4, criticalSections: [{ from: 1, to: 3, threshold: 6 }] },
        { id: 'M', priority: 3, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'D', kind: 'raise' },
        { at: 2, lineId: 'M', kind: 'raise' },
        { at: 3, lineId: 'M', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('合并次数累加、since 保留最早时刻，退出区间后抢占', () => {
        expect(actions(trace)).toEqual(['enter:D', 'cont:D', 'cont:D', 'preempt:M>D', 'resume:D', 'idle']);
        expect(trace.ticks[2].pending.find((p) => p.lineId === 'M')).toEqual({ lineId: 'M', since: 2, hits: 2, kind: 'edge' });
        expect(trace.ticks[2].blocked).toEqual([{ lineId: 'M', priority: 3, topPriority: 2, threshold: 6 }]);
        expect(trace.ticks[3].effectiveThreshold).toBeNull();
    });
});
describe('临界区间与屏蔽：屏蔽运行中的线不打断处理程序，门槛照常生效', () => {
    const lines = [
        { id: 'D', priority: 2, mode: 'edge', handlerTicks: 3, criticalSections: [{ from: 1, to: 2, threshold: 9 }] },
        { id: 'M', priority: 5, mode: 'edge', handlerTicks: 1 },
    ];
    const events = [
        { at: 1, lineId: 'D', kind: 'raise' },
        { at: 2, lineId: 'D', kind: 'mask' },
        { at: 2, lineId: 'M', kind: 'raise' },
    ];
    const trace = runReplay(lines, events);
    test('屏蔽中的 D 继续执行且临界区仍挡 M；区间退出后 M 抢占', () => {
        expect(actions(trace)).toEqual(['enter:D', 'cont:D', 'preempt:M>D', 'resume:D', 'idle']);
        const t2 = trace.ticks[1];
        expect(t2.masked).toEqual(['D']);
        expect(t2.effectiveThreshold).toBe(9);
        expect(t2.blocked).toEqual([{ lineId: 'M', priority: 5, topPriority: 2, threshold: 9 }]);
        expect(completes(trace)).toEqual([
            [4, 'M'],
            [5, 'D'],
        ]);
    });
});
describe('临界区间配置校验', () => {
    const base = { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 };
    test('重叠区间被拒绝', () => {
        const { errors } = validateInput([{ ...base, criticalSections: [{ from: 1, to: 3, threshold: 5 }, { from: 2, to: 4, threshold: 6 }] }], []);
        expect(errors.some((e) => e.includes('重叠'))).toBe(true);
    });
    test('from >= to、负起点、超出 handlerTicks 被拒绝', () => {
        expect(validateInput([{ ...base, criticalSections: [{ from: 2, to: 2, threshold: 5 }] }], []).errors.length).toBeGreaterThanOrEqual(1);
        expect(validateInput([{ ...base, criticalSections: [{ from: -1, to: 2, threshold: 5 }] }], []).errors.length).toBeGreaterThanOrEqual(1);
        expect(validateInput([{ ...base, criticalSections: [{ from: 1, to: 5, threshold: 5 }] }], []).errors.length).toBeGreaterThanOrEqual(1);
    });
    test('非整数门槛被拒绝', () => {
        expect(validateInput([{ ...base, criticalSections: [{ from: 1, to: 2, threshold: 2.5 }] }], []).errors.length).toBeGreaterThanOrEqual(1);
    });
    test('首尾相接的区间合法（互不重叠）', () => {
        const { errors } = validateInput([{ ...base, criticalSections: [{ from: 0, to: 2, threshold: 5 }, { from: 2, to: 4, threshold: 3 }] }], []);
        expect(errors).toEqual([]);
    });
});
