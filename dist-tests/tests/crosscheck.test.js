/**
 * 交叉核对（Vitest）：
 *  1. 固定场景：被测实现以批次 1 / 2 / 3 / 5 / 11 / 一次性推进，
 *     与「永远一次只推进 1 tick」的独立参考状态机逐 tick 比较完整快照
 *     （栈、待处理位、电平、屏蔽、动作、剩余 tick、有效门槛、门槛来源、被挡线）；
 *  2. 模糊测试：固定随机种子生成 200 个随机配置/事件场景（含随机临界区间），
 *     同样与参考机逐状态对齐。
 */
import { describe, expect, test } from 'vitest';
import { ReplayController } from '../simulator.js';
import { ReferenceMachine } from './reference-machine.js';
function normalize(rec) {
    return JSON.stringify({
        tick: rec.tick,
        eventsApplied: rec.eventsApplied,
        completed: rec.completed ?? null,
        action: rec.action,
        stack: rec.stack.map((f) => ({
            lineId: f.lineId,
            total: f.total,
            elapsed: f.elapsed,
            preempted: f.preempted,
            enteredAt: f.enteredAt,
        })),
        pending: rec.pending,
        levelAsserted: rec.levelAsserted,
        masked: rec.masked,
        topRemaining: rec.topRemaining,
        effectiveThreshold: rec.effectiveThreshold,
        thresholdSources: rec.thresholdSources,
        blocked: rec.blocked,
    });
}
function crossCheck(name, lines, events) {
    // 参考机：永远一步一拍。
    const ref = new ReferenceMachine(lines, events);
    const refRecs = [];
    let r = ref.step1();
    while (r) {
        refRecs.push(normalize(r));
        r = ref.step1();
    }
    const batches = [1, 2, 3, 5, 11, 'all'];
    for (const b of batches) {
        const ctrl = new ReplayController(lines, events);
        if (b === 'all') {
            while (ctrl.step() !== null) {
                /* run to quiescence */
            }
        }
        else {
            while (ctrl.advance(b).length > 0) {
                /* 按批次推进到静止 */
            }
        }
        const got = ctrl.ticks.map(normalize);
        expect(got.length === refRecs.length && got.every((s, i) => s === refRecs[i]), `[${name}] 批次=${b} 应与逐 tick 参考机逐状态一致（${got.length} ticks）`).toBe(true);
    }
}
describe('不同批次推进 ↔ 逐 tick 参考状态机（固定场景）', () => {
    test('嵌套抢占', () => crossCheck('嵌套抢占', [
        { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'C', priority: 3, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'C', kind: 'raise' },
    ]));
    test('电平+屏蔽', () => crossCheck('电平+屏蔽', [{ id: 'M', priority: 1, mode: 'level', handlerTicks: 2 }], [
        { at: 1, lineId: 'M', kind: 'raise' },
        { at: 3, lineId: 'M', kind: 'mask' },
        { at: 5, lineId: 'M', kind: 'unmask' },
        { at: 6, lineId: 'M', kind: 'lower' },
    ]));
    test('同优先级混合', () => crossCheck('同优先级混合', [
        { id: 'X', priority: 2, mode: 'edge', handlerTicks: 2 },
        { id: 'Y', priority: 2, mode: 'level', handlerTicks: 1 },
        { id: 'Z', priority: 3, mode: 'edge', handlerTicks: 1, initiallyMasked: true },
    ], [
        { at: 1, lineId: 'X', kind: 'raise' },
        { at: 1, lineId: 'Y', kind: 'raise' },
        { at: 2, lineId: 'Z', kind: 'raise' },
        { at: 3, lineId: 'Z', kind: 'unmask' },
        { at: 4, lineId: 'Y', kind: 'lower' },
        { at: 5, lineId: 'Y', kind: 'raise' },
    ]));
    test('模式切换 + 调级抢占', () => crossCheck('模式切换 + 调级抢占', [
        { id: 'E', priority: 1, mode: 'edge', handlerTicks: 1 },
        { id: 'A', priority: 3, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'E', kind: 'mask' },
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'E', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'A', kind: 'setPriority', priority: 1 },
        { at: 4, lineId: 'E', kind: 'setMode', mode: 'level' },
        { at: 4, lineId: 'E', kind: 'unmask' },
    ]));
    test('运行中切模式（电平→边沿）', () => crossCheck('运行中切模式（电平→边沿）', [
        { id: 'L', priority: 2, mode: 'level', handlerTicks: 3 },
        { id: 'K', priority: 1, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'L', kind: 'raise' },
        { at: 2, lineId: 'L', kind: 'setMode', mode: 'edge' },
        { at: 3, lineId: 'K', kind: 'raise' },
        { at: 5, lineId: 'L', kind: 'raise' },
        { at: 6, lineId: 'L', kind: 'setMode', mode: 'level' },
        { at: 7, lineId: 'L', kind: 'raise' },
    ]));
    test('临界区间：阻挡 + 紧急放行 + 恢复后续存', () => crossCheck('临界区间', [
        { id: 'D', priority: 2, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 8 }] },
        { id: 'M', priority: 5, mode: 'edge', handlerTicks: 1 },
        { id: 'Q', priority: 8, mode: 'edge', handlerTicks: 1 },
        { id: 'U', priority: 9, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'D', kind: 'raise' },
        { at: 2, lineId: 'M', kind: 'raise' },
        { at: 2, lineId: 'Q', kind: 'raise' },
        { at: 4, lineId: 'U', kind: 'raise' },
    ]));
    test('临界区间：跨帧门槛 + 当拍调级', () => crossCheck('跨帧门槛', [
        { id: 'G', priority: 1, mode: 'edge', handlerTicks: 5, criticalSections: [{ from: 1, to: 4, threshold: 7 }] },
        { id: 'H', priority: 9, mode: 'edge', handlerTicks: 3 },
        { id: 'C', priority: 5, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'G', kind: 'raise' },
        { at: 2, lineId: 'H', kind: 'raise' },
        { at: 3, lineId: 'H', kind: 'setPriority', priority: 3 },
        { at: 3, lineId: 'C', kind: 'raise' },
    ]));
    test('临界区间：多区间 + 电平混合', () => crossCheck('多区间+电平', [
        {
            id: 'A',
            priority: 2,
            mode: 'level',
            handlerTicks: 4,
            criticalSections: [
                { from: 0, to: 2, threshold: 6 },
                { from: 3, to: 4, threshold: 4 },
            ],
        },
        { id: 'B', priority: 5, mode: 'edge', handlerTicks: 2, criticalSections: [{ from: 1, to: 2, threshold: 7 }] },
        { id: 'C', priority: 6, mode: 'edge', handlerTicks: 1 },
    ], [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
        { at: 3, lineId: 'C', kind: 'raise' },
        { at: 6, lineId: 'A', kind: 'lower' },
        { at: 8, lineId: 'A', kind: 'raise' },
        { at: 9, lineId: 'B', kind: 'raise' },
    ]));
});
// ---------------------------------------------------------------------------
// 模糊测试：确定性 PRNG，参考机核对 200 个随机场景（含随机临界区间）
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** 生成互不重叠的随机临界区间（约 40% 的线配置 1～2 段）。 */
function randomCriticalSections(rand, handlerTicks) {
    if (handlerTicks < 1 || rand() >= 0.4)
        return undefined;
    const sections = [];
    let cursor = 0;
    const count = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
        const from = cursor + Math.floor(rand() * (handlerTicks - cursor));
        if (from >= handlerTicks)
            break;
        const to = from + 1 + Math.floor(rand() * (handlerTicks - from));
        sections.push({ from, to, threshold: 1 + Math.floor(rand() * 6) });
        cursor = to;
        if (cursor >= handlerTicks)
            break;
    }
    return sections.length ? sections : undefined;
}
describe('模糊测试：200 个随机场景，逐状态对齐参考机', () => {
    test('种子 20261001：含临界区间的随机配置全部一致', () => {
        const rand = mulberry32(20261001);
        const kinds = ['raise', 'lower', 'mask', 'unmask', 'setPriority', 'setMode'];
        const mismatches = [];
        for (let it = 0; it < 200; it++) {
            const n = 1 + Math.floor(rand() * 8);
            const ids = Array.from({ length: n }, (_, i) => 'L' + i);
            const lines = ids.map((id) => {
                const handlerTicks = 1 + Math.floor(rand() * 4);
                return {
                    id,
                    priority: 1 + Math.floor(rand() * 4),
                    mode: rand() < 0.5 ? 'edge' : 'level',
                    handlerTicks,
                    initiallyMasked: rand() < 0.15,
                    criticalSections: randomCriticalSections(rand, handlerTicks),
                };
            });
            const evCount = Math.floor(rand() * 24);
            const events = Array.from({ length: evCount }, () => {
                const kind = kinds[Math.floor(rand() * kinds.length)];
                const ev = {
                    at: 1 + Math.floor(rand() * 30),
                    lineId: ids[Math.floor(rand() * n)],
                    kind,
                };
                if (kind === 'setPriority')
                    ev.priority = 1 + Math.floor(rand() * 4);
                if (kind === 'setMode')
                    ev.mode = rand() < 0.5 ? 'edge' : 'level';
                return ev;
            });
            const ref = new ReferenceMachine(lines, events);
            const refRecs = [];
            let rr = ref.step1();
            while (rr) {
                refRecs.push(normalize(rr));
                rr = ref.step1();
            }
            const batch = [1, 2, 7][it % 3];
            const ctrl = new ReplayController(lines, events);
            while (ctrl.advance(batch).length > 0) {
                /* drain */
            }
            const got = ctrl.ticks.map(normalize);
            if (got.length !== refRecs.length || got.some((s, i) => s !== refRecs[i])) {
                mismatches.push(`#${it}（n=${n}, events=${evCount}, batch=${batch}）`);
            }
        }
        expect(mismatches, `不一致场景：${mismatches.join('；')}`).toEqual([]);
    });
});
