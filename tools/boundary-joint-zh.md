# Search / Catalog / Discover 联合边界审计与修复报告

## 四模块修复后的联合复核（2026-11-02）

四个模块逐一互斥审计、修复并结束子代理后，主线程联合运行 catalog guard、ES snapshot、sync publication、discovery host 及既有持久化/搜索/投影/stdio 回归，共 **155/155 通过**，独立 discover service 脚本另 **6/6 通过**；两套 TypeScript 检查均通过。本轮联合检查使用模拟 ES transport；真实 ES 9.2.0 故障验证结果仍为此前记录的 **9/9**，没有将其重复计入本轮。

```powershell
& 'R:\nodejs\node.exe' --test tools/auditCatalogGuardCheck.ts tools/auditElasticsearchSnapshotCheck.ts tools/auditSyncPublicationCheck.ts tools/auditDiscoveryHostCheck.ts tools/catalogPersistenceCheck.ts tools/boundaryCatalogPersistenceCheck.ts tools/catalogSearchCheck.ts tools/boundarySyncOwnershipCheck.ts tools/boundaryDiscoveryCheck.ts tools/boundaryProjectionCheck.ts tools/searchProjectionCheck.ts tools/boundary-review-check.ts tools/workspaceSearchServerCheck.ts tools/searchCheck.ts tools/boundaryElasticsearchCheck.ts
& 'R:\nodejs\node.exe' tools/discoverAgentCheck.ts
& 'R:\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
& 'R:\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.tools.json
```

下文保留各模块的审计证据与历史阶段数据。作用域控制新工具的实现与验收另记，尚未计入上述结果。

## 最终验收第 4 模块：发现 / 投影 / Host 协议边界（2026-11-02）

本轮仅审计 projection、CatalogSearch discover、WorkspaceAgentService / GlobalAgentService、MCP 与 stdio Host 协议边界；没有启动真实 Elasticsearch，远端交互使用既有 stateful `catalogSnapshotFixture`。src 未由审计子代理修改，父代理完成严格 JSON 数组、Unicode query 计长及过滤器 schema 修复。详细复现和证据见 [发现边界报告](boundary-discovery-zh.md)。

新增发现测试复现并复核三项修复：数组索引 accessor 在调用 search 前拒绝且 getter 不执行；数组额外 own 属性不再被 projection 静默丢弃；Unicode 查询长度与 schema 一致，空白 kinds/tags 归为 `invalid_arguments` 而非后端失败。新增审计还验证了跨 project/revision/global/namespace 的拒绝授权、host 配置 scope、不可信 ES hit 与 relation 复核、cycle/depth/width/node budgets、malformed 工具与 JSON-RPC 输入、global async 与 call budget、MCP notification、stdio async 顺序/超长行恢复/末尾无换行处理及错误脱敏。

执行命令（Node.js 24）：

```powershell
& 'R:\nodejs\node.exe' --test tools/auditDiscoveryHostCheck.ts tools/boundaryDiscoveryCheck.ts tools/boundaryProjectionCheck.ts tools/searchProjectionCheck.ts tools/workspaceSearchServerCheck.ts
& 'R:\nodejs\node.exe' tools/discoverAgentCheck.ts
```

最终结果：新增审计 **13/13**，既有五脚本 **37/37**，合计 **50/50 通过，0 失败、0 取消、0 跳过**。本轮未覆盖真实 ES 节点与 TeX。此前章节保留模块 1-3 记录。

## 最终验收第 3 模块：sync / publication coordinator（2026-11-02）

本轮仅审计 `src/search/catalogSearch.ts`、`src/database/repository/catalogPublication.ts`，以及 CatalogService / CatalogStore 的发布、lease 与跨连接状态。新增复现与回归文件为 `tools/auditSyncPublicationCheck.ts`；审计子代理没有修改 `src`，以下实现修复由父代理完成。此前章节保留历史审计记录；当前实现采用独立物理索引构建加 SQLite epoch / generation CAS 发布，超时或失败的孤立索引不会覆盖当前发布。

本轮明确复现并经父代理修复的三类问题：

| 问题 | 最小触发时序与影响 | 修复及复核 |
|---|---|---|
| 发布完成时遗漏外层事务检查 | sync 等待 bulk 时，宿主在同连接 `BEGIN`；发布 SAVEPOINT 加入外层事务，sync 曾返回 `{generation:1,syncedGeneration:1}`，随后 `ROLLBACK` 撤销发布与同步确认 | service 的 `publishSnapshot` 与 coordinator 发布前拒绝外层事务；两个独立回归均通过 |
| discovery 最终检查可落入旧 WAL 读快照 | A discovery 等待 search 时，宿主在 A 连接 `BEGIN` 并读 state 固定 generation 1；B 连接提交 generation 2；A 曾从固定读快照读取旧 state 并返回旧树 | discovery 异步完成后、最终 state/publication 读取前拒绝外层事务；真实双连接回归通过 |
| 排队 sync 的取消与超时不覆盖队列等待 | discovery 占用队列时，后续 sync 的 abort 不结算、timeout 从出队才计时，可能无限等待 | 从调用时建立取消与计时并在队列外 race；两个回归确认及时拒绝，排队项最终出队后 epoch 不增加、不新建索引 |

其余定向检查通过：close 等待已接受 discovery 并拒绝之后排队的 sync；跨连接 generation 变化拒绝旧 discovery；lease 跨重启保留、显式 recovery 与复用 owner token 的 revision fencing 正常；旧 epoch 不能覆盖新发布；epoch 到 `Number.MAX_SAFE_INTEGER` 后由数据库 CHECK 约束原子拒绝递增，未持久化 unsafe epoch，不构成溢出缺陷。既有回归还覆盖独立并发 build、失败后安全重试、create timeout / bulk abort 后迟到响应、重启恢复、generation CAS、seal / digest 失败和 discovery 前后验证。

执行命令：

```powershell
& 'R:\nodejs\node.exe' --test tools/auditSyncPublicationCheck.ts tools/catalogSearchCheck.ts tools/boundarySyncOwnershipCheck.ts
```

最终结果：**36/36 通过，0 失败、0 取消、0 跳过**（新增审计 10 项 + 既有 coordinator / ownership 26 项）。本轮未运行范围外模块或 TeX。父代理另行执行的全局检查不计入上述独立验收数量。

## 审计方式与范围

子代理分别检查 Elasticsearch SDK adapter、SQLite catalog 持久化链、projection，以及 discover/宿主调用；另有独立 adversarial review 检查跨模块数据流与跨连接竞争。各模块报告保留原始发现与复现步骤：[Elasticsearch](boundary-elasticsearch-zh.md)、[持久化](boundary-catalog-persistence-zh.md)、[投影](boundary-projection-zh.md)、[发现](boundary-discovery-zh.md)、[交叉审查](boundary-review-zh.md)。主线程按发现逐项修复，维护测试断言，并联合运行完整边界与回归套件。

## 已修复问题

| 范围 | 原问题及风险 | 修复与回归证据 |
|---|---|---|
| ES 响应，中 | 非零 shard failure 被当作完整结果；非法 total/relation、超量 hits 等可污染发现树 | 部分分片失败与不自洽搜索元数据现抛错，限制 hits 数量并校验 score/took/timed_out；见 `boundaryElasticsearchCheck.ts`、`boundaryDiscoveryCheck.ts`。 |
| ES 写入，中 | bulk item 缺少整数 status 被计为成功，可能误标 generation 已同步 | 严格校验每项 status；畸形项抛错、同步保持 dirty。 |
| ES 删除，中低 | 任意 404 被当作文档缺失，掩盖缺失索引等故障 | 仅 `document_missing_exception` 返回 false，其他错误传播。 |
| ES 目标，条件性 P2 | alias/data stream 名称可接受全索引 `match_all` 删除 | 全量替换在删除前通过 `_resolve/index` 要求唯一同名 concrete index；歧义、alias、data stream、HTTP 错误均拒绝且不发删除/写入请求；wire stub 覆盖空和非空快照。 |
| SQLite 读边界，中 | 有效 JSON 却包含非字符串数组或非对象 payload 时返回错误运行时类型 | `recordFromEntry` 校验 tags/searchTerms 数组元素及 payload object；省略的可选数组在写入时落为 `[]`；语法错误仍抛 `SyntaxError`。 |
| 投影，中/低 | 可选元数据形状未校验；host getter 在输入拒绝之前执行 | projectId/revision/sourceUri 与 tags/searchTerms 运行时验证；descriptor-safe 复制后再读取输入字段；getter 不执行。 |
| 关系树，中 | 裸 target ID 多种 kind/项目歧义导致错误展开；外部复合键回退成同名 raw ID；构树 resolver 越作用域 | 裸 ID 仅唯一可见候选解析；外部复合键不回退；未解析/循环标 truncated；resolver 由 discover 显式传入树构建。 |
| 查询边界，低 | schema 接受纯空白查询，但 coordinator 拒绝 | schema 增加 `\\S` pattern，单条和批量输入与运行时一致。 |
| 跨连接一致性，P2 | A 缓存旧命中根；B 在同库替换并同步后 A 返回旧 label | discover 的命中根及关系树使用本次 SQLite 列表的权威记录，跨连接复测新 label。 |
| 跨连接同步，P2 | 独立 coordinator 的全量删/写可以交错；CAS 事后标 dirty 仍留有暂时 clean 窗口 | SQLite namespace 持久所有权 token 串行化重建；discover 拒绝 owned/dirty，前后比较 ownership revision，token 校验确认/释放，失败标 dirty；旧 bulk 阻塞时新 sync 拒绝，完成后可重试。 |

## 联合验证

命令（仓库根目录，Node.js 24）：

```powershell
& 'R:\nodejs\node.exe' --test tools/boundary-review-check.ts tools/boundarySyncOwnershipCheck.ts tools/boundaryElasticsearchCheck.ts tools/searchCheck.ts tools/boundaryDiscoveryCheck.ts tools/catalogSearchCheck.ts tools/boundaryProjectionCheck.ts tools/searchProjectionCheck.ts tools/boundaryCatalogPersistenceCheck.ts tools/workspaceSearchServerCheck.ts tools/discoverAgentCheck.ts tools/environmentCheck.ts tools/environmentDiscoverCheck.ts
& 'R:\nodejs\node.exe' node_modules/jiti/lib/jiti-cli.mjs tools/catalogPersistenceCheck.ts
& 'R:\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
& 'R:\nodejs\node.exe' node_modules/typescript/bin/tsc --noEmit -p tsconfig.tools.json
& 'R:\Git\cmd\git.exe' diff --check
```

最终结果：Node 联合套件 **119/119 通过**（其中 `discoverAgentCheck.ts` 是脚本级测试条目，内部另输出 6 项通过）；持久化脚本 **9/9 通过**；source/tools 两套 TypeScript `--noEmit` 检查通过；`git diff --check` 通过，仅输出既有文件 LF/CRLF 提示。中途回归曾发现新增同步锁夹具返回空 bulk items；已修正夹具并完整重跑，无失败、取消或跳过。

## 当前实现的边界与运维前提

前述历史联合结果和租约实现记录不代表当前架构。当前采用每次尝试独立物理索引与 SQLite epoch / generation CAS，已在本机真实 Elasticsearch 9.2.0 单节点上运行故障套件，9/9 通过；并非多节点故障注入。适配层最终独占审计 56/56 通过，含查询期间替换 alias、篡改 namespace marker，以及封写后改变归属的回归。

- 已发布索引有写封锁；查询前后验证具体索引、namespace marker、文档数量和内容 digest。拥有修改映射、移除封锁、替换或删除索引权限的 Elasticsearch 管理员仍属于可信管理边界，校验不能构成对恶意管理员的强隔离。
- 失败或超时后可立即重试，迟到写入只影响未发布的独立索引；重启后不依赖人工释放同步锁。原有 lease / recoverSync API 保留兼容，但不是当前 CatalogSearch 同步路径。旧索引和失败构建可能残留，宿主需要保留与清理策略，并避免删除当前发布或仍在构建的索引。
- 普通原始 SQL 和公开通用 CRUD 对五张 Catalog 表的写入受连接级许可触发器拒绝；批准的 replaceSnapshot 维护 generation 和缓存。内部许可 helper、重新注册 UDF、删除触发器等宿主管理权属于可信边界。通用投影允许长 opaque ID 与 unresolved 关系，发现阶段只解析授权范围内可唯一识别的目标。
- 调用前及远程等待后拒绝同连接外层事务，避免把持久发布吞入可回滚事务或用旧 WAL 读快照验证新鲜度。排队同步的取消/超时从调用开始计算。
