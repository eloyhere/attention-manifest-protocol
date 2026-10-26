# 架构重构：agent 即人，从表服务到聚合 + 端口

> 状态：v0.1 设计稿。本会话不写 `src/database/**`；database 重构由另一个会话负责。
> 本体论见 `docs/agent-as-person.md`；端口见 `src/process/agent.ts`、`src/ipc/social.ts`、`src/context/agentContext.ts`。

## 0. 结论

问题不是缺模块，而是层错了：领域模块（kernel/process/thread/authz/registry）直接写 SQL，`Database` facade 按表堆 service。继续按表加会得到 20 字段的上帝对象。

目标：**6 个聚合 + 6 个端口 + 一个组合根**，领域层不 import `node:sqlite`。`person` 不是新层——`process` 就是 agent，也就是 person；人格内容拆进既有模块。

## 1. 现状证据

- `Database` facade 已有 11 个 service，按表增长。
- 原始 SQL（`.prepare(` 计数）：`thread` 23、`process` 14、`kernel` 5、`authz` 8、`concurrency` 12、`registry` 27。
- `cycle/runtime.ts` 是 manifest + ledger + attention + goals 的 god object。
- `manifest` 已有 Identity/SelfModel/Commitment；如果再加 person 表，会出现两套自我模型。
- schema 已到 v4；person 表已写入 schema 但尚未接代码，迁移由 database 会话统一处理。

## 2. 目标：六个有界上下文

| 聚合 | 拥有 | 端口 |
| --- | --- | --- |
| **Agent (person)** | profile、self narrative、roles、memories、affect、background、life events | `AgentStore` / `AgentReader` |
| **Social** | relationships、institutions、memberships、messages | `SocialStore` / `SocialReader` |
| **Execution** | process、thread、steps、leases | `ExecutionStore` |
| **Attention** | window、pages、frame、context assembly | `AttentionStore` |
| **Epistemics** | objects、claims、evidence、receipts、warrant | `WarrantStore` |
| **Registry** | concepts、modules、relations、attestations（架构元数据） | `RegistryStore` |

组合根只负责打开连接、事务、迁移、装配端口；不再暴露 20 个 `readonly` service。

## 3. 依赖规则

```text
domain (agent/thread/process/kernel/...)
        │ depends on
        ▼
ports (src/process/agent.ts, src/ipc/social.ts, ...)
        ▲ implemented by
        │
adapters (src/database/adapters/sqlite/*)
        │
        ▼
SQLite
```

规则：

1. 领域层不得 import `node:sqlite`、`src/database/**`、表名或 SQL。
2. 端口只传 id、值对象、DTO；不传数据库 row。
3. 事务边界在 adapter/service；领域层不写 `BEGIN`/`COMMIT`。
4. 事件在事务提交后发出；ledger/observability 消费事件，不反向依赖领域。
5. `registry` 只登记架构，不存运行时人格。

## 4. 语义边界

| 概念 | 归属 | 决定 |
| --- | --- | --- |
| **process** | Execution | agent 的运行时句柄；pid 是人的身份键。不建第二套生命周期。 |
| **AgentProfile** | Agent | 传记摘要，以 pid 为外键；不是第二个 process。 |
| **manifest** | Protocol | 对外签名快照；由 `issueManifest(agent)` 生成，不是人格 source of truth。 |
| **role** | Agent | 社会位置、义务、观众、脚本；不授予 capability。 |
| **capability** | Authz | 权限；role 可以约束/请求，但不能替代 handle。 |
| **memory** | Agent | 有类型的重建；可以引用 claim/evidence，但不是证据。 |
| **affect** | Agent | 状态；影响显著性与预算，不改 claim 的 tier。 |
| **background process** | Agent | 习惯/情绪/监控；不占前台 running 槽位。 |
| **relationship** | Social | 持续信任/依恋/义务；不是 message 历史。 |
| **institution** | Social | 规范、成员、地位；社会人格是 status/capability。 |
| **goal** | Execution/Agent | 目标状态；thread 是执行尝试；agent 的 current concern 可以引用 goal。 |
| **thread** | Execution | 任务/目标线程；可完成，不是人。 |

## 5. 迁移步骤（strangler）

### Phase 0：冻结契约（本会话）

- `docs/agent-as-person.md` + `src/process/agent.ts` + `src/ipc/social.ts` + `src/context/agentContext.ts`。
- 不动 database；不新增按表 service。
- `tools/agent-check.ts` 用内存端口验证 8 项。

### Phase 1：适配器先行（database 会话）

- 在 `src/database/adapters/sqlite/` 实现 `AgentStore`、`SocialStore`、`ExecutionStore`、`AttentionStore`、`WarrantStore`、`RegistryStore`。
- 保留现有 facade 作为兼容层，内部委托给新 adapter；旧 service 标记 deprecated。
- 统一 schema v5 迁移：agent 表、thread class、索引；写 v4 → v5 测试。

### Phase 2：Execution 收口

- `process.ts` / `thread.ts` 状态机保留，SQL 移到 `ExecutionStore`。
- `kernel` 只依赖 `ExecutionStore` + `AgentReader` + `AttentionStore`。
- 删除 kernel 中的 `db.prepare`；`StepContext` 不再暴露原始连接。
- 验收：`rg "\.prepare\(" src/{process,thread,kernel}` 为 0。

### Phase 3：Agent / Social 接入

- 实现 `AgentService`：createAgent、reviseNarrative、assign/activate role、remember/recall、affect、context assembler。
- `StepContext.agentContext` 通过 `AgentReader` 注入；kernel 不读 agent 表。
- `issueManifest(agent)` 从 agent 状态生成 manifest 快照，消除 `manifest.SelfModel` 与自我叙事的重复。

### Phase 4：Attention / Epistemics

- `window` 通过 `AttentionStore` 持久化；context assembler 只产出候选，window 决定最终装入。
- `warrant`/`receipt` 通过 `WarrantStore`；`objects` 哈希链仍由 adapter 维护。

### Phase 5：缓存与事件

- `store` 的 Proxy 缓存订阅领域事件失效，而不是手工 `invalidate`。
- 禁止跨聚合缓存写穿；缓存 key 带 aggregate/version。

### Phase 6：测试与边界守卫

- 用 `node:test` 替代手写 check 脚本；保留脚本作为 smoke。
- registry 的 `module_dependencies` 增加「领域层不得依赖 database」的规则，CI 失败而不是口头约定。

## 6. 不变量

- **R-1** 领域层不 import `node:sqlite` 或 `src/database/**`。
- **R-2** 一个事务只写一个聚合；跨聚合用事件/补偿。
- **R-3** 端口不暴露 row、连接、SQL、表名。
- **R-4** schema 只由 adapter 拥有；领域类型不随表结构变化。
- **R-5** kernel 不直接读写 agent/social 表。
- **R-6** role 不授予 capability；memory 不是 evidence；affect 不改 tier。
- **R-7** `manifest` 是快照，不是人格存储。
- **R-8** 兼容层只能变薄，不能变厚；新代码不得新增按表 service。
- **R-9** 每次迁移有 vN → vN+1 的测试与回滚说明。
- **R-10** registry 的模块依赖图无环，且能查出层级违规。

## 7. 模块处置表

| 模块 | 处置 | 原因 / 动作 |
| --- | --- | --- |
| `process` | **修改 + 新增** | agent 运行时 + 人格 facets；新增 `agent.ts`、`agentStore.ts`、`agentService.ts` |
| `thread` | 保留 | task/goal 线程；不再承担 agent 语义 |
| `kernel` | 修改 | 通过 `AgentContext` 注入人格；后续移除直接 SQL |
| `context` | 修改 + 新增 | 新增 `agentContext.ts`：self→role→affect→memory→relationship→background 的预算装配 |
| `ipc` | 修改 + 新增 | 新增 `social.ts`/`memorySocialStore.ts`：relationship/institution/membership；mailbox 仍是传输 |
| `attention` | 修改 | salience 接收 role salience、affect（stress/arousal）与关系权重；不再只算 VOI |
| `window` | 保留 | 工作记忆/页表；人格上下文是候选，window 决定最终装入 |
| `frame` | 保留 | 一次注意帧；不承载人格 |
| `goal` | 修改 | 目标属于 agent 的 current concerns；thread 是执行尝试 |
| `mission` | 修改 | 改成 concern/task 队列；不再有独立 mission 实体 |
| `progress` | 修改 | 按任务/生命章节统计，不再用「进程 done」 |
| `manifest` | 修改 | `issueManifest(agent)` 生成签名快照；不是人格 source of truth |
| `concept` | 保留 | 语义知识；memory 可引用 concept |
| `warrant` | 保留 | 信念/证据；memory 不是 evidence |
| `evidence` | 保留 | 证据图 |
| `ledger` | 保留 | 审计/事件；消费 `AgentEvent`/`SocialEvent` |
| `receipt` | 保留 | 行动结算 |
| `execution` | 保留 | 工具/句柄/动作层；后续接 `ExecutionStore` |
| `policy` | 保留 | 规范/审批；制度规范可引用 policy |
| `authz` | 修改 | role ≠ capability；role 可约束 capability，但不授予 |
| `cooperation` | 修改 | 协作/共享板对齐 relationship/institution |
| `delegate` | 修改 | 委派是子 agent + role/relationship，不是匿名任务 |
| `protocol` | 保留 | A2A/MCP/wire |
| `registry` | 保留 | 架构元数据；不存运行时人格 |
| `semantic` | 保留 | canonical/sha256 |
| `storage` | 保留 | append log |
| `structure` | 保留 | 数据结构库；不动 |
| `boundary` | 保留 | 构造即拒绝 |
| `concurrency` / `lock` | 保留 | lease/心跳/锁 |
| `error` | 修改 + 新增 | 新增 `agentError.ts`；错误码属于领域 |
| `types` | 修改 | 增加 `Pid`；agent 身份是 `pid` |
| `store` | 暂缓 | 等 database 端口化后改成事件失效的读穿缓存 |
| `cycle` | **废弃 / 后续移除** | `Runtime` 是 god object；拆到 agentService/execution/attention/warrant 后删除 |
| `cache` | **已移除** | 空目录，无实现 |
| `person` | **不新增** | 人格内容已拆进 process/ipc/context；不建第二套生命周期 |

## 8. 完成定义

1. `Database` facade 字段 ≤ 8：`db`、`transaction`、`close`、6 个聚合端口。
2. `rg "\.prepare\(" src/{process,thread,kernel}` 为 0。
3. `src/kernel` 不 import `src/database/**`。
4. agent 的 P-1…P-12 全部有测试。
5. v4 → v5 迁移有测试；旧库可打开或明确拒绝。
6. 全量 verify + `tsc` 通过；registry 依赖检查通过。

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 一次性重写导致回归 | strangler：adapter 先兼容，domain 逐步切 |
| 双写/双读不一致 | 单一写路径；旧 facade 只委托，不另写 |
| 事务边界变粗 | 每聚合一个事务；跨聚合事件 + 幂等 |
| 性能下降 | 端口批量读；context assembler 只取 top-k |
| schema 迁移丢数据 | 先备份；v5 只加表/列，不 drop（除非明确 pre-release） |
| 两个会话冲突 | 本会话只写 docs + 非 database 模块；database 会话拥有 schema/adapter |

## 10. 给 database 会话的最小契约

先实现这四个端口，其他可以后补：

1. `AgentStore`（profile/narrative/roles/memories/affect/background/life events）
2. `SocialStore`（relationships/institutions/memberships）
3. `ExecutionStore`（process/thread/steps/leases）
4. `AttentionStore`（window/pages/frame）

只要这四个端口稳定，kernel 与 agent service 就可以并行开发，不需要等整个 schema 重写完成。
