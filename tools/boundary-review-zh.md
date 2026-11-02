# Search / Catalog / Discover 边界审查报告

> 修复复核：下文“当前仍可复现”是独立审查时的历史状态，不是最终状态。B-01 命中根已改用当前 SQLite 列表记录，跨连接复测返回新 metadata；B-02 全量删除前通过 `_resolve/index` 拒绝 alias/data stream；B-03 裸关系仅唯一候选解析；B-04 已增加 SQLite namespace 持久同步所有权，跨连接同步在旧 bulk 未完成时拒绝，结束后才能重试。真实 ES 独占性仍须由运维保证；崩溃锁须停写确认后人工 recoverSync 并重建。最终验证见 `boundary-joint-zh.md`。

审查类型：adversarial boundary review；期间业务源码由主线程并行修订。本报告按最后读取到的源码状态描述。未修改业务实现；只新增 `tools/boundary-review-check.ts` 和本报告。

## 发现摘要

| ID | 严重度 | 状态 | 发现 |
|---|---|---|---|
| B-01 | P2 | 当前仍可复现 | 共享 SQLite 文件的不同 `Database` 实例，其 `CatalogStore` 缓存彼此不失效；generation 已同步后旧 coordinator 仍可返回旧 label/summary/tags。 |
| B-02 | P2（条件性配置风险） | 当前仍可复现 | adapter 接受 alias 格式的 `index` 名；`replaceDocuments` 对此名称发起全量 `match_all` delete-by-query。若 alias 指向多用途/共享索引，会破坏 alias 覆盖的数据。 |
| B-03 | 已修复 | 复核通过 | 裸关系 target ID 重复对应多个 kind 时曾展开为多个子节点；主线程现改为仅在唯一候选时解析。 |
| B-04 | 已修复/缓解 | 复核通过 | 两个 coordinator/process 可在共享索引交错全量同步。旧请求 CAS 失败后，主线程现重新标 dirty，阻止后续发现使用该索引。 |

## B-01：跨 Database 实例的目录缓存未失效

**严重度：P2，数据新鲜度/结果完整性。** 不要求绕过权限；前提是一个 SQLite 文件/namespace 由多个进程或 `Database` 实例共享，且其中一个实例更新快照并同步 ES，另一个实例仍持有旧的 `CatalogStore` 缓存。

**位置：** [catalogStore.ts](../src/database/store/catalogStore.ts#L8-L20) 仅订阅同一个 `CatalogService` 的实例内 `onChange`。 [catalogSearch.ts](../src/search/catalogSearch.ts#L111-L137) 从 `catalog.list()` 建新记录映射，但命中根随后通过 `cache.readRecord()` 读取可能过期的行；`catalogSearch.ts:166-178` 也使用列表记录构树，故目前 stale 情况主要影响命中根。 [catalogService.ts](../src/database/service/catalogService.ts#L57-L67) 的 change handlers 是服务实例字段，不跨连接共享。

**触发与预期：** coordinator A 首次读 `knowledge/id`，缓存 `name=old`。coordinator B 使用另一个 `Database` 连接，在同一 namespace 把相同 key 改成 `name=new` 并成功 `sync()`。generation 与 ES 文档是最新的；A 后续 discover 应从权威 SQLite 返回 `new`。

**实际：** A 的 `catalog.list()` 读到最新 generation/记录以构造 search ID map，但 `cache.readRecord()` 命中 A 的本地旧 row，返回 `old` label。它仍可能通过授权检查，因为 projectId/revision 未变化。

**复现：** `node --test tools/boundary-review-check.ts` 中 `a second SQLite connection can leave the first instance cache stale after generation sync`。测试使用临时文件 SQLite、两个 `Database`/`CatalogSearch` 实例及一个共享 ES stub：A 同步并 discover 一次以填缓存；B 替换同一实体的 label 后同步；A 再 discover，断言旧 label 被返回，而 SQLite generation 已 clean 且 ES 存储新 label。当前此测试通过，实际体现了该行为。

**建议：** 若允许共享 DB，跨连接读必须绕过/验证缓存（例如 catalog generation 或 row updated_at 作为缓存代际），或明确禁止多个 Database/coordinator 实例共用该 DB namespace 并在 bootstrap 强制单实例锁。只靠进程内 `onChange` 不足以实现跨进程一致性。现有 generation 只比较索引同步状态，没有与 cache 条目绑定。

## B-02：索引 alias 未被排除，但全量重建对 alias 执行破坏性删除

**严重度：P2，需错误/不当配置触发。** 当前配置和文档要求 namespace 独占 index，因此遵循运维约束时不触发；但代码对 alias 没有可验证的拒绝或独占性保护。Elasticsearch alias 可以使用与 concrete index 相同的名字字符集。

**位置：** [elasticsearch.ts](../src/search/elasticsearch.ts#L108-L128) 只用正则校验 index 字符串，构造参数注释也称 concrete index；它没有查询 `_resolve/index` 类型或要求创建受协调器管理的 index。`elasticsearch.ts:204-228` 的 `replaceDocuments()` 对给定名称执行 `deleteByQuery(match_all)`，再批量写入。 [workspaceServerHost.ts](../tools/workspaceServerHost.ts#L34-L70) bootstrap 只校验 node/index/namespace/path 非空与 URL scheme，然后直接创建 coordinator 并重建。

**触发与预期：** bootstrap 的 `search.index` 配成一个现存 alias 名，alias 指向含其他用途文档的 index（或多个 index）。预期 coordinator 拒绝无法证明为独占 concrete index 的目标，或只删除本 namespace 的文档。

**实际：** `ElasticsearchSearch({ client, index: "shared-search-alias" })` 成功；`replaceDocuments([])` 发出面向该 alias 的 `deleteByQuery`，query 为 `match_all`。独立测试证明适配器接受并发出请求；未连接真实 ES，未实测 alias 指向多个 concrete indices 时该服务器版本的删除行为。

**复现：** `node --test tools/boundary-review-check.ts` 中 `an alias-shaped index name is accepted and receives destructive match_all replacement`。stub 观察到 `deleteByQuery({index:"shared-search-alias", query:{match_all:{}}})`。

**建议：** bootstrap 启动时通过 ES API 解析目标并拒绝 alias/data stream，或由协调器创建带 namespace 专属、不可变命名的 index/alias 并以 namespace filter 删除。若设计有意依赖人工独占约束，应将其视作硬性部署前提并在启动文档/运维检查中明确，而非把 regex 描述为 concrete-index 验证。

## B-03：关系目标同 ID 多 kind 消歧（已修复）

旧版 [catalogSearch.ts](../src/search/catalogSearch.ts#L111-L124) fallback `byId.get(targetId)` 会返回所有 kind 候选。通用 `CatalogRecord` 允许 raw target ID，且 projection 的 unresolved workspace target 与 host `relatedIds` 可保留裸 ID，因此一条边可能扩展到多个语义不同的实体。独立复现曾实际得到 `knowledge/same-id` 和 `skill/same-id` 两个 child。

主线程在审查中将 fallback 改为仅当候选数为 1 时返回；歧义目标现在不展开，并把树标记 `truncated`。当前测试更新为 `a raw ambiguous relation target is not expanded to multiple kinds`，通过。typed `catalogKey(namespace,kind,id)` 始终精确消歧。此项不再作为开放发现报告。

## B-04：跨 coordinator 全量同步竞态（CAS dirty 缓解已验证）

每个 `CatalogSearch` 的队列仍只在实例内串行（见 [catalogSearch.ts](../src/search/catalogSearch.ts#L42-L43)、`#L163-L170`）；两个进程可交错 `delete_by_query` 和 bulk。构造出的情况是：gen1 的 bulk 暂停，第二 coordinator 写 gen2 并标 clean，随后 gen1 bulk 落入 ES；其 generation CAS 必须失败。

当前实现 [catalogSearch.ts](../src/search/catalogSearch.ts#L79-L86) 在 CAS 失败时调用 `invalidateSynced()`。复现确认 ES 可能暂时/最终包含 stale old 文档与 new 文档，但共享 SQLite 状态变为 `{generation:2,syncedGeneration:0}`，两个实例的 discover 都拒绝返回结果。此前“错误地保持 clean”的实现状态已由主线程修复。本轮只审查代码，不保证跨 coordinator 提供互斥或原子 ES 切换；dirty 状态避免静默服务，但 ES 仍可处于部分/混合状态直到完整 retry sync。

## 有界审查与验证

**读取范围：** `src/search/elasticsearch.ts`、`src/search/catalogSearch.ts`、`src/search/projection.ts`、`src/database/{entity/catalog.ts,repository/catalogRepository.ts,service/catalogService.ts,store/catalogStore.ts,sql/schema.ts}`、`src/context/workspaceService.ts`、`src/global/service.ts`、`src/module/mcp/workspaceServer.ts`、`tools/workspaceServerHost.ts`，及 `tools/searchCheck.ts`、`tools/catalogSearchCheck.ts`、`tools/searchProjectionCheck.ts`、`tools/catalogPersistenceCheck.ts`、`tools/discoverAgentCheck.ts`、`tools/workspaceSearchServerCheck.ts`。按时间读取的是工作树动态状态，主线程同期修复了 B-03/B-04；上述状态栏已区分。

**运行验证：** 主线既有测试组合此前通过 57 项（catalog search、adapter、projection）；SQLite persistence 9 项、discover/environment 17 项、workspace agent 23 项、stdio host integration 1 项均有通过记录。独立 `tools/boundary-review-check.ts` 当前 4/4 通过：B-01、B-02 可复现，B-03/B-04 修复检查通过。

我另启动了一次全工具 TypeScript 检查；source 检查通过，但 tools 检查失败于主线程同期新增的 `tools/boundaryProjectionCheck.ts:70-72`：`HostComponent.kind` 是 union，不能赋给要求 `kind: "module"` 的 `EnvironmentEntry`。我已通知主代理；本审查未修改该文件。它与 search/catalog 实现无关。

**其他已覆盖且未发现开放问题：** adapter 的 mandatory scope、empty project scope network-free、global 显式纳入、revision 对 global 的约定例外、metadata source allowlist、bulk validation/duplicate 检查先于删除、删除超时/失败阻断批量写入；catalog hit 的 SQLite kind/project/revision/tags 复核、query revision、空 scope、generation CAS、sync/discover 实例内排队、每树预算、深度和循环、namespace 复合键、typed relation 解析；projection 的 JSON/I-JSON、访问器/循环/非 JSON 拒绝、预期跨源合并与意外重复拒绝；CatalogService 快照原子 SAVEPOINT、generation、外层事务读缓存规避和单条写封闭；MCP async 服务调用和 stdio 按序 backpressure/错误脱敏。未做真实 Elasticsearch server、alias 或多节点集群的集成测试；ES 行为以官方 SDK wire stub 为界。