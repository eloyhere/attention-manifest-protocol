# 诊断流程：把“分层定位”变成 AMP 对象

> 目标：把 on-call 的“先分层、再定原因”固化成可验证的数据结构，而不是只存在人的脑子里。

## 1. 不新增 parallel runtime

诊断复用 AMP 已有层次：

| AMP 对象 | 诊断中的角色 |
|---|---|
| `Process` | 系统模型：stages、invariants、failure_modes、discriminating_test |
| `PlanTask` | 一条只读诊断步骤，带 `expect` 观察 |
| `Action` | 本轮诊断意图，例如 `diagnose:database` |
| `Operation` | 实际 probe/tool call，如 `pg_locks` 查询 |
| `Behavior` | “先诊断再变更”的策略与 destructive approval |
| `Warrant/Evidence` | probe 结果与假设支持/反驳 |
| `Session` | 诊断帧、步骤状态、历史 |

诊断帧本身是纯数据，可渲染成 prompt、Plan 或 Action，不直接执行。

## 2. 模块

`src/diagnosis/`

- `types.ts`：`DiagnosticLayer`、`DiagnosticSignal`、`Hypothesis`、`DiagnosticFrame`
- `checklist.ts`：USE 风格层清单（thread/pool/connect/DB/queue/app/release）
- `frame.ts`：`buildDiagnosisFrame`、`assessHypotheses`、`selectLayer`、`toPlanTasks`、`toActionPlan`
- `index.ts`

## 3. 数据流

```text
IncidentInput
  → buildDiagnosisFrame
  → layers + steps + hypotheses
  → observe(signal) * N
  → assessHypotheses
  → selectLayer / selectHypothesis
  → toActionPlan (read-only)
  → Operation(probe)
  → Evidence
  → 决策：继续诊断 / 审批变更 / 回滚
```

关键点：

- 每个 hypothesis 必须有 `discriminatingTest`；
- 每个 step 必须 `readOnly: true`；
- `toPlanTasks` 的 `irreversibility` 全为 0；
- 只有证据足够才进入写操作，写操作仍走 approval。

## 4. 当前可用

```ts
import { buildDiagnosisFrame, observe, assessHypotheses, toActionPlan } from "../src/diagnosis/index.ts";

let frame = buildDiagnosisFrame({
    id: "payment-api",
    summary: "p99 2.8s, 5xx 8%, pool saturated, DB CPU 92%",
    symptoms: ["latency", "errors", "db-cpu"],
});

frame = observe(frame, { layer: "database", kind: "saturation", name: "db.lock_wait", state: "critical" });
frame = observe(frame, { layer: "database", kind: "latency", name: "db.query_p99", state: "critical" });
console.log(assessHypotheses(frame)[0]);
console.log(toActionPlan(frame));
```

测试：[`tools/diagnosis-check.ts`](../tools/diagnosis-check.ts)

## 5. 分阶段接入

### P0（已完成）

- 纯诊断帧；
- 层清单、假设、判别测试；
- `PlanTask` / `ActionPlan` 桥接；
- `toContextAst`：诊断帧 → AST 子树（summary 在上下文，signal/hypothesis 详情在本地 ref）；
- 测试覆盖 DB、connect、queue、code 四类判别。

### P1：Behavior + Planner

- 新增 `diagnose_before_change` behavior：
  - trigger：engineering/incident + 高不确定性；
  - preferredActions：`diagnose`、`inspect`、`verify`；
  - destructive 仍需 approval；
  - priority 低于 hard guardrails。
- `DiagnosticPlanner`：
  - 输入 frame；
  - 输出当前层的一个只读 Action；
  - 不直接调用工具。

### P2：Operation / Evidence

- 定义 read-only probe 工具（thread dump、pool metrics、pg_locks、queue lag）；
- 每个 probe 生成 `OperationRecord(kind="tool.call", sideEffect="read")`；
- 输出写入 evidence，更新 hypothesis confidence。

### P3：Session / Replay

- `RuntimeTurn.diagnosis?: DiagnosticFrame`；
- session 保存 frame 与 probe 结果；
- replay 可重放诊断步骤，不重放副作用。

### P4：Eval

- 场景 fixture：DB 锁、连接池泄漏、connect 慢、队列积压、代码回归；
- 评分：是否先分层、是否有判别测试、是否避免无证据变更；
- 记录 human score 与错误类型。

## 6. 设计约束

1. 诊断步骤永远 `readOnly`；
2. 没有 `discriminatingTest` 的假设不能进入决策；
3. 连接延迟必须拆成 **池等待 / 建连 / 查询**；
4. DB 慢查询/锁优先于连接池饱和这个症状；
5. 变更动作必须可回退、可审批；
6. 不用“刚发布”直接替代因果证据。

## 7. 已知边界

- 纯模块目前不执行 probe，也不自动更新证据；
- 假设权重是初始启发式，需要真实场景校准；
- 层清单覆盖常见资源，不覆盖所有内核/网络/分布式竞态；
- 仍需 trace/profile 处理跨层 emergent failure。
