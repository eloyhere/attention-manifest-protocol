# 第 2 模块：作用域持久化、身份与 workspace 绑定边界审计

独立审计代理按互斥顺序检查 SQLite 迁移、身份、CAS、继承、batch、fork、文件持久隔离。审计代理只新增 `auditControlPersistenceCheck.ts`，生产修复和修复后断言由主线程完成；代理已停止修改，之后才启动运行时/host 模块审计。

## 发现与修复

| 编号 | 证据与影响 | 修复后验证 |
| --- | --- | --- |
| CP-01 | 有非空 context 时，fork 先写 child context，而 child session 外键尚不存在，导致 store_failure。 | 先保存 child descriptor，再复制 context；失败补偿清理 child。真实 SQLite 非空 context fork 通过。 |
| CP-02 | 两个 registry 同库，旧 registry 的缓存 active descriptor 在 authenticate 时无条件 upsert，覆盖另一个 registry 已持久化的 revoked；旧 token 可复活。 | registry 操作先重读持久 descriptor/secret；repository 在事务中检查下一 revision、固定 workspace、终态不可复活。旧 registry 的 control 调用返回 permission_denied，数据库保持 revoked。 |
| CP-03 | 原始文件 adapter 以 rootId 为全局键；session roots 改为复合主键后，不同 workspace 同 rootId 可复用该存储键。初始证据来自直接 adapter，未证明当时所有文件服务接口均泄漏。 | 保留公开 root ID，数据库采用 (session_id,root_id)，SessionRuntime 包装持久键为 JSON[workspaceId,sessionId,rootId]，graph 缓存和 outline 同步隔离；真实 SQLite 两个 runtime 注解隔离通过。旧单 PK 表无损迁移、fork、reopen、foreign_key_check 通过。 |
| CP-04 | 认证回调使用有续期副作用的 authenticate，dryRun 和 CAS 拒绝仍增加 session revision/total_changes。 | 新增只读 verify；文档和集成示例使用 verify 回调。dryRun 和 CAS 拒绝的 total_changes/revision 均稳定。可信宿主自行安装写回调仍可产生其自身副作用，服务不承诺撤销任意宿主代码。 |
| CP-05 | 认证回调重入同 port，内层偏好 set 提交后外层再拒绝，留下已提交修改。 | service 认证期重入保护；内层 control_unavailable，偏好 version 保持 0。 |
| CP-06 | session revision 达 MAX_SAFE_INTEGER 后 authenticate 写入不安全整数，下一 registry 构造失败。 | 所有 revision 增量使用安全上限检查；返回 store_failure，数据库无写入且 revision 稳定。 |

此前联合回归还发现 fork 为规避 root_id 全局唯一而改写公开 root ID，违反 session 契约。已恢复公开 ID，改用数据库复合键及内部文件存储作用域键解决冲突。

## 其他通过的边界

- partial global 权限下，未指定授权 workspace 的 read/list/default/write 全部拒绝；构造后修改 identity/授权数组无效；workspace 参数不能冒充其他身份；session workspace 绑定不可变。
- suspended/revoked/expired/closed、workspace 与 session 不匹配均拒绝。
- global → workspace → session 继承，reset 保留本地版本并恢复继承；链接继承拷贝、unlink dry preview、删除遮蔽隔离、复活清理旧链接、默认值 reset。
- 14 类安全敏感键、65 层数据、非 JSON/非有限值、未配对 surrogate、accessor、稀疏数组和超 1 MiB 值拒绝；getter 不执行、数据库无写。
- all/existing 仅影响当前授权 workspace 的活跃且未过期 session；dryRun 的 total_changes 稳定。注入 SQL trigger 失败或某 session 版本溢出时，整个批次回滚；registry/default 版本上限和嵌套事务拒绝。
- 实际构造缺 workspace_id 的 v4 数据库迁移通过；注入不兼容 view 使迁移失败时，新增列、schema_version、scheduler、evidence 整体回滚。root 表迁移保留原 ID、process 和 object chain。

## 验证

2026-11-02 使用 `R:\nodejs\node.exe`：

```
node --test tools/auditControlPersistenceCheck.ts tools/workspaceDatabaseCheck.ts tools/sessionCheck.ts tools/controlPersistenceCheck.ts tools/controlIntegrationCheck.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.tools.json
```

独立审计脚本内部 **15/15**；联合 Node 测试 **64/64**，其中脚本型测试在 Node 中按一个子测试计数；两套类型检查退出码均为 **0**。更早 file*Check 与 session/control 联合 **142/142**，文件作用域修复后通过；后续完整联合回归应再覆盖这些文件。

本模块使用真实 SQLite 与本地目录夹具；stdio 搜索依赖 HTTP fixture，未以本轮结果声称真实 Elasticsearch 集群通过。低层 SQLite/raw filesystem adapter 属于可信宿主接口；不向 agent 暴露任意 SQL。未知未发布 draft 数据库变体不等于受支持的 schema 版本，未对全部历史草稿排列作穷举证明。
