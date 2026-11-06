# MCP/LCP 工具上下文平面审计报告

**审计日期**：2026-11-06  
**范围**：MCP/LCP 工具上下文平面；四个北向入口、Manifest Store/Retriever/Budgeter/Executor/Shaper/Policy & Audit、南向 MCP、Manifest/Budget/Handle 契约、四类 token 成本、检索/门控/代码执行/输出整形/CLI、缓存、权限、安全、路线和模块关系。

## 证据标记与结论边界

- **[源文档]**：直接来自项目内《MCP-Token税与下一代工具协议.html》或 `refract.md`；表示已有设计/论证，不等于本报告独立复现。
- **[论文补充]**：来自本次检索的论文页面/摘要；预印本、基准和模拟结果不直接等同于生产事实。
- **[规范补充]**：来自 MCP 官方 Tasks 扩展页面；用于补足源文档没有展开的异步任务语义。
- **[审计结论]**：本报告对边界、缺口、优先级和落地条件的独立判断。

> **核心判断 [审计结论]**：不要重造替换 MCP 的南向 wire protocol；应在 MCP 之上建立北向稳定、南向兼容的工具上下文平面。模型只看到四个稳定入口，平面负责清单、检索、预算、执行、结果整形、权限和审计。LCP 的价值不是把 JSON 换成更短的 JSON，而是把“何时让模型看到什么、看到多少、以什么身份和权限看到”变成可验证、可缓存、可撤销的运行时决策。

---

## 1. 审计对象与上下文

本报告只审计工具上下文平面，不复制 `refract.md` 的完整 Agent 操作系统。审计对象为：

1. **北向**：`find_tools`、`inspect_tool`、`run`、`read_handle` 四个模型可见入口。
2. **上下文平面**：Manifest Store、Retriever、Budgeter、Executor、Shaper、Policy & Audit。
3. **南向**：`server/discover`、`tools/list`、`tools/call` 及 MCP Tasks 扩展。
4. **契约**：Manifest、Budget、Handle，以及异步 TaskHandle 与数据 Handle 的关系。
5. **经济学**：定义税、结果税、往返税、协议税，及缓存、检索、代码执行、输出整形和 CLI 的影响。
6. **治理**：多租户、最小权限、供应链、提示词注入、动态描述投毒、沙箱、取消、Receipt 和路线。

`refract.md` 中与本主题直接相关的约束是：上下文是注意力调度结果；先 list/摘要、再按需展开；`mount/unmount/persist/focus/blur/update/associate/verify` 作为注意力操作；Session/Turn 预算树；Tool/Skill/Protocol 版本和失败分类；每次能力调用生成 Receipt；stale、版本哈希、事件溯源和确定性验证器优先于让模型自行遵守规则。[源文档]

**审计取舍 [审计结论]**：LCP 只消费最小的 Session/Turn、当前 Task、权限上下文、预算余额和 Receipt 指针；完整事件流、视图渲染、证据图和内部策略不应进入模型窗口。

---

## 2. 证据基线：源文档、论文和规范补充

### 2.1 源文档的主要主张

《MCP-Token税与下一代工具协议.html》将工具上下文成本拆为：

- **定义税**：每轮驻留的工具名称、描述和 schema；
- **结果税**：大结果进入历史后，在后续轮次重复重放；
- **往返税**：每次自然语言工具调用都需要模型再次读结果、判断和决策；
- **协议税**：握手、会话、重连、协商和轮询等状态成本。[源文档]

源文档提出三种杠杆：推迟（defer，按需加载定义）、外置（externalize，把循环和中间结果放入沙箱）、压缩（compress，分页、句柄、聚合、紧凑编码）。其 LCP 草案是“四个北向入口 + 六个上下文平面模块 + 南向 MCP”，并提出 Manifest/Budget/Handle 三份契约。[源文档]

源文档中的厂商数字、registry 计数、模拟结果和公开安全案例应视为路线信号或待复测基线，而不是组织 SLA。[审计结论]

### 2.2 论文补充

- **NTILC**：`Neural Tool Invocation via Learned Compression`（arXiv:2606.06566，2026-06）用外部的、签名感知的神经检索替代把完整工具注册表放进上下文；摘要报告上下文消耗降低超过 95%，延迟最高降低 74%。它支持 Retriever 方向，但依赖训练与分布覆盖，不能假设对未知 MCP 生态零配置有效。[论文补充] [论文页面](https://arxiv.org/abs/2606.06566)
- **Toollery**：`Scaling LLM Agents to Thousands of Skills and Tools`（arXiv:2609.22218，2026-09，v2 于 2026-10）用工具侧查询扩展把大注册表压缩成固定 top-K 候选；摘要称在大规模技能、BFCL 工具和驾驶舱请求上改善候选召回，但收益依赖工作负载覆盖和 provider caching。[论文补充] [论文页面](https://arxiv.org/abs/2609.22218)
- **Plan or Retrieve First?**（arXiv:2610.19068，2026-10）在 46,984 个端点上发现：单工具问题 Retrieve-then-Plan 较好，多工具问题 Plan-then-Retrieve 较好；后者额外发现调用约使推理成本翻倍。因此 Retriever 需要复杂度自适应，而不是固定一种检索顺序。[论文补充] [论文页面](https://arxiv.org/abs/2610.19068)
- **The Bitter Lesson of Tool Calling**（arXiv:2608.06370，2026-08）在 BFCL v4 的 14 个模型上比较程序化调用和原生 JSON 调用；摘要报告 PTC 在 11/14 个模型上不差于或优于基线，平行 fan-out 时 13/14 个模型保持不差。它支持 Executor，但没有覆盖所有沙箱逃逸、供应链和高风险副作用。[论文补充] [论文页面](https://arxiv.org/abs/2608.06370)
- **MCP-DPT**（arXiv:2604.07551，2026-04）将 MCP 防御按架构层放置，指出现有防护偏工具侧，宿主编排、传输和供应链仍有空白；这支持把 Policy & Audit 放入上下文平面，而不是只信任 MCP 服务器自报。[论文补充] [论文页面](https://arxiv.org/abs/2604.07551)

### 2.3 MCP Tasks 规范补充

MCP 官方 Tasks 扩展 `io.modelcontextprotocol/tasks` 允许 `tools/call` 返回异步任务句柄，而不是最终结果；扩展提供 `tasks/get`、`tasks/update`、`tasks/cancel`，任务拥有 server-generated `taskId`、状态、TTL 和建议轮询间隔。[规范补充] [官方规范](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)

关键语义是：

- 客户端在每次请求能力中声明支持扩展，服务器按请求决定是否返回 `resultType: "task"`；服务器不得向未声明能力的客户端返回任务结果。
- 任务状态包括 `working`、`input_required`、`completed`、`failed`、`cancelled`；`completed` 可携带最终结果，`failed` 携带 JSON-RPC 错误。
- 客户端应按 `pollIntervalMs` 轮询，并可通过通知订阅接收状态；任务 ID 应持久化以支持崩溃恢复。
- `tasks/update` 用于向 `input_required` 的任务提交 `inputResponses`；响应确认可能先于可观察状态更新，属于最终一致。
- `tasks/cancel` 是取消意图，**取消是协作式且最终一致**：服务器只必须确认收到请求，不保证停止工作，也不保证最终状态一定变成 `cancelled`；任务可能已在取消生效前完成或失败。任务取消不能用 `notifications/cancelled` 代替。
- 流式 HTTP 下后续 Task 请求需要以 task ID 路由到持有状态的实例；TTL 是任务可用性的后备边界，不是强制终止时间。

LCP 必须把上述语义暴露为受控的北向状态，而不是把 `tasks/*` 无过滤地呈现给模型。[审计结论]

---

## 3. 目标架构：四个北向入口、六个平面模块、一个 MCP 南向面

```text
用户输入 / Session + Turn
        │
        ▼
┌──────────────────────────────┐
│ Northbound                    │
│ find_tools / inspect_tool     │
│ run / read_handle             │
└───────────────┬──────────────┘
                ▼
┌────────────────────────────────────────────┐
│ LCP Context Plane                          │
│ Manifest Store → Retriever → Budgeter      │
│                         │        │          │
│                         ▼        ▼          │
│                    Executor → Shaper       │
│                         │                   │
│                  Policy & Audit（贯穿）      │
└─────────────────────────┬──────────────────┘
                          ▼
┌────────────────────────────────────────────┐
│ Southbound MCP                            │
│ server/discover / tools/list / tools/call  │
│ tasks/get / tasks/update / tasks/cancel    │
└────────────────────────────────────────────┘
```

[源文档] 北向接口面积应恒定，南向服务器数量可以增长。 [审计结论] “四入口恒定”是模型可见调用面恒定，不是内部只有四个函数；内部仍需索引、绑定、租户策略、执行队列、任务状态和 Receipt DAG。

### 3.1 四个入口

| 入口 | 职责 | 模型可见内容 | 禁止 |
|---|---|---|---|
| `find_tools(query, filters?)` | 检索能力 | top-k 摘要、置信度、权限状态、版本/digest | 返回未授权或低置信度硬凑的工具 |
| `inspect_tool(id, version?/digest?)` | 展开权威 schema | 完整输入/输出契约、前置条件、风险、示例 | 使用与 Manifest digest 不同的实时描述 |
| `run(code, budget, policy_ref?, control?)` | 沙箱内程序化编排或控制异步任务 | 结果摘要、任务/数据句柄、Receipt | 任意网络、任意密钥、绕过 Policy |
| `read_handle(id, cursor/limit, projection?)` | 读取数据或任务句柄 | 有界切片、状态、摘要、下一游标 | 跨租户、绕过 TTL/撤销、无界恢复 |

`run` 的 `control` 不是第五个北向入口，而是同一入口的受限控制变体，可承载 `resume_task`、`cancel_task` 等操作；模型永远不能直接伪造南向 `tasks/*` 参数。[审计结论]

### 3.2 `find_tools` 与 `inspect_tool`

Retriever 输入可使用当前 Turn/Task 摘要、身份、租户、资源范围和预算，但原始敏感数据不能直接成为可持久化索引查询。返回至少包括 `tool_id`、`server_id`、版本、digest、短签名、`when`、`not_when`、权限状态、前置条件、分数和 TTL。低置信度应返回空、要求澄清或走受控 fallback，而不是选择“最不差”的工具。

短签名只能导航；真实参数校验、枚举、互斥约束、输出结构和错误分类必须来自与 digest 绑定的完整 schema。否则定义税会在错误调用、澄清和重试中反弹。[审计结论]

---

## 4. 六个平面模块与模块关系

### 4.1 Manifest Store

保存 Server Manifest、Tool Summary、Authoritative Schema 和 Binding Record：

- Server Manifest：身份、协议版本、能力、端点、认证和租户范围；
- Tool Summary：名字、短签名、何时用、何时不用、风险和前置条件；
- Authoritative Schema：输入/输出 schema、错误契约、示例；
- Binding Record：版本/digest 与 MCP `tools/call`、Executor SDK 或 CLI 的绑定。

缓存键至少应含 `tenant_id + server_id + tool_id + version + digest + policy_scope`。`ttlMs` 是缓存建议，不是授权期限；权限撤销、供应链事件、digest 变更必须主动失效。

### 4.2 Retriever

采用词法/BM25、向量、签名/类型约束、状态就绪度、时效、权限和风险联合排序：

```text
score = lexical + semantic + signature_fit
      + state_ready + freshness - risk - estimated_cost
```

简单任务走 Retrieve-then-Plan；多工具任务可先生成抽象能力 stub 再联合检索；top-1 低分时扩大候选或澄清，不无界加载。召回率、精确率、选择准确率、误调用率、漏召回导致的任务失败率必须分开测量。[审计结论]

### 4.3 Budgeter

管理输入定义 token、单次结果 token、Session/Turn 总 token、工具调用/重试次数、时延、CPU、内存、并行度、出站字节和句柄 TTL。Budget 与 `refract.md` 的 Session→Turn→Intent→Mission→Goal→Plan→Task→Action 预算树对齐。

超限不得静默截断：

```text
if result > max_result_tokens:
    on_exceed = handle | paginate | summarize_with_pointer | error
```

每次调用记录预算前余额、子预算、实际消耗、超限动作、回收额度和最终账单。Token 预算要注明模型和 tokenizer 版本。

### 4.4 Executor

将南向 MCP 工具或 CLI 映射为类型化 binding，在隔离沙箱中运行代码；循环、条件、并行、过滤、聚合和中间结果留在执行侧，模型只收到 Shaper 的最终结果。

最低基线：默认无网络、无文件系统和无环境变量；出站域名/方法/端口白名单；短期凭证引用；CPU/内存/并发/墙钟/输出字节限额；固定代码 hash、依赖、binding 和 Manifest digest；强制超时、取消、重试、幂等键；所有子调用生成可关联 Receipt。PTC 基准支持程序化调用，但不替代沙箱和高风险生产测试。[论文补充][审计结论]

### 4.5 Shaper

执行服务端过滤、字段投影、聚合、分页、句柄化、紧凑编码和摘要。优先顺序是：过滤/聚合→投影/分页→大对象句柄→可验证编码→低风险离线摘要。任何摘要或编码必须附原始 Handle、来源 Receipt、schema/digest、是否完整和下一步读取方式。压缩率不能作为唯一验收；要同时测任务成功率、解析失败率、遗漏率和 p95 token。

### 4.6 Policy & Audit

是贯穿每个入口、每个子调用和每次句柄读取的闸门，而不是事后日志：身份、租户和对象级授权；工具/版本/digest 信任；读写/删除/外传风险；人工确认；预算/出站/速率限制；Receipt、Evidence、trace、原始响应和句柄生命周期；供应链签名、撤销和事件响应。未授权能力应在检索前被过滤，权限必须在执行前和输出前再次检查。[论文补充][审计结论]

---

## 5. `run` 的执行上下文、子调用和归属

### 5.1 RunContext 是不可扩权的快照

`run` 不能只接收 `code` 和 `budget`。Executor 应在接受请求时生成不可变的 `RunContext`：

```text
RunContext = {
  run_id, parent_receipt_id, trace_id,
  tenant_id, principal_id, agent_id,
  on_behalf_of?, session_id, turn_id, task_id, action_id,
  manifest_bindings: [{server_id, tool_id, version, digest}],
  policy_snapshot_id, policy_version,
  budget_ledger, deadline, cancellation_token,
  credential_refs, egress_policy, workspace_snapshot,
  data_classification, output_policy, idempotency_key
}
```

该上下文绑定当前 Session/Turn/Task/Action、用户主体、Agent 身份、租户、Policy 版本、Manifest digest、Budget ledger、凭证引用、工作区快照、数据等级和取消令牌。子调用只能继承或收紧这些字段，不能把 `tenant_id`、scope、出站白名单、预算或数据等级扩大。[审计结论]

### 5.2 子调用执行上下文

每个 `run` 内部 MCP/CLI 子调用都建立 `ChildCallContext`：

```text
ChildCallContext = {
  parent_run_id, call_id, depth, trace_span,
  inherited_tenant, principal, on_behalf_of,
  tool_binding_digest, policy_snapshot_id,
  child_budget, deadline, cancellation_token,
  allowed_scopes, allowed_egress, data_classification,
  idempotency_key, parent_receipt_id
}
```

执行顺序必须是：

1. 校验代码要调用的 binding 是否来自已批准 Manifest digest；
2. 用当前 Policy snapshot 重新检查工具、对象、租户和风险 scope；
3. 从父预算划拨 child budget，检查 deadline、并发和出站额度；
4. 以短期、最小 scope 的 capability token 调南向 MCP/CLI；不得把通用用户 refresh token 或环境变量暴露给代码；
5. 记录参数摘要、南向端点、结果大小、耗时、资源、错误和网络访问；
6. 结果先进入受控存储，再交给 Shaper；中间结果默认不回模型；
7. 任一子调用被取消、超时或策略拒绝时，按错误分类决定重试、补偿、句柄化或终止，不能由代码绕过。

### 5.3 租户、主体、Agent 和服务器的归属

必须区分四种身份：

- **资源租户（tenant）**：数据、预算、Handle 和审计记录的根归属；
- **授权主体（principal）**：用户、服务账号或工作负载，授予 scope；
- **执行 Agent**：代表主体执行推理和代码，不因此获得更大权限；
- **南向服务器**：受委托处理方/能力提供方，不是资源所有权人。

建议所有 Run、ChildCall、TaskHandle、DataHandle 和 Receipt 都带 `tenant_id`，并同时带 `principal_id`、`agent_id`、`session_id`、`turn_id`。`on_behalf_of` 只能从已验证的委托链产生。服务器端仍须做对象级授权，不能因为网关已经检查过就信任“调用方已校验”。

**硬规则 [审计结论]**：

- 跨租户检索、执行、缓存命中和 Handle 读取一律拒绝；
- 共享缓存只允许公共、低敏感、明确可共享的 Manifest；
- 资源租户和凭证租户不一致时必须有显式委托策略；
- 子 Agent 只能使用父 Agent 授权的能力和预算；
- `read_handle` 的所有权检查不能只看 Handle ID，必须验证 tenant、principal、Session/Turn 绑定和 Policy scope。

### 5.4 Receipt 归属与父子关系

一次 `run` 至少产生：`run_receipt`、每个子调用的 `action_receipt`、必要时的 `task_receipt`、`handle_receipt` 和最终 `turn_receipt`。Receipt 形成父子 DAG：

```text
turn_receipt
  └─ run_receipt
       ├─ child action_receipt (MCP/CLI call 1)
       ├─ child action_receipt (MCP/CLI call 2)
       ├─ task_receipt / task status transitions
       └─ handle_receipt (result or task handle)
```

每个 Receipt 记录 `tenant_id`、主体/Agent、Session/Turn/Task/Action、Manifest digest、Policy snapshot、Budget、代码 hash、父 Receipt、trace/span、数据分类、结果/句柄引用和签名。MCP 服务器自己的审计记录应通过 trace/request ID 关联，但不能替换 LCP 的本地 Receipt；LCP 负责“谁代表谁、为何调用、预算和策略是什么”，服务器负责“实际收到什么、执行了什么”。

Receipt 归属不是“哪个模块写日志”这么简单：租户拥有审计可见性，主体拥有授权责任，Agent 对执行负责，服务器对南向执行事实负责。撤销 Manifest、凭证或 Policy 时，必须可沿 Receipt DAG 找到受影响的 Handle、任务、Evidence 和结论。[审计结论]

---

## 6. 南向 MCP 与 Tasks/Handle 语义

### 6.1 南向 MCP 是兼容层，不是信任层

适配流程：

```text
server/discover → 身份/版本/能力/扩展
       ↓
tools/list      → schema/摘要/TTL/排序/digest
       ↓
tools/call     → 预算/租户/权限/Receipt 绑定
       ↓
MCP tasks/*     → 异步状态、输入、结果和取消
```

`tools/list` 和服务器描述只能作为待验证输入；Manifest Store 要校验签名、digest、端点所有权和版本漂移；远端描述、资源文本和错误消息都按不可信数据处理。[审计结论]

### 6.2 TaskHandle 与 DataHandle 必须分离

MCP `taskId` 是**异步执行状态句柄**；LCP `Handle` 通常是**数据结果句柄**。两者不能混成一个只有字符串的对象：

```text
TaskHandle = {
  kind: "task",
  task_id, tenant_id, principal_id,
  parent_run_id, source_receipt_id,
  mcp_server_id, original_method: "tools/call",
  status, created_at, last_updated_at,
  ttl_ms, poll_interval_ms,
  input_request_keys, cancellation_state,
  policy_snapshot_id, manifest_digest
}

DataHandle = {
  kind: "data",
  handle_id, tenant_id, principal_id,
  source_run_id, source_receipt_id, source_digest,
  schema_version, data_classification,
  allowed_projections, cursor_binding,
  expires_at, revocation_epoch, status
}
```

任务完成后，最终 MCP 结果可以由 Shaper 存成 DataHandle；此时 `TaskHandle` 仍用于审计任务状态，`DataHandle` 用于有界读取。不要用 DataHandle 的“active”假装任务已经完成，也不要在任务未完成时把空结果解释为成功。

### 6.3 LCP 如何封装 MCP Tasks

模型不直接调用 `tasks/get/update/cancel`。建议：

- `run` 遇到 MCP `resultType: "task"` 时，返回 `TaskHandle`、当前状态、TTL、建议轮询间隔和 Receipt 指针；
- `read_handle(TaskHandle)` 内部调用 `tasks/get`，尊重 `pollIntervalMs`，只返回有限状态摘要；
- `read_handle` 发现 `completed` 时，取最终结果交 Shaper，必要时生成 DataHandle；
- `input_required` 时，先把经过 Policy 脱敏的输入请求呈现给用户/模型；模型提交的回答通过 `run(control={resume_task, input_responses})`，由适配器内部调用 `tasks/update`；
- 取消通过 `run(control={cancel_task})` 或宿主取消事件触发，内部发送 `tasks/cancel`；不把 `notifications/cancelled` 当成任务取消；
- 任务 ID、输入请求 key、轮询状态和取消请求均归入父 RunContext 和 Receipt DAG；
- LCP 可在内部使用 `notifications/tasks` 降低轮询，但北向仍输出稳定的状态模型，不能把推送当作强一致事实。

这保持四个北向入口不变，同时完整保留 MCP Tasks 的语义。[审计结论]

### 6.4 取消、超时和最终一致

取消必须区分四个状态：

```text
not_requested → cancel_requested → cancellation_observed
                               ↘ work_finished_before_cancel
                               ↘ cancel_failed_or_unknown
```

收到用户取消后：

1. Budgeter 立即冻结未使用预算并阻止新的子调用；
2. Policy 将 Run/Task 标为取消中，撤销或缩短 capability lease；
3. Executor 向所有可取消的子调用传播 cancellation token；
4. MCP adapter 向对应服务器发送 `tasks/cancel`；
5. 由于 MCP 取消是协作式且最终一致，不能在收到空确认后声称“已停止”；
6. 保留任务和 Receipt 到终态或 TTL，记录 `cancel_requested_at`、服务器确认、最后观察状态和潜在副作用；
7. 若服务器在取消生效前完成，状态应是 `completed`，而不是被客户端改写为 `cancelled`；
8. 若任务最终失败，记录 `failed` 和错误；若状态未知，返回 `cancellation_pending/unknown`，不伪造成功；
9. 已产生的外部副作用必须走补偿/回滚策略，取消本身不等于回滚。

客户端可以在发出 `tasks/cancel` 后删除本地轮询状态，但 LCP 为审计和租户追责仍应保留最小 TaskHandle/Receipt 索引；这是“客户端可丢弃”和“平台不可失忆”的区别。[规范补充][审计结论]

---

## 7. Manifest / Budget / Handle 契约审计

### 7.1 Manifest

```json
{
  "server_id": "github",
  "tool_id": "create_pr",
  "version": "2.1.0",
  "digest": "sha256:...",
  "summary": "创建 Pull Request",
  "signature": {"required": ["repo", "head", "base"], "optional": ["title", "body"]},
  "when": ["已有变更并需要提交 PR"],
  "not_when": ["只需读取 issue"],
  "auth": {"scopes": ["repo:write"], "risk": "write"},
  "preconditions": ["repo_access", "branch_exists"],
  "output": {"shape": "object", "max_default_tokens": 400},
  "ttl_ms": 3600000,
  "cache_scope": "tenant",
  "signature_ref": "signed-artifact"
}
```

短 Manifest 只能导航；执行权威是与 digest 绑定的完整 schema。`when/not_when` 必须能用于评测和检索，变更必须触发版本、审批和重索引。[源文档][审计结论]

### 7.2 Budget

至少包括：`max_input_tokens`、`max_result_tokens`、`max_total_tokens`、`max_calls`、`max_retries`、`max_parallelism`、CPU/内存/墙钟/网络字节、句柄 TTL、`on_exceed`、`on_timeout`、`on_cancel`、`idempotency_key` 和回滚策略。预算由执行方强制，不能靠提示词“请少输出”。

### 7.3 Handle

数据 Handle 至少含 `id/owner/tenant/session/turn/source_receipt/source_digest/data_classification/schema_version/created_at/expires_at/revocation_epoch/allowed_projections/max_page_size/cursor_binding/status/audit_ref`。读取校验身份、租户、Session/Turn、Policy、digest、TTL、撤销 epoch 和 cursor；句柄 ID 要高熵，防猜测、重放、侧信道和跨租户缓存命中。[审计结论]

---

## 8. 四类 token 成本

### 8.1 定义税

若每轮挂载的定义为 `d`，任务有 `N` 轮，则近似 `N × d`。工具集变化、排序漂移、租户差异会破坏缓存。优化顺序：延迟加载、Manifest、检索、门控、稳定序列化。

### 8.2 结果税

若第 `i` 轮新增结果为 `r_i`，历史重放近似：

```text
C_result ≈ Σ(i=1..N) (N-i+1) × r_i
```

均匀结果下接近二次增长；数据型、多步任务中结果税常高于定义税。因此先做过滤、聚合、分页、句柄和代码执行，再做 schema 压缩。[源文档][审计结论]

### 8.3 往返税

自然语言模式每一步都回模型；代码模式把循环、条件、并行和中间结果放进 Executor。需同时度量 LLM turn 数、南向调用数、重试数、网络 RTT、端到端 p95 和成功率，而不能只看 token。

### 8.4 协议税

握手、会话、重连、协商和轮询的 token 可能不大，却会造成缓存失效、扩缩容困难和重试开销。无状态请求、稳定排序、TTL、退避和正确的 Tasks 持久化可降低协议税。[源文档]

### 8.5 计量原则

每个 Turn 的账单按 `server/tool/version/digest/tenant/session/turn/task/run/receipt` 归因；同时记录定义、结果、重放、往返和协议四项。没有 per-server/per-turn 账本，任何 token 节省结论都不可靠。

---

## 9. 检索、门控、代码执行、整形与 CLI

### 检索式加载

工具数大于约 10 或定义超过预算时应成为默认基线：摘要常驻，命中 top-k 后 `inspect_tool`。风险是漏召回、别名错误和额外检索往返；必须低置信度空结果、澄清和 fallback。

### 网关门控

按意图、租户、权限、状态、环境和风险做硬过滤，再做语义排序。它可统一审计、计费、密钥和配额，但须多副本、策略版本、缓存一致性、熔断和离线降级；“未登录/只读/生产写”不能由相似度决定。

### 代码执行

适合批量、多步、数据密集、并行 fan-out；不适合简单查询或无成熟沙箱的高风险动作。绑定必须类型化、固定版本、受限标准库并记录子调用 DAG。代码省下的是结果税和往返税，不是安全责任。[审计结论]

### 输出整形

优先服务端过滤、聚合、投影、分页和句柄；紧凑编码必须可验证且可回读。摘要不应是唯一真相；保留原文 Handle 和 Receipt。

### CLI 优先

`git/gh/curl` 等成熟 CLI 可能具有近零定义成本和更好组合性。[源文档] 但 shell 权限粗、错误结构弱、跨平台差异大。LCP 可把 CLI 当 Southbound adapter，并把命令、参数、环境、出站、结果和 Receipt 纳入相同 Policy；不能给模型无限 shell。[审计结论]

---

## 10. 缓存：稳定性优先于压缩率

缓存层包括 Manifest、完整 schema、Retriever 索引、幂等低敏感结果和 Prompt/Provider cache。所有键要包含 tenant/policy scope/version/digest；权限变化、撤销、digest 变化必须主动失效。多租户敏感结果禁止共享。

服务器稳定排序、固定字段顺序、固定空值编码和不变北向前缀有助于 prompt cache。[源文档] 一份更短但每轮变化的目录可能比一份更长但完全命中的目录更贵。[审计结论] 缓存指标必须与 token、成功率、权限拒绝和 stale 命中联合观测；TTL 不能代替撤销，缓存不能代替授权。

---

## 11. 权限、安全与审计

### 11.1 主要威胁

| 威胁 | 控制 |
|---|---|
| 工具描述/错误/资源文本提示词注入 | 不可信数据标记；描述与指令分离；Policy 不由模型决定 |
| 动态元数据投毒 | 签名、digest、版本锁、变更重审、运行时校验 |
| 跨租户缓存或 Handle 泄漏 | tenant-bound key、对象级授权、读取前检查 |
| confused deputy | 显式 `on_behalf_of`、服务器独立对象授权、禁止万能凭证 |
| 高权限密钥外泄 | 最小 scope、短期 capability token、默认只读、出站白名单 |
| 恶意 stdio/npm/容器 | 签名制品、SBOM、锁版本、沙箱、撤销 |
| 沙箱逃逸/资源耗尽 | syscall/网络/FS 隔离、CPU/内存/时长/并发限额 |
| 句柄猜测/重放 | 高熵 ID、Session/tenant/cursor 绑定、TTL、epoch |
| 无界结果 | 硬 Budget、分页/Handle、背压 |
| 检索误召回 | 权限前置、状态和签名过滤、低置信度空结果 |

### 11.2 三条硬边界

1. **最小权限**：默认只读；写、删、发布、支付、导出和提权单独 scope。
2. **出站白名单**：沙箱和 MCP 服务器不能变成任意网络代理；按域名、方法、端口、数据分类和目的地控制。
3. **高风险确认**：人工确认内容包含参数摘要、影响范围、目标、预算和回滚方式；确认不等于绕过服务器授权。

### 11.3 Receipt 审计链

每个入口、Run、ChildCall、MCP Task 状态变化、Handle 读取和取消都记录 `who/what/why/when/where`、tenant/principal/agent、Session/Turn/Task、Manifest digest、Policy snapshot、Budget、代码 hash、南向端点、参数摘要、结果/句柄、耗时、错误、确认和最终状态。Receipt 签名、锚定工作快照、可验证、可争议、可撤销。LCP Receipt 和南向服务器 Receipt 通过 trace/request ID 关联，不互相替代。

---

## 12. 与 `refract.md` 的模块关系

| `refract.md` | LCP 投影 | 模型看到的内容 |
|---|---|---|
| L0 外部资源 | MCP/CLI 适配器 | 摘要和指针 |
| L0.7 Tool/Skill/Protocol | Registry + Manifest 版本/契约 | 当前候选短契约 |
| L1 Session/Turn/预算树 | Budgeter、RunContext、恢复/取消 | 预算余额和状态摘要 |
| L2 注意力对象 | Manifest、候选、schema、Task/Data Handle | mounted 摘要/指针 |
| L3 注意力调度 | Retriever + Policy 门控 | 当前选择和简短理由 |
| L4 上下文组装 | 北向 prompt | 目标、约束、Action、详情 |
| L6 确定性验证 | schema/流程/权限/Budget 校验 | 短错误与修复动作 |
| L7 Evidence/Receipt | 审计链、结果来源、置信度 | Receipt/Handle 指针 |
| 横切能力 | 事件溯源、熔断、幂等、token 归因 | 通常不进上下文 |
| Workspace | Executor 快照、文件/网络边界 | 必要路径和版本指针 |

Turn 完成时，工具详细结果默认不跨 Turn 持久化；活跃 Task、预算余额、未完成 TaskHandle/DataHandle 和必要 Receipt 指针才可 persist。stale 对象禁止继续调用，必须重新 discover/inspect；Agent 只能看到短错误和修复动作。[源文档][审计结论]

---

## 13. 失败模式与修正

1. **万能聚合器**：把全部 schema 合并到一个服务器，只转移定义税并扩大权限/单点风险；应只做检索和路由。
2. **纯向量检索**：语义相似不等于签名兼容、已登录或可授权；必须混合检索和硬门控。
3. **只缩写 schema**：区分度下降，错误和重试反弹；应目录/详情分离。
4. **只依赖 Prompt Cache**：权限变化、租户差异和结果税仍存在；缓存需 digest、scope、主动失效。
5. **超限直接截断**：破坏结构和事实；应 Handle、分页或结构化错误。
6. **模型自授予权限**：提示词是软约束；Policy/Executor/Shaper 必须硬执行。
7. **代码执行无子调用审计**：无法解释副作用；必须保留 Run/ChildCall/Task/Handle Receipt DAG。
8. **把取消确认当成停止**：MCP `tasks/cancel` 是协作式最终一致；必须区分请求、观察到取消、完成先于取消和未知状态。
9. **TaskHandle/DataHandle 混淆**：任务状态和数据所有权不同；二者必须分型、分权限、分 TTL。

---

## 14. 推荐路线与验收

### P0：计量基线（约 2 周）

采集每轮定义、每次结果、历史重放、cache hit/miss/stale、检索召回/选择、LLM 往返、南向调用、重试、p95、每工具/租户失败、Handle 读取、Task 轮询和取消状态。交付按 Session/Turn/Task/Run/Tool/Receipt 归因的账单看板。

### P1：兼容代理 MVP（约 4–6 周）

实现 Manifest Store、混合 Retriever、Budgeter、分页/投影/Handle、Policy 前置过滤和 Receipt；保留原生 MCP fallback。先验证结果税和权限，再尝试紧凑编码。

### P2：代码模式（约 6–10 周）

为高频、低风险、幂等工具生成固定 binding；接入隔离 Executor、出站白名单、资源限额、子调用 Receipt 和取消传播；以 shadow/canary 对比原生 JSON。

### P3：契约和治理（4 周起）

将 Manifest/Budget/Handle/TaskHandle 映射为 MCP profile/extension；补齐签名、撤销、租户隔离、Policy 迁移、审计查询、Tasks 一致性测试和故障注入。

### 验收指标

| 指标 | 目标方向 | 必须联合观察 |
|---|---|---|
| 定义 token/轮 | 下降 | 召回率、选择准确率 |
| 结果 token p95/历史重放 | 显著下降 | 完整性、Handle 可回读 |
| LLM 往返和 p95 | 下降 | 工具成功率、资源成本 |
| Prompt cache hit | 上升且稳定 | tenant/policy scope、stale 命中 |
| 任务成功率/副作用率 | 不下降/上升 | 取消和超时语义 |
| 跨租户泄漏 | 重大事件为零 | 对象级授权、缓存和 Handle |
| Receipt 完整率/撤销可达率 | 100%/可验证 | Run/ChildCall/Task/Handle 父子链 |

---

## 15. 最终审计结论

### 可采纳

- 四个北向入口 + MCP 南向兼容；
- Manifest 与完整 schema 分离；
- 混合检索、状态门控、权限前置和低置信度空结果；
- Budgeter + DataHandle 治理结果税；
- Executor 代码模式治理多步和数据密集任务；
- `RunContext` 不可扩权、ChildCall 继承父权限和预算；
- TaskHandle 与 DataHandle 分型，MCP Tasks 取消按最终一致处理；
- 稳定排序、digest、主动失效和租户绑定缓存；
- CLI 作为受控适配器和反向基准。

### 必须保留的条件

- 源文档中的厂商数字、registry 计数和案例需标注测量时点与口径；
- 论文大多是预印本/基准/模拟，须用真实模型、tokenizer、租户和权限分布复测；
- 四个入口固定不等于风险固定，`run` 与 `read_handle` 仍是强数据面；
- `tasks/cancel` 确认不等于停止，不能把最终状态伪造为 cancelled；
- TTL 不等于授权期限或强制终止；缓存不等于授权；Manifest 不等于信任。

### 不建议

- 从零替换 MCP wire protocol；
- 全量聚合 schema 后指望缓存解决；
- 仅靠提示词限制权限、预算和出站；
- 把任意 shell/任意代码作为低成本工具；
- 让动态、未签名、未绑定租户的描述进入高权限路径；
- 没有 P0 账本就承诺固定 token 降幅。

**最终判断 [审计结论]**：LCP 应实现为 MCP-compatible profile + context-plane runtime。模型在每个 Turn 只看到与当前目标、权限、预算、状态和证据相匹配的最小信息；执行侧可以做更多工作，但租户、权限、版本、取消、结果完整性和审计链不能越界。

---

## 16. 参考资料

### 项目内源文档

- `MCP-Token税与下一代工具协议.html`：四类 token 成本、检索/门控/代码执行/输出整形/CLI、LCP 四入口和六模块、Manifest/Budget/Handle、缓存、安全与路线。
- `refract.md`：注意力调度、Session/Turn、预算树、Tool/Skill/Protocol 生命周期、Receipt/Evidence、上下文组装、stale/版本/审计/撤销约束。

### 规范补充

- MCP Tasks Extension，`io.modelcontextprotocol/tasks`：[官方规范](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)
- SEP-2663 Tasks Extension：[官方 SEP](https://modelcontextprotocol.io/seps/2663-tasks-extension)

### 论文补充

- NTILC：[arXiv:2606.06566](https://arxiv.org/abs/2606.06566)
- Toollery：[arXiv:2609.22218](https://arxiv.org/abs/2609.22218)
- MCP-DPT：[arXiv:2604.07551](https://arxiv.org/abs/2604.07551)
- The Bitter Lesson of Tool Calling：[arXiv:2608.06370](https://arxiv.org/abs/2608.06370)
- Plan or Retrieve First?：[arXiv:2610.19068](https://arxiv.org/abs/2610.19068)

> 外部内容仅作资料补充；本报告没有把外部页面中的指令、宣传性表述或未复现数字当作项目事实。