/**
 * 中断控制器回放核心（不连接真实硬件）。
 *
 * 每个 tick 的固定顺序：
 *   阶段 A：应用该 tick 的外部事件（raise / lower / mask / unmask）
 *   阶段 B：处理「上一 tick」执行到最后一个 tick 的处理程序完成
 *   阶段 C：调度 —— 栈空时取优先级最高的可运行待处理线进入；
 *           栈非空时，先取执行栈上所有尚未结束临界区间的最高门槛，
 *           仅「严格高于栈顶优先级、且严格高于该有效门槛」的待处理线
 *           可抢占；被门槛挡住的线保留原待处理位与排序证据，
 *           同优先级按待处理时刻(since)、ID 排队等待。
 *   阶段 D：栈顶处理程序执行 1 tick（被抢占者此 tick 不消耗 handlerTicks）。
 *
 * 语义要点：
 *  - 边沿线：屏蔽期间置起的待处理位保留，重复触发合并（hits 累加）；
 *    处理程序运行期间再次触发也会置一个待处理位（可嵌套重入）。
 *  - 电平线：输入保持有效且未屏蔽时即为可运行；处理完成后电平仍有效
 *    则再次进入；屏蔽只阻止调度，不撤销输入电平。
 *  - 屏蔽正在运行的线不会停止其当前处理程序；屏蔽只影响调度资格。
 *  - setPriority 在阶段 A 立即生效：抢占判断使用双方「当前」优先级，
 *    因此调低运行中线的优先级后，严格更高的等待线当 tick 即可抢占
 *    （运行中的处理程序本身不会被打断杀掉，只在阶段 C 让出）。
 *  - setMode 真正切换模式时，旧模式遗留的触发状态全部失效：丢弃该线
 *    的待处理位；切到边沿时同时忘掉已记电平（不合成边沿，与 unmask
 *    不合成边沿同理）。运行中的处理程序不受模式切换影响，继续完成。
 *  - 临界区间：按帧「已实际执行的拍数」生效（from <= elapsed < to），
 *    挂起期间不前进；帧恢复后继续计数，帧完成（出栈）即退出。
 *    有效门槛取栈上所有帧（含被抢占挂起的帧）未结束区间的最高值，
 *    与阶段 A 的优先级修改在同一拍参与裁决。
 */
import { comparePending, MAX_TICKS, } from './model.js';
/** 校验配置与事件，返回告警/错误。 */
export function validateInput(lines, events) {
    const errors = [];
    const warnings = [];
    if (lines.length < 1 || lines.length > 8) {
        errors.push(`中断线数量必须在 1～8 之间，当前为 ${lines.length} 条。`);
    }
    const ids = new Set();
    for (const ln of lines) {
        if (!ln.id || !ln.id.trim())
            errors.push('存在空 ID 的中断线。');
        if (ids.has(ln.id))
            errors.push(`中断线 ID 重复：${ln.id}`);
        ids.add(ln.id);
        if (!Number.isInteger(ln.priority))
            errors.push(`线 ${ln.id} 的优先级必须是整数。`);
        if (!Number.isInteger(ln.handlerTicks) || ln.handlerTicks < 1) {
            errors.push(`线 ${ln.id} 的 handlerTicks 必须是 >= 1 的整数。`);
        }
        if (ln.mode !== 'edge' && ln.mode !== 'level') {
            errors.push(`线 ${ln.id} 的模式必须是 edge 或 level。`);
        }
        const css = ln.criticalSections ?? [];
        let shapeOk = true;
        for (const cs of css) {
            if (!Number.isInteger(cs.from) || !Number.isInteger(cs.to) || !Number.isInteger(cs.threshold)) {
                errors.push(`线 ${ln.id} 的临界区间 from/to/threshold 必须都是整数。`);
                shapeOk = false;
                continue;
            }
            if (cs.from < 0 || cs.from >= cs.to || cs.to > ln.handlerTicks) {
                errors.push(`线 ${ln.id} 的临界区间 [${cs.from}, ${cs.to}) 必须满足 0 <= from < to <= handlerTicks(${ln.handlerTicks})。`);
                shapeOk = false;
            }
        }
        if (shapeOk) {
            // 区间互不重叠：按起点排序后，每个区间的起点不得早于前一个区间的终点。
            const sorted = [...css].sort((a, b) => a.from - b.from);
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i].from < sorted[i - 1].to) {
                    errors.push(`线 ${ln.id} 的临界区间 [${sorted[i - 1].from}, ${sorted[i - 1].to}) 与 [${sorted[i].from}, ${sorted[i].to}) 重叠。`);
                }
            }
        }
    }
    for (const ev of events) {
        if (!ids.has(ev.lineId)) {
            errors.push(`tick ${ev.at} 的事件引用了不存在的线：${ev.lineId}`);
        }
        if (!Number.isInteger(ev.at) || ev.at < 1) {
            errors.push(`线 ${ev.lineId} 存在非法 tick（需为 >= 1 的整数）：${ev.at}`);
        }
        if (ev.at > MAX_TICKS) {
            warnings.push(`tick ${ev.at} 超出 ${MAX_TICKS} tick 回放窗口，该事件永远不会被应用。`);
        }
        if (ev.kind === 'setPriority' && !Number.isInteger(ev.priority)) {
            errors.push(`tick ${ev.at} 的优先级调整缺少整数 priority：${ev.lineId}`);
        }
        if (ev.kind === 'setMode' && ev.mode !== 'edge' && ev.mode !== 'level') {
            errors.push(`tick ${ev.at} 的模式调整必须指定 edge 或 level：${ev.lineId}`);
        }
        const cfg = lines.find((l) => l.id === ev.lineId);
        if (cfg?.mode === 'edge' && ev.kind === 'lower') {
            warnings.push(`tick ${ev.at}：边沿线 ${ev.lineId} 的 lower 事件无意义，已忽略。`);
        }
    }
    return { errors, warnings };
}
/** 逐 tick 推进器：同一状态机既支持单步也支持整批回放。 */
export class ReplayController {
    constructor(lines, events, warnings = []) {
        this.lastTick = 0;
        this.truncated = false;
        this.logs = [];
        this.ticks = [];
        this.state = {
            cfg: new Map(lines.map((l) => [l.id, l])),
            pending: [],
            levelAsserted: new Set(),
            masked: new Set(lines.filter((l) => l.initiallyMasked).map((l) => l.id)),
            stack: [],
            runningIds: new Set(),
        };
        this.eventsByTick = new Map();
        for (const ev of events) {
            const list = this.eventsByTick.get(ev.at) ?? [];
            list.push(ev);
            this.eventsByTick.set(ev.at, list);
        }
        this.warnings = warnings;
    }
    get currentTick() {
        return this.lastTick;
    }
    get isTruncated() {
        return this.truncated;
    }
    /** 是否还有工作（未来事件 / 执行栈 / 可运行待处理位）。 */
    hasWorkAfter(tick) {
        if (this.state.stack.length > 0)
            return true;
        for (const key of this.eventsByTick.keys()) {
            if (key > tick)
                return true;
        }
        return this.runnablePending().length > 0;
    }
    /** 推进一个 tick；没有任何剩余工作时返回 null。 */
    step() {
        if (this.lastTick >= MAX_TICKS) {
            this.truncated = this.hasWorkAfter(this.lastTick);
            return null;
        }
        if (!this.hasWorkAfter(this.lastTick))
            return null;
        const tick = this.lastTick + 1;
        const rec = this.runTick(tick);
        this.lastTick = tick;
        this.ticks.push(rec);
        return rec;
    }
    /** 一次推进 n 个 tick（用于测试「不同批次推进」与逐 tick 完全一致）。 */
    advance(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const rec = this.step();
            if (!rec)
                break;
            out.push(rec);
        }
        return out;
    }
    toTrace() {
        return { ticks: this.ticks, logs: this.logs, truncated: this.truncated, warnings: this.warnings };
    }
    // ------------------------------------------------------------------
    // 阶段 A：事件
    // ------------------------------------------------------------------
    applyEvent(ev, tick) {
        const { cfg, pending, levelAsserted, masked, runningIds } = this.state;
        const line = cfg.get(ev.lineId);
        const existing = pending.find((p) => p.lineId === ev.lineId);
        switch (ev.kind) {
            case 'raise': {
                if (line.mode === 'edge') {
                    // 边沿：待处理位尚未被调度消费时（无论屏蔽、空闲还是本线正在运行），
                    // 重复触发都合并为一位，hits 累加并保留最早 since。
                    if (existing) {
                        existing.hits += 1;
                    }
                    else {
                        pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'edge' });
                    }
                }
                else {
                    // 电平：置高输入。屏蔽 / 正在运行都不丢失输入状态，
                    // 但只有未屏蔽且未运行时才立即可调度。
                    levelAsserted.add(line.id);
                    if (!masked.has(line.id) && !runningIds.has(line.id) && !existing) {
                        pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'level' });
                    }
                }
                break;
            }
            case 'lower': {
                if (line.mode === 'level') {
                    levelAsserted.delete(line.id);
                    // 还没被调度消费的 level 待处理位随撤销而消失；
                    // 已在执行栈中的处理程序不受影响（屏蔽/撤销不杀正在运行的程序）。
                    if (!runningIds.has(line.id)) {
                        const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === 'level');
                        if (idx >= 0)
                            pending.splice(idx, 1);
                    }
                }
                // edge 线的 lower 在 validateInput 中已作为告警，这里直接忽略。
                break;
            }
            case 'mask': {
                masked.add(line.id);
                // 电平位被屏蔽后立即失去调度资格并移出待处理集合，
                // 输入电平本身不撤销（解除屏蔽时若仍有效会重新置位）。
                if (line.mode === 'level' && !runningIds.has(line.id)) {
                    const idx = pending.findIndex((p) => p.lineId === line.id && p.kind === 'level');
                    if (idx >= 0)
                        pending.splice(idx, 1);
                }
                // 边沿位按需求在屏蔽期间保留（重复触发继续合并），不动 pending。
                break;
            }
            case 'unmask': {
                masked.delete(line.id);
                // 解除屏蔽不会合成边沿；但仍有效的电平线立即恢复可调度，
                // since 取「当前可运行」的时刻（解除屏蔽的时刻）。
                if (line.mode === 'level' &&
                    levelAsserted.has(line.id) &&
                    !runningIds.has(line.id) &&
                    !pending.some((p) => p.lineId === line.id)) {
                    pending.push({ lineId: line.id, since: tick, hits: 1, kind: 'level' });
                }
                break;
            }
            case 'setPriority': {
                cfg.set(line.id, { ...line, priority: ev.priority });
                break;
            }
            case 'setMode': {
                if (ev.mode !== line.mode) {
                    // 真正切换模式：旧模式遗留的触发状态失效 —— 丢弃待处理位，
                    // 并忘掉已记电平（切到边沿不会把保持的电平合成边沿；
                    // 切到电平时本线也不可能有已记电平）。运行中的帧不受影响。
                    for (let i = pending.length - 1; i >= 0; i--) {
                        if (pending[i].lineId === line.id)
                            pending.splice(i, 1);
                    }
                    levelAsserted.delete(line.id);
                }
                cfg.set(line.id, { ...line, mode: ev.mode });
                break;
            }
        }
    }
    // ------------------------------------------------------------------
    // 调度辅助
    // ------------------------------------------------------------------
    /** 当前有资格被调度的待处理位（未屏蔽、未在栈中），按调度顺序排序。 */
    runnablePending() {
        const { masked, runningIds } = this.state;
        return this.state.pending
            .filter((p) => !masked.has(p.lineId) && !runningIds.has(p.lineId))
            .sort((a, b) => {
            // 主排序：优先级高者先；次排序：置位时刻、ID（同优先级等待规则）。
            const pa = this.state.cfg.get(a.lineId).priority;
            const pb = this.state.cfg.get(b.lineId).priority;
            if (pa !== pb)
                return pb - pa;
            return comparePending(a, b);
        });
    }
    /**
     * 有效门槛：执行栈上所有帧（含被抢占挂起的帧）中，已执行拍数落在
     * [from, to) 内的临界区间的最高门槛；挂起帧的 elapsed 不前进，
     * 其区间状态随帧恢复/完成而变化。无生效区间时 threshold 为 null。
     */
    criticalCeiling() {
        let best = null;
        const sources = [];
        for (const f of this.state.stack) {
            const cfg = this.state.cfg.get(f.lineId);
            for (const cs of cfg.criticalSections ?? []) {
                if (f.elapsed >= cs.from && f.elapsed < cs.to) {
                    if (best === null || cs.threshold > best) {
                        best = cs.threshold;
                        sources.length = 0;
                        sources.push({ lineId: f.lineId, from: cs.from, to: cs.to, threshold: cs.threshold });
                    }
                    else if (cs.threshold === best) {
                        sources.push({ lineId: f.lineId, from: cs.from, to: cs.to, threshold: cs.threshold });
                    }
                }
            }
        }
        return { threshold: best, sources };
    }
    // ------------------------------------------------------------------
    // 单 tick
    // ------------------------------------------------------------------
    runTick(tick) {
        const eventsApplied = [];
        let completed;
        // 阶段 A：应用事件（同一 tick 多事件按输入顺序）。
        for (const ev of this.eventsByTick.get(tick) ?? []) {
            const cfg = this.state.cfg.get(ev.lineId);
            if (!cfg)
                continue;
            if (cfg.mode === 'edge' && ev.kind === 'lower')
                continue;
            this.applyEvent(ev, tick);
            eventsApplied.push(ev.kind === 'setPriority'
                ? { lineId: ev.lineId, kind: ev.kind, priority: ev.priority }
                : ev.kind === 'setMode'
                    ? { lineId: ev.lineId, kind: ev.kind, mode: ev.mode }
                    : { lineId: ev.lineId, kind: ev.kind });
            this.logs.push({
                tick,
                type: 'event',
                lineId: ev.lineId,
                eventKind: ev.kind,
                detail: `tick ${tick} 事件：${ev.lineId} ${eventLabel(ev.kind)}${ev.kind === 'setPriority' ? ` ${ev.priority}` : ''}`,
            });
        }
        // 阶段 B：处理上一 tick 的完成（栈顶 elapsed 已达 total）。
        const top = this.state.stack[this.state.stack.length - 1];
        if (top && top.elapsed >= top.total) {
            this.state.stack.pop();
            this.state.runningIds.delete(top.lineId);
            completed = { lineId: top.lineId };
            this.logs.push({
                tick,
                type: 'complete',
                lineId: top.lineId,
                detail: `tick ${tick} 完成：${top.lineId}（共 ${top.total} tick）`,
            });
            // 完成后：电平仍有效 → 重新成为可运行待处理位（电平重入）。
            const cfg = this.state.cfg.get(top.lineId);
            if (cfg.mode === 'level' &&
                this.state.levelAsserted.has(top.lineId) &&
                !this.state.masked.has(top.lineId) &&
                !this.state.pending.some((p) => p.lineId === top.lineId)) {
                this.state.pending.push({ lineId: top.lineId, since: tick, hits: 1, kind: 'level' });
            }
            // 露出的父帧标记为「抢占结束」，本 tick 稍后可能 resume。
            const parent = this.state.stack[this.state.stack.length - 1];
            if (parent)
                parent.preempted = true;
        }
        // 阶段 C：抢占 / 调度。
        const runnable = this.runnablePending();
        const winner = runnable[0];
        let action;
        const currentTop = this.state.stack[this.state.stack.length - 1];
        // 有效门槛：在应用了当拍事件（A）与上一拍完成（B）之后计算，
        // 本 tick 的抢占裁决、轨迹记录与日志引用同一个值。
        const ceiling = this.criticalCeiling();
        const blocked = [];
        if (!currentTop) {
            // 栈空：取优先级最高的可运行待处理线进入。
            if (winner) {
                this.enterFrame(winner, tick);
                action = { type: 'enter', lineId: winner.lineId };
            }
            else {
                action = { type: 'idle' };
            }
        }
        else {
            const topPri = this.state.cfg.get(currentTop.lineId).priority;
            const winPri = winner ? this.state.cfg.get(winner.lineId).priority : null;
            // 仅严格更高优先级可抢占当前程序；同优先级即使等待也不动。
            // 比较用双方「当前」优先级：setPriority 在阶段 A 生效后，
            // 本 tick 的抢占判断即按新优先级执行。
            // 此外还须严格高于有效门槛：临界区间生效期间，不足够高优先级的
            // 待处理线被挡在门外，真正紧急（严格更高）的线仍可进入。
            const deniedByCeiling = winner !== undefined && winPri > topPri && ceiling.threshold !== null && winPri <= ceiling.threshold;
            if (winner && winPri > topPri && !deniedByCeiling) {
                currentTop.preempted = true;
                this.enterFrame(winner, tick);
                action = { type: 'preempt', by: winner.lineId, resumed: currentTop.lineId };
                this.logs.push({
                    tick,
                    type: 'preempt',
                    lineId: winner.lineId,
                    detail: `tick ${tick} 抢占：${winner.lineId}（优先级 ${winPri}）抢占 ${currentTop.lineId}（优先级 ${topPri}）${ceiling.threshold !== null ? `，已严格高于有效门槛 ${ceiling.threshold}` : ''}，同优先级候选继续等待`,
                });
            }
            else {
                if (deniedByCeiling) {
                    // 被门槛挡住的线：待处理位与排序证据（since / hits）原样保留。
                    for (const p of runnable) {
                        const pp = this.state.cfg.get(p.lineId).priority;
                        if (pp > topPri) {
                            blocked.push({ lineId: p.lineId, priority: pp, topPriority: topPri, threshold: ceiling.threshold });
                        }
                    }
                    const src = ceiling.sources.map((s) => `${s.lineId} 临界区[${s.from},${s.to})`).join('、');
                    this.logs.push({
                        tick,
                        type: 'block',
                        lineId: winner.lineId,
                        detail: `tick ${tick} 阻挡：${blocked
                            .map((b) => `${b.lineId}（优先级 ${b.priority}）`)
                            .join('、')} 未严格高于有效门槛 ${ceiling.threshold}（${src}），抢占被拒，待处理位保留`,
                    });
                }
                if (currentTop.preempted) {
                    // 抢占者已完成、露出的父帧本 tick 恢复（无更高优先级再抢占）。
                    action = { type: 'resume', lineId: currentTop.lineId };
                }
                else {
                    action = { type: 'continue', lineId: currentTop.lineId };
                }
            }
        }
        // 阶段 D：栈顶执行 1 tick（刚进入的帧也算第 1 个执行 tick；
        // 被抢占而挂起的帧此 tick 不执行、不消耗 handlerTicks）。
        const execTop = this.state.stack[this.state.stack.length - 1];
        if (execTop) {
            execTop.elapsed += 1;
            if (action.type === 'enter') {
                this.logs.push({
                    tick,
                    type: 'enter',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 进入：${execTop.lineId}（需要 ${execTop.total} tick）`,
                });
            }
            else if (action.type === 'preempt') {
                this.logs.push({
                    tick,
                    type: 'enter',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 进入：${execTop.lineId}（抢占进入，需要 ${execTop.total} tick）`,
                });
            }
            else if (action.type === 'resume') {
                this.logs.push({
                    tick,
                    type: 'resume',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 恢复：${execTop.lineId}（已执行 ${execTop.elapsed}/${execTop.total}）`,
                });
                // 恢复并执行一个 tick 后，抢占痕迹消费完毕，此后按 continue 记录。
                execTop.preempted = false;
            }
            else if (action.type === 'continue') {
                this.logs.push({
                    tick,
                    type: 'continue',
                    lineId: execTop.lineId,
                    detail: `tick ${tick} 执行：${execTop.lineId}（已执行 ${execTop.elapsed}/${execTop.total}）`,
                });
            }
        }
        return {
            tick,
            eventsApplied,
            completed,
            action,
            stack: this.state.stack.map((f) => ({ ...f })),
            pending: this.state.pending.slice().sort(comparePending).map((p) => ({ ...p })),
            levelAsserted: [...this.state.levelAsserted].sort(),
            masked: [...this.state.masked].sort(),
            topRemaining: execTop ? execTop.total - execTop.elapsed : null,
            effectiveThreshold: ceiling.threshold,
            thresholdSources: ceiling.sources,
            blocked,
        };
    }
    enterFrame(p, tick) {
        const cfg = this.state.cfg.get(p.lineId);
        this.state.pending = this.state.pending.filter((x) => x !== p);
        this.state.stack.push({
            lineId: p.lineId,
            total: cfg.handlerTicks,
            elapsed: 0,
            enteredAt: tick,
            preempted: false,
        });
        this.state.runningIds.add(p.lineId);
    }
}
function eventLabel(kind) {
    switch (kind) {
        case 'raise':
            return 'raise（触发/拉高）';
        case 'lower':
            return 'lower（撤销电平）';
        case 'mask':
            return 'mask（屏蔽）';
        case 'unmask':
            return 'unmask（解除屏蔽）';
        case 'setPriority':
            return 'setPriority（调整优先级）';
        case 'setMode':
            return 'setMode（切换触发模式）';
        default:
            return kind;
    }
}
/** 整批回放：推进到无剩余工作或达到 500 tick 上限。 */
export function runReplay(lines, events) {
    const { errors, warnings } = validateInput(lines, events);
    if (errors.length > 0) {
        throw new Error('配置无效：\n' + errors.map((e) => ' - ' + e).join('\n'));
    }
    const ctrl = new ReplayController(lines, events, warnings);
    while (ctrl.step() !== null) {
        // 逐 tick 推进，直到空闲且无未来事件，或触顶 500。
    }
    return ctrl.toTrace();
}
