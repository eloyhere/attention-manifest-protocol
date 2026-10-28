# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更

- 将项目说明收敛到中英文 README；评测汇总只保留 JSON 格式。

## [0.4.0] - 2026-10-29

治理层 v0.4：持久化、轮换与真实 HTTP 互操作。

### 新增

- 真实 HTTP 服务端（`src/governance/httpServer.ts`）：localhost、方法/路径/体积限制，
  配合 `HttpCooperationTransport` 端到端认证；`cooperation-http-check` 3 项。
- 密钥轮换（`GovernanceKeyring.rotate/revokeKid/prune`）：重叠窗口内旧签名继续有效，
  旧 kid 可单独吊销；`signing-check` 增至 5 项。
- 审计检查点（`checkpoint/verifyCheckpoint/entriesAfter`）：留存分段可独立校验；
  `audit-check` 增至 4 项。
- 治理对象持久化（`src/governance/store.ts`）：清单/凭据/回执写入 JSONL 事件日志，
  重开恢复最新状态；`governance-store-check` 1 项。
- DeepSeek 配对样本扩到 20 组：质量 rubric 20/20、judge 4.85/5、配对 token 增量 +6.9%、
  成本约 $0.007547、边界 20/20。

## [0.3.0] - 2026-10-28

治理层 v0.3：Ed25519 签署、持久审计、认证传输与工具前门控。

### 新增

- Ed25519 签署适配层（`src/governance/signing.ts`）：`GovernanceSignatureBundle` 绑定
  signer/subject/id/version/digest，`GovernanceKeyring` 支持吊销；`signing-check` 4 项覆盖
  防移植、缺签、重复签与吊销。
- 审计持久化：`src/storage/fileAppendSink.ts` 提供 JSONL 文件 sink；`audit-check` 新增
  跨进程重开与磁盘篡改拒绝（共 3 项）。
- HTTP 传输认证：Ed25519 签名、时间窗与 nonce 重放防护；`cooperation-check` 增至 14 项。
- 工具前置门控（`src/governance/toolPolicy.ts`）：`GovernedToolPolicy` 在工具执行前检查
  高风险审批、冻结/熔断与证据下限；`tool-gate-check` 4 项。
- DeepSeek 评测扩到 20 个质量用例与 20 个边界用例：rubric 20/20、judge 4.85/5、
  配对 token 增量 +6.2%、成本约 $0.004095；报告见 `docs/probes/governance-live.json`。
\n## [0.2.0] - 2026-10-28

治理层 v0.2：可审计、可传输、可度量，校验链全绿。

### 新增

- 注意力治理层（`src/governance/`）。按「Attention Manifest Protocol 完整说明」实现九个构件：
  情景×模式矩阵（9.1–9.8 全部表）、13+1 个视角的注册表、签名注意力清单、三层上下文、
  三联签切换凭据、贝叶斯控制层、法务行为规范层（冻结/降级/熔断）、预算三账本与七阶段审批
  工作流。统一了说明中 T1/T2/T3 的严格度与既有 T0–T4 强度序（F1→T3、F2→T2、F3→T1），
  并保留八种旧场景到五种规范场景、`inspire` 到 `diverge` 的显式桥接。
- `docs/governance.md`、`governance.schema.json`（清单与凭据）、两个可校验示例
  （`attention-manifest.json`、`switch-credential.json`）。
- `tools/governance-check.ts`（19 项）与 `tools/governed-task-check.ts`（5 项），
  已接入 `npm run verify`。
- `src/runtime/governedTask.ts`：把清单验签、凭据校验、法务审计、账本扣款、黑板回执与
  控制决策套在 `CognitiveRuntime` 外面；拒绝路径在模型调用之前返回。已用真实 DeepSeek
  （`deepseek-chat`）跑通一次治理回合。
- Agent 预算账本与 `reallocate()`：预算现在支持 `scope: "agent"`，子 Agent 的额度从父账本转移，
  总量守恒；负数/NaN/Infinity 额度直接拒绝，储备扣款必须带财务审批，超过 50% 另需董事会。
- 视角切换编排（`src/governance/switching.ts`）：平级切换、降级、模式切换、情景重派生与升级计划；
  情景切换走 `rederiveAttentionManifest()`，版本递增并记录 parent 摘要。
- 多 Agent 合作（`src/governance/cooperation.ts`）：结构化消息（清单摘要、refs、凭据、回执）、
  接收端凭据复验、监事会独立审计路径、按可靠度 × 信息价值剪枝通信图。
- 多 Agent 传输接缝（`src/governance/transport.ts`）：`LoopbackTransport`、`HttpCooperationTransport`
  与 `createCooperationHandler()`；接收端始终重跑摘要/清单/凭据/回执校验，格式错误 400、
  策略拒绝 422、成功 200。`cooperation-check` 增至 13 项。
- 治理审计链（`src/governance/audit.ts`）：清单、凭据、回执、扣款、法务、工作流、切换与
  runtime 回合均可追加到只追加哈希链；`verify()` 检测改写/重排/截断，`open({ sink })` 重开时
  先验链。`GovernedTask` 可注入 `audit`，结算后自动写 `runtime.turn`。
- `tools/audit-check.ts`（2 项）验证跨对象记录、重开、篡改与损坏拒绝，已接入 `npm run verify`。
- `tools/cooperation-check.ts`（13 项）已接入 `npm run verify`；`governance-check` 增至 21 项，
  新增对伪造签名、负额度、冻结撤销、归档门禁、控制 NaN、未知 effect、私域引用泄漏的回归断言。
- `tools/live-governance-eval.ts`（`npm run governance-live`）：接入 DeepSeek 做质量、token 与边界评测。
  质量用确定性 rubric + 严格 judge；token 记录 input/output/cache/cost、账本扣款与预算上限；
  边界覆盖危机升级、过期清单、过期凭据、法务冻结、预算耗尽、提示注入泄漏、多 Agent 越界与超限。
  报告写入 `docs/probes/governance-live.json`，key 只从环境变量读取。
  首次完整运行：10 个质量用例 rubric 全满分、judge 4.90/5；配对 token 增量 +5.4%；边界 10/10。
- `GovernedTask` 现在把清单情景/模式映射进 runtime 的 scenario/interaction 预算，并把清单摘要、
  证据下限与禁止项作为 `systemNote` 注入系统提示；扣款按清单的 `perspective`/`agent` 账本绑定执行，
  模型调用前先检查账本是否冻结。
- 构造边界（`src/boundary/`）。`frameFrom()` 在对象存在之前校验 id 文法、引用闭包、9 个槽位
  上限、忽略上限（默认 50，溢出的部分作为 `deferred` 返回）与预算一致性；`parseToolCall()`
  按 `inputSchema` 的子集解析参数，并给出被接受内容的摘要；`RefTable` 让 `tool` 与
  `capability` 共用一个命名空间，并解析 `self`。19 项断言以 `npm run boundary-check` 运行，
  同时接入 `npm run verify`。
- `ExecProfile` 在策略判断与派发之前用 `parseToolCall()` 解析参数。被拒绝的参数不会到达服务端，
  只留下一条 blocked 回执；审批绑定的是解析后的摘要。
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
- 概念经济。`pruneConcept()` 为一个概念的体量设上限：重复示例折叠为更典型的那条；超过
  `maxExamples` 的示例从最不典型的一端裁掉；`minExamples` 作为下限，保证概念仍有实例。
  关系先去重，提供解析器时删除悬空目标，外延只折叠完全重复项。定义、内涵、反例与
  `grounded_in` 永不裁剪；视图不提升 `version`。
- `compactConceptHistory()` 保留 head 与 `keepVersions`，其余版本压缩为
  `concept-checkpoint`。版本号不连续或保留窗口覆盖全部版本时拒绝压缩。不变量 C-1 至 C-4
  记录在 `docs/compaction.md` §6。
- 新增 `concept-compaction.schema.json`、两个可校验示例，以及 `tools/concept-check.ts`
  （14 项断言），已接入 `npm run verify`。
- `src/structure/priority.ts`：基于比较堆的稳定 `PriorityQueue`；可按 key 以 O(log n)
  重新定级与删除的 `IndexedPriorityQueue`；按整数优先级分桶、桶内 FIFO 的 `BucketQueue`；
  以及有界选取的 `TopK`。`tools/priority-check.ts` 含 27 个用例（包括与稳定排序模型对拍的
  随机差分检查），以 `npm run priority-check` 运行，并接入 `npm run verify`。

### 变更

- 数量随新层更新：schema 14 → 16、可校验示例对象 33 → 37、校验入口 29 → 31、
  `tools/` 下的 TypeScript 脚本 38 → 40。
- `tools/` 下的 38 个脚本全部由 JavaScript 迁移为 TypeScript。它们由 Node 直接做类型剥离后
  运行，并纳入 `tsconfig.tools.json` 的检查范围；仓库中已不存在 `.mjs` 文件。
- `npm run verify` 现在连续执行两份类型检查——`src/` 的 `tsc --noEmit` 与 `tools/` 的
  `tsc -p tsconfig.tools.json`——测试代码中的类型错误会直接使整个校验失败。
- 测试夹具改为声明它真正构造的协议类型（`Claim`、`EvidenceItem`、`Hypothesis`、
  `Candidate`、`MergeClaim`、`TeamManifest`、`AttentionRequest` 以及未签名的 `Manifest`），
  不再把字面量拓宽成 `string`。
- HTTP 套件改用共享的 `listen()` 与 `portOf()`，不再无类型地调用 `server.address()`。
- 随改名同步更新了文档、`package.json` 中的脚本路径与 README。
- 许可证由 `UNLICENSED` 改为 Apache-2.0：仓库根目录新增许可证原文，`package.json` 与
  `package-lock.json` 声明为 `Apache-2.0`，中英文 README 说明了授权内容与再分发须满足的
  条件。
- 署名：新增 `NOTICE` 记录版权所有者（Eloy Kim，2026），再分发须保留该文件；
  `package.json` 补充 author 字段；中英文 README 均链接许可证与署名声明。

### 修复

- 审计门禁曾不可满足：`audit.behavior` / `audit.budget` 没有审批部门。现在分别由法务与财务拥有，
  审计阶段可以推进到升级或归档。
- `src/bayes/calibration.ts` 的交叉验证把未使用的 `item` 形参留在 `filter` 回调里，导致
  `tsc --noEmit` 失败；现在形参改名并保持行为不变。
- `package.json` 的 `description` 含损坏的 UTF-8 片段（`T0閳ユ彑4`），已改为 `T0-T4`；
  `demo` 脚本指向早已删除的 `src/cycle/demo.ts`，已移除，README 改为指向真实可运行的
  治理校验命令。
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
