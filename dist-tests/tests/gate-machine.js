/**
 * 第三套独立实现：表驱动的逐拍临界门槛状态机（仅供 Vitest 核对）。
 *
 * 与 simulator.ts、reference-machine.ts 刻意采用不同写法：
 *  - 事件处理抽成 eventHandlers 表；
 *  - 每拍是一个纯 transition(state, tick) -> {state, out}；
 *  - 门槛/阻挡判定抽成 decide()，先算「有效门槛」，再给出唯一决策与逐候选原因。
 *
 * 只产出核对所需最小信息：action、stack（lineId/elapsed）、pending、
 * 仲裁门槛与阻挡原因。
 */
export class GateMachine {
    constructor(lines, events) {
        this.t = 0;
        this.s = {
            cfg: new Map(lines.map((l) => [l.id, l])),
            pending: [],
            level: new Set(),
            masked: new Set(lines.filter((l) => l.initiallyMasked).map((l) => l.id)),
            stack: [],
            running: new Set(),
        };
        this.maxT = Math.max(0, ...events.map((e) => e.at));
        this.evs = Array.from({ length: this.maxT + 1 }, () => []);
        for (const e of events)
            if (e.at <= this.maxT)
                this.evs[e.at].push(e);
    }
    pri(id) {
        return this.s.cfg.get(id).priority;
    }
    cfg(id) {
        return this.s.cfg.get(id);
    }
    // ---- 事件处理表：kind -> 处理函数（纯命令式改写 this.s）----
    apply(ev, tick) {
        const s = this.s;
        const c = this.cfg(ev.lineId);
        const hasPending = () => s.pending.some((p) => p.lineId === c.id);
        const dropPending = (kind) => {
            s.pending = s.pending.filter((p) => p.lineId !== c.id || (kind !== undefined && p.kind !== kind));
        };
        const canQueueLevel = () => c.mode === 'level' && s.level.has(c.id) && !s.masked.has(c.id) && !s.running.has(c.id) && !hasPending();
        const eventHandlers = {
            raise: () => {
                if (c.mode === 'edge') {
                    const p = s.pending.find((x) => x.lineId === c.id);
                    if (p)
                        p.hits++;
                    else
                        s.pending.push({ lineId: c.id, since: tick, hits: 1, kind: 'edge' });
                }
                else {
                    s.level.add(c.id);
                    if (canQueueLevel())
                        s.pending.push({ lineId: c.id, since: tick, hits: 1, kind: 'level' });
                }
            },
            lower: () => {
                if (c.mode !== 'level')
                    return;
                s.level.delete(c.id);
                if (!s.running.has(c.id))
                    dropPending('level');
            },
            mask: () => {
                s.masked.add(c.id);
                if (c.mode === 'level' && !s.running.has(c.id))
                    dropPending('level');
            },
            unmask: () => {
                s.masked.delete(c.id);
                if (canQueueLevel())
                    s.pending.push({ lineId: c.id, since: tick, hits: 1, kind: 'level' });
            },
            setPriority: () => {
                s.cfg.set(c.id, { ...c, priority: ev.priority });
            },
            setMode: () => {
                if (ev.mode === c.mode)
                    return;
                dropPending();
                s.level.delete(c.id);
                s.cfg.set(c.id, { ...c, mode: ev.mode });
            },
        };
        eventHandlers[ev.kind]();
    }
    /** 找帧「下一执行拍 elapsed+1」所在区间（区间按实际执行拍计数，挂起冻结）。 */
    section(frame) {
        const next = frame.elapsed + 1;
        return (this.cfg(frame.lineId).criticalSections ?? []).find((x) => x.startTick <= next && next <= x.endTick);
    }
    alive() {
        if (this.s.stack.length)
            return true;
        for (let i = this.t + 1; i < this.evs.length; i++)
            if (this.evs[i].length)
                return true;
        return this.runnable().length > 0;
    }
    runnable() {
        return this.s.pending
            .filter((p) => !this.s.masked.has(p.lineId) && !this.s.running.has(p.lineId))
            .slice()
            .sort((a, b) => this.pri(a.lineId) !== this.pri(b.lineId)
            ? this.pri(b.lineId) - this.pri(a.lineId)
            : a.since !== b.since
                ? a.since - b.since
                : a.lineId < b.lineId
                    ? -1
                    : 1);
    }
    /** 核心裁决：全栈生效区间 -> 最高门槛；唯一获准候选；其余逐一带原因。 */
    decide(runnable) {
        const active = this.s.stack
            .map((f) => ({ f, sec: this.section(f) }))
            .filter((x) => Boolean(x.sec));
        let floor = null;
        let floorSource = null;
        for (const { f, sec } of active) {
            if (floor === null || sec.priorityFloor > floor) {
                floor = sec.priorityFloor;
                floorSource = f.lineId;
            }
        }
        const cur = this.s.stack[this.s.stack.length - 1];
        const topPri = cur ? this.pri(cur.lineId) : null;
        const passes = (p) => (!cur || this.pri(p.lineId) > topPri) && (floor === null || this.pri(p.lineId) > floor);
        let grantedId = null;
        if (runnable.length && passes(runnable[0]))
            grantedId = runnable[0].lineId;
        const blocked = [];
        runnable.forEach((p, i) => {
            if (i === 0 && grantedId === p.lineId)
                return;
            const pr = this.pri(p.lineId);
            let reason;
            if (cur && pr <= topPri)
                reason = 'below-top';
            else if (floor !== null && pr <= floor)
                reason = 'critical-gate';
            else
                reason = 'queue';
            const b = { lineId: p.lineId, priority: pr, reason };
            if (reason === 'critical-gate') {
                b.priorityFloor = floor;
                b.floorSourceLineId = floorSource;
            }
            blocked.push(b);
        });
        return { floor, floorSource, active: active.map((x) => x.f.lineId), blocked, grantedId };
    }
    /** 只推进一拍。 */
    step1() {
        if (this.t >= 500 || !this.alive())
            return null;
        this.t += 1;
        const tick = this.t;
        const s = this.s;
        // 阶段 A：当拍事件（按输入顺序）。
        for (const ev of this.evs[tick] ?? []) {
            const c = this.cfg(ev.lineId);
            if (c.mode === 'edge' && ev.kind === 'lower')
                continue;
            this.apply(ev, tick);
        }
        // 阶段 B：上一拍完成（栈顶执行完最后一拍后，本拍出栈）。
        const finished = s.stack[s.stack.length - 1];
        if (finished && finished.elapsed >= finished.total) {
            s.stack.pop();
            s.running.delete(finished.lineId);
            const c = this.cfg(finished.lineId);
            if (c.mode === 'level' && s.level.has(c.id) && !s.masked.has(c.id) && !s.pending.some((p) => p.lineId === c.id)) {
                s.pending.push({ lineId: c.id, since: tick, hits: 1, kind: 'level' });
            }
            const parent = s.stack[s.stack.length - 1];
            if (parent)
                parent.preempted = true;
        }
        // 阶段 C：裁决（先事件、先完成之后；门槛取全栈生效区间最高值）。
        const runnable = this.runnable();
        const cur = s.stack[s.stack.length - 1];
        const d = this.decide(runnable);
        const granted = runnable.find((p) => p.lineId === d.grantedId) ?? null;
        let action;
        if (!cur) {
            if (granted) {
                s.pending = s.pending.filter((p) => p !== granted);
                s.stack.push({ lineId: granted.lineId, elapsed: 0, total: this.cfg(granted.lineId).handlerTicks, preempted: false, enteredAt: tick });
                s.running.add(granted.lineId);
                action = `enter:${granted.lineId}`;
            }
            else
                action = 'idle';
        }
        else if (granted) {
            cur.preempted = true;
            s.pending = s.pending.filter((p) => p !== granted);
            s.stack.push({ lineId: granted.lineId, elapsed: 0, total: this.cfg(granted.lineId).handlerTicks, preempted: false, enteredAt: tick });
            s.running.add(granted.lineId);
            action = `preempt:${granted.lineId}>${cur.lineId}`;
        }
        else if (cur.preempted) {
            action = `resume:${cur.lineId}`;
        }
        else {
            action = `cont:${cur.lineId}`;
        }
        // 阶段 D：栈顶执行 1 拍（挂起帧不前进，区间随之冻结）。
        const exec = s.stack[s.stack.length - 1];
        if (exec) {
            exec.elapsed++;
            if (action.startsWith('resume:'))
                exec.preempted = false;
        }
        return {
            tick,
            action,
            frames: s.stack.map((f) => ({ ...f })),
            pending: s.pending.map((p) => ({ ...p })).sort((a, b) => (a.since !== b.since ? a.since - b.since : a.lineId < b.lineId ? -1 : 1)),
            level: [...s.level].sort(),
            masked: [...s.masked].sort(),
            floor: d.floor,
            floorSource: d.floorSource,
            activeSectionFrames: d.active,
            blocked: d.blocked,
        };
    }
    /** 一次性跑到静止/500 拍。 */
    run() {
        const out = [];
        let r;
        while ((r = this.step1()))
            out.push(r);
        return out;
    }
}
