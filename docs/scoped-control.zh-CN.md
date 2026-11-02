# 作用域注册调整与交互配置

八个工具仅使用以下规范名称，不提供省略 `tool` 的别名：

| 工具 | 作用域 |
| --- | --- |
| `amp_tool_global_adjust` | 全局注册数据，或显式授权的 workspace 目标 |
| `amp_tool_workspace_adjust` | 当前宿主绑定的 workspace |
| `amp_tool_global_interaction` / `amp_tool_global_scenario` | 全局默认配置，或显式授权的 workspace 目标 |
| `amp_tool_workspace_interaction` / `amp_tool_workspace_scenario` | 当前 workspace 的默认配置与现有 session |
| `amp_tool_session_interaction` / `amp_tool_session_scenario` | 当前宿主绑定的 session |

## 身份与持久化

宿主使用 `database.controlService.bind(identity)` 绑定端口，并注入 `WorkspaceAgentService`、`GlobalAgentService` 或 `SessionControlService` 的 `control` 选项。`identity` 的 `workspaceId`、`sessionId`、`allowGlobal`、授权 workspace 集合与认证回调来自宿主。工具参数不能指定 session 身份；仅 global 工具接受目标 `workspaceId`，端口会再次验证授权。缺少端口返回 `control_unavailable`。

```ts
import { Database } from "attention-manifest-protocol/database";
import { SessionRegistry } from "attention-manifest-protocol/session";
import { SessionControlService } from "attention-manifest-protocol/control";
import { registerSessionControlTools } from "attention-manifest-protocol/module";

const database = new Database("state.sqlite");
const identities = new SessionRegistry({ store: database.workspaceSessions });
// roots 由宿主审核；下面示例中的 roots 由应用传入。
const opened = identities.open({ agentId: "agent.example", roots });
const control = database.controlService.bind({
    workspaceId: opened.descriptor.workspaceId!,
    sessionId: opened.descriptor.id,
    authenticate: () => {
        identities.verify(opened.credential.sessionId, opened.credential.token);
    },
});
const sessionControl = new SessionControlService({ control });
registerSessionControlTools(toolRegistry, sessionControl);
```

Session 执行器为 `SessionControlToolExecutor`。Workspace 和 Global 使用已有的注册函数与执行器，新增工具会随其 descriptors 注册。所有新增工具的静态风险为 `write`，包括同名工具的读取 action；宿主审批与工具策略继续生效。意外异常只返回 `internal_error`，不会回传后端错误内容。

`workspaces` 保存显式 workspace；默认 workspace 是普通 workspace，与 global scope 分开。宿主可使用 `createWorkspace(id, name)`、`defaultWorkspace()`、`setDefaultWorkspace(id, expectedVersion?)` 管理工作区。默认切换只影响之后省略 workspaceId 的新 session；既有 session 和 fork 保留原绑定。v4 数据库通过增量迁移升级到 v5，保留 scheduler 和证据 hash chain，未知未来版本拒绝打开。SQLite 连接是可信宿主边界，不应暴露任意 SQL 给 agent。

## 注册项调整

`registry` 为 `modules`、`skills`、`knowledge`、`protocols`、`environments`、`concepts` 之一。`value` 是 JSON 元数据，不允许修改可执行函数、工具 schema、风险或授权策略。

| action | 必填字段（除 action、registry） |
| --- | --- |
| `list` | 无 |
| `get` / `remove` | `id` |
| `register` / `update` | `id`, `value`（对象） |
| `default_get` / `default_reset` | `key` |
| `default_set` | `key`, `value`（JSON） |
| `link` / `unlink` | `id`, `targetId`, `relation` |

变更 action 支持 `expectedVersion` 和 `dryRun`。首次本地写入的 CAS 版本为 0；继承项的 `get` 返回本地 `version`、来源和 `effectiveVersion`。Workspace 对全局项的 update/remove 创建本地覆盖或删除遮蔽。默认值 reset 恢复继承；条目 remove 保留版本和删除标记。Link 的目标属于同 registry，版本随源条目递增。

```json
{"action":"register","registry":"modules","id":"module.search","value":{"name":"Search","description":"Metadata search"},"expectedVersion":0}
```

```json
{"action":"update","registry":"modules","id":"module.search","value":{"name":"Search v2"},"expectedVersion":1,"dryRun":true}
```

宿主通过 `listRegistry(workspaceId, registry)` 读取有效注册目录，或 `applyControlRegistry(...)` 将覆盖和删除标记应用到搜索目录。此投影固定 record kind 和宿主 scope，不会创建可执行工具。一般嵌入式宿主应在调整后重建快照并同步搜索；stdio host 配置 control 与 search 时已接好更新链路。

## 交互模式与情景

两个域都支持 `get`、`set`、`reset`。set 提供一个模式选择器，或一个权重 `mix`，二者互斥。

- interaction 的 `mode`：`affect`、`think`、`inspire`、`converge`、`orchestrate`。
- scenario 的 `scenario`：`chat`、`writing`、`office`、`collaboration`、`investigation`、`research`、`engineering`、`iteration`。
- mix 只接受该域的合法 key，权重必须为有限非负数，至少一项正数；服务调用已有 resolver 归一化。

```json
{"action":"set","mode":"think","expectedVersion":0}
```

```json
{"action":"set","mix":{"engineering":0.7,"research":0.3},"applyTo":"all","dryRun":true}
```

有效配置按 global → workspace → session 继承，更具体的配置优先；reset 清除本地选择并恢复继承。get 返回 `mix`/`effectiveMix`、`source`、本地 `version`、`effectiveVersion` 与解析计划；没有配置时 mix 为 null。

Global/workspace 变更支持 `applyTo`：`defaults` 修改该 scope 的配置（默认）；`existing` 写入当前授权范围内有效 session 的本地配置；`all` 同时修改默认和现有 session。批量操作在一个事务内完成，失败时全部回滚。Session 工具不接受 `applyTo`。授权集合只覆盖部分 workspace 的 global 端口，必须指定获准的目标 workspace，不能通过全局继承扩大影响。

`CognitiveRuntime` 的 `control` 选项接收同一个已认证 session 端口，每轮开始读取有效配置。显式 turn override 优先，其后依次采用作用域配置、runtime 显式默认、runtime session 默认、自动推断。工具在本轮改变配置后，从下一轮生效。凭据或 session 生命周期失效时，在调用模型前拒绝执行。

## stdio host

本地 bootstrap 可配置 `control: { databasePath: "state.sqlite", workspaceId?: "workspace-id" }`。省略 workspaceId 时绑定数据库的默认 workspace。若同时配置 search，两者使用同一数据库；搜索 namespace 持久绑定到该 workspace，不能被另一个 workspace 接管；仅配置 search 而未绑定 control 身份的宿主，也不能复用已绑定的 namespace。配置属于宿主启动输入，不能通过 tools/call 更改。

Control 工具的 workspace/global `revision` 可选，提供时执行既有快照版本检查；其他 workspace 工具仍遵循原 revision 契约。Session 工具独立于项目快照，不接受 revision。需要版本竞争保护时，变更请求应提供 `expectedVersion`。
