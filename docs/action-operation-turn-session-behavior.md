# Action / Operation / Turn / Session / Behavior

> 目的：给 AMP 引入五个容易混淆的概念，先定边界，再谈实现。
> 结论：**Session 是连续性容器，Turn 是交互事务，Action 是目标意图，Operation 是原子执行，Behavior 是跨轮的选择/约束策略。**
> 它们不是五个并列模块，而是「容器 → 事务 → 意图 → 原语」+「横切的策略层」。

## 0. 一张图

```text
Person / Process
├── Behaviors（跨轮的策略/ disposition）
├── Threads（工作任务，跨轮/跨 session）
└── Sessions（交互连续性）
    └── Turns（一次用户可见的交互事务）
        └── Actions（目标意图，0..N 个）
            └── Operations（原子执行，1..N 个）
                └── Observations / Results / Receipts
```

横切关系：

```text
Behavior  ──选择/约束──▶ Action ──调用──▶ Operation
Behavior  ──触发条件──▶ Turn / Session
Thread    ──目标上下文──▶ Turn（一个 turn 可属于一个 thread）
```

关键不是「谁包含谁」，而是**边界与副作用**：

- Turn 是用户看到的边界；
- Action 是「想做什么」；
- Operation 是「实际做了什么、碰了什么」；
- Session 是「这段关系/上下文持续多久」；
- Behavior 是「在什么条件下倾向怎么做」。

## 1. 先解决命名冲突

现有代码里已经有一个 `Action`：

```ts
// src/authz/authz.ts
export type Action = "read" | "write" | "append" | "grant" | "revoke" | "spawn" | "kill" | "send" | "receive" | "fork" | "join";
```

它是**权限动词**，不是我们要引入的「目标意图」。如果直接复用，会出现「Action 到底是 can() 的权限，还是 agent 的行动」的歧义。

**建议改名**：

| 现名 | 新名 | 理由 |
| --- | --- | --- |
| `authz.Action` | `PermissionAction` 或 `Right` | 权限位，不是行为意图 |
| `ToolInvocation` | `OperationInvocation` | 工具调用只是 operation 的一种 |
| `ToolDescriptor` | `OperationDescriptor` | 统一 LLM/tool/memory/policy 操作 |
| `ToolExecutor` | `OperationExecutor` | 执行原语 |
| `RuntimeToolCall` | `OperationRecord` | 记录一次 operation，而不是「tool call」 |
| `ExecProfile` | `OperationProfile` | 执行配置 |

在改名完成前，新概念不要叫 `Action` 进 `authz` 命名空间；可以先放在 `runtime/action.ts`。

## 2. 五个定义

### 2.1 Action（行动 / 目标意图）

**一句话**：Agent 在某个目标下选择的一个有语义的、可解释的意图单元。

它回答：**「我要做什么，为什么，预期改变什么？」**

```ts
interface ActionRecord {
    id: ActionId;
    turnId: TurnId;
    goal: string;                 // 想达成什么
    intent: string;               // 语义动作，例如 "assess_incident" / "clarify" / "rollback"
    expectedEffect: string;       // 预期外部/内部变化
    preconditions: string[];      // 前置条件
    successCriteria: string[];    // 怎样算完成
    risk: "none" | "read" | "write" | "destructive";
    status: "planned" | "running" | "done" | "failed" | "abandoned";
    operationIds: OperationId[];
}
```

Action 的特征：

- 有**目标**和**预期效果**，不只是「调用一个函数」；
- 可以被用户理解/审计；
- 可以包含多个 Operation；
- 可以由 Behavior 选择/约束，但 Action 本身是**一次实例**；
- 失败后可以重新规划，而不是无限重试同一个原语。

例子：

- `assess_incident`（目标：定位原因）→ `logs.query(pre)` + `metrics.query(5xx)`
- `rollback_release`（目标：恢复服务）→ `deploy.rollback(v41)`，需要审批
- `verify_recovery`（目标：确认恢复）→ `metrics.query(post)`
- `clarify_ambiguous_request`（目标：补齐约束）→ 不调用外部工具，只产生一个追问

### 2.2 Operation（操作 / 执行原语）

**一句话**：一次原子的、类型化的执行调用；它是唯一允许触碰外部状态的层。

它回答：**「具体调用了什么，参数是什么，产生了什么结果/副作用？」**

```ts
interface OperationRecord {
    id: OperationId;
    actionId: ActionId;
    kind: "llm.complete" | "tool.call" | "memory.write" | "policy.check" | "human.handoff";
    input: unknown;
    executor: string;             // provider/tool/executor id
    sideEffect: "none" | "read" | "write" | "destructive";
    idempotencyKey?: string;
    timeoutMs?: number;
    status: "running" | "ok" | "error" | "denied";
    result?: unknown;
    evidenceId?: string;
}
```

Operation 的特征：

- **原子**：要么成功/失败/被拒绝，不包含子 Action；
- **可重试**：有 idempotency key 的 operation 可以安全重试；
- **可审计**：参数、结果、风险、审批、脱敏都要记录；
- **有副作用分类**：read/write/destructive；
- 工具调用、LLM 调用、记忆写入、人工 handoff 都是 operation 的不同 `kind`。

例子：

- `tool.call: logs.query({window:"pre"})`
- `tool.call: deploy.rollback({version:"v41"})`，destructive + approval
- `llm.complete({...})`
- `memory.write({...})`
- `human.handoff({reason:"crisis"})`

### 2.3 Turn（回合 / 交互事务）

**一句话**：一次用户可见的交互事务：一个输入进来，经过若干 Action/Operation，产生一个输出和回执。

它回答：**「这一轮用户看到了什么，系统做了什么，花了多少？」**

```ts
interface TurnRecord {
    id: TurnId;
    sessionId: SessionId;
    threadId?: ThreadId;          // 这一轮服务于哪个任务
    index: number;
    input: string;
    actions: ActionRecord[];
    output: string;
    usage: LlmUsage;
    receiptId: string;
    startedAt: string;
    endedAt?: string;
    status: "open" | "committed" | "failed";
}
```

Turn 的特征：

- **用户边界**：用户发一次消息到系统给出最终回答，是一个 turn；
- **事务边界**：turn 结束时写 receipt；中途重试不产生新 turn；
- **不是 step**：kernel 的 `step` 是执行量子；一个 turn 可能对应多个 step/task；
- **不是 action**：一个 turn 可以包含多个 action；
- **可评估**：eval、latency、token、质量分都以 turn 为单位；
- **不可变**：committed 后不再改，只能追加 correction/feedback。

例子：用户说「生产挂了，修一下」：

```text
Turn T1
  Action A1 assess_incident
    Operation logs.query(pre)
    Operation metrics.query(5xx)
  Action A2 rollback_release
    Operation deploy.rollback(v41)   [approval]
  Action A3 verify_recovery
    Operation metrics.query(post)
  Output: 结论 + 证据 + 已回滚 + 待验证
  Receipt: T1
```

### 2.4 Session（会话 / 连续性容器）

**一句话**：一段有边界的交互连续性；它拥有 turn 序列、上下文、注意力、先验、活跃目标与行为痕迹。

它回答：**「这是和谁、在什么通道、从什么时候到什么时候的连续互动？」**

```ts
interface SessionRecord {
    id: SessionId;
    pid: Pid;
    channel: string;              // web / cli / a2a / ...
    status: "open" | "idle" | "archived";
    attention: SessionAttentionState;
    priors: Record<Dimension, BetaBelief>;
    turnIds: TurnId[];
    activeThreadIds: ThreadId[];
    behaviorTrace: BehaviorActivation[];
    startedAt: string;
    archivedAt?: string;
}
```

Session 的特征：

- **连续性**：上下文、注意力、贝叶斯先验、反馈属于 session；
- **不是 task/thread**：session 是交互连续性，thread 是工作连续性；一个 session 可以聊多个 thread，一个 thread 可以跨 session；
- **一个人可以有多个 session**：不同通道/话题/时间段；但同一 session 同时只有一个 foreground turn；
- **生命周期**：open → idle → archived；archive 保留快照，delete 清理；
- **不拥有行为定义**：Behavior 在 person/profile 层，session 只记录激活痕迹。

### 2.5 Behavior（行为 / 策略性倾向）

**一句话**：跨 turn 的、条件触发的选择与约束策略；它决定「在什么情况下倾向做什么、不做什么」，但不直接执行。

它回答：**「这个 agent 在什么条件下，稳定地偏向哪类 action，遵守什么 guardrail？」**

```ts
interface Behavior {
    id: BehaviorId;
    name: string;
    trigger: BehaviorTrigger;      // 用户状态/场景/注意力/风险/历史
    policy: BehaviorPolicy;        // 选择/排序/抑制哪些 action
    guardrails: string[];          // 硬约束
    metrics: string[];             // 如何评估是否有效
    version: number;
}

interface BehaviorActivation {
    behaviorId: BehaviorId;
    turnId: TurnId;
    trigger: string;
    confidence: number;
}
```

Behavior 的特征：

- **不是一次 action**：`approval_before_destructive` 是行为；`deploy.rollback` 是 action；`tool.call` 是 operation；
- **不是 workflow**：workflow 是一张计划图；behavior 是选择/约束策略，可能生成 workflow；
- **不直接产生副作用**：只选择/约束 action，副作用仍由 operation 执行；
- **可度量**：触发率、遵守率、误触发、用户反馈；
- **可版本化**：行为改变要能回放/对比；
- **人格式存在**：默认在 `AgentProfile`，可被 scenario/interaction/session 激活。

内置候选：

| Behavior | 触发 | 策略/约束 |
| --- | --- | --- |
| `clarify_when_uncertain` | 后验区间宽/清晰度低 | 先追问，不硬答 |
| `evidence_before_claim` | 事实性/高风险 | 先检索/引用，再声明 |
| `approval_before_destructive` | operation.sideEffect=destructive | 必须审批，否则拒绝 |
| `affect_then_converge` | 情感强度高/危机 | 先共情/稳定，再收敛到步骤 |
| `rest_when_fatigued` | attention health 低 | 降低负载/建议休息 |
| `no_diagnosis` | affect/健康话题 | 不做诊断，建议专业帮助 |

## 3. 关系与基数

```text
Person 1 ── * Session 1 ── * Turn 1 ── * Action 1 ── * Operation
Person 1 ── * Behavior
Person 1 ── * Thread
Turn * ── 0..1 Thread
Behavior * ── * Turn（通过 BehaviorActivation 记录）
```

严格规则：

1. **Operation 只能属于一个 Action**；Action 只能属于一个 Turn（长任务用 Thread 承载多个 Turn，而不是让 Action 跨 Turn）。
2. **Turn 属于一个 Session**；可以关联一个 Thread（可选）。
3. **Session 属于一个 Person**；一个 Person 可有多个 Session。
4. **Behavior 属于 Person/Profile**；通过 activation 关联到 Turn，不拥有 Turn。
5. **只有 Operation 允许外部副作用**；Action 是意图，Turn/Session 是容器，Behavior 是策略。
6. **destructive operation 必须有 policy/approval**；Behavior 不能绕过。
7. **Turn committed 后不可变**；修正通过新 Turn/feedback 追加。
8. **一个 Session 同时只有一个 foreground Turn**；后台 operation 必须有 `origin=background` 和 thread/session 关联。

## 4. 心理学依据

### 4.1 Activity Theory：activity → action → operation

Leontiev 的三层模型把活动分成：

- **activity**：由动机（motive）驱动；
- **action**：由目标（goal）驱动；
- **operation**：由条件/工具（conditions/tools）驱动，常常自动化。

对应到 AMP：

| Activity Theory | AMP | 说明 |
| --- | --- | --- |
| activity / motive | Person 的 concern、Thread 的 goal | 长期在意的事/工作任务 |
| action / goal | `Action` | 这一轮想达成什么 |
| operation / conditions | `Operation` | 具体工具、参数、执行条件 |
|  automatized operation | 可复用的 Operation/Behavior | 熟练后不再重新规划 |

这给了我们两个重要约束：

- **Action 必须有 goal**，不能把「调用工具」直接叫 action；
- **Operation 是条件层的**，不应承担「为什么做」的语义。

Behavior 不在三层里另立一层；它更像**沉淀下来的 action/operation 选择模式**（habit/disposition）。把 Behavior 当成「第四层」会把它实体化，反而不利于审计。

### 4.2 Behaviorism 的教训

行为主义把行为看作可观察的刺激-反应；这对「可观测、可评估」有帮助，但不够解释目标、表征和策略。因此：

- Behavior 必须是**可观测的**（触发、动作序列、结果）；
- 但不能把 Behavior 简化成「输入→输出」的硬编码；它需要 trigger/policy/guardrail/metrics；
- 内在状态（belief、attention、affect）是 Behavior 的输入，不是 Behavior 本身。

### 4.3 对话/会话理论

对话系统里：

- **turn** 是话轮/发言权的单位；
- **session** 是一次对话的容器；
- **dialogue act** 是话语的交际意图（提问/确认/请求）。

映射：

- Turn ≈ 一次完整交换（用户输入 + 系统输出），不是单条 message；
- dialogue act ≈ Action 的语义标签（clarify/confirm/request）；
- session ≈ 对话连续性；
- grounding/repair ≈ `clarify_when_uncertain` 这类 Behavior。

注意：用户可能一次说多件事，所以**一个 Turn 可以有多个 Action**；系统也可能多次调用工具，所以**一个 Action 可以有多个 Operation**。

## 5. 软件工程依据

### 5.1 Command / Action / Operation

- **Command**：表达意图的请求（做什么），可排队、可审计、可撤销；
- **Handler/Operation**：执行命令的原子处理（怎么做），有副作用、超时、重试、幂等；
- **Event**：已经发生的事实，不可变。

映射：

- Action ≈ Command（意图）；
- Operation ≈ Handler/Effect（执行）；
- Observation/Receipt ≈ Event（事实）。

这正好对应 CQRS/命令模式的分离：**意图与执行分离**，才能做审批、重试、审计、回放。

### 5.2 Behavior Tree / Policy

Behavior Tree 的叶节点是 **action/condition primitives**，内部节点是 selector/sequence 等控制流。Behavior 不是「一个动作」，而是**选择/排序动作的结构**。

强化学习里：

- **action** 是 primitive choice；
- **policy** 是从 observation 到 action 的分布；
- **episode/trajectory** 是一段交互。

映射：

- Behavior ≈ policy/disposition（选择策略）；
- Action ≈ 一次选中的 primitive/semantic act；
- Turn ≈ 一个交互事务；
- Session ≈ 比 episode 更长的连续性容器（不一定等于 episode）。

不要把 Behavior 实现成一张巨大的 behavior tree；先用**小策略 + guardrail**，需要时再编译成树/计划。

### 5.3 Session / Turn 的工程语义

- Session 是**状态边界**：上下文、缓存、认证、注意力、先验；
- Turn 是**事务边界**：输入、输出、usage、receipt、幂等；
- Action 是**语义边界**：目标、预期效果、成功标准；
- Operation 是**副作用边界**：执行、审批、重试、审计。

四者混用会导致：

- 把 tool call 叫 action → 无法表达「为什么调用」；
- 把 turn 叫 session → 上下文/生命周期混乱；
- 把 behavior 叫 workflow → 无法复用/度量策略；
- 把 operation 叫 step → 审批/幂等/脱敏无处放。

## 6. 与现有代码的映射

| 现有 | 新定位 | 动作 |
| --- | --- | --- |
| `process` / `AgentProfile` | Person | 保留；增加 `behaviors` 默认集 |
| `thread` | Thread（工作任务） | 保留；Turn 可关联 `threadId` |
| `kernel.step` | 执行量子 | 保留；不是 Turn |
| `RuntimeTurn` | Turn | 扩展 `actions`、`threadId` |
| `RuntimeSession` | Session | 已有；补 `behaviorTrace`、`actions` 索引 |
| `RuntimeToolCall` | OperationRecord（tool 类型） | 改名/扩展 `actionId`、`sideEffect`、`approval` |
| `module/tool` | Operation descriptor/executor | 改名；保留 MCP 适配 |
| `execution/exec.ts` | Operation executor/approval | 保留；接 operation 记录 |
| `authz.Action` | PermissionAction/Right | **必须改名**，避免冲突 |
| `interaction` | Behavior 的输入 | 不是 Behavior 本身 |
| `scenario` | Behavior 的输入 | 不是 Behavior 本身 |
| `attention` | Session 状态 + Behavior 触发 | 保留 |
| `bayes` | Session 先验 + Behavior 触发 | 保留 |

### 6.1 一个 turn 内部建议的数据流

```text
input
  → session.load / turn.open
  → behavior.select(user, scenario, interaction, attention, history)
  → action.plan(goal, behavior constraints)
  → for each action:
       operation.execute (policy/approval/redaction)
       observation.append
       action.evaluate(success criteria)
  → turn.output + receipt
  → session.record(turn, attention, priors, behaviorTrace)
  → turn.commit
```

关键：**Behavior 在 Action 之前，Operation 在 Action 之后**；Turn 包住整个事务，Session 包住多个 Turn。

## 7. 建议的类型骨架

> 已落地为 `src/runtime/action.ts`、`src/runtime/operation.ts`、`src/runtime/behavior.ts`；`authz.Action` 已加 `PermissionAction` 主名与 deprecated alias。

### 7.1 已接线（2026-10-27）

```text
RuntimeSession
  └── RuntimeTurn
        ├── behavior: BehaviorPlan          # BehaviorRegistry.select
        ├── actions: ActionRecord[]         # SingleActionPlanner
        └── operations: OperationRecord[]   # tool.call + llm.complete
```

- `BehaviorRegistry`：6 个默认 behavior（clarify/evidence/approval/affect/rest/no_diagnosis），只选择/约束，不执行；
- `SingleActionPlanner`：一个 turn 一个 bounded action；按 behavior 选择 `clarify` / `acknowledge_then_converge` / `respond`；
- `RuntimeToolCall` 带 `actionId`/`operationId`；tool call 生成 `OperationRecord(kind="tool.call")`；
- 每轮生成一个聚合 `OperationRecord(kind="llm.complete")`（记录 model/messages/usage/finishReason）；
- `RuntimeSession.history` 保存 behavior/actions/operations；
- `KernelRuntime` 的 `runtime.turn` 对象包含 behavior/actions/operations；
- `runtime_turns` 表 + `SqliteTurnStore` 可按 turnId/pid 查询完整 turn（session/actions/operations）；
- `replayStoredTurn` 从持久化 turn 重建 action/operation 图并校验引用完整。

测试：`tools/cognitive-runtime-check.ts` 12/12。

```ts
type SessionId = string;
type TurnId = string;
type ActionId = string;
type OperationId = string;
type BehaviorId = string;

interface ActionRecord {
    id: ActionId;
    turnId: TurnId;
    goal: string;
    intent: string;
    expectedEffect: string;
    preconditions: string[];
    successCriteria: string[];
    risk: "none" | "read" | "write" | "destructive";
    status: "planned" | "running" | "done" | "failed" | "abandoned";
    operationIds: OperationId[];
}

interface OperationRecord {
    id: OperationId;
    actionId: ActionId;
    kind: "llm.complete" | "tool.call" | "memory.write" | "policy.check" | "human.handoff";
    input: unknown;
    executor: string;
    sideEffect: "none" | "read" | "write" | "destructive";
    idempotencyKey?: string;
    status: "running" | "ok" | "error" | "denied";
    result?: unknown;
    evidenceId?: string;
}

interface TurnRecord {
    id: TurnId;
    sessionId: SessionId;
    threadId?: string;
    index: number;
    input: string;
    actions: ActionRecord[];
    output: string;
    usage: LlmUsage;
    receiptId: string;
    status: "open" | "committed" | "failed";
}

interface SessionRecord {
    id: SessionId;
    pid: number;
    channel: string;
    status: "open" | "idle" | "archived";
    attention: SessionAttentionState;
    priors: Record<string, { alpha: number; beta: number }>;
    turnIds: TurnId[];
    activeThreadIds: string[];
    behaviorTrace: BehaviorActivation[];
}

interface Behavior {
    id: BehaviorId;
    name: string;
    trigger: string;
    policy: string;
    guardrails: string[];
    metrics: string[];
    version: number;
}
```

## 8. 关键取舍

### 8.1 Action 能不能跨 Turn？

**建议不能。** Action 是「这一轮的目标意图」；跨轮的长任务用 **Thread** 承载，Thread 有多个 Turn，每个 Turn 有 bounded Action。这样：

- Turn 可提交、可回执、可评估；
- Action 不会变成「没有边界的后台任务」；
- 长任务的连续性由 Thread + Session 共同提供。

### 8.2 Operation 包不包括 LLM 调用？

**建议包括。** `llm.complete` 是 `sideEffect:"none"`（或 read）的 operation；它同样有 usage、超时、重试、成本、审计。这样 Tool 和 LLM 不需要两套执行/审批逻辑。

### 8.3 Behavior 放 Person 还是 Session？

**默认放 Person/Profile，Session 只记录 activation。** 理由：

- Behavior 是稳定倾向，跨 session；
- Session 是连续性容器，不应复制行为定义；
- Scenario/Interaction 可以在 Session/Turn 层激活不同 Behavior。

### 8.4 Behavior 与 Interaction 的区别？

- `interaction` 是**交互模式权重**（affect/think/inspire/converge/orchestrate）；
- `behavior` 是**选择/约束策略**（何时追问、何时审批、何时休息）；
- Interaction 是 Behavior 的输入之一；Behavior 可以跨 interaction 存在。

### 8.5 Behavior 与 Workflow 的区别？

- Workflow 是**计划/图**（步骤、依赖、分支）；
- Behavior 是**策略/倾向**（触发、选择、约束、度量）；
- 一个 Behavior 可以生成/选择 Workflow，但 Behavior 本身不是 Workflow。

## 9. 迁移计划

### P0：命名与类型（不改变行为）

1. `authz.Action` → `PermissionAction`（或 `Right`）；
2. 新增 `src/runtime/action.ts` / `operation.ts` / `behavior.ts` 类型，不接线；
3. `RuntimeTurn` 增加 `actions`、`threadId`（可选，先空数组）；
4. 文档 + `arch-check` 保证 runtime 不依赖 database。

### P1：Behavior 先行

1. `BehaviorRegistry` + 内置 6 个 Behavior；
2. `BehaviorEngine.select(...)` 返回 `BehaviorPlan`（激活的 behavior + guardrails）；
3. Turn 记录 `behaviorTrace`；
4. 不改变现有 tool loop，只先记录「哪个 behavior 本应触发」。

### P2：Action 层

1. 在 LLM tool call 前增加 `ActionPlanner`：
   - 默认 `SingleActionPlanner`：一个 turn 一个 action，把当前 tool calls 归入该 action；
   - 后续 `GoalActionPlanner`：按目标拆分多 action；
2. `RuntimeToolCall` → `OperationRecord`，加 `actionId`；
3. Turn 输出 `actions`，receipt 记录 action 摘要。

### P3：Operation 统一

1. `ToolExecutor`/`LlmClient` 都适配成 `OperationExecutor`；
2. 审批/脱敏/幂等/超时统一在 operation 层；
3. Operation 结果写 outbox/audit。

### P4：Session/Turn 持久化

1. `turns`/`actions`/`operations` 表或对象哈希链；
2. Session 索引 turn/action；
3. Replay/eval 以 Turn 为单位，Action/Operation 为解释粒度。

## 10. 开放问题

1. **Action 的粒度**：一个 turn 默认 1–3 个 action；上限多少？超过就应拆 thread？
2. **Action 的失败语义**：operation 失败 → action 重规划，还是 turn 失败？
3. **Behavior 的冲突**：两个 behavior 给出相反策略（如 `converge` vs `clarify`）时如何裁决？建议 priority + hard guardrail。
4. **Behavior 的学习**：从反馈学 trigger 权重，还是保持显式规则？建议先显式、可审计，再学排序。
5. **Operation 的幂等**：LLM 调用天然不幂等；是否只对 tool/memory 要求 idempotency key？
6. **Turn 的并发**：一个 session 一个 foreground turn；后台 operation 如何归属？建议 `origin=background` + threadId。
7. **审计保留**：operation 参数/结果含隐私，保留多久、如何脱敏？

## 11. 参考资料

- Leontiev 的三层活动模型（activity/action/operation）：[theses.fr](https://theses.fr/2023REIML008/document#15#85#15)、[core.ac.uk](https://core.ac.uk/download/pdf/41886656.pdf#9#43#9)、[duo.uio.no](https://www.duo.uio.no/bitstream/handle/10852/86518/PhD_Thesis_2018_Bakke.pdf?sequence=1&isAllowed=y#5#9#5)
- 对话中的 turn-taking / session：[theses.hal.science](https://theses.hal.science/tel-01232885/file/These-2015-SICMA-Informatique-BARANGE_Mukesh.pdf#34#43#34)
- OpenAI Agents 的 sessions/turns 工程语义：[OpenAI API docs](https://developers.openai.com/api/docs/guides/agents-api/sessions)
- Behavior Tree 的 action/condition 叶节点：[arXiv 2106.01650](https://export.arxiv.org/pdf/2106.01650#2#4#2)
- RL 的 observation/action/policy：[OpenAI Spinning Up](https://spinningup.openai.com/en/latest/spinningup/rl_intro.html)
- Command 模式（意图与执行分离）：[Command pattern](https://raw.githubusercontent.com/mjmirza/patterns/refs/heads/main/patterns/01-design-patterns-gof/command.md#1)
- Activity Theory 综述：[Springer chapter](https://rd.springer.com/chapter/10.1007/978-3-319-59111-7_29#2)

> 说明：以上网页是外部资料，只用于概念对照；具体定义以本项目的边界与不变量为准。
