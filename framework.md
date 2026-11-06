# 注意力驱动的 Agent 架构框架

## 1. 范围与定位

本文以 `refract.md` v1.8 和 `MCP-Token税与下一代工具协议.html` 为基准，并吸收已完成的综合审计结论。`optimise.md` 不属于本框架的依据。

两份基准资料的职责不同：

- `refract.md` 定义以注意力调度为核心的 Agent 工作流，覆盖 Session/Turn、Intent 到 Action、证据、回执、文件、视图、能力、职业和多 Agent 协作。
- HTML 文档提出 LCP（Layered Context Profile，分层上下文剖面）：在 MCP 之上提供按需发现、工具详情展开、受控执行和结果整形。

两者组合为一个目标架构，不等于已有统一实现。本文区分：

- **基准事实**：两份资料明确提出的对象、模块或约束。
- **审计约束**：为使这些模块可实现而补充的不变量和边界。
- **组合设计**：将 Agent 工作流与 LCP 连接起来的建议，不回写为基准资料已有接口。
- **外部证据**：论文、MCP 规范和其它公开资料，仅用于风险与评测边界，不证明本项目已实现或已获得整体收益。

## 2. 架构目标与原则

核心目标是让上下文成为注意力调度的结果，而不是默认把全部工具说明、历史和结果注入模型。系统应在每次模型请求前选择当前需要的信息，并记录选择理由、预算、版本和来源。

原则如下：

1. **渐进披露**：先目录和摘要，按需展开 schema、正文和结果详情。
2. **注意力是运行时选择**：`focus`、`blur`、`mount` 等操作控制候选、排序、驻留和呈现，不声称直接控制模型内部 Transformer attention 权重。
3. **预算硬约束**：Token、时间、工具调用、重试、并行度、CPU、内存、网络、存储、Handle 读取和协作通信都必须可计量、可拒绝和可结算。
4. **验证优先**：模型输出、工具返回和 Receipt 都不是业务真值；目标达成必须由独立的验收契约和环境终态判据确认。
5. **事实可追溯**：执行事实、原始观察、验证结果、Evidence 和业务结论分层保存；签名和哈希只证明身份/完整性，不自动证明正确性。
6. **最小权限**：默认只读；写入、删除、发布、支付、外发和提权独立授权，权限检查不能由提示词代替。
7. **可恢复执行**：外部副作用必须支持幂等、查询、对账或补偿中的至少一种；效果不明时进入 `unknown_outcome`，不能普通重试非幂等操作。
8. **版本与失效**：能力、文件、视图、摘要、句柄、策略和证据都绑定版本/新鲜度；stale 内容不能作为当前有效依据。
9. **失败隔离**：失败由直接父级处理；取消、证据撤销和资源失效沿各自依赖关系传播，不混成同一通道。
10. **渐进落地**：先做可恢复的单 Agent 只读闭环，再做写入、并行、协作、学习和复杂统计融合。

## 3. 总体分层与事实所有权

### 3.1 L0–L8 责任地图

L0–L8 是逻辑责任地图，不是所有请求必须经过的串行调用栈，也不是必须对应独立进程或数据库表。

| 层 | 责任 | 边界 |
| --- | --- | --- |
| L0 | 外部工具、知识和行为资源适配 | 发现或适配不等于可信和授权 |
| L0.5 Workspace | 文件、树、大纲、快照、权限、隔离和提交 | 不直接判定业务 Goal 达成 |
| L0.6 Project | 指令、架构、配置、约定和项目知识 | 规则/事实须有版本、来源和适用范围 |
| L0.7 能力治理 | Tool、Skill、Protocol、Cognition、Behavior 的定义、版本、依赖、评测和发布 | 能力定义与一次调用实例分离 |
| L0.8 Profession | 能力偏好、验证严格度和风险偏好 | 只能收紧策略或影响排序，不能自动扩权 |
| L0.9 Cooperation | Agent 身份、信任、委托、拓扑、协商和仲裁 | 不成为第二个万能状态机 |
| L1 | Session/Turn、六级业务生命周期、事件、队列和预算 | 业务状态唯一写入者 |
| L2 | 注意力对象和呈现元数据 | 是领域对象的版本化引用，不是第二个事实库 |
| L3 | 路由、聚焦、切换、抑制、关联和候选调度 | 产生建议；L1 最终确认 ready 和执行授权 |
| L4 | 当前模型请求的上下文编译 | 记录输入对象版本、预算、外置和截断 |
| L5 | 推理、规划、失败归因和结构化命令提案 | 不能直接写成功状态、预算或权限 |
| L6 | 状态、契约、过程和业务终态验证 | 验证器有版本、范围和独立结果 |
| L7 | Evidence 依赖、融合、消费审计、撤销和失效 | 向 L1 提交验证结果，不绕过命令端口改状态 |
| L8 | 从验证轨迹形成学习候选 | 经评测、影子/金丝雀和发布后才进入 L0.7 |

横切能力包括事件溯源、幂等、预算账本、版本迁移、审计、熔断、故障注入、缓存失效和可观测性。它们不应作为额外的无界上下文负担注入模型。

### 3.2 唯一事实所有者

| 事实 | 所有者 | 其它模块 |
| --- | --- | --- |
| Session/Turn/Intent/Workflow Task 状态 | L1 | 读取投影或提交命令，不重复写终态 |
| 能力定义和批准版本 | L0.7 Registry | Manifest Store 保存可失效的检索投影 |
| 候选和注意力次序 | L3/Retriever | 只提供候选和理由，不授予权限 |
| 上下文编码 | L4/Shaper | 不修改原始 Observation |
| 权限裁决 | PDP | Executor、File、Handle 等作为 PEP 强制执行 |
| 预算和配额 | 统一 Budget Ledger | LCP Budgeter 适配执行/结果预算 |
| 实际调用和沙箱事实 | Executor/连接器 | 保存 Observation、外部操作标识和未知结果 |
| 结构/业务验证 | L6 | 生成 VerificationRecord |
| Evidence 和结论依赖 | L7 | 管声明、来源、撤销和失效闭包 |
| 学习候选 | L8，发布由 L0.7 完成 | 不直接替换运行中版本 |
| 协作委托 | L0.9 | L1 仍写 Task 状态，L3 仍消费调度结果 |

## 4. 业务对象与生命周期

### 4.1 Session、Turn 与六级业务链

`Session` 是跨多轮的应用交互容器，持有参与者、历史摘要、预算、活跃业务对象和跨轮保留引用。它不等于 MCP 传输 Session；底层 MCP 无状态请求不消除应用 Session、数据库状态、句柄或远程任务。

`Turn` 是一次输入到响应的交互单元、Intent 捕获边界、注意力重置点和响应预算归因单位。Turn 不等于一次 LLM 调用、Action、Mission 或完整任务。

```text
Session ──包含──> Turn[0..N]
   ├──持有──> Intent / Mission / Cooperation
   ├──持有──> Session 预算和跨轮保留预算
   └──关联──> 历史、Evidence、Receipt 和持久化引用

Turn ──捕获 0..N──> Intent
Intent → Mission → Goal → Plan → Task → Action
```

- Intent：尚未正式承诺的原始意图。
- Mission：对 Intent 的正式承接。
- Goal：可验证终态及验收标准。
- Plan：策略、控制流和 Task DAG。
- Task：可独立跟踪、可并行的战术单元。
- Action：通过 Tool/Skill 执行的原子操作声明。

Intent 在 `Turn.interpreting` 捕获，并可跨 Turn 存活；Mission/Goal/Plan/Task 可跨 Turn 推进；Action 的外部执行通过独立 Execution 归属，不被强行绑定到 Turn 的结束时间。

### 4.2 状态闭合要求

基准资料中的箭头图需要补成正式转移表。每条转移至少声明 `event_type`、`from`、`to`、触发者、guard、预期版本、预算、权限、副作用、Receipt/Evidence 要求、补偿和幂等语义。

必须显式处理：

- 取消传播使用了 `Mission.cancelled`/`Plan.cancelled` 时，要在状态合同中正式定义，不能只由传播箭头隐式增加。
- Goal 达成证据撤销后，保留“曾达成”事实，同时设 `validity=invalidated` 或 `verification_pending`，并启动纠正 Plan；不能删除历史或静默继续显示有效。
- Task 完成不能简单等同“所有 Action succeeded”；要按必需效果、可选分支、失败 attempt、补偿、未知副作用和当前验收表达式判断。
- Plan DAG 无环不等于整个系统终止；retry、replan、MRTR、轮询、协商和代码循环必须有总次数、deadline、进展度量和死信处理者。

本地取消建议采用：

```text
cancel_requested → draining → cancelled
                         ↘ completed_after_cancel
                         ↘ unknown_outcome
```

取消请求不等于所有本地/远程工作已经停止，也不撤销已经提交的外部副作用。旧 epoch 在提交门禁处必须被拒绝。

### 4.3 Session/Turn 状态

Session 的常规路径为 `created → active ⇄ idle`；可选恢复分支为 `suspended → resumed → active`；关闭为 `closing → closed → archived`，另有 `expired`、`aborted`。`closed` 是否可原地恢复必须单独规定；不能由术语隐式增加 reopen 边。

Turn 的主路径为：

```text
received → interpreting → acting → responding → completed
                 ↓            ↓          ↓
             clarifying   interrupted  failed
                 ↓            ↓
             interpreting  resumed → acting
                              ↓
                           abandoned
```

澄清输入必须带 `reply_to`/`continuation_key`，明确是原 Turn 等待续接还是新 Turn 关联。用户新输入还应先分类为 steering、status、cancel 或 new intent，不能把每条新消息自动解释为 `superseded`。

## 5. 执行边界、上下文和审计链

### 5.1 ExecutionContext

Session/Turn 是交互和业务归属；外部执行需要可跨 Turn 的 Execution 边界。每次外部调用携带由宿主注入、模型不可覆盖的上下文：

```text
ExecutionContext
  tenant_id, principal_id, agent_id, delegation_chain
  session_id, origin_turn_id, observed_in_turn_id?
  mission_id?, workflow_task_id?, action_id
  execution_id, operation_id, attempt_id, execution_span_id
  workspace_id?, snapshot_id?, capability_binding_id
  policy_version, authorization_context_id, approval_ref?
  budget_reservation_id, deadline, cancellation_epoch
```

`origin_turn_id` 是触发来源，`observed_in_turn_id` 是结果被消费/报告的 Turn。`operation_id` 在网络重试中保持稳定，`attempt_id` 每次尝试唯一。`Turn completed`、`Mission achieved` 和 `Attempt settled` 是不同事件。

### 5.2 统一执行流

```text
输入事件去重和登记
  → 创建/恢复 Session，恢复任务、预算、持久引用和未决执行
  → Turn received/interpreting，捕获或关联 Intent
  → 确认/承接 Intent，固定 Mission/Goal 验收契约
  → 生成 Plan 版本和 Task DAG，检查依赖、回退、资源和预算
  → L3 选择注意力；L4 编译模型请求
  → find_tools：检索候选并先做授权/状态过滤
  → inspect_tool：固定完整 schema、版本和 digest
  → 预算 reserve，持久化 intent-to-execute，生成 Action/Invocation
  → PDP/PEP 准入，Executor 调用 MCP/CLI/SDK
  → 每个有副作用的子调用保存 Observation、ReceiptCore 和 attempt
  → Shaper 返回字段投影、分页、Handle 或受控摘要
  → L6 验证契约、过程和环境终态
  → L7 生成声明级 Evidence，执行去重、冲突、时效和撤销管理
  → 仅在版本、租约、预算和证据闭包有效时提交 Task/Goal
  → responding：输出有效结果、未知状态和待处理项
  → 结算预算、更新 Session、重置非持久注意力
  → 后台对账未知副作用、释放租约、处理远程任务和 dirty 现场
```

事件重放只重建状态，不重新执行外部副作用。超时或断网而效果不明进入 `unknown_outcome/reconciling`；对账前不能普通重试非幂等写。

### 5.3 执行事实与业务证据

执行链必须拆开：

```text
Invocation / ActionAttempt
  → ObservationRecord（原始输出、产物、外部效果、版本）
  → ReceiptCore（谁、何时、执行什么、观察到什么、哈希/签名）
  → ReceiptIntegrityVerification
  → VerificationRecord（按版本化判据验证什么）
  → Evidence（支持/反驳哪个原子声明）
  → GoalAssessment / 业务终态
```

Receipt 证明执行事实和完整性，不自动证明业务正确；Evidence 绑定声明、来源、观察对象、判据、环境和失效条件；Goal 只能由独立验收契约达成。签名后的核心不可变，争议、撤销和补偿以追加事件表示。这样避免“Receipt 等 Evidence 才能锚定，Evidence 又等 verified Receipt 才能产生”的前置环。

## 6. 注意力与上下文编译

注意力对象包含摘要/指针、来源、评分向量、过期条件、Evidence/Receipt/能力/行为引用、Session/Turn 归属、Workspace/Project 锚点和保留策略。八个操作分为：

| 分组 | 操作 | 语义 |
| --- | --- | --- |
| 强度 | `focus` / `blur` | 提权/置顶；降权但保留摘要，不删除 |
| 驻留 | `mount` / `unmount` / `persist` | 进入/离开上下文；跨步骤/Turn 保留必须有预算、过期条件和理由 |
| 内容 | `update` | 证据或变更传播后刷新评分和摘要 |
| 关系证据 | `associate` / `verify` | 有界生成候选；评估后验、证据和建议，不直接完成业务验证 |

`blur` 不等于 `unmount`，`persist` 不等于永久保留正文。`associate` 必须有 visited 去重、深度/候选/成本上限，且不能自动扩大权限或 Workspace 范围。每次模型请求前都可以重新编译上下文，不能只在 Turn 结束时清理。

上下文应优先保留：当前输入、目标和约束、Goal 验收标准、当前 Task、必要的 Profession/Cooperation 摘要、版本化文件/工具摘要、证据置信度和最近 Receipt 状态。视图渲染不进入模型上下文；大结果通过可回取引用外置。

## 7. LCP 工具上下文平面

### 7.1 结构

LCP 是 MCP-compatible profile + context-plane runtime，不是新的南向 wire protocol。模型可见四个稳定入口：

1. `find_tools(query)`：检索授权范围内的能力摘要。
2. `inspect_tool(id)`：展开固定版本的完整 schema 和调用契约。
3. `run(code, budget)`：在受控环境中编排一个或多个类型化调用。
4. `read_handle(id, cursor)`：按权限和游标读取外置大结果。

南向适配复用 MCP 的 `server/discover`、`tools/list` 和 `tools/call`。四个入口的 schema 可以稳定，但检索结果、详情、代码、错误和历史仍可能增长，不能宣称端到端成本恒定。

### 7.2 六个组件

| 组件 | 职责 | 关键边界 |
| --- | --- | --- |
| Manifest Store | 缓存服务器能力卡片、工具摘要、完整 schema 和绑定 | digest/版本/TTL/租户/策略 scope；TTL 不是授权期限 |
| Retriever | 将意图映射到候选工具/工具集 | 混合检索、签名/类型约束、状态过滤；低置信度可空结果 |
| Budgeter | 强制每轮、每结果、每任务及资源预算 | 超限转 Handle/分页/受控摘要/错误，不能静默截断 |
| Executor | 在隔离环境调用类型化绑定或受控 CLI/SDK | 默认禁网、资源限额、每子调用授权和审计 |
| Shaper | 过滤、聚合、投影、分页、编码和句柄化 | 原文可回取；格式/摘要不自动成为真值 |
| Policy & Audit | PDP/PEP、审批、配额、审计、撤销和追踪 | 横切全部入口、子调用、Handle 和数据出口 |

### 7.3 三份契约

**Manifest** 是导航和版本固定信息，不是权限本身，至少包含服务器/端点身份、工具 ID、版本、digest、短签名、`when`/`not_when`、风险/副作用、前置条件、schema digest 和策略范围。完整 schema 由 `inspect_tool` 按需展开。缓存键必须绑定 tenant、端点、版本、digest 和 policy scope。

**Budget** 由调用方声明并由执行方强制，至少包含输入/输出/总 Token、格式、超限动作、deadline、调用/重试/并行度、CPU、内存、网络、存储、Handle、轮询和 MRTR 限额。结果过大时应 Handle、分页、受控摘要或明确报错。

**Handle** 不是普通字符串。`DataHandle` 应绑定 owner、tenant、Session、来源 Receipt/digest、数据分类、schema、TTL、权限投影、cursor、撤销 epoch 和审计引用；每次读取重新授权。`TaskHandle` 单独表示远程任务状态、服务器身份、TTL、poll 间隔、取消和最终结果；不能与 DataHandle 混用。

### 7.4 `run` 子调用与远程任务

`run` 是批量执行入口，不是天然原子 Action。一个 `run` 可以包含多个有副作用的子调用，必须为每个子调用建立 ChildCall/Invocation、Policy 检查、预算归属、幂等键、Observation 和 Receipt；外层 Run Receipt 只是聚合。

MCP Tasks 的远程任务与本地 WorkflowTask 分型：收到远程任务句柄只表示任务创建，不表示 Action succeeded；`completed` 可能带 `isError:true`，业务成功仍需 L1/L6 验收。`tasks/cancel` 是合作式请求，确认不保证停止，远程任务可能在取消请求后完成。保存 `taskId`、端点身份、授权上下文、poll/TTL、请求去重键和原始结果，状态至少容纳 `cancel_requested`、取消观察、完成先于取消和 `unknown_outcome`。

## 8. 文件、视图与协作

### 8.1 Workspace/File

Workspace 是工作现场；Project 是项目知识。文件状态与访问模式正交：

```text
unmounted → mounted → active → unmounted
                 ↓         ↓
               stale     dirty → active
```

- `unmounted`：只有路径引用。
- `mounted`：元数据和大纲已加载，正文未加载。
- `active`：正文已加载并绑定版本哈希。
- `stale`：记录版本与磁盘版本不一致，不能作为当前真相 read/write。
- `dirty`：存在未持久化编辑，普通 unmount 不得静默丢弃。

`read-only | writable` 与状态正交。`range` 是 `read/write/locate` 参数 `{line|byte,start,end}`；charset 是 metadata；diff 是独立校验操作。写入提交必须在最终时刻检查 expected hash、权限和 fencing token，防止 TOCTOU。dirty 冲突要保留 base/ours/theirs，不能用原子 rename 代替版本竞争控制。本地快照不能撤销邮件、支付、远程删除等外部副作用。

### 8.2 六种视图

ER、时序、流程、Venn、架构和脑图都是关系投影，带版本、新鲜度、来源和锚点，不是真相。渲染隐藏在模型上下文外；可执行约束由 L6 验证。脑图父子边无环，关联边须限深、限量、去重并附理由；视图和索引过期时必须传播 stale。

### 8.3 Cooperation 与跨 Agent 安全

Cooperation 绑定 Mission/Goal/Task，定义参与者、角色、拓扑、通信、分工、预算、权限、仲裁和退出。子 Agent 有独立 L1 状态，通过委托契约同步结果；Task 是跨 Agent 最小调度单位。默认 Workspace 为 `isolated`，共享写需要锁、版本哈希、合并点和 fencing。

Agent 签名、信任分和 Receipt verified 不自动证明安全组合或统计独立。跨 Agent 消息必须区分可信委托指令、不可信数据引用、provenance 和 authority scope；子 Agent 不能提升来源权威或把外部数据伪装成用户确认。跨 Agent Evidence 进入融合前需要信任门槛、回执完整性验证、独立性分析和综合可靠性门槛。

## 9. 预算、恢复、可靠性与安全

### 9.1 预算

统一账本使用 `reserve → commit/settle → release/transfer`。业务预算更适合按稳定 work item 组织：

```text
Session → Mission → Goal → Plan → Task → Attempt
```

Turn 是交互归因和临时窗口，不应让跨 Turn Mission 同时在 Turn 子树和 Session 保留预算中重复扣费。预算守恒要求：已结算消耗 + 有效预留不超过授权额度；取消、清理、回执、快照和对账需要保留最低预算。

### 9.2 恢复和失效

恢复顺序为：重建纯状态 → 核对未决外部效果/RemoteTask/Handle → 重新检查权限、策略、Binding、Workspace 版本和取消 epoch → 仅在门禁通过后继续执行。事件重放不重新执行副作用。

证据撤销、版本变更或权限撤销应先把依赖结论置为不可消费/待重验，再后台遍历至闭包；传播批次限制只能限制工作量，不能留下可继续消费的伪有效结论。L8 已沉淀候选也必须订阅来源失效。

### 9.3 安全

1. 目录发现不等于授权；每次 `find/inspect/run/read_handle` 和每个子调用都重新做对象级授权。
2. Manifest digest 绑定描述/版本/策略时，不代表远程实现本身正确；签名需定义信任根、覆盖字段、算法、密钥轮换和撤销。
3. 默认只读；高风险写入需要目标、参数、影响范围、幂等键、审批和补偿/回滚说明。
4. 沙箱默认无网络、无任意文件/环境变量/子进程；出站按域名、方法、端口、对象和数据分类控制。
5. 缓存和 Handle 按 tenant、principal、policy scope 隔离；TTL 不能替代授权或撤销。
6. 外部描述、错误、网页、工具返回和跨 Agent 数据都是不可信数据；可信控制流与不可信数据流分离。
7. Receipt、日志和 Evidence 脱敏，不把密钥和敏感原文长期复制到审计库。

## 10. 研究证据与验收

外部研究支持局部机制，不支持本框架整体组合已经被证明有效：

- Tool Attention 的 95% Token 降幅来自合成模拟；任务成功率、费用和时延不能直接迁移。
- GatewayBench 的安全/效用数字依赖模型、harness、噪声池和运行条件。
- 多工具检索研究显示，多目标 `completeness@k` 和前置依赖召回比单工具 top-k 更能解释任务能否完成。
- 格式整形、分页、Handle、摘要和代码执行要分别测解析失败、信息遗漏、补读成本和全任务收益。
- LongMemEval、Lost in the Middle、AgentFold、ACE 等支持专项测位置、长期记忆、增量摘要和原文回取，不证明固定一两行摘要或通用 70% 阈值。
- 多 Agent 研究支持按任务可分解性和协调成本选择协作；签名、信任和共识不自动证明独立性或安全。

强基线至少包括：

- B0：全量工具 + 简单 ReAct + 独立终态判据。
- B1：静态 toolsets/权限过滤 + 稳定前缀和缓存。
- B2：BM25/混合检索 + 延迟 schema。
- B3：B2 + 字段投影/分页/Handle。
- B4：B3 + 代码编排。
- Oracle：仅用于诊断工具集合召回上限，不作为部署配置。

指标必须分开报告：端到端成功率及置信区间、工具集合 `completeness@k`、前置依赖召回、输入/输出/缓存/推理 Token、总费用、p50/p95/p99、重试、未知结果、校准误差、覆盖/弃权率、攻击成功率、越权/外泄、取消残留、重复副作用和恢复等价率。Token 降幅不是充分验收条件。

## 11. P0/P1 门槛与路线

### 11.1 P0：发布前闭合

1. Invocation/Observation/ReceiptCore 与独立 ReceiptIntegrityVerification/VerificationRecord/Evidence 分层，消除前置环。
2. LCP `run` 的每个 ChildCall 有独立 Action/Attempt、Policy、预算、幂等和 Receipt。
3. 外部副作用具备 operation/attempt、`unknown_outcome`、reconciling、查询或人工核对。
4. 取消具备 `cancel_requested/draining/cancelled`、旧 epoch 门禁、RemoteTask 分型和迟到结果处理。
5. tenant/principal/policy/委托链贯穿缓存、Manifest、Handle、Receipt、恢复和子调用。
6. 写操作之前完成 PDP/PEP、审计、最小权限和结果预算。
7. 文件提交具备 CAS、fencing、dirty 草稿保护和因果回滚。
8. 跨 Agent 保留 provenance/taint，可信指令和不可信数据分离。

### 11.2 P1：扩展前验证

- Mission/Plan 取消、Goal 失效/纠正、Task skipped/failed attempt/unknown 的完成谓词。
- 澄清续接、异步执行归属、预算转移和清理保留额。
- Retriever 多工具完整召回、暂时不可执行前置原因、associate 循环和扩大召回。
- 视图、摘要、Handle 的版本、新鲜度、分页一致性和原文保留。
- L1/L3 调度、L6/L7 验证、Policy/Budgeter 的唯一写入和端口边界。
- retry、replan、MRTR、轮询、协商、锁和撤销传播的次数、deadline、进展与死信。

### 11.3 分阶段路线

**Agent 工作流**：

1. 只读串行内核：单 Agent、最小 Session/Turn、少量工具、只读 Workspace、统一预算和事实/验证/证据分层。
2. 写入与恢复：Task DAG、attempt/unknown、文件 CAS、取消栅栏、证据撤销、快照对账和 Session/Turn 恢复。
3. 双 Agent 与批量执行：Task 委派、隔离 Workspace、ExecutionBatch 子调用审计、合并点和 fencing。
4. 适应性调度与学习：候选评分、增量经验、影子/金丝雀、任务族校准、未见任务测试。
5. 高级扩展：多拓扑、高级视图、复杂贝叶斯和大规模证据治理，只在基线显示净收益后启用。

**LCP 工具平面**：

1. P0 计量和基线：定义、结果、往返、协议成本按请求、Task、Turn、Session、租户归因。
2. P1 兼容代理 MVP：Manifest、混合检索、Policy/状态门控、Budget、Shaper 和 Handle。
3. P2 代码模式：高频类型化 Binding、Executor 沙箱、出站白名单、子调用 Receipt 和资源限额。
4. P3 契约和治理：Manifest/Budget/Handle/TaskHandle 扩展、签名、撤销、审批、审计和策略迁移。

两条路线是不同维度，不能把 HTML 的工期、性能比例或外部生态计数当项目承诺。安全、租户、授权、基本审计和 `unknown_outcome` 必须前移到最小闭环。

## 12. 必须注入的故障场景

- 远端写已成功，本地 Receipt 落盘前崩溃。
- 取消请求发出后，远程任务仍返回成功或 `completed + isError`。
- `run` 第三步失败，前两步已经产生外部副作用。
- 租户 A/B 访问相同端点、相同查询和可猜 Handle。
- 权限撤销、文件锁过期、外部进程修改文件后执行 flush。
- Goal 达成 Evidence 被撤销，依赖传播超过单批次深度。
- MRTR/input_required 重复、拒绝、超时或凭据过期。
- 分页期间数据变化、Handle 到期、原始 Observation 被清理。
- worker 迟到、乱序、重复投递或旧 epoch 恢复。
- 多 Turn/多 Agent 同时预留最后额度。
- Session 关闭时仍有 dirty buffer、unknown attempt、RemoteTask 或未释放租约。

每项都要报告：独立终态、任务效用、攻击成功率/越权率、未知结果、取消残留、重复副作用、预算差额、p95/p99、总费用和可复验性。

## 13. 最终边界

本框架保留的骨架是：Session/Turn 与业务生命周期分离、Plan/Task DAG、按需工具上下文、版本化 Workspace、视图投影、不可变执行事实、声明级 Evidence 和统一委派协议。

在状态迁移、ExecutionContext、Invocation/Observation/Verification/ReceiptCore、PDP/PEP、预算账本、幂等/未知结果、取消/远程任务、文件提交和 provenance 通过属性测试、故障注入、固定测试集和独立终态评测前，不应宣称：

- 取消已经彻底停止所有远程副作用；
- 事件重放可以普遍安全重执行；
- Receipt 或签名自动等于业务真值；
- 四个北向入口让端到端成本恒定；
- 多 Agent 会自动安全组合；
- L0–L8、六级生命周期、八操作和六视图的整体组合已经证明优于简单基线。

## 14. 参考边界

本框架的项目内基准是：

- `refract.md`
- `MCP-Token税与下一代工具协议.html`

综合审计使用的外部补充包括：Tool Attention、GatewayBench、多工具检索 completeness 研究、Notation Matters、Lost in the Middle、LongMemEval、AgentDojo、MAST、LLM Compiler、τ-bench、Can CaMeLs Talk?、MCP 2026-07-28 Tasks 扩展、MCP 变更记录和 RFC 8785。外部资料用于补充风险、研究边界和评测设计，不证明本框架已经实现或整体有效。
