# 第 3 模块：运行时、搜索投影与 stdio 宿主边界审计

在协议与持久化模块独立审计代理均停止后，互斥审计运行时和宿主集成。两次代理异常中断，第三次仅新增 `auditControlIntegrationCheck.ts` 并通过 3/3；生产修复和真实 stdio 复现由主线程完成。

## 独立边界检查

- 真实 SQLite session 端口控制下，显式单轮 override 优先于 session 配置；reset 恢复 workspace，再恢复 global，最后回退 runtime 本地默认。交互和情景两域均覆盖。
- 模型请求在等待时修改 interaction、同轮模型工具调用修改 scenario：当前轮和工具续接 prompt 固定，下一轮采用新配置。测试用显式 promise 屏障建立时序。
- 注册项 disabled 和删除遮蔽 base/global 条目，另一 workspace 不受影响；unlink 只影响本地，外部 composite key 当作普通 ID 由宿主 namespace/kind 包裹；原始 base 和可信 executable tool 元数据不被改变。

## 发现并修复：search-only namespace 接管

原 `tools/workspaceServerHost.ts` 只在 `config.control` 指定时验证持久 `control_search_workspace:<namespace>` 绑定。仅配置 search 的同库宿主可以跳过归属检查，替换该 namespace 的 catalog snapshot，造成此前绑定 workspace 的搜索结果被覆写。真实 stdio 子进程回归证实：修复前，配置冲突的进程退出，但持久 generation 已从 1 增加到 2；这属于失败前的持久副作用。修复后无论是否配置 control 均读取现有绑定；未提供 workspace 身份时拒绝使用已绑定的 namespace，只有显式绑定身份可创建新的绑定。测试确认子进程以 1 退出、catalog generation 保持不变，且在拒绝前没有访问搜索后端。既有同库 control+search 注册、更新、移除及重启后发现回归仍通过。

## 验证与边界

`node --test tools/auditControlIntegrationCheck.ts`：独立 3/3 通过。`node --test tools/controlIntegrationCheck.ts`：含真实 stdio 进程的 4/4 通过；工具侧 `tsc --noEmit -p tsconfig.tools.json` 通过。

SQLite 使用真实连接，搜索远端使用本地 HTTP fixture；这些检查没有运行真实 Elasticsearch 集群。真实集群故障套件 9/9 是先前 search 模块的独立记录，不计入本模块结果。宿主配置文件是可信输入；原始 SQL 与直接低层 adapter 仅对宿主开放。报告只认定上述经实际进程复现并修复的宿主问题。
