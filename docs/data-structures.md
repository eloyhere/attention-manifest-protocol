# AMP 数据结构盘点与 AST 优化

> 目标：把现有对象、关系、上下文路径摆出来，再判断 AST + summary/detail 应该插在哪，而不是再造一套平行模型。

## 1. 核心对象

| 结构 | 位置 | 关键字段 | 关系 |
|---|---|---|---|
| `AgentProfile` | `src/process/agent.ts` | id、name、values、constraints、lifeChapter | 一个人/agent 的稳定档案 |
| `Memory` | `src/process/agent.ts` | id、kind、content、salience、at、roleId | 多对一 Agent |
| `SelfNarrative` | `src/process/agent.ts` | version、narrative | 一对多 Agent 版本 |
| `RoleAssignment` | `src/process/agent.ts` | role、salience | 多对一 Agent |
| `AffectState` | `src/process/agent.ts` | valence/arousal/stress/fatigue | 一对一 Agent |
| `BackgroundProcess` | `src/process/agent.ts` | kind、label、intensity、trigger | 多对一 Agent |
| `Relationship` | `src/ipc/social.ts` | fromPid/toPid、trust、attachment、obligations | 两个人之间 |
| `Membership` | `src/ipc/social.ts` | institution、role、status | 人 ↔ 组织 |

## 2. 执行对象

| 结构 | 位置 | 关键字段 | 关系 |
|---|---|---|---|
| `Process` | `src/process/process.ts` | pid、state、owner | 持久 agent |
| `Thread` | `src/thread/thread.ts` | tid、pid、goal、state | Process 1→N Thread |
| `RuntimeSession` | `src/runtime/session.ts` | id、state、priors、history、scope | 一个 agent 的连续会话 |
| `RuntimeTurn` | `src/runtime/cognitiveRuntime.ts` | turnId、sessionId、scope、behavior、actions、operations、approvals | Session 1→N Turn |
| `BehaviorPlan` | `src/runtime/behavior.ts` | activations、guardrails、winner、conflicts、preferredActions | Turn 的策略快照 |
| `ActionRecord` | `src/runtime/action.ts` | id、turnId、goal、intent、risk、status | Turn 1→N Action |
| `OperationRecord` | `src/runtime/operation.ts` | id、actionId、kind、input、sideEffect、status | Action 1→N Operation |
| `ApprovalRecord` | `src/runtime/operation.ts` | operationId、tool、risk、decision、status | Operation 1→0..1 Approval |
| `RuntimeReceipt` | `src/runtime/cognitiveRuntime.ts` | id、pid、turnId、outcome、usage | 一次 turn 的回执 |

关系：

```text
Process 1─N Thread 1─N Turn 1─N Action 1─N Operation 1─0..1 Approval
Session 1─N Turn
Turn 1─0..1 BehaviorPlan
Turn 1─N Operation (llm/tool)
```

## 3. 上下文对象

| 结构 | 位置 | 关键字段 | 问题 |
|---|---|---|---|
| `AgentContext` | `src/context/agentContext.ts` | profile、narrative、memories、segments、excluded、tokens | 渲染后的文本段，没有 tree/edge |
| `AgentContextSegment` | 同上 | kind、ref、text、tokens | summary 与 detail 混在一起 |
| `ExcludedSegment` | 同上 | kind、ref、reason | 只记录排除，不记录依赖 |
| `ContextWindow` | `src/window/window.ts` | capacityTokens、resident、table、hits/faults | 扁平 LRU，没有父子/先后 |
| `Page` | `src/window/page.ts` | id、objectKind、objectId、tokens、pinned、content | 无 summary/ref |
| `ContextAssembly` | `src/context/context.ts` | segments、excluded、tokens | excluded 没有 reason |
| `ContextAst` | `src/context/ast.ts` | nodes、edges、view、flat | 新层，尚未接 runtime |
| `ContextAstNode` | 同上 | id、parentId、kind、summary、detailRef、order、salience | 需要与 Page 对齐 |
| `ContextAstView` | 同上 | nodes、tokens、excluded、refs、text | 可直接作为 prompt |

## 4. 计划/诊断对象

| 结构 | 位置 | 关键字段 | 关系 |
|---|---|---|---|
| `Goal` | `src/goal/plan.ts` | statement、success、value、priority | Plan 的父 |
| `Process`（planning） | 同上 | stages、failure_modes、discriminating_test | 系统模型 |
| `Plan` | 同上 | tasks、edges、commitment_window、rollback | Goal 的执行图 |
| `PlanTask` | 同上 | pre、expect、irreversibility、status | Plan 1→N Task |
| `DiagnosticFrame` | `src/diagnosis/types.ts` | layers、signals、hypotheses、steps、phase | 诊断黑板 |
| `Hypothesis` | 同上 | supports、contradicts、discriminatingTest、rootWeight | 1→N Frame |
| `DiagnosticStep` | 同上 | layer、probe、readOnly | 1→N Frame |

`PlanTask` 已经具备 `expect` 和 `irreversibility`，这是诊断步骤最合适的落点；`DiagnosticFrame` 不需要另造 step schema。

## 5. 当前架构的主要问题

1. **三条上下文路径并存**
   - `AgentContext`：self/role/memory 文本；
   - `ContextWindow`：page/LRU；
   - `ContextAst`：tree/edge。
   三者没有统一根，prompt 组装容易重复/漏项。

2. **summary 和 detail 没分层**
   - `AgentContextSegment.text` 直接进 prompt；
   - `Memory` 在 400 字处截断；
   - `Page.content` 可以是完整对象；
   - 没有 `detailRef` 约定，模型无法按需展开。

3. **只有扁平 LRU，没有结构**
   - `ContextWindow` 的 eviction 不知道父子关系；
   - 不能保证“父 summary 在、子 detail 可展开”；
   - 不能表达 before/depends/supports/contradicts。

4. **诊断帧未接入 runtime**
   - `DiagnosticFrame` 是纯模块；
   - `Action` 仍是一轮一个；
   - `PlanTask` 已能承载多步，但 runtime 还没消费。

5. **缺少统一的“摘要预算”**
   - `AgentContext` 按 kind 分预算；
   - `ContextWindow` 按 page token；
   - AST 按 summary token；
   - 三套预算需要合成一个 `ContextBudget`。

6. **证据关系没有进入上下文**
   - `Warrant`/`Evidence` 与 `Hypothesis` 的 supports/contradicts 没有进入 AST edge；
   - 模型看到的是文本，不是“哪条证据支持哪个假设”。

## 6. 目标结构

```ts
ContextAstNode {
  id, parentId, kind,
  summary,          // 进 prompt
  detailRef,        // 本地/对象存储
  detailTokens,
  order, salience
}

ContextAstEdge {
  from, to,
  kind: "before" | "after" | "depends" | "supports" | "contradicts"
}
```

三类投影：

```text
AgentContext  → AST 子树（self/role/memory）
DiagnosisFrame → AST 子树（layers/signals/hypotheses）
Session/Turn   → AST 子树（turns/actions/operations）
```

统一根：

```text
root.process
  ├─ agent.context
  ├─ session.turn.N
  │   ├─ action.N
  │   └─ operation.N
  └─ diagnosis.incident
      ├─ step.thread_pool
      ├─ step.database
      └─ hypothesis.db_lock
```

## 7. 兼容策略

- 保留 `Page` 作为 AST 节点的兼容投影：
  - `Page.objectKind = node.kind`
  - `Page.objectId = node.id`
  - `Page.tokens = summary tokens`
- `ContextWindow` 继续负责 resident/LRU；
- `ContextAst` 负责结构、summary、refs；
- `AgentContext` 逐步改成“从 AST 渲染”，而不是自己拼文本；
- `ContextAssembly` 增加 `excluded.reason`，与 `AgentContext` 对齐。

## 8. 实测结果（DeepSeek）

同一故障场景：

| 条件 | 输入 tokens | layer | blocking_pid | lock | tool |
|---|---:|---|---|---|---|
| flat summaries+details | 30,193 | database | 4711 | ShareLock | none |
| AST summaries | 7,521 | database | null | null | none |
| AST + read_detail | 7,611 | database | 4711 | ShareLock | read_detail |

结论：

- AST summary 保留“哪一层”的判断，输入 token 约为 flat 的 25%；
- detail 问题不能靠 summary 猜，必须按需展开；
- `read_detail` 一次调用即可恢复细节，额外成本很小；
- 这是 **retrieval 架构**，不是“把上下文压短”这么简单。

## 9. ContextIndex（已实现）

`src/context/contextIndex.ts` + `src/context/contentStore.ts`：

```text
exact map  → nodeId 精确查找
CAS        → sha256(content) 去重
LRU        → detail 热缓存
```

本机测试：

```text
nodes=25 uniqueDetails=13 hits=1 misses=2 viewTokens=289
```

24 个节点只有 13 份唯一 detail，说明 CAS 去重生效；第二次读取命中 LRU。

Bloom/Cuckoo 暂不默认接入：当前规模下 exact map 已经够，负查询成本没有 profile 证据。

## 10. 投影与路由验证

`AgentContext` / `ContextWindow` 已能投影到同一 AST 形状：

```text
agentNodes=12 windowNodes=3
agentView=177 windowView=40
```

Runtime 增加显式 `contextAst: true` 开关：通用 turn 的 self/role/memory 也通过 AST summary view 进入 system prompt；默认仍走旧渲染。

诊断工具路由按 top hypothesis，而不是静态层顺序：

```text
payment -> pg_stat_statements
lock-only -> pg_locks
queue -> queue_lag
cold/unknown -> thread_dump (read-only fallback)
```

这修正了之前 `toActionPlan` 固定返回 `thread_pool` 的问题。

## 11. 下一步

1. 把 `ContextAst` 接进 `AgentContext` 渲染（投影已就绪，默认路径还未切换）；
2. 把 `DiagnosticFrame` 存到 `RuntimeTurn`/`Session`（已接）；
3. 把 `PlanTask` 接到 runtime 的 `ActionPlanner`；
4. 用 `ObjectRepository` 替换 `FileContentStore` 的生产路径；
5. 增加 `supports/contradicts` edge，从 evidence 自动生成；
6. 用 Vite 页面观察 AST、token 预算、DeepSeek A/B。
