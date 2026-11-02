# Catalog 持久层独占边界审计

## 结论

在本次约定的普通应用 DML 威胁模型下，未发现必须修复的 Catalog 持久层缺陷。没有修改 `src/database`。已验证连接本地写许可触发器、公开 CRUD 拒绝、严格完整快照校验、事务/跨连接缓存一致性、generation 与 publication CAS。

**明确的信任边界：** `withCatalogWrite` 和 `registerCatalogWriteGuard` 位于内部模块 `src/database/store/catalogGuard.ts`，不从 `src/database/index.ts`、`src/database/store/index.ts` 或 database package barrel 导出。它们属于可信实现 capability。任意 JS 直接导入内部源码模块、重注册 SQLite UDF 或直接构造 repository 不在普通业务 DML 威胁模型内，不据此报缺陷。任意 JS 可 `DROP TRIGGER` 同样是宿主/管理能力，不是需要本模块解决的普通 DML 绕过。

## 范围与复现

只读检查 `src/database` 中 catalog entity、guard、repository、service、store、schema 和 wiring；新增独立检查脚本 `tools/auditCatalogGuardCheck.ts`。源码未修改。使用 Node 24.21.0，在仓库根目录执行：

```powershell
& 'R:\nodejs\node.exe' tools/auditCatalogGuardCheck.ts
& 'R:\nodejs\node.exe' node_modules/jiti/lib/jiti-cli.mjs tools/catalogPersistenceCheck.ts
```

结果：新增边界审计 **10/10**；既有持久化模块 **9/9**；合计 **19 项实际检查通过**。联合主线另报全仓回归 **106/106**，非本次单独运行的计数。

## 边界证据

- 对 `catalog_entries`、`catalog_relations`、`catalog_sync_state`、`catalog_sync_ownership`、`catalog_search_publication` 的普通 SQL INSERT/UPDATE/DELETE 逐表尝试，均由触发器以 `catalog writes require CatalogService` 拒绝。公开 `CatalogRepository` CRUD 以及通用 `TableSql` 更新也被拒绝；状态不变。
- 对预编译 statement，在许可外执行以及在一次获准快照操作之后执行，仍被拒绝。另一个未注册的 SQLite 连接对同一文件执行 UPDATE，因缺少 `amp_catalog_write_allowed` 函数而失败关闭。
- JSON tuple key 能隔离包含分隔符的 namespace/kind/id。Repository snapshot 对缺字段/多余 metadata、namespace 不一致、重复 entry/relation 均在更改前拒绝；原数据与 generation 保持不变。Service 入口校验 JSON payload 和 tags/searchTerms 运行时形状，并为调用方和读出值提供隔离副本。
- 外层事务中成功释放 SAVEPOINT 后再回滚，未提交 cache 值不会残留；外层事务提交后，第二个连接写入并递增 generation，首个连接的 CatalogStore 检测 generation 变化并读到新值。
- 人为将 generation 置为 `Number.MAX_SAFE_INTEGER` 后替换会安全失败，快照旧行保留。旧 publication epoch、新 epoch 配错误 generation、旧 generation 均不能发布；publication 只在 epoch 与当前 generation 匹配时成功。
- 同步写许可只接受同步回调；async function、Promise/thenable 被拒绝。排队的 microtask 在回调返回后尝试 UPDATE，观察到触发器拒绝，证明 permit 不跨异步 continuation。

## 局限

这是模块边界检查，不是对可执行任意 JS 的安全沙箱。数据库拥有者有意绕过触发器或调用内部 capability 时，generation/cache 维护仍由该受信任管理方负责。未运行 Elasticsearch 网络同步与发现模块测试；它们不属于本模块范围。