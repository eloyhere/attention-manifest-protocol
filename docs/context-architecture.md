# Context / Frame / Receipt / Attention 架构契约

> 状态：目标架构，待按迁移计划实施。  
> 约束：`database/` 目录本轮不动。  
> 原则：**一个 Context，一个生命周期；Frame 是分配，Context 是物化，Receipt 是结算，Attention 是选择。**

## 1. 四个对象，四种职责

| 对象 | 回答的问题 | 是否可变 | 是否内容存储 |
|---|---|---|---|
| **Attention** | 应该关注什么？为什么？ | 策略可学习 | 否，只产出候选/槽位 |
| **Frame** | 这一轮实际分配了什么？排除了什么？ | 不可变快照 | 否，只存 refs/budget |
| **Context** | 这些分配如何变成可用的提示内容？ | 有生命周期 | 图 + view；detail 在 store |
| **Receipt** | 实际发生了什么？成本/结果/VOI？ | 不可变结算 | 否 |

一句话：

```text
Attention 选择 → Frame 固化 → Context 物化 → Receipt 结算 → Ledger 学习
```

---

## 2. 关系图

```text
                 ┌──────────────────────┐
                 │ Attention            │
                 │ candidates, VOI,     │
                 │ salience, trust,     │
                 │ resource slots       │
                 └──────────┬───────────┘
                            │ selectFocus / planAttention
                            ▼
                 ┌──────────────────────┐
                 │ Frame (immutable)    │
                 │ slots, ignored,      │
                 │ budget, impasse      │
                 └──────────┬───────────┘
                            │ materialize(frame)
                            ▼
                 ┌──────────────────────┐
                 │ Context (lifecycle)  │
                 │ graph + view + refs  │
                 │ expansions/evictions │
                 └──────┬─────────┬─────┘
                        │         │
              prompt/LLM│         │ action/tool
                        ▼         ▼
                 ┌──────────────────────┐
                 │ Receipt (immutable)  │
                 │ usage, outcome, VOI  │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Ledger / Calibration │
                 └──────────────────────┘
```

关键边界：

- **Attention 不读 Context 内容**，只看 refs、VOI、成本、风险。
- **Frame 不存 summary/detail**，只存 target ref、slot、budget、ignored。
- **Context 不重新选择槽位**，只物化 Frame 已选的 slots；不能偷偷加关注对象。
- **Receipt 不存 Context 文本**，只存 usage/outcome/VOI，供校准。
- **Ledger 是历史**，Context 是可重建的视图。

---

## 3. Attention 的两层

当前代码里 “attention” 有两个不同层次，必须区分：

### 3.1 资源注意力

`AttentionPlan` / `processAttention` / `planAttention`：

- foreground/background slots；
- reserve/safety floor；
- utilization/pressure/rest；
- 这是**运行时容量调度**。

### 3.2 语义注意力

`selectFocus` / `salience` / `AttentionBroker`：

- candidate → slot；
- VOI、goalFit、uncertainty、novelty、cost、risk、trustCap；
- ignored/revisit_if；
- 这是**关注对象选择**。

两者共同约束 Frame：

```text
Frame.slots.length <= min(cap, foreground slots)
Frame.budget <= available resource budget
```

Frame 是两者的交汇点，不是第三个 attention 实现。

---

## 4. Frame：不可变分配

Frame 已经是对的，不需要重构：

```ts
Frame {
  id, agent, cycle, ts, parent,
  mode, goal,
  slots: Slot[],       // target ref, role, salience, why, cost, state
  ignored: Ignored[],  // target, reason, revisit_if
  budget: { allocated, spent },
  open_questions, impasse, note,
  digest
}
```

### Frame 负责

- 这一轮关注哪些 ref；
- 每个 ref 的角色、salience、why、cost、tier；
- 主动排除了什么、为什么、何时重访；
- 预算、impasse、mode。

### Frame 不负责

- summary/detail 文本；
- token 内的实际内容；
- 工具路由；
- receipt/outcome。

Frame 的不可变性是审计基础：Context 不能篡改分配。

---

## 5. Context：唯一内容视图 + 生命周期

### 5.1 目标 API

```ts
class Context {
  readonly id: string;
  readonly frameId: string;
  readonly graph: ContextGraph;
  phase: "created" | "materialized" | "active" | "settled" | "compacted" | "archived";

  static create(frame: Frame, graph: ContextGraph, store: ContentStore): Context;

  materialize(options: { budgetTokens: number }): ContextView;
  expand(nodeId: string): string | undefined;
  settle(receipt: Receipt): void;
  compact(options?: { keep?: string[]; maxTokens?: number }): void;
  archive(): void;

  snapshot(): ContextSnapshot;
}
```

### 5.2 ContextView

```ts
ContextView {
  frameId: string;
  nodes: ContextNodeView[];   // summary + ref + slot role + why
  tokens: number;
  budgetTokens: number;
  missingRefs: Ref[];         // frame slot has no node
  deferred: Ignored[];        // budget/expansion无法容纳
  refs: string[];
  expansions: string[];
  text: string;
}
```

### 5.3 ContextNode

```ts
ContextNode {
  id: string;
  kind: "goal" | "frame" | "slot" | "observation" | "evidence" | "hypothesis" | "decision" | "detail";
  parentId?: string;
  summary: string;
  detailRef?: string;
  tokens: number;
  salience: number;
  slotRole?: Slot["role"];
  why?: string;
  retention: "must" | "should" | "may";
}
```

### 5.4 生命周期

```text
created
  │ frame attached, graph not materialized
  ▼
materialized
  │ view built under budget; missing/deferred recorded
  ▼
active
  │ used by prompt/action; expand() allowed
  ▼
settled
  │ receipt attached; usage/outcome fixed
  ▼
compacted
  │ summary/eviction applied; detail refs preserved
  ▼
archived
```

规则：

- `materialize` 只能使用 Frame slots + 允许的祖先/pinned 支撑节点；
- `expand` 只能展开已存在 refs，且要计费；
- `settle` 只能在 active/materialized；
- `compact` 不能删除 CAS detail，只能移除 view；
- `archive` 后只读；
- 任何 missing ref 必须记录，不能静默丢。

### 5.5 Context 不变量

1. `view.tokens <= budgetTokens`
2. 每个 view node 必须对应一个 frame slot、其祖先支撑，或 pinned 根
3. 每个 omission 有 `missingRefs` 或 `deferred.reason`
4. `detailRef` 必须可由 store 解析，或标记 missing
5. Context 不能新增 Frame 没有的 target
6. Context 不能修改 Frame/Receipt
7. `settled` 必须有 Receipt
8. `archived` 后不能 expand/materialize
9. 同一个 `(frameId, contextId)` 只能有一个 active view
10. Context 可以从 Frame + graph + store 重建

---

## 6. Receipt：结算，不是上下文

Receipt 已经是对的：

```ts
Receipt {
  id, op, target, at, ms,
  usage, outcome,
  predicted_voi, realized_voi,
  handle, note
}
```

关系：

```text
Frame --1:N--> Receipt
Context --1:N--> Receipt
Receipt --> calibration (predicted vs realized)
```

Receipt 不携带 Context 文本，避免把“视图”误当“事实”。  
Context 的 `settled` 只是挂 receipt id，不复制 receipt 内容。

---

## 7. 合并映射

| 现有 | 目标 | 处理 |
|---|---|---|
| `AgentContext` | `Context` 的 agent source adapter | 内部化，不再公开 |
| `ContextWindow` | `Context` 的 resident view adapter | 内部化，不再公开 |
| `ContextAst` | `ContextGraph` | 改名/合并 |
| `ContextIndex` | `ContextStore` 的 cache | 内部化，不是 source |
| `ContextSegment` | `ContextNodeView` | 合并 |
| `AgentContextSegment` | `ContextNodeView` | 合并 |
| `ContextAstView` | `ContextView` | 合并 |
| `ContextAssembly` | `ContextView` 的投影 | 合并 |
| `assembleAgentContext` | `Context.materializeAgent()` | 方法化 |
| `assembleContext` | `Context.materialize()` | 方法化 |

目标公开 API 只暴露：

```text
Context
ContextFrame（Frame 的别名/引用，不复制）
ContextView
ContextNode
```

`Frame`、`Receipt`、`Attention` 保持独立，不并入 Context。

---

## 8. 迁移顺序（不碰 database）

### Phase 1：契约与测试

- 写本文件；
- 写 `Context` 生命周期测试（纯内存 store，不碰 database）；
- 写系统不变量测试。

### Phase 2：Context 内部化

- `ContextGraph` = 现 `ContextAst`；
- `ContextStore` = 现 `ContentStore`；
- `Context.materialize` 吸收 `assembleContext` / `assembleAgentContext`；
- `ContextWindow` 只作为 resident adapter；
- `ContextIndex` 只作为 cache。

### Phase 3：切换调用方

- `CognitiveRuntime` 只依赖 `Context`；
- `contextAst` 开关删除，统一走 Context；
- 现有 `AgentContext`/`Window` 调用改为 adapter；
- 添加 `arch-check`：禁止第二个 Context store / 直接 prompt AgentContext。

### Phase 4：删除

- 删除 `agentContext.ts`、`contextIndex.ts` 的公开导出；
- 删除旧 `ContextAssembly`；
- 保留 `ContextGraph`/`ContextStore` 内部文件；
- 删除重复测试。

### Phase 5：Frame/Receipt/Attention 接口稳定

- Frame 不变；
- Receipt 不变；
- Attention 保持 policy，不读 Context 内容；
- 只增加 `frameId/contextId` 的关联字段（如需）。

---

## 9. 系统测试（不是组件测试）

必须有的少量测试：

1. **Frame → Context**：每个 slot 都能 materialize 或记录 missing；
2. **预算**：view.tokens 不超 budget；
3. **扩展**：detail 一次 expand 可取回，二次命中缓存；
4. **结算**：Context 未 settle 前不能 archive；settle 后 receipt 可查；
5. **剪枝**：deferred 有 reason，detail 仍可 expand；
6. **重建**：从 Frame + graph + store 重建同一 view；
7. **权限**：destructive operation 无 approval 必拒绝；
8. **无第二源**：arch-check 禁止第二个 context store。

---

## 10. 当前判断

- `Frame` 已经是正确抽象，不要改；
- `Receipt` 已经是正确结算对象，不要并进 Context；
- `Attention` 是 policy/resource，不是内容；
- `Context` 应该是**唯一的内容物化对象 + 生命周期**；
- `database/` 不动，先通过 `ContentStore` 端口适配。

下一步不是继续加 AST/树结构，而是：

```text
写 Context 生命周期测试
→ 合并 AgentContext/Window/Ast/Index
→ 切换 runtime
→ 删除旧导出
```

在这之前，不再新增任何 `ContextXxx`。
