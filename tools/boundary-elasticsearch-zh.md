# Elasticsearch SDK Adapter 边界审计报告

> 修复复核：以下“实际行为”保留独立审计时的复现记录。主线程现已修复三个问题：部分分片失败抛错；bulk item 必须有整数 status；删除仅把文档缺失映射为 false。新增 concrete-index 解析拒绝 alias/data stream；搜索响应校验 total、relation、hit 数量、耗时及 score。回归探针已改为断言修复后的拒绝行为。最终联合结果见 `boundary-joint-zh.md`。

## 范围与结论

审计范围仅为 `src/search/elasticsearch.ts`、`src/search/types.ts`，并阅读既有 `tools/searchCheck.ts`。新增 `tools/boundaryElasticsearchCheck.ts`，未修改实现文件或其他已有文件。

新增探针 4/4 通过。这里的“通过”表示测试成功复现所记录的当前行为，不表示该行为符合预期。既有 `tools/searchCheck.ts` 覆盖了常规成功路径、输入边界、scope/revision/global DSL、mapping、错误传播、响应元数据白名单、批次与替换流程；本次发现以下 3 个 fail-open 边界。

## 发现

### B-1 部分 shard 失败被作为普通成功返回

- 严重性：中
- 位置：[elasticsearch.ts](../src/search/elasticsearch.ts:301)
- 复现：让 `_search` HTTP 200 响应包含 `_shards: { total: 3, successful: 2, skipped: 0, failed: 1 }`、`timed_out: false` 和一条 hit。
- 实际：`search()` 返回该 hit，`timedOut` 为 `false`；`SearchResult` 不含 shard failure 信息，也不拒绝该响应。调用者无法区分完整结果与部分分片结果，可能把不完整命中当成完整搜索结果。
- 预期：对非零 shard failure，应将结果标记为不完整/失败，或在返回类型中明确暴露失败计数与错误详情；不得静默表现为完整成功。
- 证据：`boundaryElasticsearchCheck.ts` 的 `audit reproduction: partial shard failure is returned as ordinary search success` 用真实 SDK 传输到本机 HTTP stub 复现。响应映射位于 `elasticsearch.ts:301-311`，目前只读取 `took`、`timed_out`、total 和 hits；`SearchResult` 在 `types.ts:37-43` 没有 shard 状态字段。

### B-2 缺少 bulk item status 被累计为成功索引

- 严重性：中（可能造成同步状态误报）
- 位置：[elasticsearch.ts](../src/search/elasticsearch.ts:185)
- 复现：bulk HTTP 200 响应返回 `items: [{ index: { _id: "d1" } }]`，缺少 `status`，且无 `error`。
- 实际：`status < 200` 和 `status >= 300` 均为 false，`operation.error` 又是 undefined，于是 `indexed` 加一并返回无 failures。上游可能据此认为该文档已成功写入；快照同步调用方也可能错误地确认 generation。
- 预期：要求每个 item 有有效的整数 HTTP 状态码且位于 2xx；缺少/畸形状态应抛错或记录失败，不得计为成功。
- 证据：`boundaryElasticsearchCheck.ts` 的 `audit reproduction: a malformed successful bulk item without status is counted as indexed` 断言当前结果为 `{ indexed: 1, failures: [] }`。相关分支为 `elasticsearch.ts:183-195`。

### B-3 删除时把索引不存在误映射为文档不存在

- 严重性：低到中（错误分类与运维信号丢失）
- 位置：[elasticsearch.ts](../src/search/elasticsearch.ts:237)
- 复现：`DELETE /<index>/_doc/<id>` 返回 HTTP 404，ES 错误类型为 `index_not_found_exception`。
- 实际：`deleteDocument()` 仅检查状态码；任何 404 均返回 `false`。因此“目标文档缺失”和“索引配置/生命周期错误”无法区分，调用者可能把后者当作幂等成功。
- 预期：仅将 Elasticsearch 文档级 404（例如 `document_missing_exception`）映射为 `false`；索引不存在等其他 404 应传播为错误。
- 证据：`boundaryElasticsearchCheck.ts` 的 `audit reproduction: index_not_found_exception on document delete is mapped to not-found document` 通过真实 SDK/stub 复现；catch 分支位于 `elasticsearch.ts:235-239`，虽然已有 `errorType()` helper，但此处未使用。

## 覆盖情况

本次新增测试覆盖：

- search 响应部分 shard failure 的 fail-open 映射。
- bulk HTTP 200 响应项缺少 status 时的计数行为。
- document delete 404 与 index-not-found 404 的当前混同。
- 输入校验失败不发网络请求的控制用例，以及项目/revision/global 带筛选和分页请求的基础控制用例。

既有 `tools/searchCheck.ts` 还覆盖：构造惰性和 client 所有权、显式 endpoint/config/index 名称、strict mapping 及竞争创建、单条/bulk 写入和 refresh、完整输入预校验、UTF-8 ID 限制、bulk 1000 边界、删除错误传播、空 scope 零网络、项目隔离及 global/revision DSL、source allowlist 与 `content`/未知字段剔除、total relation/timedOut 映射、分页窗口、网络/SDK 错误和 `replaceDocuments` 的删除校验、分批、部分失败、失败删除和空快照流程。

## 最终验收第 2 模块：快照审计

本轮范围按要求收敛至 `src/search/elasticsearch.ts` 及指定 adapter 检查，未修改源码。新增 `tools/auditElasticsearchSnapshotCheck.ts`，覆盖 namespace hash + UUID 索引名、严格 mapping 和 `_meta`、批量 NDJSON、部分 bulk 失败不 refresh/block、count+mget digest 验证，以及快照身份竞态。最终 adapter suites 56/56 通过；本机隔离 Elasticsearch 9.2.0 fault suite 9/9 通过。

### 已复现并由主线程修复：验证后的身份竞态

- 复现 1（search post-check）：`searchSnapshot()` 首次通过 resolution 与 `_meta`，count/mget/digest 正常；第二次 `assertOwnedIndex()` 也通过；`POST /<snapshot>/_search` 期间模拟将 concrete index 替换为 alias。旧代码随后只做 count/mget/digest，仍成功返回 hit，未再执行 `GET /_resolve/index/<snapshot>`。
- 复现 2（marker post-check）：请求序列为第一次 `resolveIndex + getMapping`、settings/count/mget、第二次 `resolveIndex + getMapping`、search；在 search 响应时把 `_meta.amp_search.namespace` 改为 foreign。旧代码仍成功返回 hit，没有 search 后 mapping 检查。
- 复现 3（构建封写后）：create、resolve/mapping、bulk、refresh、`addBlock` 后改变 `_meta`，旧代码接着 settings/count/mget 并返回已封写索引，没有 marker 复查。
- 主线程已在 `verifySnapshot()` 入口加入 `assertOwnedIndex()`。本轮三条时序回归均已改为断言拒绝：search 期间替换 alias 报 concrete-index 错误；search 后修改 marker 报 ownership-marker 错误；buildSnapshot 封写后修改 marker 报 ownership-marker 错误。最终复测结果见下方测试数。

## 未覆盖与限制

- 未连接真实 Elasticsearch 集群；错误和边界响应由 SDK 9 实际 HTTP transport、本机 stub 构造。stub 覆盖 SDK 序列化/反序列化及请求行为，但不验证服务端实现差异。
- 未对未知/畸形 `_search` 响应字段做全面模糊测试，例如缺失 `hits`、非法 total/took 类型；SDK 的静态类型不构成运行时响应验证。
- `replaceDocuments` 是非事务性删除后分批写入；既有测试验证失败可观察和部分结果累计，但未验证并发外部写入。适配器注释要求调用方独占索引并串行化写操作。
- `SearchDocument` 与 `SearchResult` 是编译期接口，本报告未另设编译期类型断言；重点是运行时边界和真实 SDK wire 行为。
