# 架构审阅与下一步路线

> 日期：2026-10-26。范围：`src/` 39 个模块、200 个 TS 文件、约 25.7k 行；`tools/` 55 个 check 脚本。
> 证据：全量 58/58 校验通过；`src` 与 tools 的 tsc 通过；DeepSeek 40 次调用；Bayesian 后验离线评分。
> 说明：本次 web search 接口返回 429（并发/余额限制），心理学/工程学引用以经典文献与代码实测为准。
>
> **实现更新（同日）**：P0 的 `CognitiveRuntime`、`Kernel.stepAsync`、`DeepSeekLlm`、安全门已落地；随后补了 kernel-backed `KernelRuntime`、多轮 `RuntimeSession`/反馈先验、tool loop + MCP executor、SQLite outbox sink、截断续写和 runtime eval（ECE/Brier）。下面保留审阅时的问题基线；更新后的状态见 `docs/runtime.md` 与 `docs/eval.md`。

## 0. 结论

**不要继续加「更多维度 / 更多模式」。** 当前最缺的是一条**认知运行闭环**：

```text
用户输入
  → 贝叶斯评分（输入质量/状态）
  → 场景权重 + 交互权重
  → 注意力容量/分配
  → AgentContext 装配
  → LLM/工具调用
  → 回答评分 + 回执
  → 信念更新 / 休息 / 追问 / 下一轮
```

这些零件都已存在，但没有一个 runtime 把它们串起来。`src` 内没有调用 `BayesianEngine`、`resolveScenario`、`resolveInteraction` 的运行时代码；它们主要出现在 `tools/` 与 `AgentContext` 的测试路径里。

## 1. 现状快照

| 项 | 状态 |
| --- | --- |
| 模块数 | 39 |
| TS 文件 / 行数 | 200 / 25,739 |
| 全量校验 | **58/58** |
| 测试框架 | 57 个 `node:assert` 脚本，**0 个 `node:test`**；无 CI 配置 |
| kernel 原始 SQL | **0** |
| process/thread 原始 SQL | **0（原 37）** |
| Database facade | **11 个按表 service** + 1 个 `adapters` |
| schema | v4；v<4 时 **DROP** 调度表；agent 表已在 schema 中 |
| 遗留 runtime | **0**：`src/cycle` 与 `AmpRuntime` 夹具均已删除，协议断言迁到纯模块/新 runtime |
| LLM 端口 | `LlmClient.complete` 是 **async**；只有 `ScriptedLlm`，无真实 provider |
| kernel 执行 | `Kernel.step` 是 **sync**；没有 `stepAsync` |
| 新模块接线 | `bayes`/`scenario`/`interaction` 主要被 tests/probe 使用，无端到端 runtime |

## 2. 做得好的地方

1. **人格分层正确**：`process = agent`，`thread = task`；self/roles/memory/affect/relationship 拆进 `process`、`ipc`、`context`，没有另起 `person` 层。
2. **端口方向正确**：kernel 只依赖 `ExecutionStore`；agent/social 有 SQLite adapter；database 的 `TableSql/Repository` 抽象可用。
3. **注意力模型有结构**：process capacity → thread allocation → reserve/floor → rest，而不是单一「token 百分比」。
4. **场景与交互正交**：场景决定任务/预算，交互决定关系/动作；两者都是权重，符合真实任务混合。
5. **贝叶斯评分可解释**：Beta 后验、证据可靠性折扣、区间与 `evidenceCount`，比单一 LLM judge 更诚实。
6. **测试覆盖广**：关键不变量（lease、幂等、权限、窗口、角色、记忆）都有脚本。

## 3. 关键缺口（按严重度）

| 严重度 | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| **P0** | 没有端到端 cognitive runtime | `BayesianEngine` 只在定义/测试；`AgentService` 无 runtime 调用；kernel 的 `agentContext`/`attention` 只在 tests 注入 | 所有模型无法产生真实产品行为 |
| **P0** | async LLM 与 sync kernel 不匹配 | `LlmClient.complete(): Promise`；`Kernel.step(handler): StepReport`，handler 不能 await | 无法在 step 内调用真实模型 |
| **P0** | 没有真实 LLM adapter | 只有 `ScriptedLlm`；DeepSeek 调用在 probe 里直接 `fetch` | 运行时无法复用探针/计费/重试 |
| **P0** | 贝叶斯没有闭环校准 | 先验 `Beta(2,2)`；correctness 依赖 checker；n=5；无 ECE/Brier | 分数可能「看起来精确」但未校准 |
| **P0** | 交互 guardrails 只是数据 | `InteractionPlan.safety` 没有被 runtime 强制；危机升级未实现 | 情感交互有安全/伦理风险 |
| **P1** | 记忆生命周期缺失 | 有 remember/recall/consolidate，但没有 consolidation 调度、遗忘策略、隐私脱敏、投毒检测 | 长期人格会退化或泄露 |
| **P1** | 角色/制度未接权限 | role obligations 与 authz capability 仍分离；无冲突裁决 | 角色冲突无法执行 |
| **P1** | 遗留 runtime 已清零 | `src/cycle`、`ampRuntime.ts`、`cycleDemo.ts` 均已删除 | 单一 runtime 完成 |
| **P1** | process/thread 原始 SQL 已清零 | 状态机、创建、调度、address-space 全部端口化 | 数据库重构完成 |
| **P1** | schema 迁移破坏性 | v<4 DROP tables；版本仍 4，agent 表未 bump | 升级可能丢数据 |
| **P1** | 无可观测性 | 无 OTel/trace/metrics；只有 JSON 文件 | 无法定位质量/成本回归 |
| **P2** | 测试/CI 形态 | 57 脚本、无 `node:test`、无 CI | 回归靠手动 |
| **P2** | Database facade 仍大 | 11 个 service + adapters | 组合根不够薄 |
| **P2** | 多 agent/社会未接 | relationship/institution 模型存在，mailbox/coord 未用 | 协作能力停留在表 |

## 4. 心理学视角：下一步应该做「监控—控制」而不是「更多量表」

### 4.1 元认知：monitoring → control

Nelson & Narens 的框架把元认知分成 **monitoring**（我现在的把握/负荷如何）与 **control**（因此我要继续、追问、验证还是休息）。当前我们有 posterior（monitoring），但没有 control policy。

**建议**：后验区间宽、correctness 低、attention health 低时，触发：
- 追问澄清（grounding）；
- 验证/查证（tool/warrant）；
- 降低交互强度/休息（rest）；
- 拒绝过度承诺（calibration）。

这比再加一个「自信度」维度更有用。

### 4.2 主动推理：用不确定性驱动动作

预测加工/主动推断把认知描述为「最小化预测误差」。作为工程启发式（不是现象学主张）：**高不确定性的地方才值得花注意力**。当前 `BayesianEngine` 输出方差/区间，但没有用于策略。

**建议**：`uncertainty × value` 决定是否调用工具、检索记忆、追问或直接回答。

### 4.3 执行功能：更新、切换、抑制

Miyake 等人的 unity/diversity 模型把执行功能分为 updating、shifting、inhibition。当前有 scenario/interaction 切换，但没有：
- **updating**：新证据到达后是否改写当前计划；
- **shifting**：从 affect 切到 think/converge 的成本；
- **inhibition**：抑制无关记忆/角色/工具。

**建议**：runtime 的 control policy 显式包含 switch cost 与 inhibition（例如 affect 模式下不加载程序性记忆）。

### 4.4 会话 grounding：误解要修复

Clark & Brennan 的 grounding 理论强调共同基础与 repair。当前回答评分是单向的，没有「用户是否理解了」的闭环。

**建议**：下一轮用户输入作为反馈证据（修正、追问、重复、否定），更新 answer posterior；高不确定性时主动复述/确认。

### 4.5 自我决定理论：自主、胜任、关联

Deci & Ryan 指出持续动机来自 autonomy、competence、relatedness。交互设计若只优化「参与度/依赖度」，会破坏自主性。

**建议**：
- 用户可随时说「别共情，直接给方案」；
- 不用 parasocial 依赖作为成功指标；
- 关键决定保留用户选择权；
- 关系/制度建模服务于协作，不是操纵。

### 4.6 信任校准

人机信任研究强调 trust 应与 reliability 匹配。过度自信的回答会制造 overtrust；过度 hedge 会制造 undertrust。

**建议**：把 posterior 区间映射为语言不确定性；高风险任务要求外部验证；记录「预测正确率 vs 实际正确率」。

### 4.7 记忆：重构、巩固、隐私

Conway 的自我记忆系统强调记忆是重构的，不是回放。当前 memory 有 salience/consolidated，但没有：
- 巩固调度（episodic → semantic）；
- 遗忘/脱敏；
- 记忆投毒检测；
- 引用来源。

**建议**：把 consolidation/forgetting 作为 runtime 的后台过程，而不是表字段。

### 4.8 团队认知（后续）

Transactive memory、shared mental models、psychological safety 是 multi-agent 协作的核心。当前 relationship/institution 表存在，但未参与调度。

**建议**：等单 agent runtime 稳定后再做 multi-agent；否则会先得到「多个会说话的 agent」，而不是「协作」。

## 5. 软件工程视角：先闭环，再扩展

### 5.1 模块化单体，不要微服务

当前是 SQLite + 单进程；正确方向是 **modular monolith**：强模块边界、端口/适配器、单部署单元。不要因为「agent/社会/注意力」多就拆服务。

### 5.2 Hexagonal / ports & adapters

kernel 已经走对：`ExecutionStore`、`AgentReader`、`AttentionStore`。下一步 runtime 也必须只依赖端口：
- `LlmClient`（已有 async 端口）；
- `AgentReader` / `PersonStore`；
- `AttentionStore`；
- `WarrantStore` / `ReceiptStore`；
- `Clock` / `IdGenerator`。

验收：`src/runtime` 不 import `src/database/**`、不 import `node:sqlite`。

### 5.3 异步执行：不要在 SQLite 事务里等网络

`Kernel.step` 是 sync，不能 await LLM。推荐 `stepAsync`：
1. 短事务认领 + lease；
2. 事务外 `await` LLM/工具；
3. 短事务提交（lease 校验、usage、receipt、step）。
**不要在 await 期间持有 `BEGIN IMMEDIATE`**，否则会长时间锁库。

### 5.4 事务性 outbox / 事件日志

回答、评分、receipt、attention 变化应作为事件写出。当前 object hash chain 是好的，但缺 outbox：
- 同一事务写业务行 + outbox；
- 后台 dispatcher 发事件/更新索引；
- 避免「写了 receipt 但没更新 belief」。

### 5.5 架构适应度函数

当前 registry 有 module_dependencies，但没有强制「domain 不得 import database」「kernel 不得有 `.prepare`」。建议把以下检查放进 CI：
```text
src/{process,thread,kernel,runtime} 不得 import src/database/**
src/kernel 不得包含 ".prepare("
src/runtime 不得 import node:sqlite
DAG：process/thread/kernel/runtime → ports；adapters → domain
```
这比文档约定可靠。

### 5.6 Eval-driven development

LLM 系统的回归不能只靠单元测试。需要：
- golden set（每场景/交互 20–30 条）；
- 自动评分（exact/rubric/LLM judge）+ 人工抽检；
- 指标：accuracy、质量分、token、成本、延迟、ECE/Brier、安全事件；
- 每次改 prompt/scenario/interaction 跑同一套 eval。

### 5.7 可观测性

OpenTelemetry 的 GenAI 语义约定可以统一记录 model、tokens、latency、tool calls。建议每条 runtime turn 一个 trace：
```text
turn -> user_score -> scenario -> interaction -> attention -> context -> llm -> answer_score -> receipt
```
指标：p50/p95 latency、tokens、cost、cache hit、attention health、posterior calibration。

### 5.8 迁移与兼容

当前 schema v4 的 DROP 迁移是高风险。建议 **expand-contract**：
1. 加新列/表；
2. 双写/回填；
3. 切换读；
4. 删除旧列。
不要在一个版本里 DROP 用户数据。

### 5.9 测试形态

保留 57 个 smoke 脚本是合理的，但 domain/contract 测试应迁到 `node:test`：
- 单元：Beta、state machine、scenario/interaction；
- 端口契约：`AgentStore` 的内存/SQLite 同一套；
- 集成：runtime + fake LLM；
- 迁移：vN → vN+1；
- CI 每次跑全量。

## 6. 推荐路线

### P0（下一步，1–2 个迭代）

**1. `CognitiveRuntime` 闭环**
- `src/runtime/cognitiveRuntime.ts`，只依赖端口。
- 输入：user text、session pid、scenario mix、interaction mix（先手动/规则，后学习）。
- 流程：scoreUser → scenario/interaction → attention → context → LLM → scoreAnswer → receipt → post-turn state。
- `stepAsync`（或 runtime 自行 claim/commit）处理 async LLM。
- 输出 trace：beliefs、plan、tokens、cost、receipt。

**2. `DeepSeekLlm` adapter**
- 实现 `LlmClient`，复用 probe 的 endpoint/model/usage/cost；
- 支持 timeout、retry、thinking disabled、prompt cache usage；
- 不在 CI 里打真实 API，用 `ScriptedLlm` + 录制的 fixture。

**3. 安全门**
- `InteractionPlan.safety` 在输出前强制检查；
- 高风险信号升级；不诊断；不诱导依赖；
- 记录安全事件。

**4. Eval harness 初版**
- 复用 DeepSeek probe，但加 golden set、每模式 20–30 条；
- 输出 ECE/Brier、quality/token、rest 触发率；
- 人工抽检 10%。

### P1

- 记忆生命周期：consolidation 调度、遗忘/脱敏、投毒检测。
- 角色/制度：role conflict、obligations → authz constraints。
- process/thread SQL 清零；`src/cycle` 已删除，legacy runtime 只保留为测试夹具。
- legacy runtime 已删除；后续只需保持 arch-check 不回归。
- schema expand-contract；event outbox。
- OTel + CI + `node:test` 分层。

### P2

- 多 agent / transactive memory / shared mental models。
- 前端 inspector（person/attention/beliefs 面板）。
- Prompt cache 管理。
- 真实人工评估与长期依赖风险研究。

## 7. 不建议现在做

1. **不要继续加评分维度**：grounding/calibration 目前都 .5，说明证据不足，不是维度不足。
2. **不要微服务化**：单 SQLite、单进程，模块化单体更合适。
3. **不要重写数据库**：先完成 process/thread 端口化和 expand-contract migration。
4. **不要训练/微调**：评估集和校准还没建立。
5. **不要用 engagement/依赖度做目标**：与 self-determination、parasocial 风险冲突。
6. **不要同时做多 agent**：单 agent 闭环未稳，multi-agent 会放大协调问题。

## 8. 验收标准（下一步）

- `CognitiveRuntime.respond` 用 `ScriptedLlm` 能跑通固定场景；
- 可选 `DeepSeekLlm` 集成测试（手动/夜间，不进 CI）；
- trace 含 user/answer posterior、scenario/interaction、attention、tokens、receipt；
- `src/runtime` 无 SQL、无 database import；
- 安全门有拒绝/升级单测；
- eval harness 能跑 20 条并输出 ECE/Brier；
- 全量 checks + tsc 通过。

## 9. 参考文献（节选）

- Nelson, T. O. & Narens, L. (1990). *Metamemory: A theoretical framework and new findings*.
- Flavell, J. H. (1979). *Metacognition and cognitive monitoring*. American Psychologist.
- Friston, K. (2010). *The free-energy principle: a unified brain theory?* Nature Reviews Neuroscience.
- Clark, A. (2013). *Whatever next? Predictive brains, situated agents, and the future of cognitive science*. BBS.
- Miyake, A. et al. (2000). *The unity and diversity of executive functions*. Cognitive Psychology.
- Gross, J. J. (1998). *The emerging field of emotion regulation*. Review of General Psychology.
- Deci, E. L. & Ryan, R. M. (2000). *The "what" and "why" of goal pursuits*. Psychological Inquiry.
- Clark, H. H. & Brennan, S. E. (1991). *Grounding in communication*.
- Edmondson, A. (1999). *Psychological safety and learning behavior in work teams*.
- Wegner, D. M. (1987). *Transactive memory*.
- Parasocial relationships with AI: systematic review (2026).
- Cockburn, A. *Hexagonal Architecture*.
- Fowler, M. *Modular Monolith* / *ParallelChange*.
- Microservices.io: *Transactional Outbox*.
- OpenTelemetry: *GenAI semantic conventions*.
- OWASP: *LLM Top 10*.
