# 认知运行时：从评分到回执的闭环

> 概念边界（Action / Operation / Turn / Session / Behavior）：[action-operation-turn-session-behavior.md](action-operation-turn-session-behavior.md)。
>
> 实现：`src/runtime/cognitiveRuntime.ts`、`src/runtime/safety.ts`、`src/runtime/routing.ts`。
> LLM 适配器：`src/module/llm/deepseek.ts`；kernel 异步执行：`Kernel.stepAsync`。
> 测试：`tools/cognitive-runtime-check.ts`、`tools/deepseek-llm-check.ts`、`tools/kernel-async-check.ts`。

## 0. 一句话

把「用户评分 → 场景/交互 → 注意力 → 上下文 → 模型 → 安全 → 回答评分 → 回执」串成一个可测试的循环，而不是继续堆评分维度。

## 1. 循环

```text
user input
  │
  ├─ BayesianEngine.scoreUser
  ├─ inferScenarioMix / inferInteractionMix
  ├─ resolveScenario / resolveInteraction
  ├─ processAttention / planAttention
  ├─ AgentContext assembly
  ├─ LlmClient.complete
  ├─ checkSafety
  ├─ BayesianEngine.scoreAnswer
  └─ ReceiptSink.write
```

`CognitiveRuntime.respond` 返回 `RuntimeTurn`：

```ts
{
  input, user, scenario, interaction, attention, context,
  answer, answerScore, usage, safety, receiptId, trace
}
```

`trace` 是人类可读的决策记录：user quality、scenario rationale、interaction rationale、attention utilization、context tokens、LLM tokens、answer score、safety。

## 2. 关键设计

### 2.1 只依赖端口

`CognitiveRuntime` 不 import `src/database/**`、不 import `node:sqlite`。它只需要：

- `AgentReader` / `SocialReader`；
- `LlmClient`；
- `BayesianEngine`；
- 纯函数：`resolveScenario`、`resolveInteraction`、`planAttention`、`assembleAgentContext`。

这让 runtime 可以用 `ScriptedLlm` 测试，也可以换真实 provider。

### 2.2 安全门

`checkSafety` 在 LLM 前后各跑一次：

- 用户危机信号（自伤/伤人/急性危险）→ **直接 escalate，不调用模型**，节省 token 并避免错误回应；
- 回答中的诊断语言（在 affect 模式禁止诊断时）→ refuse；
- 依赖/操纵语言 → refuse。

这是模式匹配的安全网，不是分类器；高风险场景仍需人类升级。

### 2.3 回执与 outbox

`ReceiptSink` 是端口；默认 `MemoryReceiptSink` 供测试。生产接：

- `OutboxRuntimeReceiptSink` → SQLite `outbox` 表（`runtime.receipt` topic）；
- kernel 的 `receipt` 对象 + `runtime.turn` 哈希链对象；
- 后续 OTel span。

回执记录 `usage`、`outcome`、`note`，但不记录密钥/完整隐私内容。

**原子路径**：`Kernel.stepAsync` 的 `StepOutcome.events` 在 kernel 提交事务内调用 `eventSink`；`outboxEventSink` 把 `runtime.receipt` 写进同一事务，与 `steps`/`receipt`/`runtime.turn` 一起提交或回滚。`OutboxRuntimeReceiptSink` 保留给非 kernel 的独立 turn。

### 2.4 多轮 session

[src/runtime/session.ts](src/runtime/session.ts)

```ts
const session = new RuntimeSession();
const runtime = new CognitiveRuntime({ ..., session });
```

- 每轮 `record(turn)` 更新 `SessionAttentionState`：load/stress/fatigue/recoveryDebt/cyclesSinceRest；
- 遥测输入：attention utilization/pressure、实际 latency、tokens、tool errors；
- 真实系统遥测：`NodeTelemetry` 提供 `systemLoad`、`eventLoopLagMs`、`memoryMb`；`StaticTelemetry` 用于确定性测试；
- answer evidence 自动 `bayes.learn`；
- `RuntimeSession` 有 `scope`；每轮用 `engineFor(scope)` 的 scoped priors 评分，record/feedback 更新 local counts；未显式指定时 scope 自动派生为 `session:primary-scenario`；snapshot 恢复 scope priors；
- `feedback(turnId, { helpful, correction, actualCorrect })`：helpful/correction 变成证据；actualCorrect 同时更新 source reliability，并影响后续评分；
- `RuntimeSession.reliability` 随 session snapshot 持久化；
- `shouldRest()` / `rest()` 使用 attention policy；
- `snapshot()` 返回 state + priors + turns；`serialize()` 含 history + `turnCounter` + `version`。

**持久化**：`SqliteSessionStore` → `runtime_sessions` 表；`RuntimeSession.restore` 恢复 state/priors/history/next turn id/version。`CognitiveRuntime({ sessionStore })` 会自动 load/save；`archiveSession()` 保留快照但标记归档，`deleteSession()` 清理。

**Turn 持久化**：`SqliteTurnStore` → `runtime_turns` 表；每轮保存完整 `RuntimeTurn`（session/actions/operations/behavior/trace）。`get(turnId)` / `list(pid)` 可供 replay/eval/审计。`replayStoredTurn` 会校验 operation→action、action→operation 引用完整。

当前 state 更新是启发式，不是生理模型；它只用于调度，不用于宣称「AI 有情绪」。

### 2.5 Behavior / Action / Operation

- `BehaviorRegistry` 用 `user/scenario/interaction/attention/text` 选择默认 behavior，输出 `BehaviorPlan`（activation + guardrails + maxActions）；
- behavior 有 `priority` 与 `hardGuardrail`；soft behavior 的 action preference 由最高优先级胜出，hard guardrail 始终保留；`BehaviorPlan` 记录 `winner`/`conflicts`；session 记录 `behaviorConflicts` 频次；`autoTuneBehavior: true` 时才会应用受控 priority 变更，默认关闭；
- `selectCalibration` 只在 cross-val 优于 raw 时启用映射；recorded 40 条上选择 raw；
- behavior guardrails 进入 system prompt；`maxActionsPerTurn` 截断 planner 输出；
- `SingleActionPlanner` 使用 winner 的 `preferredActions`，每个 turn 生成 1 个 bounded `ActionRecord`；
- tool call 生成 `OperationRecord(kind="tool.call")`，带 `actionId`、`sideEffect`、`idempotencyKey`、`status`；
- destructive/denied tool 生成独立 `ApprovalRecord`；`KernelRuntime` 发独立的 `runtime.approval` outbox 事件；`outboxEventSink` 同时写入 `runtime_approvals` 表，支持 `list(pid)` / `prune(before)`；`listForSubject` 需要 owner 或显式 read grant，写入前对 tool/decision 脱敏；
- 每轮一个聚合 `OperationRecord(kind="llm.complete")`，记录 model/messages/usage/finishReason；
- `RuntimeTurn` 带 `behavior/actions/operations/approvals`；session 与 kernel `runtime.turn` 对象都保存它们。

边界：behavior 只选择/约束；action 是意图；operation 是唯一副作用层。当前 `llm.complete` 是聚合记录，不是每次子调用一条；后续再拆细。

## 3. 异步执行：`Kernel.stepAsync`

`LlmClient.complete` 是 async；原 `Kernel.step` 是 sync。新增：

```ts
await kernel.stepAsync(async (context) => {
  const response = await llm.complete(...);
  return { status: "done", usage: { tokens: response.usage.outputTokens } };
});
```

事务边界：

1. 短事务：认领 task + lease + 读取 process/task；
2. **事务外** await 模型/工具；
3. 短事务：检查 lease，写 budget、receipt、step、状态迁移。

`stepAsync` 在等待期间启动 worker heartbeat，避免 worker 过期；不会在 `BEGIN IMMEDIATE` 里等网络。

### 3.1 KernelRuntime：一轮 = 一个 task

[src/runtime/kernelRuntime.ts](src/runtime/kernelRuntime.ts)

```ts
const result = await runtime.runTask(task.tid, userText);
// { report, turn, objectId, receiptId }
```

- 精确运行指定 task（不是 `next ready`），避免多任务时跑错；
- kernel 负责 lease、预算、step 行、receipt；
- 同一提交事务里写 `runtime.turn` 哈希链对象，body 含 user/answer 后验、scenario/interaction、attention、usage、safety、trace；
- runtime 本身仍不 import database。

**实测**：用 `deepseek-flash` 跑一条真实 task：

```text
status=done tokens=824 input=359 output=465
scenario=engineering interaction=think attention=0.50
object=runtime.turn.1.1 receipt=rc.1.1
```

答案完整返回；`finishReason=length` 会自动续写（默认 1 次），仍截断则标记 `truncated answer`（见 `RuntimeTurn.finishReason`）。

### 3.2 工具循环

`LlmRequest.tools` + `LlmResponse.toolCalls` 已接入 runtime：

```text
LLM tool_call
  → ToolRegistry descriptor
  → ToolExecutor.execute
  → tool message（toolCallId）
  → 二次 LLM
```

- `maxToolRounds` 默认 4；
- 工具结果截断到 4000 字符，避免上下文爆炸；
- `McpToolExecutor` 把 MCP `tools/call` 适配成 `ToolExecutor`；
- `registerMcpTools` 从 `readOnlyHint`/`destructiveHint` 推断 `read`/`write`/`destructive`；
- `RiskToolPolicy`：allowlist + approval；destructive 默认需要审批，未批准时不执行；
- tool call 记录 `risk`/`decision`/`redacted`，可审计；
- 工具结果经过 `redactSecrets` 再进入模型上下文、receipt、outbox；
- 工具结果只是数据，不当作指令（prompt injection 边界）；
- 工具调用与 usage 都记录在 turn/object 中。

### 3.3 截断续写

`finishReason=length` 时，runtime 追加：

```text
assistant: <partial answer>
user: Continue exactly where you stopped. Do not repeat.
```

默认最多 1 次；usage 累加，receipt note 记 `continued 1x`。仍截断则保留 `truncated answer (length)`，不会假装完整。

### 3.4 Prompt cache 与成本

- system prompt 以 `STABLE_SYSTEM_PREFIX` 开头，动态 scenario/interaction/attention 放在后面，便于 provider 命中前缀缓存；
- `LlmUsage` 增加 `cacheHitTokens` / `cacheMissTokens` / `costUsd`；
- DeepSeek adapter 映射 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，按 off-peak 默认价计算成本；
- tool loop/续写的 usage 相加，trace 记录 `cacheHit/cacheMiss/cost`。

价格是配置项，不是硬编码真理；实际账单以 provider 为准。

### 3.5 安全升级/handoff

`checkSafety` 判定 crisis 时：

- 不调用模型；
- `EscalationSink.escalate` 写一个最小事件（turnId、reason、resources，不含完整用户文本）；
- 返回危机资源与安全 fallback；
- `RuntimeTurn.escalationId` 可被审计/分页。

`MemoryEscalationSink` 只是测试/本地适配器；生产应接人工 handoff/值班系统。

## 4. DeepSeekLlm

```ts
const llm = DeepSeekLlm.fromEnv();
// or new DeepSeekLlm({ apiKey, model: "deepseek-flash", timeoutMs: 60000, retries: 2 })
```

- endpoint：`https://api.deepseek.com/chat/completions`；
- `thinking: { type: "disabled" }`（runtime 要确定性最终答案）；
- `temperature: 0`、`max_tokens`；
- 映射 `usage.prompt_tokens/completion_tokens` 与 cache hit/miss；
- 计算 `costUsd`（默认 off-peak 价格，可配置）；
- 429/5xx 重试，401 不重试；
- 映射 `tools` 与 `tool_calls`；
- 错误信息不含 key；
- key 只从构造参数/环境变量读取。

## 5. 测试

- `tools/cognitive-runtime-check.ts`：**16/16**
  - 情感/技术回合、context、安全；
  - behavior activation + action intent；
  - session 记录 + feedback 更新先验；
  - rest 建议/重置；
  - length 续写 + usage/cache/cost 合并；
  - tool call → action/operation → 二次 LLM；
  - destructive tool 未审批被拦截；
  - 工具结果 secret 脱敏。
- `tools/deepseek-llm-check.ts`：**5/5**
  - 请求/usage/cache/cost 映射、thinking disabled；
  - 503 重试、401 不重试、错误不泄露 key；
  - tools/tool_calls 映射；
  - `fromEnv` 缺 key 报错。
- `tools/kernel-async-check.ts`：**4/4**
  - await 后提交 usage；
  - 异常 → task failed；
  - `runAsync` 排空；
  - 空闲返回 undefined。
- `tools/kernel-runtime-check.ts`：**5/5**
  - 一轮 = 一个 task + receipt + `runtime.turn` 对象；
  - 精确选择指定 task，不误跑 next ready；
  - 非 ready task 返回 undefined；
  - kernel 提交事务内写 `runtime.receipt` outbox。
- `tools/mcp-executor-check.ts`：**3 项**：MCP call → ToolResult；未知工具错误；risk 推断。
- `tools/outbox-check.ts`：**1/1**：独立 sink 写 outbox，可标记 dispatched。
- `tools/session-store-check.ts`：**2/2**：SQLite session 恢复 state/priors/history/turn id/version；可 archive/delete。
- `tools/turn-store-check.ts`：**1/1**：turn 快照持久化 session/actions/operations；replay 校验引用图。
- `tools/telemetry-check.ts`：**1/1**：Node/static telemetry 更新 attention。
- `tools/calibration-check.ts`：ECE/Brier/isotonic/cross-validation/model selection。
- `tools/calibration-registry-check.ts`：只有 CV 改善足够才激活校准映射。
- `tools/labels-workflow-check.ts`：CSV 导入、active-learning 选样、第三人裁决。
- `tools/behavior-tuning-check.ts`：冲突统计 → priority 建议 + apply/rollback。
- `tools/calibration-sim.ts`：合成 400 条数据验证 selector 在数据足够时启用映射。
- `tools/scoped-priors-check.ts`：scope 级 Beta 先验与 global 回退。
- `tools/scoped-priors-pooling.ts`：partial pooling 对未见 scope 的影响。
- `tools/label-audit.ts`：覆盖率/重复/分歧/pairwise κ/adjudication。
- `tools/behavior-tuning-check.ts`：从冲突统计生成保守 priority 建议。
- `tools/reliability-check.ts`：source reliability 折扣 evidence 权重。
- `tools/agreement-check.ts`：agreement / Cohen's κ / Fleiss' κ。
- `tools/runtime-eval.ts`：220 条确定性 eval，输出 ECE/Brier（见 `docs/eval.md`）。
- `tools/eval-recorded-replay.ts`：40 条真实 recorded 回答 + 10 条 fixture label。
- `tools/eval-summary.ts`：汇总 replay/recorded/annotations 指标到 `docs/eval-summary.md`。
- `tools/eval-replay.ts`：12 条 fixture-label replay，验证 label→metric 路径。
- `tools/arch-check.ts`：runtime 不依赖 database、kernel 无 raw SQL、process/thread SQL 不增长、legacy runtime 不存在。
- `tools/runtime-deepseek-check.ts`：真实 DeepSeek 单轮（手动，不进 verify）。

全量 verify 已包含上述除 `runtime-deepseek-check` 外的检查；`runtime-deepseek-check` 需要 `DEEPSEEK_API_KEY`，不进 CI。

## 6. 当前限制

1. **独立 sink 非原子**：`OutboxRuntimeReceiptSink` 单独写 outbox；需要原子时用 `Kernel.stepAsync` + `outboxEventSink`（推荐）。
2. **session 生命周期只做了 archive/delete**：可保留快照并标记 `archivedAt`，也可删除；没有乐观并发/多版本清理。
3. **attention 仍是启发式**：真实 Node telemetry 已接入，但权重是手调的，不是校准过的模型。
4. **安全是模式匹配 + escalation sink**：没有分类器，也没有真实人工 handoff/值班系统。
5. **routing 是规则**：`inferScenarioMix`/`inferInteractionMix` 只是先验，后续应由贝叶斯/回执学习。
6. **prompt cache 只做稳定前缀 + 记账**：没有按 cache 命中率动态调整 context。
7. **截断只续写一次**：没有按模型/任务自适应 max tokens。
8. **eval 仍是 fixture**：220 条模板 + 12 条 fixture labels，不是真实用户/人工研究。

## 7. 下一步

1. **session archive/并发**：软删除、版本冲突、旧快照清理。
2. **真实 handoff**：接值班/工单/危机资源，审计 escalation 处置。
3. **Eval 真实化**：真实/回放模型，人工标注 ≥10%，报告 inter-rater agreement。
4. **prompt cache 策略**：按命中率/成本动态裁剪 context。
5. **legacy runtime**：`src/cycle`、`AmpRuntime` 夹具、`cycleDemo` 均已删除；协议断言迁到纯模块/新 runtime。arch-check 会阻止回归。
6. **工具审计持久化**：把 approval/denial/redaction 写进 outbox，而不只在 turn 里。
7. **自适应截断**：按 finishReason/任务调 max tokens，最多续写 N 次。
