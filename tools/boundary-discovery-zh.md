# Discovery 边界审计报告

> 修复复核：下文记录审计期间观察到的中间状态。主线程已移除 buildTree 对局部映射的越作用域引用；歧义 raw ID 不展开，foreign composite key 不回退到 raw ID；循环/缺失关系标 truncated。Elasticsearch 非法 total 和超量 hits 现拒绝；schema 用非空白 pattern 与运行时校验对齐。测试断言已更新为修复契约。最终联合结果见 `boundary-joint-zh.md`。

审计范围严格限定为 `src/search/catalogSearch.ts`、discover types 与 `workspaceService`、global service、MCP handler、`tools/workspaceServerHost.ts`。只读检查既有 `tools/catalogSearchCheck.ts`、`tools/discoverAgentCheck.ts`、`tools/workspaceSearchServerCheck.ts`；新增唯一测试文件 `tools/boundaryDiscoveryCheck.ts`。实现文件未修改。

## 发现

### BD-01：歧义 raw relation 触发运行时 ReferenceError

- **Severity：Medium (availability / correctness)**
- **位置：** [catalogSearch.ts](../src/search/catalogSearch.ts:116) 和 [catalogSearch.ts](../src/search/catalogSearch.ts:185)
- **最小触发：** 同一 namespace 中存在两个以上可授权记录具有相同业务 `id`、不同 `kind`；一个可命中根记录通过 raw `targetId: "same"` 关系引用它们。
- **证据：** `boundaryDiscoveryCheck.ts` 的 “same raw relation ID across two authorized projects” 用这种快照调用 `discover`，执行到 `buildTree` 未定义的 `byKey`/`byId` 标识符，抛 `ReferenceError`，整次 discover 失败。第 185 行位于 `buildTree` 方法，局部作用域没有这两个映射；映射只定义在 `discover` 方法中。独立 TypeScript 检查也报 `TS2304`。
- **影响：** 含歧义 raw relation 的条目不能被发现，形成可由目录数据触发的拒绝服务；当前并非静默跨项目展开，因为 `resolve` 对多候选返回空数组，但随后的 unresolved 分支抛错。

### BD-02：typed-looking foreign target 可退化为本地 raw ID

- **Severity：Medium (relationship integrity)**
- **位置：** [catalogSearch.ts](../src/search/catalogSearch.ts:116)–[catalogSearch.ts](../src/search/catalogSearch.ts:123)
- **最小触发：** 根关系 `targetId` 为 `JSON.stringify(["other-namespace", "file", "victim"])`，当前 namespace 中另有一条记录的业务 `id` 恰为该整段 JSON 文本，且该记录在 scope 中可见。
- **证据：** 测试中 target 是 `JSON.stringify(["some-other-namespace", "file", "victim"])`；`byKey` 查找失败后按 `byId` 对同一字符串做 raw ID 回退，响应树错误地包含该本地记录。relation 本来表达外 namespace typed key，却被解释为不同语义的业务 ID。
- **影响：** 关系完整性/显示语义可被目录中的冲突业务 ID 混淆。目标仍经过 project scope 过滤，未观察到授权范围提升；但可将无关的获准元数据错误挂入树。

### BD-03：ES total 和 hits 数量未在协调器边界复核

- **Severity：Medium (response integrity / resource bound)**
- **位置：** [catalogSearch.ts](../src/search/catalogSearch.ts:125)–[catalogSearch.ts](../src/search/catalogSearch.ts:144)，以及 [elasticsearch.ts](../src/search/elasticsearch.ts:301)–[elasticsearch.ts](../src/search/elasticsearch.ts:310)（用于解释 adapter 透传行为，不属于本次可修改范围）
- **最小触发：** 请求 `limit: 1`；ES 响应 4 个合法且不同的当前目录 hit，并给 `hits.total = { value: -19, relation: "bogus" }`。
- **证据：** 测试观察到返回 4 棵树，`total` 为 -19、`totalRelation` 为 `bogus`，且 `truncated` 为 false。Coordinator 遍历完整 `found.hits`，没有限制 `hits.length` 不超过请求 limit；它将 total / relation 原样复制，`truncated` 只使用 `found.total > found.hits.length`。
- **影响：** 超出调用者请求 limit 的响应仍会被展开；非法计数和关系值进入公共结果，且 `truncated` 可错误地声称完整。单棵树仍受 nodeLimit 限制，但多 hit 的总树数/响应体可能增大至 adapter 收到的 hit 数量，最终才由 workspace `maxResponseChars` 拒绝整个响应。

### BD-04：协议层接受全空白查询，Coordinator 再拒绝

- **Severity：Low (contract consistency)**
- **位置：** [workspace.ts](../src/protocol/workspace.ts:436)–[src/protocol/workspace.ts](../src/protocol/workspace.ts:440) 与 [catalogSearch.ts](../src/search/catalogSearch.ts:95)–[src/search/catalogSearch.ts](../src/search/catalogSearch.ts:96)
- **最小触发：** `queries: "   "`。
- **证据：** `parseToolCall` 依据 `minLength: 1` 接受该值；Coordinator 随后检查 `query.trim()` 并抛 `RangeError`，不发送 ES 请求。经 `WorkspaceAgentService.callAsync` 时该异常被归一为 `search_failed`，而不是 `invalid_arguments`。
- **影响：** schema 描述和执行边界行为不一致，调用者收到后端错误分类而非参数错误。该输入不会产生空查询/`match_all` 网络请求。

## 验证通过项

- `CatalogSearch` 的 generation CAS、同步/查询串行化和关闭后的拒绝调用：现有 checks 与新 close/replace 探针验证；见 [catalogSearchCheck.ts](./catalogSearchCheck.ts:240)–[catalogSearchCheck.ts](./catalogSearchCheck.ts:355)。
- scope 必须明确；空 project scope 且不含 global 时无 ES 请求；root 与 relation target 使用 SQLite 当前记录复核授权及 revision：见 [catalogSearchCheck.ts](./catalogSearchCheck.ts:172)–[catalogSearchCheck.ts:216) 和新增 scope 测试。
- SQLite 中同 namespace + kind 的重复 ID（即使项目不同）会在快照验证时拒绝，未覆盖写入：新增 `same namespace and kind duplicate business ID` 探针。
- hit 的 id/kind/project/revision 不匹配 SQLite 时丢弃；标题、摘要取 SQLite，而不是不可信 ES `_source`；content 和未知字段不出现在结果：见 [catalogSearchCheck.ts](./catalogSearchCheck.ts:192)–[catalogSearchCheck.ts:216) 及新增 metadata 探针。
- 宽关系图的树节点数受 nodeLimit 约束，maxDepth/cycle 会截断；现有和新增 width/depth checks 通过。
- stdio 多条请求按输入顺序回复，scope DSL 只使用服务 bootstrap 提供的授权项目与 global 配置；新增子进程 wire 检查通过。既有 [workspaceSearchServerCheck.ts](./workspaceSearchServerCheck.ts:63)–[workspaceSearchServerCheck.ts:92) 验证 stdio 启动先持久化并同步，再执行异步 discover。
- 既有 [discoverAgentCheck.ts](./discoverAgentCheck.ts:160)–[discoverAgentCheck.ts:231) 验证 service schema/call budget、global scope 转发、MCP async 等待和错误脱敏。

## 新增边界测试结果

运行：`node --test tools/boundaryDiscoveryCheck.ts`

在审计过程中实现文件由并行工作者修改，最终测试轮次为 **8 passed / 2 failed**：两个失败是上面的 BD-01/BD-02 发现，不应通过放宽断言隐藏。stdio 顺序/scope、重复 ID 拒绝、空白查询边界、恶意 ES total/hits、SQLite 元数据权威、树宽深预算、replace/close 并发及空 scope 断言通过。

对该测试单文件类型检查因审计期间 `catalogSearch.ts` 出现的未定义 `byKey`/`byId` 而失败（`TS2304`），已向父代理报告；测试本身无独立类型错误。按授权未修改任何实现文件。

## 最终验收第 4 模块：发现 / 投影 / Host 协议边界（2026-11-02）

本轮审计限定为 `src/search/projection.ts`、`CatalogSearch.discover`、`WorkspaceAgentService` discover、`GlobalAgentService`、MCP 与 `tools/workspaceServerHost.ts`。新增唯一脚本 `tools/auditDiscoveryHostCheck.ts`，使用既有 stateful `catalogSnapshotFixture` 和本地 stdio 子进程；未启动或依赖真实 Elasticsearch。src 只读，审计期间发现的修复由父代理完成。

### 本轮发现与复核

| 问题 | 最小复现 / 影响 | 修复与回归 |
|---|---|---|
| 数组索引 accessor 穿透严格 JSON 参数边界 | `queries` 数组的索引 `0` 为 enumerable getter；修复前 `callAsync` 执行 getter 4 次并调用 search，虽然工具边界声明拒绝 accessor | `jsonValue` 现通过 own descriptor 读取数组值；漏洞回归确认调用前拒绝、getter 次数为 0、search 次数为 0 |
| 数组自有非索引属性在投影中被静默丢弃 | payload 数组有额外 enumerable 属性或 symbol；旧 projection 只复制索引，造成投影数据有损 | 增加数组形状检查，拒绝 symbol、hole、accessor 和任何非索引自有属性（含不可枚举）；投影回归均通过 |
| schema 与运行时长度计量不一致 | 300 个 emoji 在 schema 的 code-point 长度下合法，但 JS UTF-16 `length` 为 600，旧 coordinator 将其作为 `search_failed`；空白 kinds/tags 也会落到 `search_failed` | coordinator 按 Unicode code point 限制 query；schema 对 kinds/tags 项增加非空白 pattern。新增回归确认 300 emoji 成功、513 code points 与空白过滤器在调用 search 前报 `invalid_arguments` |

### 已验证边界

- CatalogSearch 命中根与关系目标均以当前 SQLite namespace/project/revision 记录为权威；跨 namespace composite key 不回退为本地 raw ID。global-only scope 只返回无 project 的 global 记录；workspace/global service 仅传 host 配置的项目集合。恶意 hit / relation 不会挂入未授权、旧 revision 或 foreign namespace 节点，内容正文不出现在 discover 响应。
- malformed envelope、工具参数及 scope 注入在 search 前拒绝；revision 错误一致返回 `revision_mismatch`。循环、缺失边、宽度、深度及 nodeLimit 有界；数据库拒绝重复 relation，投影对重复 relation 去重。
- global wrapper 的 async discover 维持共享调用预算，错误只暴露稳定错误码；MCP notification 不执行工具，非法 JSON-RPC envelope 不消耗工具预算，async 调用等待服务结果。
- stdio 在超长行后恢复处理下一行，malformed JSON 返回 parse error，末尾无换行请求仍处理；回复按请求顺序输出。bootstrap、后端错误不泄露 URL、凭据或私有配置。stateful wire fixture 验证异步搜索路径，无需真实 ES 节点。

### 最终测试结果

```powershell
& 'R:\nodejs\node.exe' --test tools/auditDiscoveryHostCheck.ts tools/boundaryDiscoveryCheck.ts tools/boundaryProjectionCheck.ts tools/searchProjectionCheck.ts tools/workspaceSearchServerCheck.ts
& 'R:\nodejs\node.exe' tools/discoverAgentCheck.ts
```

新增审计 **13/13**；其余五脚本合计 **37/37**（Node test suites 31 项，`discoverAgentCheck.ts` 内部 6 项）。最终 **50/50 通过，0 失败、0 取消、0 跳过**。边界测试原始记录中的 BD-01/02/03/04 是历史中间状态，修复后由本轮及既有脚本复核，不代表当前仍可复现。未改 src，TeX 与真实 Elasticsearch 均排除。
