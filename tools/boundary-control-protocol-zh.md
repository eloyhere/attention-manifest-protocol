# 第 1 模块：八个 control 工具协议边界审计

审计对象：`src/protocol/{control,workspace,global}.ts`、`src/context/workspaceService.ts`、`src/global/service.ts`、`src/control/sessionService.ts`、三个 direct executor、`src/naming/ids.ts`，并追踪共同参数边界 `src/boundary/toolCall.ts` 与 `src/semantic/jsonValue.ts`。仅使用 stub `ControlPort`，未导入或修改仍由其他实现者收尾的 `src/control/service.ts`。本轮仅新增此报告与 `tools/auditControlProtocolCheck.ts`；没有修改任何 `src` 文件。

## 结果与最小证据

1. **F1 已修：公开 control descriptor 共享可变的嵌套 schema。** 初始版本在 `src/protocol/control.ts` 使用模块级 `Version` 等对象；先创建 `SessionControlService`，再执行 `controlToolDefinitions("session")[0].inputSchema.oneOf[1].properties.expectedVersion.minimum = -10`，原本 `invalid_arguments` 的 `{action:"set",mode:"think",expectedVersion:-1}` 被现存 session 与新建 workspace/global 服务接受。主线程现已在 `controlInputSchema` 返回时深拷贝；复核同一污染步骤后，三个 scope 均返回 `invalid_arguments`，stub 调用数保持不变。直接服务 `tools()` 与 registry 返回的定义也互不污染。该污染要求同进程调用公开工厂并修改返回对象，不能由普通 JSON 调用参数直接完成。

2. **F2 已修：不可枚举 `toJSON` 绕过 schema 校验。** 初始版本 `jsonValueProblem` 只遍历 `Object.keys`，`cloneJson` 随后通过 `JSON.stringify` 调用不可枚举 `toJSON`；`Object.defineProperty({action:"get"},"toJSON",{value(){return {action:"set",mode:"think",scope:"global",sessionId:"forged",workspaceId:"forged"}}})` 被三种服务接受，stub 看见 schema 明确禁止的字段。调用 scope 参数本身仍由宿主固定，**本证据证明协议参数校验绕过，不等于已验证实际持久化权限提升**。主线程已改为检查不可枚举自有键并改用 descriptor 克隆；复核三个 scope 均 `invalid_arguments`，`toJSON` 调用数 0、stub 未调用。direct session executor 的不可枚举 `toJSON` getter 调用数为 0；进程内 MCP `tools/call` 与模拟 JSON wire 均拒绝；模拟 wire 在传输前正常触发一次调用方 `JSON.stringify`（这是 wire 生成行为），但 MCP 服务拒绝变造字段。

3. **D2 已加固：global wrapper 捕获的 control port。** 初始版本 `src/global/service.ts` 的 wrapper 每次读取构造参数 `options.control`，因此宿主在构造后替换 `options.control` 可以重绑定 port；始终发送固定 `scope="global"`。主线程改为构造时捕获 control；复核 `rebound=0`、原始 port 被调用 1 次且收到 `global`。

4. **设计边界 D1：仅宿主能够提供第二构造参数中的 schema override。** `new WorkspaceAgentService(options, controlToolDefinitions("global"))` 可让 workspace 控制工具 schema 接收 `workspaceId`，port 收到的固定 scope 仍是 `workspace`。这依赖调用者能直接构造服务及安装 host-only schema；普通工具参数无法改变定义。宿主不得把这个构造能力暴露给不可信调用者。global 正常服务构造将 global schema 传入 workspace adapter，并用宿主 wrapper 固定 `global` scope；授权目标 `workspaceId` 的最终许可由 port 裁定，测试中 `allowed` 成功、`other` 获 `permission_denied`。

## 覆盖的协议与 adapter 断言

- 八个 canonical ID 恰为 workspace adjust/interaction/scenario、global adjust/interaction/scenario、session interaction/scenario；三组注册进一个 direct registry，组合 executor 全部按正确 scope 调用 stub，`ToolAliases` 未映射八个名字，伪 alias/拼写变体返回 `unknown_tool`。
- action 分支、必填参数、互斥 set mode/mix、枚举、非负安全整数 expectedVersion、adjust 值类型与 mutation 参数校验；unknown key、数组顶层、getter、symbol、日期/Map/Set/函数/BigInt/循环/稀疏数组等非 JSON 值在 port 前拒绝。
- workspace/session 普通参数不能指定 identity/scope/workspaceId；global schema 允许授权目标 `workspaceId`，不能指定 sessionId/allowGlobal/authenticate 等。全八工具缺 port 返回 `control_unavailable`；宿主 `ControlError` 稳定映射；意外异常的敏感字符串只返回 `internal_error`；revision、请求数及回复字符数限制生效。
- workspace MCP `tools/list` schema 与本地 descriptor 相同，写风险注解正确；同步及异步 `tools/call` 对伪造字段返回 `invalid_arguments`，通知消息不执行工具。

## 验证命令与结果

- `R:\nodejs\node.exe --test tools/auditControlProtocolCheck.ts`：**11/11 通过**（F1/F2/D2 已转换成修复后回归拒绝断言）。
- `R:\nodejs\node.exe --test tools/controlProtocolCheck.ts`：**7/7 通过**。
- `R:\nodejs\node.exe --test tools/workspaceAgentCheck.ts`：**23/23 通过**。
- `R:\nodejs\node.exe --test tools/namingCheck.ts`：脚本内部 **26/26 通过**，Node 子测试 1/1。
- `R:\nodejs\node.exe node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2023 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --types node tools/auditControlProtocolCheck.ts`：退出码 **0**。使用 TypeScript 6 单文件编译需加 `--ignoreConfig`；首次未加该参数出现 TS5112 配置报错，补参数后成功。此处只覆盖审计脚本类型检查，完整项目 tsc 由主线程执行。

本报告未覆盖底层 `src/control/service.ts` 的持久化/凭据权限模型、其他模块对 `cloneJson` 的影响、真实远程 MCP 传输与真实授权数据库。审计完成后停止本模块所有文件修改。
