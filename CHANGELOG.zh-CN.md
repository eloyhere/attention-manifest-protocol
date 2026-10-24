# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- 上下文经济。`planPrune()` 在已验证的账本上生成显式视图：被取代的主张、已关闭的假设、
  已解决且非阻塞的未知会离开视图；每一条丢弃都带 `reason` 与 `revisit_if`；引用闭包保证
  不会出现悬空引用。`supersedes` 有意**不**被视为依赖。
- `compactLedger()` 用检查点替换冷前缀，检查点承诺被移除条目的摘要；`verifyCompaction()`
  重算该承诺，并检查 tail 是否接续同一条链。若保留的 tail 仍引用前缀条目，压缩会被拒绝，
  并抛出带 `pinned` 列表的 `CompactionRefused`。
- 新增 `compaction.schema.json`（检查点与剪枝计划）、两个可校验示例
  （`checkpoint.json`、`prune-plan.json`），以及含 P-1 至 P-7 不变量的
  `docs/compaction.md`。
- 新增 `tools/compaction-check.ts`（15 项断言），已接入 `npm run verify`。

### 变更

- 数量随新层更新：schema 14 → 15、可校验示例对象 33 → 35、校验入口 29 → 30、
  `tools/` 下的 TypeScript 脚本 38 → 39。
- `tools/` 下的 38 个脚本全部由 JavaScript 迁移为 TypeScript。它们由 Node 直接做类型剥离后
  运行，并纳入 `tsconfig.tools.json` 的检查范围；仓库中已不存在 `.mjs` 文件。
- `npm run verify` 现在连续执行两份类型检查——`src/` 的 `tsc --noEmit` 与 `tools/` 的
  `tsc -p tsconfig.tools.json`——测试代码中的类型错误会直接使整个校验失败。
- 测试夹具改为声明它真正构造的协议类型（`Claim`、`EvidenceItem`、`Hypothesis`、
  `Candidate`、`MergeClaim`、`TeamManifest`、`AttentionRequest` 以及未签名的 `Manifest`），
  不再把字面量拓宽成 `string`。
- HTTP 套件改用共享的 `listen()` 与 `portOf()`，不再无类型地调用 `server.address()`。
- 随改名同步更新了文档、`package.json` 中的脚本路径与 README。

### 修复

- `a2a-check` 曾把运行时 `Delegation` 的摘要与同一个对象（本该是 `DelegationDoc`）的摘要
  相比较，两侧哈希的都是 camelCase 对象，因此该断言永远不可能失败。现在先用
  `toDelegationDoc()` 转换，再比较文档与文档的摘要。
- `persistence-check` 展开了类型为 `unknown` 的哈希链载荷；现在在测试边界处显式收窄。
- `sign-check` 在自动改写后把类型导入插进了多行 import 语句中间；导入顺序已修正。

## [0.1.0] - 2026-10-24

首个公开的参考实现。

### 新增

#### 协议与类型

- `docs/schemas/` 下的 14 个 JSON Schema，以及与之一一对应的 TypeScript 类型。
- 消息信封与七种言语行为：`attend`、`plan`、`act`、`ask`、`note`、`reflect`、`read`。
- 12 条不变量：W-1 至 W-5（凭据）、A-1 至 A-5（注意力）、M-1（自述）、X-1（日志）。

#### 注意力

- 带单调性规则的显著性契约，以及焦点集与忽略集。
- 不可变的帧链；`Frame.ignored` 记录被排除的对象，并给出 `reason` 与 `revisit_if`。
- 僵局分类，以及带注意力债务的打断分级。
- 在调度器处强制预算：分配可以降级为句柄、分页或拒绝，但绝不静默截断。
- 基于句柄的溢出机制，使大结果始终可寻址。

#### 凭据

- T0–T4 认知投入等级、置信度派生与等级校验。
- 带 `supersedes` 链的最小修订。
- 显式的未知与停止规则，以及预注册与复现检查。

#### 执行

- MCP 2026-07-28 客户端：无状态 `_meta`、`server/discover`、`ttlMs` 与 `cacheScope`、
  HTTP 绑定头，以及回退到旧式 `initialize` 握手。
- 作为唯一计费点的预算调度器，配合审批门控与 TTL 缓存。

#### 联邦与信任

- `ManifestBundle` 与 `Attestation`、摘要固定、撤销，以及失败关闭的导入。
- Agent Card 发现与 JWS/EdDSA 卡片签名。
- bundle 密钥、背书与 scope 策略；A2A `message/send` 绑定会将 JSON-RPC 错误如实上报。

#### 协作

- 带等级衰减的委派、10 条不变量、租约 fencing 与深度限制。
- 任务板、含冲突值处理的结果合并，以及权威裁决。
- 统一账本、指标（重复任务率、对齐 token 占比、单次成功成本、争议率）与端到端会话。

#### 持久化与共享

- 覆盖事件、帧、回执、主张、假设、未知、目标与计划的只追加哈希链。
- 按数量、链尾、哈希与链序校验快照；恢复时拒收损坏的快照。
- 三种共享粒度。

#### 文档与工具

- `docs/architecture.md`：规范性架构文档。
- `docs/rationale.md`：12 条 ADR，每条都给出证据、代价与被否决的方案。
- 多 Agent、信任链与联邦三份专题文档，以及九份研究简报。
- 29 个校验入口（166 项带计数的断言）、4 个示例生成器、5 个端点探针，另有 33 个示例对象
  通过 schema 校验。

### 安全

- 预算只在一点强制执行，针对的是 CVE-2026-114386 所代表的那类失效：嵌套工具调用绕过了
  单次运行的配额。
- 外部内容不能提高自身显著性；提升只能来自可信信号。
- 委派、联邦导入与通道操作均失败关闭，并各自记录原因。

### 已知限制

- 尚未实现沙箱隔离、多租户与 OAuth 交互授权。
- 跨域测试均在本机运行；尚未演示与外部 Agent 的真实互通。
- 规范文档与研究简报以简体中文撰写。
