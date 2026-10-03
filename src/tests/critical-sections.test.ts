/**
 * Vitest：以独立逐拍状态机（gate-machine.ts，表驱动的第三套实现）
 * 核对产品实现 simulator.ts 的临界区间语义。
 *
 * 覆盖需求点名的五类：嵌套抢占、边沿合并、电平重入、屏蔽、临界区间边界；
 * 并逐拍比较 action、帧（id/elapsed）、待处理位（id/since/hits）、
 * 有效门槛及其来源、每个被挡候选的原因。
 */

import { describe, it, expect } from 'vitest';
import { LineConfig, ScheduledEvent } from '../model.js';
import { ReplayController, runReplay } from '../simulator.js';
import { GateMachine, GateTick } from './gate-machine.js';

/** 把产品某拍归一化为与门槛机同构的最小投影。 */
function project(ctrl: ReplayController, t: number) {
  const r = ctrl.ticks[t - 1];
  let action: string;
  switch (r.action.type) {
    case 'enter':
      action = `enter:${r.action.lineId}`;
      break;
    case 'preempt':
      action = `preempt:${r.action.by}>${r.action.resumed}`;
      break;
    case 'resume':
      action = `resume:${r.action.lineId}`;
      break;
    case 'continue':
      action = `cont:${r.action.lineId}`;
      break;
    default:
      action = 'idle';
  }
  return {
    tick: r.tick,
    action,
    frames: r.stack.map((f) => ({ lineId: f.lineId, elapsed: f.elapsed, total: f.total, preempted: f.preempted, enteredAt: f.enteredAt })),
    pending: r.pending.map((p) => ({ lineId: p.lineId, since: p.since, hits: p.hits, kind: p.kind })),
    level: r.levelAsserted,
    masked: r.masked,
    floor: r.arbitration.priorityFloor,
    floorSource: r.arbitration.floorSourceLineId,
    activeSectionFrames: r.arbitration.activeSections.map((s) => s.frameLineId),
    blocked: r.arbitration.blocked.map((b) => {
      const x: GateTick['blocked'][number] = { lineId: b.lineId, priority: b.priority, reason: b.reason };
      if (b.reason === 'critical-gate') {
        x.priorityFloor = b.priorityFloor;
        x.floorSourceLineId = b.floorSourceLineId;
      }
      return x;
    }),
  };
}

/** 产品实现分别用批次 1/3/整批推进，与门槛机（永远逐拍）逐拍比较。 */
function expectAgreement(name: string, lines: LineConfig[], events: ScheduledEvent[]): void {
  it(`逐拍一致：${name}`, () => {
    for (const batch of [1, 3, 'all'] as const) {
      const ctrl = new ReplayController(lines, events);
      if (batch === 'all') while (ctrl.step() !== null) {}
      else while (ctrl.advance(batch).length > 0) {}
      const gates = new GateMachine(lines, events).run();

      expect(ctrl.ticks.length, `批次数 ${batch} 的拍数`).toBe(gates.length);
      for (let i = 0; i < gates.length; i++) {
        expect(project(ctrl, gates[i].tick), `tick ${gates[i].tick}（批次 ${batch}）`).toEqual(gates[i]);
      }
    }
  });
}

function actions(trace: ReturnType<typeof runReplay>): string[] {
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
      default:
        return 'idle';
    }
  });
}

const CS_LINES: LineConfig[] = [
  { id: 'A', priority: 2, mode: 'edge', handlerTicks: 5, criticalSections: [{ startTick: 2, endTick: 4, priorityFloor: 5 }] },
  { id: 'B', priority: 4, mode: 'edge', handlerTicks: 1 },
  { id: 'C', priority: 6, mode: 'edge', handlerTicks: 1 },
];

describe('临界区间门槛', () => {
  expectAgreement('门槛阻挡/紧急进入/区间后放行', CS_LINES, [
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'B', kind: 'raise' },
    { at: 3, lineId: 'C', kind: 'raise' },
  ]);

  it('B(p4) 在门槛5内连续被挡并保留待处理位，C(p6) 可入，区间结束后 B 才抢占', () => {
    const trace = runReplay(CS_LINES, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 3, lineId: 'C', kind: 'raise' },
    ]);
    expect(actions(trace)).toEqual([
      'enter:A',
      'cont:A',
      'preempt:C>A',
      'resume:A',
      'cont:A',
      'preempt:B>A',
      'resume:A',
      'idle',
    ]);
    // 区间按 A 实际执行拍计数：t2、t4、t5 在区间内；t3 A 挂起不前进。
    expect(trace.ticks[1].arbitration.priorityFloor).toBe(5);
    expect(trace.ticks[2].arbitration.priorityFloor).toBe(5); // A 挂起，elapsed 冻结
    expect(trace.ticks[3].arbitration.priorityFloor).toBe(5);
    expect(trace.ticks[4].arbitration.priorityFloor).toBe(5);
    expect(trace.ticks[5].arbitration.priorityFloor).toBeNull(); // 下一执行拍=5，区间退出
    // 被挡期间 B 的待处理位与排序证据不动。
    for (const i of [1, 2, 3, 4]) {
      const b = trace.ticks[i].pending.find((p) => p.lineId === 'B');
      expect(b?.since).toBe(2);
      expect(b?.hits).toBe(1);
    }
  });

  it('模型/裁决/日志展示同一门槛与阻挡原因', () => {
    const trace = runReplay(CS_LINES, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
    ]);
    const rec = trace.ticks[1];
    expect(rec.arbitration.priorityFloor).toBe(5);
    expect(rec.arbitration.blocked).toEqual([
      { lineId: 'B', priority: 4, reason: 'critical-gate', priorityFloor: 5, floorSourceLineId: 'A' },
    ]);
    const log = trace.logs.find((l) => l.tick === 2 && l.type === 'block')!;
    expect(log.lineId).toBe('B');
    expect(log.priorityFloor).toBe(5);
    expect(log.detail).toContain('5');
  });
});

describe('临界区间边界（单拍、端点）', () => {
  const lines: LineConfig[] = [
    { id: 'D', priority: 1, mode: 'edge', handlerTicks: 3, criticalSections: [{ startTick: 2, endTick: 2, priorityFloor: 10 }] },
    { id: 'X', priority: 5, mode: 'edge', handlerTicks: 1 },
  ];
  expectAgreement('仅第2拍有门槛', lines, [
    { at: 1, lineId: 'D', kind: 'raise' },
    { at: 2, lineId: 'X', kind: 'raise' },
  ]);

  it('门槛恰在第2拍存在，第1拍前与第3拍后都可抢占', () => {
    const trace = runReplay(lines, [
      { at: 1, lineId: 'D', kind: 'raise' },
      { at: 2, lineId: 'X', kind: 'raise' },
    ]);
    expect(trace.ticks[0].arbitration.priorityFloor).toBeNull();
    expect(trace.ticks[1].arbitration.priorityFloor).toBe(10);
    expect(trace.ticks[2].arbitration.priorityFloor).toBeNull();
    expect(actions(trace)).toEqual(['enter:D', 'cont:D', 'preempt:X>D', 'resume:D', 'idle']);
  });

  it('区间覆盖整个 handlerTicks 时全程受门槛保护（进入拍裁决在压栈前，故从第 2 拍起有门槛）', () => {
    const trace = runReplay(
      [{ id: 'H', priority: 1, mode: 'edge', handlerTicks: 2, criticalSections: [{ startTick: 1, endTick: 2, priorityFloor: 9 }] }],
      [
        { at: 1, lineId: 'H', kind: 'raise' },
        { at: 2, lineId: 'H', kind: 'raise' },
      ]
    );
    // t1 阶段 C 裁决时栈尚空（帧在本拍才压入），门槛 null；自 t2 起区间全程生效。
    expect(trace.ticks[0].arbitration.priorityFloor).toBeNull();
    expect(trace.ticks[1].arbitration.priorityFloor).toBe(9);
  });
});

describe('嵌套抢占与门槛取值', () => {
  const lines: LineConfig[] = [
    { id: 'A', priority: 1, mode: 'edge', handlerTicks: 8, criticalSections: [{ startTick: 2, endTick: 7, priorityFloor: 3 }] },
    { id: 'B', priority: 4, mode: 'edge', handlerTicks: 3, criticalSections: [{ startTick: 2, endTick: 2, priorityFloor: 6 }] },
    { id: 'C', priority: 5, mode: 'edge', handlerTicks: 1 },
    { id: 'Hi', priority: 7, mode: 'edge', handlerTicks: 1 },
  ];
  expectAgreement('嵌套 + 全栈最高门槛 + 冻结/退出', lines, [
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'B', kind: 'raise' },
    { at: 3, lineId: 'C', kind: 'raise' },
    { at: 4, lineId: 'Hi', kind: 'raise' },
  ]);

  it('门槛取栈中所有未结束区间的最高值；外层区间随挂起冻结、随恢复继续', () => {
    const trace = runReplay(lines, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'B', kind: 'raise' },
      { at: 3, lineId: 'C', kind: 'raise' },
      { at: 4, lineId: 'Hi', kind: 'raise' },
    ]);
    // t2：A 门槛3 允许 B(p4) 抢占。
    expect(trace.ticks[1].action).toEqual({ type: 'preempt', by: 'B', resumed: 'A' });
    // t3：A(frozen) 门槛3 + B 门槛6 → 有效 6，C(p5) 被挡。
    const arb = trace.ticks[2].arbitration;
    expect(arb.priorityFloor).toBe(6);
    expect(arb.floorSourceLineId).toBe('B');
    expect(arb.activeSections.map((s) => s.frameLineId).sort()).toEqual(['A', 'B']);
    expect(arb.blocked.find((b) => b.lineId === 'C')?.reason).toBe('critical-gate');
    // t4：B 区间退出（下一执行拍3），只剩 A 的 3，Hi(p7) 可入。
    expect(trace.ticks[3].arbitration.priorityFloor).toBe(3);
    expect(trace.ticks[3].action).toEqual({ type: 'preempt', by: 'Hi', resumed: 'B' });
    // A 的 elapsed 自 t2 起一直冻结在 1（被 B/Hi 抢占），恢复后区间继续。
    const aFrameAt5 = trace.ticks[4].stack.find((f) => f.lineId === 'A')!;
    expect(aFrameAt5.elapsed).toBe(1);
  });
});

describe('边沿合并（被门槛挡下期间）', () => {
  const lines: LineConfig[] = [
    { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4, criticalSections: [{ startTick: 2, endTick: 3, priorityFloor: 5 }] },
    { id: 'E', priority: 5, mode: 'edge', handlerTicks: 1 },
  ];
  const events: ScheduledEvent[] = [
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'E', kind: 'raise' },
    { at: 2, lineId: 'E', kind: 'raise' },
    { at: 3, lineId: 'E', kind: 'raise' },
  ];
  expectAgreement('被挡期间重复边沿合并、放行后进入一次', lines, events);

  it('3 次触发合并为 1 位（hits=3、since 最早），区间内被挡，结束后进入一次', () => {
    const trace = runReplay(lines, events);
    const p3 = trace.ticks[2].pending.find((p) => p.lineId === 'E')!;
    expect(p3.hits).toBe(3);
    expect(p3.since).toBe(2);
    // E(p5) 需严格高于门槛5：5 不大于 5，t2/t3 均被挡。
    expect(trace.ticks[1].arbitration.blocked.find((b) => b.lineId === 'E')?.reason).toBe('critical-gate');
    expect(trace.ticks[2].arbitration.blocked.find((b) => b.lineId === 'E')?.reason).toBe('critical-gate');
    // t4 区间退出（A 下一执行拍4），合并位被消费，只进入一次。
    expect(trace.ticks[3].action).toEqual({ type: 'preempt', by: 'E', resumed: 'A' });
    expect(trace.ticks[3].pending.some((p) => p.lineId === 'E')).toBe(false);
  });

  it('真正紧急(p6)在门槛5区间内当拍即可进入，待处理位不保留', () => {
    const hi: LineConfig[] = [
      lines[0],
      { id: 'E', priority: 6, mode: 'edge', handlerTicks: 1 },
    ];
    const trace = runReplay(hi, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'E', kind: 'raise' },
    ]);
    expect(trace.ticks[1].action).toEqual({ type: 'preempt', by: 'E', resumed: 'A' });
    expect(trace.ticks[1].arbitration.blocked).toEqual([]);
  });
});

describe('电平重入（区间随每次调用重置）', () => {
  const lines: LineConfig[] = [
    { id: 'L', priority: 1, mode: 'level', handlerTicks: 2, criticalSections: [{ startTick: 2, endTick: 2, priorityFloor: 5 }] },
    { id: 'U', priority: 3, mode: 'edge', handlerTicks: 1 },
  ];
  expectAgreement('电平第二次调用区间重新生效', lines, [
    { at: 1, lineId: 'L', kind: 'raise' },
    { at: 2, lineId: 'U', kind: 'raise' },
  ]);

  it('每次完成重入都从第1拍重新计数；每次调用的第 2 拍（t2、t7、t9…）区间重新生效', () => {
    const trace = runReplay(lines, [
      { at: 1, lineId: 'L', kind: 'raise' },
      { at: 2, lineId: 'U', kind: 'raise' },
    ]);
    const floorTicks = trace.ticks.filter((r) => r.arbitration.priorityFloor === 5).map((r) => r.tick);
    // t2：第一次调用第2拍（L 在 t3 才完成出栈）；t3 U 进入；t4 L 第二次进入，
    // t5 为其第2拍；此后每 2 拍重入一次（t7、t9…），每次区间都从第1拍重新计数。
    expect(floorTicks.slice(0, 4)).toEqual([2, 5, 7, 9]);
  });
});

describe('屏蔽与门槛', () => {
  const lines: LineConfig[] = [
    { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4, criticalSections: [{ startTick: 2, endTick: 3, priorityFloor: 5 }] },
    { id: 'M', priority: 3, mode: 'edge', handlerTicks: 1 },
  ];
  expectAgreement('屏蔽中不参与裁决，unmask 当拍再裁决', lines, [
    { at: 1, lineId: 'A', kind: 'raise' },
    { at: 2, lineId: 'M', kind: 'raise' },
    { at: 2, lineId: 'M', kind: 'mask' },
    { at: 4, lineId: 'M', kind: 'unmask' },
  ]);

  it('屏蔽线不进入 blocked；边沿位保留；unmask 当拍按区间是否结束裁决', () => {
    const trace = runReplay(lines, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'M', kind: 'raise' },
      { at: 2, lineId: 'M', kind: 'mask' },
      { at: 4, lineId: 'M', kind: 'unmask' },
    ]);
    expect(trace.ticks[1].arbitration.blocked.some((b) => b.lineId === 'M')).toBe(false);
    expect(trace.ticks[1].pending.some((p) => p.lineId === 'M')).toBe(true);
    // t4：A 区间已结束（下一执行拍4），M 解除屏蔽当拍即可抢占。
    expect(trace.ticks[3].action).toEqual({ type: 'preempt', by: 'M', resumed: 'A' });
  });

  it('屏蔽期内门槛阻挡与屏蔽原因互斥：先屏蔽则不产生 critical-gate', () => {
    const trace = runReplay(lines, [
      { at: 1, lineId: 'A', kind: 'raise' },
      { at: 2, lineId: 'M', kind: 'mask' },
      { at: 2, lineId: 'M', kind: 'raise' },
    ]);
    expect(trace.ticks[1].arbitration.blocked).toEqual([]);
    expect(trace.ticks[1].pending.find((p) => p.lineId === 'M')?.since).toBe(2);
  });
});

describe('未配置临界区间的旧轨迹保持不变', () => {
  it('没有 criticalSections 时门槛恒为 null、无 block 日志', () => {
    const trace = runReplay(
      [
        { id: 'A', priority: 1, mode: 'edge', handlerTicks: 4 },
        { id: 'B', priority: 2, mode: 'edge', handlerTicks: 1 },
      ],
      [
        { at: 1, lineId: 'A', kind: 'raise' },
        { at: 2, lineId: 'B', kind: 'raise' },
      ]
    );
    expect(trace.ticks.every((r) => r.arbitration.priorityFloor === null)).toBe(true);
    expect(trace.logs.some((l) => l.type === 'block')).toBe(false);
  });
});

describe('随机属性：门槛机 vs 产品实现逐拍一致', () => {
  // 独立确定性 PRNG（与 run-tests.ts 不同种子）。
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('120 个随机配置/事件（含随机互不重叠区间）全部对齐', () => {
    const rand = rng(7788991);
    const kinds: ScheduledEvent['kind'][] = ['raise', 'lower', 'mask', 'unmask', 'setPriority', 'setMode'];
    for (let it = 0; it < 120; it++) {
      const n = 1 + Math.floor(rand() * 6);
      const ids = Array.from({ length: n }, (_, i) => 'X' + i);
      const lines: LineConfig[] = ids.map((id) => {
        const h = 1 + Math.floor(rand() * 5);
        const line: LineConfig = {
          id,
          priority: 1 + Math.floor(rand() * 5),
          mode: rand() < 0.5 ? 'edge' : 'level',
          handlerTicks: h,
          initiallyMasked: rand() < 0.12,
        };
        if (rand() < 0.5) {
          // 在 1..h 的拍轴上随机切 1~3 个不重叠段落。
          const cuts = [0, ...Array.from({ length: 1 + Math.floor(rand() * 2) }, () => Math.floor(rand() * h)).sort((a, b) => a - b), h];
          const secs = [];
          for (let k = 1; k < cuts.length; k++) {
            const s = cuts[k - 1] + 1;
            const e = cuts[k];
            if (s <= e && rand() < 0.55) secs.push({ startTick: s, endTick: e, priorityFloor: 1 + Math.floor(rand() * 7) });
          }
          if (secs.length) line.criticalSections = secs;
        }
        return line;
      });
      const events: ScheduledEvent[] = Array.from({ length: Math.floor(rand() * 20) }, () => {
        const kind = kinds[Math.floor(rand() * kinds.length)];
        const ev: ScheduledEvent = { at: 1 + Math.floor(rand() * 24), lineId: ids[Math.floor(rand() * n)], kind };
        if (kind === 'setPriority') ev.priority = 1 + Math.floor(rand() * 7);
        if (kind === 'setMode') ev.mode = rand() < 0.5 ? 'edge' : 'level';
        return ev;
      });

      const gates = new GateMachine(lines, events).run();
      for (const batch of [1, 4, 'all'] as const) {
        const ctrl = new ReplayController(lines, events);
        if (batch === 'all') while (ctrl.step() !== null) {}
        else while (ctrl.advance(batch).length > 0) {}
        expect(ctrl.ticks.length, `#${it} 拍数一致 batch=${batch}`).toBe(gates.length);
        for (let i = 0; i < gates.length; i++) {
          expect(project(ctrl, gates[i].tick), `#${it} tick ${gates[i].tick} batch=${batch}`).toEqual(gates[i]);
        }
      }
    }
  });
});
