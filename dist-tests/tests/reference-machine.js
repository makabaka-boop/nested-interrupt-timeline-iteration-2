/**
 * 逐 tick 参考状态机（测试专用，独立于 src/simulator.ts 重新实现同一套语义）。
 *
 * 交叉核对思路：对同一份配置与事件流，参考机每次只推进 1 个 tick（step1），
 * 被测机则用各种不同批次大小推进（advance(1)/advance(3)/一次性 runReplay），
 * 逐 tick 比较归一化后的完整状态快照；再加上手写期望序列核对具体场景。
 */
/** 参考机自带的一份区间工具（与产品代码相互独立，刻意不共享实现）。 */
function sectionsOf(cfg) {
    return [...(cfg.criticalSections ?? [])].sort((a, b) => a.startTick - b.startTick);
}
function sectionFor(cfg, nextTick) {
    return sectionsOf(cfg).find((s) => s.startTick <= nextTick && nextTick <= s.endTick);
}
export class ReferenceMachine {
    constructor(lines, events) {
        this.t = 0;
        this.stack = [];
        this.pending = [];
        this.level = new Set();
        this.masked = new Set();
        this.running = new Set();
        this.cfg = new Map(lines.map((l) => [l.id, l]));
        const maxT = Math.max(0, ...events.map((e) => e.at));
        this.evs = Array.from({ length: maxT + 1 }, () => []);
        for (const e of events)
            if (e.at >= 1 && e.at <= maxT)
                this.evs[e.at].push(e);
        for (const l of lines)
            if (l.initiallyMasked)
                this.masked.add(l.id);
    }
    get tick() {
        return this.t;
    }
    pri(id) {
        return this.cfg.get(id).priority;
    }
    /** 是否还可能产生记录：栈非空 / 未来有事件 / 存在可运行待处理位。 */
    alive() {
        if (this.stack.length)
            return true;
        for (let i = this.t + 1; i < this.evs.length; i++)
            if (this.evs[i].length)
                return true;
        return this.orderedRunnable().length > 0;
    }
    orderedRunnable() {
        return this.pending
            .filter((p) => !this.masked.has(p.lineId) && !this.running.has(p.lineId))
            .map((p) => ({ ...p }))
            .sort((a, b) => this.pri(a.lineId) !== this.pri(b.lineId)
            ? this.pri(b.lineId) - this.pri(a.lineId)
            : a.since !== b.since
                ? a.since - b.since
                : a.lineId < b.lineId
                    ? -1
                    : 1);
    }
    /** 只推进一个 tick；结束后返回 null。 */
    step1() {
        if (this.t >= 500 || !this.alive())
            return null;
        this.t += 1;
        const tick = this.t;
        const eventsApplied = [];
        // ---- 阶段 A：事件（按输入顺序）----
        for (const e of this.evs[tick] ?? []) {
            const cfg = this.cfg.get(e.lineId);
            if (cfg.mode === 'edge' && e.kind === 'lower')
                continue;
            const p = this.pending.find((x) => x.lineId === e.lineId);
            if (e.kind === 'raise') {
                if (cfg.mode === 'edge') {
                    if (p)
                        p.hits++;
                    else
                        this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'edge' });
                }
                else {
                    this.level.add(cfg.id);
                    if (!this.masked.has(cfg.id) && !this.running.has(cfg.id) && !p) {
                        this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
                    }
                }
            }
            else if (e.kind === 'lower') {
                this.level.delete(cfg.id);
                if (!this.running.has(cfg.id)) {
                    const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.kind === 'level');
                    if (i >= 0)
                        this.pending.splice(i, 1);
                }
            }
            else if (e.kind === 'mask') {
                this.masked.add(cfg.id);
                if (cfg.mode === 'level' && !this.running.has(cfg.id)) {
                    const i = this.pending.findIndex((x) => x.lineId === cfg.id && x.kind === 'level');
                    if (i >= 0)
                        this.pending.splice(i, 1);
                }
            }
            else if (e.kind === 'unmask') {
                this.masked.delete(cfg.id);
                if (cfg.mode === 'level' &&
                    this.level.has(cfg.id) &&
                    !this.running.has(cfg.id) &&
                    !this.pending.some((x) => x.lineId === cfg.id)) {
                    this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
                }
            }
            else if (e.kind === 'setPriority') {
                this.cfg.set(cfg.id, { ...cfg, priority: e.priority });
            }
            else if (e.kind === 'setMode') {
                if (e.mode !== cfg.mode) {
                    // 真正切换模式：旧模式遗留的待处理位与已记电平一并失效。
                    for (let i = this.pending.length - 1; i >= 0; i--) {
                        if (this.pending[i].lineId === cfg.id)
                            this.pending.splice(i, 1);
                    }
                    this.level.delete(cfg.id);
                }
                this.cfg.set(cfg.id, { ...cfg, mode: e.mode });
            }
            eventsApplied.push(e.kind === 'setPriority'
                ? { lineId: e.lineId, kind: e.kind, priority: e.priority }
                : e.kind === 'setMode'
                    ? { lineId: e.lineId, kind: e.kind, mode: e.mode }
                    : { lineId: e.lineId, kind: e.kind });
        }
        // ---- 阶段 B：上一 tick 的完成 ----
        let completed;
        const top = this.stack[this.stack.length - 1];
        if (top && top.elapsed >= top.total) {
            this.stack.pop();
            this.running.delete(top.lineId);
            completed = { lineId: top.lineId };
            const cfg = this.cfg.get(top.lineId);
            if (cfg.mode === 'level' &&
                this.level.has(cfg.id) &&
                !this.masked.has(cfg.id) &&
                !this.pending.some((x) => x.lineId === cfg.id)) {
                this.pending.push({ lineId: cfg.id, since: tick, hits: 1, kind: 'level' });
            }
            const parent = this.stack[this.stack.length - 1];
            if (parent)
                parent.preempted = true;
        }
        // ---- 阶段 C：调度（含临界区间门槛裁决）----
        const runnable = this.orderedRunnable();
        const cur = this.stack[this.stack.length - 1];
        const arbitration = this.arbitrate(runnable.map((p) => this.pending.find((q) => q.lineId === p.lineId)), cur);
        const topPri = cur ? this.pri(cur.lineId) : null;
        const win = runnable.length &&
            (!cur ||
                (this.pri(runnable[0].lineId) > topPri &&
                    (arbitration.priorityFloor === null || this.pri(runnable[0].lineId) > arbitration.priorityFloor)))
            ? runnable[0]
            : null;
        let action;
        if (!cur) {
            if (win) {
                const target = this.pending.find((p2) => p2.lineId === win.lineId);
                this.pending.splice(this.pending.indexOf(target), 1);
                this.stack.push({ lineId: win.lineId, total: this.cfg.get(win.lineId).handlerTicks, elapsed: 0, enteredAt: tick, preempted: false });
                this.running.add(win.lineId);
                action = { type: 'enter', lineId: win.lineId };
            }
            else
                action = { type: 'idle' };
        }
        else if (win) {
            cur.preempted = true;
            const target = this.pending.find((p2) => p2.lineId === win.lineId);
            this.pending.splice(this.pending.indexOf(target), 1);
            this.stack.push({ lineId: win.lineId, total: this.cfg.get(win.lineId).handlerTicks, elapsed: 0, enteredAt: tick, preempted: false });
            this.running.add(win.lineId);
            action = { type: 'preempt', by: win.lineId, resumed: cur.lineId };
        }
        else if (cur.preempted) {
            action = { type: 'resume', lineId: cur.lineId };
        }
        else {
            action = { type: 'continue', lineId: cur.lineId };
        }
        // ---- 阶段 D：执行 1 tick ----
        const exec = this.stack[this.stack.length - 1];
        if (exec) {
            exec.elapsed++;
            if (action.type === 'resume')
                exec.preempted = false;
        }
        return {
            tick,
            eventsApplied,
            completed,
            action,
            stack: this.stack.map((f) => ({ ...f })),
            pending: this.pending
                .map((p) => ({ ...p }))
                .sort((a, b) => (a.since !== b.since ? a.since - b.since : a.lineId < b.lineId ? -1 : 1)),
            levelAsserted: [...this.level].sort(),
            masked: [...this.masked].sort(),
            topRemaining: exec ? exec.total - exec.elapsed : null,
            arbitration,
        };
    }
    /**
     * 独立重写的阶段 C 裁决：扫全栈取下一执行拍（elapsed+1）落在区间内的最高门槛；
     * 再逐一标注未获准候选的阻挡原因。与 simulator.ts 刻意分开实现。
     */
    arbitrate(runnable, cur) {
        const activeSections = [];
        for (const f of this.stack) {
            const sec = sectionFor(this.cfg.get(f.lineId), f.elapsed + 1);
            if (sec) {
                activeSections.push({
                    frameLineId: f.lineId,
                    startTick: sec.startTick,
                    endTick: sec.endTick,
                    priorityFloor: sec.priorityFloor,
                });
            }
        }
        let priorityFloor = null;
        let floorSourceLineId = null;
        for (const s of activeSections) {
            if (priorityFloor === null || s.priorityFloor > priorityFloor) {
                priorityFloor = s.priorityFloor;
                floorSourceLineId = s.frameLineId;
            }
        }
        const topPri = cur ? this.pri(cur.lineId) : null;
        let grantedId = null;
        if (runnable.length) {
            const p0 = this.pri(runnable[0].lineId);
            const overTop = !cur || p0 > topPri;
            const overGate = priorityFloor === null || p0 > priorityFloor;
            if (overTop && overGate)
                grantedId = runnable[0].lineId;
        }
        const blocked = [];
        for (let i = 0; i < runnable.length; i++) {
            const p = runnable[i];
            if (i === 0 && grantedId === p.lineId)
                continue;
            const pri = this.pri(p.lineId);
            let reason;
            if (cur && pri <= topPri)
                reason = 'below-top';
            else if (priorityFloor !== null && pri <= priorityFloor)
                reason = 'critical-gate';
            else
                reason = 'queue';
            const entry = { lineId: p.lineId, priority: pri, reason };
            if (reason === 'critical-gate') {
                entry.priorityFloor = priorityFloor;
                entry.floorSourceLineId = floorSourceLineId;
            }
            blocked.push(entry);
        }
        return {
            topLineId: cur?.lineId ?? null,
            topPriority: topPri,
            priorityFloor,
            floorSourceLineId,
            activeSections,
            blocked,
        };
    }
}
