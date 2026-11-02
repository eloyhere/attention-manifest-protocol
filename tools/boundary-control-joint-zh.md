# 作用域控制工具：串行模块审计与最终联合边界验收

2026-11-02。先完成 SQLite 权威持久化、八个规范控制工具及宿主接入，之后按协议入口 → 持久化与 workspace 绑定 → 运行时/搜索投影/stdio 宿主顺序，逐模块派出互斥审计子代理；每个模块停止后，主线程逐项修复并复测。后两模块各有代理进程异常退出，主线程接管遗留测试与报告，第三模块以重新派出的互斥代理完成 3 项独立检查。所有三个模块无并行审计代理。

## 功能与边界

仅提供八个规范名称：`amp_tool_global_adjust`、`amp_tool_workspace_adjust`、`amp_tool_global_interaction`、`amp_tool_workspace_interaction`、`amp_tool_session_interaction`、`amp_tool_global_scenario`、`amp_tool_workspace_scenario`、`amp_tool_session_scenario`。无新别名。Global 端口可选择经授权的目标 workspace；workspace/session 工具固定宿主绑定身份。注册数据只调整 allowlist 元数据、默认值与关系，不允许更新可执行代码、工具 schema、risk 或权限。interaction/scenario 有 global → workspace → session 继承、reset、expectedVersion CAS、dryRun、已有 session 批量应用；下一轮 runtime 请求采用当前有效值。workspace 默认归属、v4→v5 迁移、授权、SQLite 回滚及搜索 namespace 绑定均落库。

## 已确认问题与修复

1. 协议审计 F1/F2：返回的 schema 可以污染 live/future schema；隐藏 `toJSON` 或 getter 可改写经验证参数。现对公开 descriptor 深拷贝，拒绝不透明对象属性，通过 descriptor 克隆严格 JSON，并捕获 global port 绑定；测试覆盖直接执行器、MCP in-process 和 wire。
2. 持久化审计 CP-01～CP-06：有内容 fork 的外键写入次序、旧 registry 复活 revoked token、不同 session 同名 root 的文件注解别名、dryRun/CAS 拒绝触发认证续期写入、认证回调重入后残留内层提交、session revision 溢出。先持久化 fork 子记录并失败清理；复合 session root 主键与 session 限定的内部文件存储键；registry 重读持久状态及 repo 原子 revision 检查；只读 `verify` 认证回调；认证期重入拒绝；安全整数增量检查。真实 SQLite 回归全部通过。
3. 运行时/宿主审计：search-only stdio 配置曾跳过已绑定的 namespace 归属检查；真实子进程复现退出前仍将 generation 从 1 写到 2。现在无论是否启用 control 都验证已有绑定；冲突配置访问搜索端前退出，generation 不变。审计还验证了显式 override 与继承优先级、模型等待时的下一轮配置生效、registry 删除遮蔽及 workspace/link 隔离。

详细逐模块证据：[协议](boundary-control-protocol-zh.md)、[持久化](boundary-control-persistence-zh.md)、[运行时与宿主](boundary-control-integration-zh.md)，使用说明：[作用域控制文档](../docs/scoped-control.zh-CN.md)。先前搜索/Catalog 模块的审计记录见 [Search/Catalog 联合报告](boundary-joint-zh.md)。

## 目标收尾复核

目标自动续轮重新读取当前实现、模块报告和验收证据，复跑七个独立审计脚本与 `controlIntegrationCheck.ts`，Node 结果 **48/48 通过，0 失败、0 跳过**；其中脚本型 Catalog SQL 防护内部 10/10，作用域持久化内部 15/15。两套 TypeScript noEmit 与 git diff --check 再次退出 0。此次复核未改生产实现，也未重跑真实 Elasticsearch；以下 366/366 和真实单节点 9/9 仍明确属于此前对应阶段。已知架构脚本冲突仍按下文保留，不把它报告为通过。

## 最终验证

- 完整联合边界与回归（控制、Catalog、ES adapter fixture、发布/同步、发现、运行时、session、文件服务与 stdio）：**366/366 通过，0 失败**。这包含独立审计协议 11 项、持久化 15 项、集成 3 项，以及真实 stdio 归属拒绝测试；脚本型审计按 Node 子测试计数为 1，脚本内部另输出计数。
- `tsc --noEmit -p tsconfig.json` 与 `tsc --noEmit -p tsconfig.tools.json` 均通过；`tsc -p tsconfig.build.json` 与 declaration rewrite 均通过；修复一处测试 fixture 行尾空格后 `git diff --check` 退出码 0，最后有针对性 29/29 回归通过。
- 一并执行 `tools/archCheck.ts` 时，联合 366 项通过但该架构门槛单项失败：仓库同时跟踪旧文件 `tools/arch-check.ts` 与 `tools/archCheck.ts`，各自会把另一份脚本计作旧路径引用；仓库另有大量已跟踪连字符命名 `.ts` 文件，和新版命名检查条件冲突。这是独立于本轮控制/搜索功能的既有双版本架构脚本冲突，本轮未对全仓库批量改名，故该门槛仍需另行处理。正式 366/366 结果排除了这一个已知失败的脚本，不能表述为全部门槛通过。

测试中的 SQLite 是真实连接与文件数据库；远端 ES 使用本地 HTTP fixture，**不代表此轮重新运行真实 Elasticsearch 集群**。真实 ES 9.2.0 单节点故障套件 9/9 是之前搜索模块记录，不能累计到本轮 366 项。原始 SQLite/ES 管理权限、trusted host 的任意认证回调和启动配置仍属于宿主可信边界；采用文档示例中的只读 `verify` 回调，才能保证 dryRun 与拒绝的 CAS 请求不因认证续期写库。
