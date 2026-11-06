# 架构一致性审计：生命周期、执行闭环与 LCP 交界面

审计日期：2026-11-06。审计性质：设计文档审计与公开资料核验，不是实现代码审计或安全测试。

完整阅读范围：[refract.md](../refract.md) 第 1–2218 行；[MCP-Token税与下一代工具协议.html](../MCP-Token税与下一代工具协议.html) 第 1–1763 行，包含样式、正文、参考资料和脚本。本文以下以 R§ 表示前者章节，以 H§ 表示后者章节；行号用于定位原文。未读取或修改其他 report，未读取或修改 framework，仅创建本报告。

**来源分界：** MCP Tasks 2026-07-28 的取消/完成语义、CaMeL 与 2026-10-05 *Can CaMeLs Talk?* 的研究结论，均为本次补充核验的外部规范或论文，不是 refract 原文。本报告将“原文依据”“外部补充”和“作者修订建议”分别标出，避免混同。

## 1. 审计结论与严重性口径

两份材料在“渐进披露、结果外置、运行时强制预算、兼容 MCP”方向上一致，但尚未构成可直接实现的闭合架构。主要缺口不是模块数量不足，而是不同模块对同一执行事实、状态、权限和预算缺少唯一所有者。R 的六级生命周期承担业务治理，H 的 LCP 承担工具访问与上下文整形；二者中间缺少统一的调用、等待、恢复、取消和结果归属契约。

**建议有条件接受总体方向；在解决本报告 P0 项以前，不应宣称“完整生命周期”“取消彻底”“可安全重放”“回执即客观正确性”或“现有端点零改造即可获得相同治理保证”。** 这些是设计推导，不代表已观察到实现事故。

严重性定义：P0 表示可导致越权、重复外部副作用、证据闭环无法启动或关键状态无法恢复，属于写操作/多租户/异步路径的发布阻断项；P1 表示结果错误、并发不一致、资源泄漏或长期不收敛，需要在对应功能上线前解决；P2 表示可衡量性、可维护性或表达精度问题。文档直接矛盾标为“冲突”；尚无契约而风险取决于实现的标为“缺失/不确定”，不将后者当成已证实漏洞。

## 2. 先固定架构上下游和唯一写入者

下表是建议的职责分割，不是原文已提供的接口。核心要求是：LCP 是执行与披露的适配面，不能另建一套与 L1 竞争的业务状态机。

| 对象/决定 | 唯一事实所有者 | 上游输入 | 下游输出与边界 |
|---|---|---|---|
| Session/Turn/Intent/工作流 Task 状态 | L1 运行时聚合 | 经过认证的输入事件、执行事件 | 带版本的状态投影；LCP 不直接标 Goal achieved |
| 能力定义与批准版本 | L0.7 Registry | 可信配置、签名制品、评测 | 固定 schema/implementation/policy 引用；Manifest Store 是投影缓存 |
| 候选检索与注意力次序 | L3，使用 Retriever | L1 当前目标、L2 索引、授权后的能力集合 | 候选与理由；召回和高分不能授予权限 |
| 上下文选择与编码 | L4，调用 Shaper | 候选、不可变 Observation、结果预算 | 摘要/句柄与来源映射；不改原始证据 |
| 权限裁决 | 独立 Policy Decision Point（PDP） | 身份、委托链、资源、操作、策略版本 | allow/deny/approval_required；Executor、句柄存储、文件层是强制点（PEP） |
| 预算与配额 | 统一账本 | Session 授权额度、各消耗方申请 | 原子 reserve/commit/release；LCP Budgeter 仅适配结果和执行限额 |
| 实际调用及沙箱 | Executor/连接器 | 经准入的 Invocation | 子调用日志、原始结果、外部操作标识、失败/未知结果；不自行宣告业务达成 |
| 结构和业务验证 | L6 | 原始 Observation、标准版本、workspace/工具版本 | VerificationRecord；与签名验证分开 |
| Evidence 及结论依赖 | L7 | Observation/VerificationRecord | 可撤销的命题、消费依赖图和失效事件 |
| 轨迹学习 | L8 | 已冻结的验证集和有效轨迹 | 候选；L0.7 完成注册、版本与激活 |
| 协作拓扑及委托 | L0.9 | 父工作流、授权范围、预算租约 | 派发契约；L1 仍是 Task 状态写入者，L3 仍是调度消费者 |

原文重叠点包括：L1 与 L3 都有 DAG 调度（R 1244、1766）；L0.9 与 L3 都有拓扑调度；L0.7 与 L8 都做 Behavior 抽象；L1、L7、L0.9、L5/L6 都列出冲突仲裁；LCP Budgeter 与 Policy & Audit 都列配额，R 又有预算树。建议以“一个命令处理器写事实、其他层读投影/发建议事件”消除重叠；争议分型转交，不能由多个仲裁器同时更新同一终态。

## 3. 严重问题：P0

### A01　Receipt、Evidence 与验证形成潜在前置环〔冲突/契约缺失〕

**依据：** R 202 说 Receipt 产生 Evidence；R 1014 要求 signed→anchored 必须关联快照和证据；R 1388 要求操作必须有已 verified Receipt；R 704 又要求跨 Agent Evidence 只有在 Receipt verified 后才能进入融合。R 的总数据流（167）为执行→Receipt→验证→Evidence，而核心循环（1800）省略验证，写作 Receipt→Evidence→融合。

**失败路径：** 若 anchored 所需证据必须是已验证的 Evidence，Receipt 等 Evidence；Evidence 进入验证/融合又等 verified Receipt，首条跨 Agent 操作无法前进。反之若为破环允许任意证据先进入，则“已 verified”到底只表示来源完整性还是任务正确性不清楚，可能发生自证。非文件工具、失败调用、Turn 汇总回执也未必有 workspace 快照，统一 anchored 前置条件可能不可满足。

**修订：** 拆分不可变 `InvocationRecord → ObservationRecord → ReceiptCore`，ReceiptCore 只锚定原始结果摘要哈希、执行上下文与可选 workspace 前后版本；先验证签名/来源完整性，生成独立 `ReceiptVerificationRecord`，再由 L6 基于原始观测生成业务 `VerificationRecord`，L7 才激活 Evidence。原始记录可以被引用，不要求其结论先被认定为真。将 verified 拆为 `integrity_verified` 与 `semantic_verified`，禁止同一凭据同时充当被证明命题和唯一证明。后续争议、撤销、补充证据采用追加记录，不能回写已签名正文。

### A02　LCP 批量代码执行绕开 Action 级治理〔缺失〕

**依据：** H 1421 只暴露 `run(code,budget)`；H 1147 允许循环、条件、并行、多步调用留在沙箱。R 201 说 Tool 原子执行产生 Receipt，R 744 要求每次调用产生 action_receipt，R 1176 规定 Action 不跨 Agent，R 1388 要求每次操作可验证。

**失败路径：** 一个 `run` 内顺序读私库、创建 PR、发消息，若只生成一张外层回执，内部写调用没有独立 Action、权限判断、幂等键、预算归属和撤销依赖。第 3 次调用失败后重跑代码会重复前 2 次副作用；沙箱隔离不能修复这个业务语义问题。

**修订：** 定义 `ExecutionBatch` 包含 0..N 个受治理的子 Invocation；每个类型化绑定强制继承 ExecutionContext，经 PEP 准入，并创建独立调用与结果记录。外层回执是聚合，不能替代子回执。只有可证明无外部副作用的本地 map/filter 才不生成 Action。代码中的动态分支可以增量登记 Action，但必须在产生副作用之前完成策略检查与持久化。`run` 的“成功”只表示解释器完成；Task 是否完成仍由 L1/L6 决定。

### A03　缺少可恢复的副作用提交协议〔缺失；最新规范强化风险〕

**依据：** R 1755 将工具、历史、Receipt 重放和 Session 恢复一起归为幂等/可重放；H 1521 用“无状态请求”推出“随意重试”。两份材料没有规定“远端成功、本地尚未记回执即崩溃”的处理。

**失败路径：** 创建订单/PR/发邮件已在远端完成，网络断开导致本地看到超时；恢复只重放历史或重跑 `run`，产生第二次写。JSON-RPC 新请求 ID 不是业务幂等键。MCP 2026-07-28 已移除 SSE 重投递/续接，断流必须走新的请求，不能据此推断第一次没有执行。[S1][S3]

**修订：** 调用前持久化含 operation_id、attempt_id、参数摘要、策略及版本的准入/意图记录；连接器声明 `safe_read | idempotent_write | deduplicated_write | non_repeatable`。同一逻辑 operation 复用受作用域约束的幂等键，不同网络尝试用不同 request/attempt ID。增加 `unknown_outcome`、`reconciling` 和外部状态查询，无法查证的非幂等写必须暂停人工核对，不能普通重试。事件重放只重建状态，不能重新执行外部效果。无法在本地与外部服务间建立事务时，应明确保证是“至少一次尝试+去重/核对”，不承诺普遍 exactly-once。

### A04　取消的绝对保证与远程协作式取消不相容〔冲突〕

**依据：** R 107“取消彻底”，R 445 superseded 必须彻底取消旧任务链，R 560 传播至所有 Action；但 Mission 和 Plan 的状态机没有 cancelled。MCP Tasks 2026-07-28 明确：`tasks/cancel` 只表达意图，ack 不保证停止，远端甚至可能最终 completed。[S7]

**失败路径：** 用户用新 Intent 替换旧 Intent；系统立刻回收预算、释放锁并标旧链 cancelled；旧进程或远程 task 继续写文件/发消息，覆盖新任务结果。取消网络请求也不等于撤销已经提交的副作用。

**修订：** 分开 `cancel_requested → draining → cancelled`，并容纳 `completed_after_cancel`、`unknown_outcome`；禁止新的子调用，收集在途子调用、远端取消能力与剩余风险，必要时用 compensation 处理。撤销写权限时使用 epoch/fencing token 防止旧执行器在本地提交。终态要表达“已停止新工作”“在途工作已核对”“已补偿/不可补偿”。远程不受控服务只能给出有限保证，应把“取消彻底”改为可验证的本地不变量及远端残留处理承诺。

### A05　租户和授权上下文没有贯穿缓存、句柄、回执和委托〔缺失〕

**依据：** R 的 Session、Evidence、Receipt、Cooperation 等 schema 有 agent/session/turn，但没有统一 tenant/principal/authorization context；H 的 Manifest 示例只有 github/id/version/digest/ttl，handle 示例只有 `h_8f2c`。H 1064–1067 已用跨租户缓存事故说明风险，却没有把该约束写回 LCP 契约。

**失败路径：** 按 server_id 命中另一个租户的私有目录或结果；worker 用 orchestration 服务账号调用；用户持有旧 handle 在权限撤销后继续读；同名工具在不同端点被错路由。身份签名能证明“谁说过”，不能证明“有权访问当前对象”。

**修订：** 身份来自受信宿主，不允许模型指定或覆盖。统一传播 tenant_id、principal_id、delegation_chain、authorization_context_id、policy_version、workspace_id、session_id、origin_turn_id、operation_id。每次列举/检查/调用/读句柄/下载产物/合并/恢复都做对象级授权。私有缓存按授权上下文隔离，public 缓存只存确实与用户无关的内容；MCP cacheScope 不是 ACL，规范明确 private 不得跨授权上下文共享。[S2] 远端资源服务器校验 audience，网关上游与下游凭据分别管理，禁止 token passthrough。[S5]

### A06　Profession、信任评分、检索门控被混作权限边界〔缺失/职责冲突〕

**依据：** R 1076 让信任等级影响共享写权限和敏感能力；R 1611 按 developer/reviewer 决定可写性；R 1196 工具先按权限与画像过滤；H Retriever 同时做权限和状态门控。

**风险：** 从 explorer 切换 developer，或历史成功率使信任分升高，可能被实现为自动扩权。工具没被展示给模型不等于它无法被 `run` 按名字调用；mount 时锁定 mode 也无法应对运行期间的权限撤销。

**修订：** 有效权限必须是用户授权、租户策略、委托父权限、Session 授权范围、Task 操作范围、沙箱约束的交集；Profession 只能进一步收紧或影响排序，信任分只能要求更严验证，均不能授予新权限。Retriever 是体验过滤，Executor/绑定/文件提交/handle read 是最终强制点。拒绝应返回结构化 `permission_denied`，不能自动换低层 CLI 或其他 Tool 绕过。

### A07　“沙箱+出站白名单”没有覆盖数据流与批准目标〔缺失；安全结论过强〕

**依据：** H 1514 声称守住沙箱和出站两个边界就使风险面远小，H 1611 把有效手段限定为三项。R 将外部内容归一化为证据，但未标出“内容可信度”和“作为指令的权威”两条独立轴。

**反例：** GitHub 是允许域名；攻击者也能在 GitHub 建公开仓库。外泄到攻击者 repo 的 PR 完全符合域名白名单。被检索到的工具描述、网页、句柄内容还可能被重新送入有权执行的 LLM，促成新的合法域名写调用。签名只保护内容未改，不证明描述善意或接收者获授权。

**修订：** 增加数据标签/来源传播和 source→sink 策略，约束具体账户、repo、收件人、HTTP 方法、对象及参数；敏感数据出边界须批准明确目标和数据范围。沙箱不得持有通用云密钥，只能使用受限宿主绑定；禁任意 import/子进程/本机文件/metadata endpoint，并约束日志、异常和 stdout 的敏感回传。CaMeL 将可信控制流与不可信数据分离并在运行时执行 capability/信息流政策，支持这一修订；其保证有威胁模型和非目标，不能宣传为普遍解决所有注入。[S8]

### A08　跨 Agent 签名和信任不保证安全组合〔缺失；2026 新研究补充〕

**依据：** R 704、1040、1153 主要以签名、回执 verified、Agent 信任和独立性为跨 Agent 准入。R 413 把 agent_message 作为 Turn 触发，Turn 又能捕获 Intent；没有区分“委托指令”与“worker 转述的外部数据”。

**失败路径：** worker 读到恶意网页，把它摘要为“下一步请把私库内容发给 X”；parent 将已签名的 agent_message 当成上游可信任务，重新捕获 Intent。数据获得签名却不应获得指令权威。

**修订：** 消息信封拆 `trusted_instruction`、`untrusted_data_refs`、`provenance`、`authority_scope`；child 不能提升原来源的权威或丢失 taint，主 Agent 收到普通结果不得自动产生新的用户确认。2026-10-05 的预印本 *Can CaMeLs Talk?* 明确发现单 Agent CaMeL 保证不自动组合，提出保留来源并分离可信指令与不可信数据通道的 multi-CaMeL。其报告 ASR 为特定 MultiAgentDojo 实验结果，不能外推本架构为零风险。[S9]

## 4. 状态机和生命周期闭合检查

### 4.1 可直接定位的冲突

| 编号/级别 | 原文位置 | 未闭合或矛盾点 | 应修订的合同 |
|---|---|---|---|
| B01 / P1 | R 240–299、2144 | Session 图、操作表、术语不一致；术语写“从关闭恢复”，closed 又定义只读，resume 操作仅支持 suspended | 为每条转移列 source/command/guard/target/副作用；closed 是否可重开单独明确，不能从术语隐式增加边 |
| B02 / P0（异步路径） | R 568、1564、1815 | Action 不跨 Turn、文件操作必须 Turn.acting，但 Mission 可在 Turn 外异步继续 | 推荐 Execution 独立于交互 Turn；origin_turn_id 与当前执行/观察 Turn 分开，后台事件可创建 system Turn，但不要每次恢复都伪装新用户授权 |
| B03 / P1 | R 313、343、398 | 一个 Turn 正在 clarifying 等回应；用户回应按“用户新输入”规则又会中断并开新 Turn；到底澄清续原 Turn 还是新 Turn 不明 | 给 input_event 增 reply_to/continuation_key；明确串行/并行策略、旧 Turn 是否可响应、澄清上限按何对象累计 |
| B04 / P1 | R 560 对照 452、478 | 取消传播要求 Mission.cancelled、Plan.cancelled，状态定义无此状态 | 定义取消请求和完成状态，或映射到 abandoned/superseded，但须保留原因和在途结果 |
| B05 / P1 | R 672 对照 466 | 撤销 Goal 达成证据后要 Goal 回退，但 achieved 没有出边和回退目标 | 事实终态与验证状态正交；可保留曾 achieved 的事实，当前 validity=invalid/stale，再启动 corrective Goal/Plan |
| B06 / P1 | R 522、538 | Task 要“所有 Action 成功”，但 Action 允许失败后重试、skipped、cancelled；失败尝试永久阻止 completed | 区分逻辑 Action 与 attempt；按必要效果和显式成功谓词验收，定义条件跳过、已补偿失败和可接受部分完成 |
| B07 / P1 | R 524 | “前驱 completed→ready”未写所有必需前驱、数据依赖和 OR 分支 | readiness 谓词要含依赖类型、全部/任选、输入版本与资源租约，不靠一句口号执行 |
| B08 / P1 | R 749–758、763–789、914–921 | Skill 定义对象生命周期混有单次运行 active/completed；Protocol breaking 回 validated，但其状态机没有 validated；Profession 是全局 active 还是每 Task 激活不明 | 版本化定义与 Binding/Invocation/Activation 实例分离；降级影响新准入，在途调用明确 pin/abort/migrate 策略 |
| B09 / P1 | R 626、1009–1014、1930 | Evidence 图含 revoked→purged，规则又说仅 archived 可 purge；Receipt 任意状态可 disputed，图只画 verified；签后改状态与整体签名覆盖范围不明 | 单一转移表生成图；不可变核心、独立追加的状态/争议事件；归档与有效性设正交维度 |
| B10 / P1 | R 1277、1472、1492–1529 | L2 stale 禁读写；File stale 又允许 diff/metadata；write 前置 active，矩阵允许 dirty；reload/unmount 前置与矩阵不一致 | 分清“禁止作为当前真相消费”和“允许显式历史诊断读取”；矩阵作为唯一规范，配一致性检查 |
| B11 / P1 | R 299、389、1565–1571 | 恢复只恢复 persist，但 Session 文件不自动恢复；active 未完成 Task 文件可 persist，dirty 中断快照又要续接 | 持久化内容/任务依赖/注意力挂载三者分离；dirty 草稿应持久化为独立 artifact，恢复后重新授权和校验再 mount |
| B12 / P1 | R 1994、六级 parent_id、失败只到父级 | 小任务可跳过层，但父级事件接收者、证据聚合、预算树未定义跳过语义 | 使用合法缩略配置或透明合成节点；不能由实现随意跳层而破坏父链 |

### 4.2 循环、僵局与终止性

**C01 / P1：DAG 不等于整个系统终止。** R 485 的无环/可达检查只能覆盖有限静态图；`replan → approved`、能力半开探测、证据 refresh、协作 renegotiate、澄清、MRTR、代码内循环可以构成跨状态机无限循环。R 风险表提到 replan 上限，但没有统一作用域，重建 Plan/Turn 后可能重置计数。应以 mission/operation 为稳定作用域设置重试总量、累计 deadline、replan 次数、信息增益或进展度量；超限进入明确 blocked/dead_letter，等待事件而非立即再调度。关联脑图允许软环，associate 需 visited 集合、去重、总候选上限和全局预算。

**C02 / P1：仲裁与验证递归可能自锁。** 若冲突方提交的证据被 contested，仲裁者为裁决又要求 verified Receipt，回执 disputed 又回同一仲裁器，缺少优先级与递归边界。应按“身份/完整性争议→执行事实争议→业务结论争议→意图冲突”建立有向依赖；高层不能等待由自身未决结论产生的低层证明。不可用的非冲突仲裁者须有 fallback/人工阻塞语义；orchestrator 不能在自己参与争议时自动当非冲突仲裁者。

**C03 / P1：终止预算可能在真正终止前用尽。** R 1863–1864 在预算耗尽后中断/关闭，却未预留取消、回执、快照、核对和补偿的成本。锁 TTL、网络退避、人工等待也不等于 CPU 时间。应分别计算可执行预算、等待期限、清理/核对保留额；没有清理预算时停止新准入，仍能写最终事实与释放租约。硬期限到达不能把 unknown outcome 变成 failed。

**C04 / P1：撤销传播深度限制可能留下伪真结论。** R 673 的深度上限和 R 1985 “只传播高影响”若用于有效性更新，会遗漏远祖 Goal/Mission 或学习产物。必须即时把受影响依赖子图标 invalidation_pending，消费门禁拒绝当有效；后台分批处理至固定点，队列失败可恢复。深度/批次限制只限制一次工作量，不能截断语义传播。L8 已沉淀 Behavior/Skill 也应订阅来源撤销。

## 5. LCP 与 Session/Turn/证据/回执的必要接口

原文四个元工具只是北向发现/执行表面，不能表示完整运行时控制面。取消、批准、异步输入、结果核对可以由宿主事件接口承载，不要求都变成模型工具，但必须定义。

### 5.1 建议最小公共信封

```text
ExecutionContext（由宿主注入，模型不得自行覆盖）
  tenant_id, principal_id, agent_id, delegation_chain
  session_id, origin_turn_id, execution_id, current_interaction_id?
  mission_id?, workflow_task_id?, action_id, operation_id, attempt_id
  workspace_id?, snapshot_id?, capability_binding_id
  policy_version, authorization_context_id, approval_ref?
  budget_reservation_id, deadline, cancellation_epoch

CapabilityBinding
  endpoint_identity, protocol_version, tool_name
  manifest_digest, input_schema_digest, output_schema_digest?
  implementation_digest? / assurance_level, policy_digest

Outcome
  complete | input_required | remote_task | rejected |
  execution_error | protocol_error | unknown_outcome
  observation_ref?, receipt_ref?, external_operation_ref?
```

这不是要求把全部字段放进模型上下文；大部分可由运行时传递、签名和审计。外部代理不应获得本租户多余内部标识，南向可用受控关联标识。

### 5.2 四个元工具逐项边界

| 接口 | 应补的契约 | Session/Turn 与证据/回执关系 |
|---|---|---|
| find_tools | query、命名空间、授权后集合、检索索引版本、top-k/空结果、召回失败分类 | 是候选建议，不产生新权限或“工具不存在”的证明；记录检索决策供归因 |
| inspect_tool | 全局能力 ID、固定 manifest/schema digest、完整 schema、权限/副作用/幂等/异步能力声明 | 完成后得到可 pin 的 Binding；展示/inspect 不等于用户授权执行 |
| run | 已 pin 的 Binding 集、统一上下文、总调用/时间/内存/输出预算、子调用边界、可恢复 continuation | 外层 Batch Receipt + 每次南向调用 Receipt；input_required 交宿主，不能让沙箱线程持有全局文件锁等待用户 |
| read_handle | opaque id、owner/tenant、ACL、snapshot/content digest、TTL、cursor 版本、limit 的字节与 token 上限 | 每次重新授权；返回内容关联原始 Observation 与派生步骤，引用不能因 Turn 完成就失效，也不能因此永久续期 |

**D01 / P1：句柄不是正文的替身。** H 的 HANDLE 示例没有生命周期和错误模型。建议句柄 `created→available→expired/revoked→deleted`，存储可用性和授权独立；未知、过期、撤销、无权、快照不匹配须区分内部原因，对外避免泄漏存在性。Evidence 活跃期间使用引用计数/保留策略避免原文先被 GC；必须删除时保留 tombstone 和 digest，并将不可复验性显式反映为证据限制。跨 Turn 只持久化 ref/权限元数据，不重放原文。

**D02 / P1：分页不是一致快照。** MCP 缓存规范明确分页没有跨页一致性保证。[S2] `cursor:0` 的偏移分页若并发插入，会漏项/重项。LCP 需要 server snapshot token 或自有冻结结果集，cursor 绑定查询摘要、排序、结果版本和授权上下文；做不到时标记 weak_consistency，不能用“全部遍历过”支撑完整性结论。

**D03 / P1：摘要和 TOON 不能直接成为 ground truth。** R 632 将 operation_history 统一给 0.9，H Shaper 会摘要、聚合或转编码。操作成功只证明产生某结果，不证明摘要忠实、查询范围充分或远端事实正确。Observation 必须保留原始结果/来源，派生摘要记录 transform/version/lossiness/input_refs；验证关键字段时回原文，输出 schema 校验与业务验证分开。system_rule 也不能因可靠性 0.95 把压缩后的对话升格为事实或用户授权。

**D04 / P0（异步路径）：MCP RemoteTask ≠ 工作流 Task。** 扩展 `completed` 明确包含 `isError:true`，`failed` 专指 JSON-RPC 错误；直接映射 R 的 Task.completed 会把业务失败计成功。[S7] 使用单独 RemoteTaskRecord 保存 taskId、server identity、授权上下文、origin operation、ttl、pollInterval、输入请求去重键和最终原始结果。收到 `resultType:task` 仅表示远程任务已持久创建，不是 Action succeeded。轮询/通知可在无前台 Turn 时推进 Execution；用户输入经新交互事件关联原等待点，不重复捕获新用户授权。

**D05 / P1：MRTR 需要等待态与有界续接。** R Turn.clarifying 不足以承载所有工具要求输入，Action 状态也没有 awaiting_input。MCP `input_required` 会结束当前请求，后续是新 ID 的请求；requestState 必须由客户端原样回传，不能拆解后当业务上下文。服务器须保护完整性，并绑定 principal、参数摘要、TTL；一次性语义还需要服务端消费控制。[S4] LCP 应保存安全的 continuation，限制轮数、截止时间和输入大小，凭据/授权 UI 由宿主处理，拒绝输入明确传播至原 operation。

**D06 / P1：应用 Session 与 MCP 连接状态不能混为一谈。** 删除 MCP 协议级 Session 不影响 R 的业务 Session，也不消除浏览器/数据库/远程任务 handle 的服务端状态。[S1][S6] 旧版 MCP 仍有握手及 Session；南向 adapter 必须按端点协商版本并维护必要 legacy 状态。H “13,087 个端点零改造”最多指接入方向，不意味着全部支持新式 discover、缓存字段、幂等、签名或取消。按每端点能力协商保证等级，缺失能力要显式降级。

## 6. 并发、文件、回滚与存储一致性：P1

**E01　flush 的 TOCTOU 未闭合。** R 1494 在 write 检查哈希，但 flush 只说语法校验和原子写回。其他 Agent/进程可能在两者之间改盘；atomic rename 只保证可见性原子，不保证没有覆盖新版本。flush/merge 必须在提交时验证 expected raw hash/文件身份、授权与锁 fencing token，失败进入 conflict；锁 TTL 到期的旧 writer 不得继续提交。统一锁顺序，等待用户/网络时释放或缩减锁，死锁检测须给出可取消受害者。

**E02　dirty→stale 丢失双版本。** R 1456 的图允许 dirty 进入 stale，随后 reload 丢弃内存改动；应显式保存 base/draft/current-disk 三份，进入 conflicted_dirty，再三方合并或有理由丢弃。force 操作的“记录证据”不足以表示用户授权，不能把任意 Agent 提供 system_rule 理由视为可丢草稿许可。

**E03　字节坐标与编码约定冲突。** R 1554 先 CRLF/LF 归一化再算字节，R 1555 统一 UTF-8，但文件 metadata 又保留原编码/BOM/newline。归一化字节偏移不能直接定位原文件。定义 raw_bytes_hash 与 normalized_text_hash，所有 span 写明坐标系与单位，并有可验证双向映射；range 应约定半开区间，行列基数与 UTF-8/UTF-16 含义。symlink/reparse point、路径大小写、硬链接、路径穿越与 root containment 也必须在实际打开/提交处校验，不能只检查字符串白名单。

**E04　AST 安全和文件创建并未覆盖通用任务。** R 要求路径必须存在才能 mount，操作没有 create/delete/rename；全部写强制 AST 对二进制、未完成语法文本、Markdown、解析失败文件没有定义。tree-sitter 提供解析树并不自动提供语义正确的保真重写器，语法通过也不能证明业务正确。应区分 text patch（带 precondition/hash）、语言专用结构编辑、binary/stream、create/delete/rename，分别定义权限、回滚和验证；解析降级不能隐式开放无校验写。

**E05　按“R 之后全部 Receipt”回滚会误撤并行分支。** R 1020–1025、1587 使用线性后续范围，但 Task DAG/多 Agent 可以并行。应按受影响资源版本、因果依赖和 workspace branch 选择回滚集合；不相关分支不回退。还原本地快照不能撤销邮件、支付、云端删除或已经泄露的数据。能力契约必须声明 rollbackable/compensatable/irreversible，补偿产生新 Action/Receipt，不抹除历史。撤销证据有效性与宣称操作从未发生是不同事件。

**E06　不可变事件与删除策略缺少统一保留关系。** R 说事件流是历史真相、Receipt 签后不变，又允许 Evidence/Receipt purge。若快照、handle 原文、schema 或签名密钥先被清理，重放/复验失效。需定义依赖保留 DAG、GC pin、tombstone、法律/租户删除和审计最小元数据策略，证明“可恢复到何时/何等级”；跨租户摘要、学习库和日志不能绕过原数据的保留与删除要求。

**E07　快照不是足够的恢复输入。** R resume 恢复 Mission/Task、预算和 persist，却未恢复在途 operation、RemoteTask、MRTR、签名/策略版本、预算预留和取消 epoch。恢复必须先重建纯状态，再核对未决外部效果、重验权限与 Binding、检查 workspace 漂移，最后允许新执行。读侧索引、脑图和摘要应携带 applied_event_sequence；消费关键约束时不能只靠异步 stale 通知，以免事件落后时使用旧投影。

## 7. 证据、评测和预算的统计一致性

**F01 / P1：独立性规则错把不同执行者当独立来源。** R 646“不同工具对同一文件操作”和 R 649“不同 Agent 对同一事实验证”直接判独立。它们可能读同一陈旧缓存、同一测试夹具、同一模型提示或同一错误原文；independence_key 的近似指纹只能去重，不能证明条件独立。建议来源 lineage DAG，分开 source、measurement、validator、environment、model family、dataset；默认保守聚类相关样本。跨级聚合只作引用，不得再次累计 Action 和 Task 的同一份观测。成功轨迹“3 次独立”须按任务/环境划分，不按重复运行次数。

**F02 / P1：统一可靠性数值混淆命题类型。** 操作历史可以确认命令执行，但不能推翻用户“我不要这个结果”的意图；用户确认可以授权，但不能替代文件确实存在或测试确实通过。将证据按 intent/authorization、execution、domain fact、policy、derived claim 分类，仲裁只在同类可比较命题上进行。R 的固定 0.9/0.95 是未校准先验，不是可直接作安全决策的概率。

**F03 / P1：Beta-Binomial 不适用于任意异质证据混合。** R 2090 选 Beta-Binomial，但没有定义成功/失败试验单位、交换性、选择偏差和相关性；web、规则、用户确认不是同一 Bernoulli 试验。应先给每个估计目标固定数据集、采样框、标签规则与分层校准；安全 ACL/不可变约束不得靠贝叶斯后验越过。盲抽 unmounted 候选有价值，但不能把无权对象纳入抽样，避免“验证”自己越权。

**F04 / P1：跨 Turn 预算不是纯树。** R 1248、1838 把 Intent/Mission 放在 Turn 子树下，Mission 又跨 Turn 使用 Session 保留预算。重父化时原 Turn 结算回收和新预留可能双算/漏算；Cooperation 又按 Agent 分配，子 Agent 独立 L1 可重复占额。采用统一多维账本，以 work item 稳定记账，Turn 作为归因维度；迁移资金通过可审计原子 transfer，不能复制余额。任何时刻满足：已授权额度 ≥ 已结算消耗 + 有效预留，且各子预留不能重复授权同一份余额。

**F05 / P1：结果 token 上限不能约束总资源。** H 1495 只限制最终结果；恶意/错误代码可以中间生成 1GB JSON、无限翻页或反复 read_handle。必须同时限制原始响应字节、解压后字节、CPU、内存、工具次数、并发、存储、累计 handle 读取量、MRTR/轮询次数和 wall deadline。按指定 tokenizer 计算上下文预算，并留出错误/receipt 元数据空间；格式转换后重新计数。拒绝/错误不应返回比正常结果更大的未限流日志。

**F06 / P2：Turn 与推理步的计量口径冲突。** R Turn 是用户输入到回复的一轮，H 多处“每轮”实指一次模型推理。一个 Turn 内可有 20 次 LLM/tool 循环；只记 per-turn 会掩盖结果重放和定义成本。增加 model_step_id、input_tokens、cached_input_tokens、output_tokens、raw_result_bytes、shaped_tokens、子调用数、总费用与任务成功率；用 task/turn/step 三轴聚合。固定四工具只让工具定义基数为 O(1)，不保证 inspect/检索结果、目录池、错误和历史总 token 恒定；“约300 tokens”须给具体 tokenizer、完整 schema 和实测。

**F07 / P2：材料中的经验公式不能当生产不变量。** H 的结果税 O(N²) 仅在每步新增固定结果、历史完整重复输入时成立；缓存、裁剪、外置会改变计费与计算口径。H 图 02 每步 0.2K 若同样全部重放，20 步应为 42K 而不是图示 4K；4K 需要额外假设每步只回传/保留当前摘要。H 的阶段工期 2+(4–6)+(6–10)+(4+) 为至少16–22周以上，与“14–22周”不完全一致。应明确这些是规划估计，不能成为架构验收保证。Tool Attention 的 95% 为模拟 token 实测，端到端成功率/时延为投影，论文摘要已明确，不能用于证明本系统闭环正确。[S10]

## 8. 规范与近期论文核验后需要补写的风险

本次直接核验了以下公开材料。MCP 2026-07-28 确实可访问，移除 initialize/Mcp-Session-Id、引入 discover 和 MRTR 等核心描述有规范依据；本报告不将这些误判为虚构。需要修正的是原材料从规范机制推导出的过强工程保证。

| 来源 | 已核验内容 | 对本架构的具体约束 |
|---|---|---|
| S1 MCP 2026-07-28 Changelog | 协议无状态、移除 SSE resumability、任务移扩展 | 不能删应用 Session；不能由无状态推出副作用安全重试 |
| S2 Caching | private 按授权上下文；TTL 是 hint；分页无一致快照；MRTR 重试不可缓存 | 授权前分区与逐对象检查；manifest approval 不能只靠 TTL；需结果 snapshot/version |
| S3 Streamable HTTP | 断流取消；取消尽快；必须版本及路由 headers；header/body 一致验证 | 连接断开、客户端取消和外部效果分开建模；多租户网关不能信未经验证的 tenant 路由头 |
| S4 MRTR | 新请求 ID；requestState 原样回传；完整性、principal/TTL/参数绑定；一次性须服务端实现 | Action awaiting_input/continuation；禁止在 LLM 中解释安全状态；不能无限自动重试 |
| S5 Authorization | 每 HTTP 请求授权；audience/resource 绑定；禁止 transit 不属于该服务的 token | 上下游 OAuth 权限不可直接继承；按需提权不是自动批准，scope 错误有界处理 |
| S6 Tools / Discovery | 工具名仅服务器内唯一；serverInfo 自报；handle 是普通名称；业务状态仍可存在 | 全局 ID 需端点身份；不能信 server name；handle 每次鉴权，完整 schema 要 pin |
| S7 Tasks Extension 2026-07-28 | durable task 创建、轮询恢复、completed 包含 isError；取消不保证停止 | 独立 RemoteTask；保留 taskId 并安全恢复；cancel_requested 和对账必需 |
| S8 CaMeL v2，2025-06-24 | 分离可信控制与不可信数据，运行时 capability/数据流政策；保证有范围和效用代价 | 沙箱与域名白名单之外需细粒度来源和 sink 约束 |
| S9 Can CaMeLs Talk?，2026-10-05 预印本 | 单 Agent 保证不自动组合，转述可升格为可信输入；提出 multi-CaMeL | Agent 消息保留 taint/provenance 与权限边界；签名不能升格权威 |
| S10 Tool Attention，2026-04-23 | 120-tool 模拟，token 降95%；任务成功/时延是投影 | 检索质量/总效用/安全都须本地端到端实测，不能复用节省百分比作承诺 |
| S11 RFC 8785 JCS（Informational） | 可重复 JSON 哈希/签名需要规范化，重复键/无效 Unicode 等有约束 | manifest/receipt 规定精确签名覆盖字段、canonicalization 和版本，不能只写“哈希+签名者” |
| S12 AgentDojo v3，2024-11-24 | 动态攻击/防御评测，97 真实任务、629 安全案例 | 需要无攻击效用与攻击后安全联合验收、适应性攻击，而非仅正常成功轨迹 |

签名方面还应补充：受信根、key_id、算法 allowlist、密钥轮换/吊销、生效时间、nonce 或单调版本、防回滚到旧的“仍签名有效”版本。批准应绑定 manifest/schema、实现制品（能获取时）、端点身份、策略和参数范围；远程托管服务无法由目录摘要证明实现未变，应声明保证等级，不能宣称 digest 解决全部供应链风险。H 的 Manifest 示例并没有 signature、key_id、cacheScope、授权作用域或 schema digest，这些不能留作暗含实现细节。

H 1555 把签名、审批与审计安排到 P3，而 P1 已处理真实数据、P2 已执行代码，与前文安全前提冲突。**身份隔离、对象授权、调用审计、最小权限和写前准入必须前移到最小闭环；完整公钥基础设施、优化检索与自动学习可以分期。** R MVP 也应先提供 unknown outcome、记录失败/拒绝与有界取消的最小版本；不能先引入回执“已 verified”标签再晚几期补其语义。

## 9. 不确定项与必须作出的设计决定

以下属于材料无法确定，不应擅自当作作者已经选择某种实现。

| 不确定项 | 需明确的决定 | 默认建议 |
|---|---|---|
| Session 内并发 Turn | 一个 active writer 还是多个；旧 Turn 如何响应和消耗预算 | 单主写者 + 有序输入事件；后台 Execution 可并发，但状态更新版本化 |
| Intent 的确认动作 | 显式请求是否已授权、系统/定时输入如何确认、哪些要求再审批 | 记录授权来源、范围和有效期；承接 Intent 与批准危险调用分离，避免每 Turn 重复确认 |
| Session 关闭与暂停 Mission | Mission 归属不可恢复的 closed Session 时由谁唤醒 | closed 不自动恢复；显式新 Session 续接同一 durable work item，重验权限和预算 |
| Evidence.level/parent_id | 多父聚合、被多个结论消费如何表示 | 原始 provenance 与结论 DAG，业务层级是标签，不用单 parent 强塞 DAG |
| Receipt verified | 是签名、执行真实性、内容正确性还是业务达成 | 分字段/分记录，不共享一个万能状态 |
| 外部操作保证 | 目标服务支持幂等/查询/取消/事务的比例 | per-tool assurance profile；不支持时降级及向上暴露限制 |
| LCP manifest 信任根 | 谁签、签什么、旧端点谁生成卡片、如何证明实现 | 网关签“观测/批准的定义”，不替远端签“实现正确” |
| 预算转移 | 跨 Turn、跨 Agent 是否预留还是实际消耗 | 单一账本，reserve/transfer/settle 全部带幂等 ID |
| 时间 | wall clock、单调计时、租约漂移及签名过期如何校验 | deadline/TTL 单位明确，运行限时用单调时钟，跨系统到期带容差与受信时间策略 |
| 自动学习范围 | 是否跨租户、撤销是否进入已沉淀模型/模板 | 默认租户隔离；有明确同意才外流；所有可追溯沉淀保存来源与撤销钩子 |

## 10. 建议修订顺序与可验收闭环

### 10.1 先做最小语义修订

1. 写出唯一的状态转移表，自动生成示意图；每条边包含触发者、guard、权限、预算、事件、副作用、补偿和幂等语义。取消传播、证据失效、缩略层级和非正常终态必须覆盖。
2. 固定 ExecutionContext、Invocation/Observation/Verification/ReceiptCore，建立 `工作流 Task—Action—attempt—RemoteTask` 的映射；明确 Turn 是交互边界，Execution 是可跨交互的执行边界。
3. 统一 PDP/PEP、缓存和 handle 授权、预算账本及版本绑定；落实 LCP 内子调用治理。四个模型工具可保留，但宿主控制面必须具备批准、取消、续接、核对和状态查询。
4. 在写操作前持久化意图，建立 unknown_outcome/reconcile；事件重放不执行副作用，外部取消与补偿保证按能力声明。
5. 拆签名/来源完整性与语义正确性，原始结果保留、摘要派生、撤销闭包、保留/GC 统一。修正“不同 Agent=独立”和固定来源权重的自动裁决语义。
6. 最后加入复杂贝叶斯、自动 Behavior 抽象、多拓扑市场协作和多视图优化；这些不能代替基础状态/权限合同。

### 10.2 建议必须通过的故障场景

| 场景 | 验收不变量 |
|---|---|
| 远端写已成功，在 Receipt 落盘前断网/崩溃 | 恢复进入核对；相同 operation 不重复副作用；无法核对时显式 unknown，而非自动再执行 |
| Intent 被 superseded，旧远程 task 仍返回成功 | 新子调用被禁止；在途结果归旧 operation；取消请求与实际完成分别记录，预算和补偿不丢 |
| run 中第 3 个调用失败，前 2 个已完成 | 所有子调用各有回执和准入；可定位已提交效果；仅重试安全步骤 |
| 租户 A/B 访问同一端点、同一查询、相同可猜 handle | 私有缓存/handle/产物没有跨租户命中；每次对象级授权；日志不会泄漏正文和密钥 |
| mount 后权限撤销、文件锁到期、外部进程改文件 | flush 在最终提交处拒绝旧权限/旧 fence/旧哈希；dirty 草稿仍能恢复 |
| 完成 Goal 的底层证据被撤销，依赖链超过批次上限 | 所有受影响结论立即不可当有效消费；后台最终完成闭包；旧学习候选被禁用或重评 |
| MRTR 多次要输入、用户不回应/拒绝、重复 task poll | 输入键去重、预算/期限有界；凭据由宿主处理；无持锁等待；不自动产生新授权 |
| worker 转述恶意工具输出，但消息签名有效 | 不可信数据不会升格成上游指令；源标签贯穿 Agent/handle/summary/最终写入 |
| 分页期间数据改变、handle 到期、原始结果被清理 | 完整性结论带 snapshot/一致性等级；expired/revoked 明确；缺原文不继续宣称可复验 |
| 多 Turn/多 Agent 同时预留最后额度 | 不超发；取消/清理保留额可用；重放不重复扣费；实际成本与提供商账单可对账 |

验收同时报告任务效用、攻击成功率/越权率、未知结果比例、取消残留、恢复重复副作用、预算差额、p95/p99 时延与总成本。定义 token 降幅只是其中一项，不足以证明架构成立。

## 11. 外部参考资料

以下为本次直接访问的来源；规范按发布版本引用，论文注明预印本/版本，查阅日期均为 2026-11-06。

- [S1 MCP Specification 2026-07-28 — Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [S2 MCP Specification 2026-07-28 — Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md)
- [S3 MCP Specification 2026-07-28 — Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)
- [S4 MCP Specification 2026-07-28 — Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr.md)
- [S5 MCP Specification 2026-07-28 — Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md)
- [S6a MCP Specification 2026-07-28 — Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md)；[S6b Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md)
- [S7 MCP Tasks Extension — 2026-07-28](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)
- [S8 Debenedetti 等，Defeating Prompt Injections by Design / CaMeL，arXiv:2503.18813v2](https://arxiv.org/html/2503.18813v2)，2025-06-24。
- [S9 Peters-Gill 等，Can CaMeLs Talk? Securing Multi-Agent Systems Against Indirect Prompt Injection Attacks，arXiv:2610.05640v1](https://arxiv.org/abs/2610.05640)，2026-10-05 预印本；另核验 [NeurIPS 2026 Workshop 展示页](https://neurips.cc/virtual/2026/loc/paris/175598)，不将 workshop 页面等同于主会正式论文录用。
- [S10 Sadani、Kumar，Tool Attention Is All You Need，arXiv:2604.21816v1](https://arxiv.org/abs/2604.21816)，2026-04-23，模拟研究。
- [S11 RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)，2020-06，Informational RFC，非 Standards Track。
- [S12 Debenedetti 等，AgentDojo，arXiv:2406.13352v3](https://arxiv.org/abs/2406.13352)，2024-11-24 修订。

本审计没有逐项复核 H 中所有市场计数、星数、商业部署数字和安全事故叙述；没有用这些未复核数字支撑本报告的架构阻断结论。外部材料用于核对协议义务、风险机制和验证边界，本文提出的接口与修订方案均明确属于建议。
