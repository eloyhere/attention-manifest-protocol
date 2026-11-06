# 实现与 `refract.md` 的差异审计

- 审计对象：`refract.md`（2026-11 版本，2218 行）为权威设计依据；`src/**` 为当前实现。
- 审计日期：2026-11-07。
- 方法：逐节阅读 `refract.md` 的 §4、§5、§6、§9、§11.2–11.10、§12、§13、§16、§19，再对照相应源码的类型与公开 API；只把"源码中不存在或语义不同"记为偏差，不以命名风格差异充数。
- 判据：**硬规则**（设计文档明确写"必须/禁止/硬规则"）优先于**结构字段**，结构字段优先于**命名**。
- 说明：本文件只做审计，不修改实现。部分偏差是后续明确要求的有意偏离（例如禁止第三方解析器、支持 line/byte 写入、二进制字节挂载），已在 §9 单列。

## 0. 结论摘要

| 领域 | 吻合度 | 主要问题 |
| --- | --- | --- |
| Session / Turn 状态机 | 高 | 状态枚举与转移表一致；缺恢复、历史压缩、persist 评估 |
| Intent / Mission / Goal / Plan / Task / Action | 中 | 状态机被大幅简化，多个规范状态缺失或改名 |
| 证据 / 回执 / 来源 | 中偏低 | 回执被收窄为"调用+观察+摘要+签名"；证据缺 7 个生命周期状态与独立性/可靠性模型 |
| 能力 / 行为 / 职业 | 中 | 五类 kind 与注册表齐备；Tool 七态生命周期、Skill/Protocol/Cognition 生命周期缺失 |
| 协作 | 低 | 只有委派任务与消息，缺 Cooperation 对象、拓扑、七维协议、六级绑定 |
| 文件对象 | 中 | 五态生命周期齐备但 `mounted` 不可观测、缺 `validate()`、无回执绑定、无跨 Agent 隔离 |
| 工作区 / 项目 / 视图 | 中 | 六种视图 kind 齐备但视图契约字段缺失；项目缺指令表/状态机；工作区缺权限面/隔离模式 |
| 注意力 / 上下文 / 预算 | 中 | 8 操作齐备；评分维度、对象状态、预算树与耗尽策略不一致 |
| Agent 可见性（§13.5） | **偏离** | 视图与项目大纲被直接暴露给模型，规范要求对 Agent 隐藏 |

## 1. Session / Turn（§4.1、§4.2）

**一致**

- `SessionState` 十个状态与规范逐字一致：`created/active/idle/suspended/resumed/closing/closed/archived/expired/aborted`（[src/session/types.ts](src/session/types.ts)）。
- `TurnState` 十个状态逐字一致：`received/interpreting/clarifying/acting/responding/completed/interrupted/resumed/abandoned/failed`（[src/turn/types.ts](src/turn/types.ts)）。
- `src/workflow/transitions.ts` 的转移表覆盖 `active⇄idle`、`suspended→resumed`、`clarifying→interpreting`、`acting→interrupted` 等规范路径，且非法转移被拒绝。

**偏差**

| # | 规范要求 | 当前实现 | 影响 |
| --- | --- | --- | --- |
| 1.1 | Session 有四种类型（`user_interactive/autonomous/scheduled/delegated`） | `Session` 类型中未见类型判别字段 | 无法按会话类型施加不同预算/权限策略 |
| 1.2 | `resume(session_id)` 八步恢复（Mission/Goal/Plan/Task、预算、persist 对象、Cooperation、脑图、`session_resume_receipt`） | 只有状态迁移；无恢复服务、无快照、无恢复回执 | 崩溃/挂起后无法按规范恢复 |
| 1.3 | Session 关闭必须处理未完成 Turn；dirty 文件阻塞关闭 | 未见关闭前检查 | 可能丢失现场 |
| 1.4 | Turn 中断需保留现场快照，`resumed` 续接 | 有 `interrupted/resumed` 状态，未见快照与续接实现 | 中断后无法续接 |
| 1.5 | `turn_receipt` / `session_receipt` | 未在 turn/session 服务中生成 | §9 的回执链断裂 |
| 1.6 | Turn 历史压缩（最近 N 完整、较早摘要、更早会话摘要） | 未实现 | 长会话无压缩 |
| 1.7 | Turn 完成时按 `persist_across_turns` 评估对象去留 | 未见评估器 | 跨 Turn 注意力依赖调用方自觉 |

## 2. 六级生命周期（§4.3–§4.9）

状态枚举不一致（源码见各 `types.ts`）：

| 实体 | 规范状态 | 当前实现 | 判定 |
| --- | --- | --- | --- |
| Intent | captured → interpreted → clarifying ⇄ clarified → confirmed → delegated → fulfilled；rejected / deferred / abandoned / superseded | `captured/confirmed/accepted/rejected/withdrawn` | **缺 8 个状态，另多 2 个** |
| Mission | proposed → active → achieved / partially_achieved / abandoned / paused → resumed / archived | `accepted/active/achieved/failed/cancelled/draining/...` | 缺 proposed/paused/resumed/archived/partially_achieved |
| Goal | proposed → active → achieved / failed / blocked / abandoned；unblocked | `pending/active/achieved/failed/cancel*` | 缺 proposed/blocked/unblocked/abandoned |
| Plan | draft → approved → executing → completed / failed / superseded；paused / replanning | `draft/ready/running/completed/failed/superseded/cancel*` | 命名不同，缺 paused/replanning |
| Task | proposed → ready → active → completed / failed / blocked / cancelled；paused / dead_letter / unblocked | `pending/ready/running/blocked/succeeded/failed/skipped/cancel*` | 命名不同，缺 paused/dead_letter/unblocked |
| Action | pending → ready → executing → succeeded / failed / skipped / cancelled；retrying / dead_letter | `declared/ready/running/succeeded/failed/reconciling/cancel*` | 命名不同，缺 retrying/dead_letter/skipped |

**实现得较好的部分**

- Plan 有独立的只读 DAG 投影，并在写入前校验完整 DAG（`src/plan/service.ts` 注释与实现）。
- `Task.succeed` 必须传入 `Acceptance`（验证 id + 证据 id），符合"achieved 只认证据、不认工具成功"的硬规则（§4.7、§5.7）。
- Action 有 `recovery_mode` 与 `cancellationEpoch`，比规范更严格。

**缺失**

- §4.9 的反向传播（Action failed → Task → Plan → Goal → Mission → Intent）与取消传播链：`WorkflowStore` 有单写者与版本守卫，但未见按层级的自动传播实现。
- Intent `superseded` 时"彻底取消旧任务链"：状态缺失，无法表达。
- Task 并行调度（入度 0 → ready、并行度受预算/舱壁限制、资源冲突串行）：有 DAG 校验，未见调度器。
- `dead_letter` 队列与 `retrying` 上限：Action 状态中不存在。

## 3. 证据、回执与来源（§5、§9）

### 3.1 证据对象

| 规范字段/能力 | 当前实现 | 判定 |
| --- | --- | --- |
| 11 个生命周期状态（captured…purged） | 4 个：`active/revoked/stale/pending_revalidation` | 缺 7 个 |
| `level`（action/task/plan/goal/mission/intent） | 无 | 缺 |
| `source`（类型/可靠性 r/来源/可复现/独立性键） | 无；`Evidence` 绑定 `observationId/receiptId/verificationId` | 缺 |
| `corroboration/conflicts/consumed_by/superseded_by/freshness` | 无 | 缺 |
| 独立性判定（§5.4） | 无 | 缺 |
| 冲突仲裁（§5.5） | 无 | 缺 |
| 撤销传播（§5.6） | `ProvenanceEvent` 有 `dependency_invalidated`，`EvidenceLedger` 有依赖失效；未见"重算置信度并回退 Goal" | 部分 |
| 贝叶斯融合（§5.7） | 无 | 缺 |
| 跨 Agent 证据（§5.8） | 无 | 缺 |

**方向正确的偏离**：`Evidence` 强制绑定 `ReceiptCore + ReceiptIntegrityVerification + BusinessVerification`（[src/evidence/types.ts](src/evidence/types.ts)），比规范的"来源记录"更强，能防止"没有回执的证据"。代价是规范要求的来源分级与独立性模型整体缺席。

### 3.2 回执

规范的 15 种回执类型（action/task/plan/mission/capability/profession/delegation/merge/cooperation/arbitration/session/turn/resume/file_*）与完整结构（执行者组合、workspace 锚点、证据引用、生命周期 `issued→signed→anchored→verified→archived`）**当前实现均不存在**。

当前 `ReceiptCore` 只有：`id/invocation/observation/issuedAt/payloadDigest/hashAlgorithm/signature/signerKeyId`（[src/receipt/types.ts](src/receipt/types.ts)）。`ReceiptIntegrityVerification` 提供摘要/签名校验。也就是说：

- **一致**：内容哈希 + 可选签名 + 独立完整性验证，符合"回执必须可验证"的精神。
- **缺**：回执类型体系、父/子回执、Session/Turn/Agent/Cooperation 绑定、执行者身份（profession/skill/tool/cognition/protocol/behavior 版本）、workspace 锚点、证据引用、生命周期与 disputed/revoked/purged、回滚、跨 Agent 验证、评测聚合。
- 直接后果：§12.6 的 `file_mount_receipt`/`file_flush_receipt`、§9.4 的文件级回滚都无处落地。

## 4. 能力、行为与职业（§6、§7、§8）

- **一致**：`CapabilityKind` 恰为 `tool/skill/protocol/cognition/behavior` 五类（§6.1）。
- **偏差**：规范 Tool 生命周期为 `registered→validated→available⇄degraded→unavailable→deprecated→retired`；实现只有 `active/degraded/failed/revoked` 四种激活状态，且"激活"不等于注册生命周期。Skill/Protocol/Cognition 的独立生命周期（§6.4–6.6）未实现；跨能力联动（§6.7）与影子执行（§6.8）未实现。
- 能力通用契约（§6.2：适用条件 Venn、前置/成功标准、失败分类、证据要求、成本、权限、评测、依赖）未作为结构字段存在。
- **Behavior**：只有候选四态 `candidate/evaluated/published/revoked`（[src/behavior/types.ts](src/behavior/types.ts)），缺 §7.4 完整生命周期与冷却/降权传播。
- **Profession**：只有 `restrictByProfession` 与 `intersectPermissionScopes` 两个纯函数（[src/profession/policy.ts](src/profession/policy.ts)）；缺 Profession 对象画像（§8.1）、认证/再认证与画像驱动选择（§8.2–8.3）、影子评测（§8.4）。

## 5. 协作（§10）

- 当前只有 `CooperationCoordinator`：`delegate/start/cancel/transfer/submitResult/storeMessage`，`DelegatedTaskState` 六态（[src/cooperation/types.ts](src/cooperation/types.ts)）。
- 缺：Cooperation 对象（参与者、目标、隔离模式、拓扑、绑定）、五种协作拓扑（§10.6）、七维协作协议（§10.7）、跨 Agent 共享/隔离（§10.8）、冲突解决（§10.9）、六级绑定（§10.10）、L0.9 治理层（§10.11）。
- 结论：当前实现是"主 Agent 派发任务 + 消息"的最小内核，不是规范描述的完整协作体系。

## 6. 文件对象（§12）

状态机五态齐备（`unmounted/mounted/active/stale/dirty`，[src/file/types.ts](src/file/types.ts)），但语义与操作有明显差异：

| # | 规范 | 当前实现 | 影响 |
| --- | --- | --- | --- |
| 6.1 | `mounted` 只加载元数据 + 大纲，不进正文 | `mount()` 已读入全文；`Workspace.mount()` 还会直接 `activate()`，`mounted` 对外不可观测 | 大文件无法"只挂载不加载" |
| 6.2 | `load()` 首次读正文；`read()` 在 mounted 可用 | 无 `load()`，只有 `activate()`；`read()` 要求 active | 行为差异 |
| 6.3 | `write()` 必须 AST 结构化重写、写后重新解析校验、失败回滚内存编辑 | 支持 line/byte/string/regex/outline 五种定位；只有 outline 目标是结构化的；无写后语法校验与回滚 | **有意偏离**（后续要求支持行/字节写入） |
| 6.4 | `flush()` 语法校验 + 原子写回 + 生成 action_receipt + 触发变更传播 | 原子写回 + 哈希更新；无语法校验、无回执、无传播 | 缺回执链与传播 |
| 6.5 | `validate()` 返回语法/大纲/哈希一致性 | **不存在** | 缺 |
| 6.6 | `diff(base?)` 支持磁盘/快照/回执基线，返回结构化 hunk 并标注受影响符号 | `diff()` 只有"磁盘基线 vs 缓冲区"，返回 unified diff 字符串 | 缺基线与结构化 hunk |
| 6.7 | 符号节点带版本哈希、类型分类、修饰符/签名/docstring | `OutlineEntry` 只有 id/name/kind/summary/range/parentId；无节点级版本哈希与元数据 | 定位安全的"命门"缺一半 |
| 6.8 | 版本哈希不匹配拒绝读写 | 提交时校验文件哈希；节点 `range` 在用时对缓冲区校验 | 部分满足 |
| 6.9 | 文件锁 exclusive/shared/region + TTL + 死锁检测 | 单一咨询锁 + TTL + 单调栅栏，无 shared/region、无死锁检测 | 多 Agent 写保护不足 |
| 6.10 | `file_mount_receipt` / `file_flush_receipt` / `file_unmount_receipt` | 无 | §12.6 未落地 |
| 6.11 | Session/Turn 绑定（文件操作归属当前 Session/Turn，跨 Turn persist 规则） | 无绑定、无 persist 评估 | §12.5 未落地 |
| 6.12 | 跨 Agent 隔离模式（isolated/shared_read/shared_write_with_lock）+ 合并点 | 无 | §12.7 未落地 |
| 6.13 | 文件写优先经 Skill，Profession 约束写权限（reviewer 只读等） | 直接工具调用；`profession` 未接入文件写入 | §12.8 未落地 |
| 6.14 | 回滚到回执前、标记后续回执 revoked、证据 stale | 无回滚 | §12.6 未落地 |

**做得比规范更细的地方**：`flush` 的幂等键语义、`compareAndSwapBytes`（二进制字节提交）、`Range` 的 UTF-8 字节 + 行双坐标校验、`stale` 的 `allowStale` 读取选项、`NodeFileStorage` 的临时文件 + fsync + 原子重命名。

## 7. 工作区、项目与视图（§11.2、§11.3、§13）

- **Workspace（§11.2）**：规范要求树形大纲、物理面、权限面（可写白名单/只读/禁止）、关系图、变更流、快照、隔离模式、合并点、认知脑图。当前 `Workspace` 只有 `tenantId/rootId/storage/outline` 与 read-only/writable 模式（[src/workspace/types.ts](src/workspace/types.ts)）。缺权限白名单、隔离模式、变更流、快照、合并点。
- **Project（§11.3）**：规范要求指令表（命令模板、前置条件、成功标准、超时、输出解析、失败分类、回退、成本、版本、成功率）、架构大纲、配置、默认 Profession、协作模板、架构脑图、状态机 `unloaded/loaded/active/stale`。当前 `Project` 只有 rules/metadata/views/environment 与 `project.outline`；无指令表、无项目状态机、无默认 Profession/协作模板。`environment` 是规范未单列的新增能力（对 agent 配置有实际价值）。
- **视图（§13）**：`ViewKind = er/sequence/flow/venn/architecture/mindmap` 六种与规范一致；但 `ProjectView` 只有 `kind/projection/sourceRuleIds/sourceVersions/version/stale/updatedAt`，缺规范统一抽象的"实体集/关系集/约束集/消费目的/来源/锚点/新鲜度"显式字段，`projection` 不透明，无法校验约束。
- **脑图（§13.6）**：完全未实现。六条硬约束（中心唯一、父子无环、深度 ≤ D、锚点存在、关联边理由非空、边数/节点数上限、锚点哈希一致）没有对应校验器。`project.outline` 是严格树，不是脑图。
- **§13.5 对 Agent 隐藏**：**明确偏离**。规范要求"视图的渲染完全隐藏""脑图结构不直接进上下文"；当前 agent surface 把 `project.views`、`project.outline`、`project.describe_environment` 暴露给模型（[src/agent/surface.ts](src/agent/surface.ts)）。至少 `views` 与 `outline` 应按规范降级为宿主/确定性路由使用，只向模型提供 1–2 行路径摘要。

## 8. 注意力、上下文与预算（§11.8–11.10、§16）

### 8.1 注意力对象

- **一致**：8 个操作齐备——`focus/blur/mount/unmount/persist/update/associate/verify`（[src/attention/operations.ts](src/attention/operations.ts)），并有预算、过期、理由、CAS 版本。
- **偏差**：
  - 评分维度为 `relevance/urgency/confidence/importance`，规范为 `相关性/正确率/代价/新鲜度/证据强度`；维度不同，无法直接对应。
  - 对象没有显式生命周期枚举（只有 `mounted: boolean` + `stale: boolean` + `intensity`），规范要求 `candidate/mounted(focus/blur)/persisted/unmounted/stale`。
  - 缺 `level`（intent→action）、`parent_id`、`profession_id`、`cooperation_id`、`mindmap_node_id`、`workspace/project 锚点`。
  - `associate` 有深度/候选/访问/预算四重上限（比规范更严格），但缺"评分树"的后验输出——`verify` 才产出 posterior。
- **硬规则**：mount 带预算与过期、persist 带理由、blur 不删除、stale 禁读写——实现中有对应字段与检查。

### 8.2 调度与上下文（§11.9、§11.10）

- 缺"路由/聚焦/切换/抑制"四机制的状态化实现、九阶段切换、脑图路由与注意力决策日志；`associate` 只是候选扩展。
- `compileContext(objects, options)` 存在，但缺规范的分层摘要/关系/明细访问预算与 exclusion 的完整投影（`CompileContextOptions` 需核对；当前类型有限）。

### 8.3 预算（§16）

- **一致**：`BudgetLedger` 支持四维（tokens/milliseconds/calls/bytes）+ 预留/结算/超限错误码，要求预留后才能结算（[src/budget/ledger.ts](src/budget/ledger.ts)）。
- **偏差**：
  - 规范预算树（Session → Turn → Intent → Mission → Goal → Plan → Task → Action）与"上层分配、下层消耗、Turn 完成结算、跨 Turn 保留预算"未实现；当前是按 `key` 的平铺账本。
  - 规范的多维配额（重试次数、澄清次数、并行度、协作/通信/仲裁/收敛/脑图预算）未实现。
  - 耗尽策略（Turn 预算耗尽 → Turn interrupted；Session 耗尽 → closing/suspended）未实现，只有抛 `limit_exceeded`。

## 9. 有意偏离（后续明确要求，不应当作缺陷）

1. **不使用第三方解析器**：规范 §12.4 指定 tree-sitter；当前全部为手写结构扫描器（无依赖）。影响：符号粒度、增量失效、错误恢复弱于 tree-sitter。
2. **支持 line/byte 写入与 string/regex 替换**：规范 §12.2 要求"禁止裸字节替换"；当前显式提供这些模式以降低 agent 操作错误（用户要求）。风险由 `Range` 校验、唯一匹配、CAS 与幂等键缓解。
3. **二进制字节挂载与 `writeBytes`**：规范未定义；为专有格式（Office/PSD/CAD/归档）与插件写入提供通道，读取语义仍是只读大纲。
4. **`Project.environment`**：规范 §11.3 没有该字段；这是为"引导 agent 配置当前项目"新增的能力。
5. **Agent surface 分层与网关**：规范 §13.5 只给原则；当前给出可执行的 tier 表与八种错误码，是规范的细化而非冲突（唯一冲突是 `project.views` 暴露，见 §7）。

## 10. 无法核实或未实现的部分

- 事件溯源、Session/Turn 快照与恢复、回滚、Receipt 采样审计、分层存储。
- 学习沉淀（L8）与行为抽象引擎（§7.5–7.6）、Cognition 路由与评测（§6.6、L5）。
- 验证层六类约束（§13.3）、冲突仲裁器（§11.7）、层级脑图/协作分工脑图。
- 跨 Agent 证据与回执互验（§5.8、§9.6）。
- 评测输入/报告（`docs/eval` 已不存在）。

## 11. 建议优先级

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| P0 | 从 agent surface 移除 `project.views` / `project.outline`，只保留摘要 | 直接违反 §13.5 的隐藏原则 |
| P0 | 为文件操作补 `file_mount/flush/unmount_receipt` 与 workspace 锚点 | §12.6 是回滚与审计的基础 |
| P1 | 补 `validate()`、`diff(base)` 结构化 hunk、节点级版本哈希 | §12.2/§12.4 的定位安全与写后校验 |
| P1 | 恢复 Session/Turn 恢复、persist 评估、历史压缩 | §4.1/§4.2 的核心生命周期 |
| P1 | 六级状态机对齐（至少补 blocked/paused/dead_letter/replanning 的语义或映射表） | 否则 §4.9 传播无法实现 |
| P2 | 证据 11 态与独立性/可靠性模型 | §5 的融合与仲裁依赖它 |
| P2 | 预算树与耗尽策略 | §16 的分配语义 |
| P2 | 视图契约字段与脑图校验器 | §13 的"可验证投影" |
| P3 | Cooperation 拓扑/七维协议、Profession 认证、L8 沉淀 | 属于后续阶段（§19 阶段三、四） |

## 12. 核查清单（已读源码）

`src/session/types.ts`、`src/turn/types.ts`、`src/intent/types.ts`、`src/mission/types.ts`、`src/goal/types.ts`、`src/plan/types.ts`、`src/task/types.ts`、`src/action/types.ts`、`src/workflow/{types,transitions,store}.ts`、`src/evidence/types.ts`、`src/receipt/types.ts`、`src/capability/{types,registry}.ts`、`src/behavior/types.ts`、`src/profession/policy.ts`、`src/cooperation/{types,coordinator}.ts`、`src/file/{types,core}.ts`、`src/workspace/types.ts`、`src/project/{types,core,environment}.ts`、`src/attention/{types,operations}.ts`、`src/context/compiler.ts`、`src/budget/ledger.ts`、`src/agent/surface.ts`。
