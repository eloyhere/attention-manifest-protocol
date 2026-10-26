# 注意力资源：进程容量与线程分配

> 状态：v0.1。实现：`src/attention/resource.ts`；认知状态估计在 `src/attention/cognition.ts`。
> 设计原则：注意力是**有上限、多维、状态依赖**的资源；CPU 利用率只是结构类比，不是目标。

## 0. 一句话

**进程注意力**是 agent 的总容量与恢复债；**线程注意力**是某个任务分到的窗口/时间片/工作集。
一个进程同一时刻只有一个前台线程；后台过程从 reserve 中分配，安全监控有硬下限。

## 1. 为什么不是单一 CPU 百分比

| CPU | 人的注意力 |
| --- | --- |
| 时间单维、可互换 | 多资源池（视觉/语言/执行），不可简单互换 |
| 100% 可长期持续 | 100% 会过载、错误上升、视野窄化 |
| idle 是浪费 | idle/rest 是恢复与整合 |
| 抢占便宜 | 切换有残留与打断成本 |
| 容量固定 | 容量随技能、压力、疲劳、睡眠变化 |

因此：**utilization 只是一个指标**，不能单独作为优化目标。

## 2. 两层模型

### 2.1 ProcessAttention

```ts
interface ProcessAttention {
  pid: number;
  effectiveSlots: number;   // 工作记忆/容量，load 后
  foregroundCap: number;    // 前台上限 = floor(effective * maxForegroundUtil)
  reserveSlots: number;     // 后台 + 安全 + 恢复
  safetySlots: number;      // 硬下限
  state: CognitiveState;    // load/vigilance/arousal/mastery/accountability
  recoveryDebt: number;     // [0,1]
  offline: boolean;         // 策略要求下线/休息
}
```

### 2.2 ThreadAttention

```ts
interface ThreadAttention {
  tid: number;
  pid: number;
  slots: number;
  foreground: boolean;
  priority: number;
  switchCost: number;
  role?: string;
}
```

### 2.3 分配规则

1. 只允许**一个前台**线程；其余前台候选进入 `deferred`。
2. 前台分配不超过 `foregroundCap`，且每个被接纳任务至少 `minSliceSlots`。
3. 后台任务只从 `effectiveSlots - safetySlots - foreground` 的 reserve 中分配。
4. **floor 不对称**：安全始终保留；被接纳任务有最小推进量；**被拒绝任务没有 floor**。
5. `offline` 时不分配前台，所有候选标记 `offline`；安全监控仍留在 reserve。
6. 切换成本计入 `pressure`，不偷偷多分配容量。

## 3. 下线/休息策略

`shouldRest` 在任一条件成立时触发：

- `cyclesSinceRest >= restAfterCycles`
- `vigilance <= vigilanceFloor`
- `load >= loadCeiling`
- `recoveryDebt >= recoveryDebtThreshold`

`applyRest` 提升 vigilance、降低 load、清零 cycles；这是**恢复**，不是「没任务」。
后台监控/安全不被 rest 关掉，它占用 safety floor。

## 4. 默认参数

```ts
DEFAULT_ATTENTION_POLICY = {
  baseSlots: 4,
  reserveRatio: 0.25,
  safetyFloorRatio: 0.1,
  maxForegroundUtil: 0.75,
  minSliceSlots: 1,
  restAfterCycles: 8,
  vigilanceFloor: 0.25,
  loadCeiling: 0.9,
  recoveryDebtThreshold: 0.7,
}
```

这些是**可校准参数**，不是心理学常数。`baseSlots=4` 借 Cowan 的工作记忆容量；`0.75` 是工程上限，不是自然定律。

## 5. 度量

- `utilization = allocated / effectiveSlots`
- `pressure = deferredRatio + switchPressure`
- `headroom = 1 - utilization`
- `recoveryDebt`
- `qualityAdjustedThroughput = (successes - errors - rework) / attentionSlots`

不要只看 utilization；一个「忙但错」的 agent 应该比「慢但稳」的 agent 得分低。

## 6. 与内核的接线

`KernelOptions.attention` 是可选函数：

```ts
const kernel = new Kernel(db, {
  attention: (pid, task) => planAttention(
    processAttention(pid, cognitiveState),
    [{ tid: task.tid, pid, priority: task.priority, preferredSlots: 2 }],
  ),
});
```

`StepContext.attention` 携带计划；内核不强制休息，只暴露计划，由 runtime/agent 决定：
- `rest=true` → 返回 `sleep`/`rest` 帧；
- `deferred` → 降级、延迟、求助；
- `foreground` → 当前任务分到的 slots。

下一步可以把 `offline` 变成内核拒绝调度前台任务的条件；但必须先有 rest frame 的唤醒语义，否则会永久停摆。

## 7. 心理学依据

- Kahneman 的容量模型：注意力是有限资源，分配策略决定表现。
- Cowan：工作记忆约 4 个 chunk；Miller 的 7±2 是旧口径。
- Wickens：多资源池，不是单一池。
- Yerkes–Dodson：唤醒-表现倒 U。
- vigilance decrement：持续注意会随时间下降。
- Leroy：attention residue；Mark et al.：打断成本。
- Meijman & Mulder：effort-recovery；恢复不足会累积负荷。
- Kaplan：定向注意恢复理论；自然/休息帮助恢复。

## 8. 反模式

- 把注意力压成一个 `%`，然后优化到 100%。
- 给所有任务同样的 floor，导致准入失效与调度抖动。
- 用「再挤一点」代替降级/延迟/求助。
- 把 rest 当 idle，不算入调度。
- 只看 token 消耗，不看错误、返工、切换与恢复债。
- 把 CPU 的「100% 正常」直接搬到人身上。
