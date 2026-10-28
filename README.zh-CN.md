# Attention Manifest Protocol（AMP）

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.zh-CN.md)

AMP 是供 agent 使用的元认知协议：声明知识和义务，分配有限注意力，获取证据，记录成本与结果。当前参考实现为 `0.4.0`，要求 **Node.js 24 或以上**，使用 Apache-2.0 许可证。

## 架构

| 构件 | 职责 |
| --- | --- |
| Warrant Ledger（凭据账本） | 主张、证据、假设、未知、概念与计划：为什么相信一个结论？ |
| Attention Ledger（注意力账本） | 帧、预算、回执与打断：注意力花在了哪里？ |
| Manifest | 可持久化、可签名的身份、能力、承诺与限制声明 |
| Attention | 选择候选并记录选择理由 |
| Frame | 固化本轮引用、预算和显式排除项 `ignored` |
| Context | 将分配物化为摘要、关系与受限的详情读取 |
| Receipt | 记录实际成本和结果，支持审计与校准 |

```text
Attention 选择 → Frame 固化 → Context 物化 → Receipt 结算 → Ledger
```

Context 使用结构树和类型化关系图。项目依赖、导入、调用与引用属于可含环的描述性关系；`depends` 单独表示先决条件。关系不会自动扩大 Frame。摘要保留来源和修订，原文按内容寻址哈希校验。结构和来源本身不证明事实正确。

## 已实现的能力

- T0–T4 证据等级、置信度限制、修订、可证伪条件、预注册与显式弃权。
- 预算内注意力、排除项、打断、租约、委派以及合并与仲裁。
- 签名清单与凭据、治理工作流、工具门控、带认证的本地/HTTP 通信、审计链和持久化适配器。
- MCP 执行、参数 Schema 校验、摘要固定与旧式握手回退，以及 A2A 发现与消息绑定。
- 项目树、项目依赖图、TS/JS 的部分静态导入/调用/引用图，以及知识库词法检索。
- Markdown、TXT、DOCX、XLSX、PPTX、TeX/LaTeX/BibTeX 的结构提取、原生定位与摘要/详情分层。
- `amp.workspace` v1 服务、7 个 agent 工具、本地运行时接入与 MCP stdio 服务端。

离线解析器位于 `tools/support/`；运行时通过端口接入数据，不依赖数据库，持久化适配器与运行时核心分离。具体契约见 [Schema](docs/schemas/)、[协议示例](docs/examples/) 与 [可执行检查](tools/)。

## 快速开始

```sh
npm ci
npm run build
npm run verify
npm run scenario
```

专项检查为 `npm run workspace-agent-check`、`workspace-context-check`、`document-context-check`、`tex-context-check`、`governance-check`、`typecheck` 与 `typecheck:tools`。`verify` 执行完整验证链和两份类型检查。评测输入/结果以 JSON 保存在 [docs/eval](docs/eval/) 与 [docs/probes](docs/probes/)，夹具与录制探针不等同于独立的人类研究或生产质量证明。

## Agent 工具

`amp.workspace` v1 的响应包含 `protocol`、`version`、`revision`、`ok`，以及 `data` 或 `error`。两种适配器共用输入 Schema；响应外层由[协议类型](src/context/workspaceProtocol.ts)定义。除能力发现外，每个业务工具都必须提供当前 `revision`。

| 工具 | 用途 |
| --- | --- |
| `amp_workspace_capabilities` | 发现获准项目、已登记 Frame、工具及额度 |
| `amp_workspace_tree` | 分页读取项目根或结构子项，保留原生来源定位 |
| `amp_workspace_query` | 使用词法 AND 与有界关系遍历返回候选 ID |
| `amp_workspace_relations` | 分页查询依赖、调用、引用等关系与来源 |
| `amp_workspace_materialize` | 将宿主已登记的 Frame 物化为预算内 Context |
| `amp_workspace_read` | 分页读取显式分配且已物化目标的详情，并验证 CAS 哈希 |
| `amp_workspace_release` | 释放读取句柄，不退款，也不重新开放 Frame |

### MCP stdio 接入

```sh
npm run workspace-agent-demo
npm run workspace-agent -- --config .cache/workspace-agent.local
```

真实 MCP 客户端应直接启动 Node，避免包管理器提示混入协议 stdout。将以下绝对路径替换为实际项目目录：

```json
{
  "mcpServers": {
    "amp-workspace": {
      "command": "node",
      "args": [
        "R:/project/attention-manifest-protocol/tools/workspace-agent-server.ts",
        "--config",
        "R:/project/attention-manifest-protocol/.cache/workspace-agent.local"
      ]
    }
  }
}
```

可信宿主配置包含 `version: 1`、`agentId`、显式 `projectIds`、`WorkspaceSnapshot`、CAS 引用到文本的 `contents` 映射、`frames` 与可选的更低 `limits`。启动时校验内容哈希。演示生成器使用示例输入；真实宿主将获准文件清单交给 [documentScanner.ts](tools/support/documentScanner.ts) 中的 `scanStructuredWorkspace`。

stdio 适配器只在启动时读取配置；新快照或新 Frame 需要宿主更新配置并启动新实例。协议采用逐行 JSON-RPC，单条输入上限 1 MiB、配置上限 64 MiB，通知不会执行工具。支持 `2025-11-25` / `2025-06-18` 的 `initialize`，以及项目已有 `2026-07-28` 的无状态发现和逐请求元数据 profile；其他版本未宣称经过测试。

### 本地运行时接入

```ts
import { WorkspaceAgentService } from "./src/context/index.ts";
import { ToolRegistry, registerWorkspaceTools, WorkspaceToolExecutor } from "./src/module/index.ts";

const workspace = new WorkspaceAgentService({
    agentId: frame.agent,
    projectIds: ["project:packages/app"],
    snapshot,
    store,
});
workspace.registerFrame(frame, snapshot.revision);
const tools = new ToolRegistry();
registerWorkspaceTools(tools, workspace);
const toolExecutor = new WorkspaceToolExecutor(workspace, existingExecutor);
```

Frame、快照、ContentStore 与后备执行器由宿主提供；将 `tools` / `toolExecutor` 传入 `CognitiveRuntime`。登记、撤销和实际 Receipt 结算属于宿主接口，不暴露给模型。

### 范围、生命周期与额度

发现与查询返回元数据和候选，不授予新权限。宿主固定项目范围并登记所选 Frame。只有 active 且实际进入视图的目标可读取 detail；祖先摘要不授予整份文件的原文访问。工作区 ID 属于扩展局部键，不是全局 Ledger 身份；完整 Frame 校验、签名与策略检查仍由宿主负责。

相同参数重复物化复用同一 Context，不重复扣摘要成本，更改参数会被拒绝。释放或撤销后句柄失效，待结算记录保留。宿主通过 `pendingSettlements()` 和 `settle(contextId, receipt)` 对账并获取已归档的 ContextSnapshot。服务为内存状态，审计和重启恢复数据需由宿主持久化。

默认上限：128 个 Frame、32 个活跃读取 Context、8000 个摘要估算 token、每页 8000 个 UTF-16 单元、每个成功响应 131072 个单元、1000 次业务调用。查询深度最多 10，候选/分页最多 100 项；宿主可降低额度。摘要与成功详情页共用 Frame 的剩余估算 token，重复读取计费、释放不退款。发现、JSON 包装和模型后续消费成本不在该估算中，真实用量由 Receipt 记录。

详情偏移以 UTF-16 单元计数，`nextOffset: null` 表示结束；结构化 JSON 详情须合并完整分页后再解析。CAS 在分页前读取和校验完整内容，因此响应上限不代表底层 I/O 上限。运行时保留完整工具 JSON，`maxToolResultChars` 默认 1048576、最低可设为 128；超限返回 `tool_result_too_large`，日志保留 4000 字符预览。

服务错误码：`invalid_arguments`、`unknown_tool`、`revision_mismatch`、`not_available`、`frame_unavailable`、`budget_exhausted`、`capacity_exceeded`、`response_too_large`、`integrity_failure`、`internal_error`。超大响应显式失败，不截断结构化内容。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [src/context](src/context/) | Context 生命周期、树/图投影、CAS、工作区事实与 agent 服务 |
| [src/module](src/module/) | 模型/工具端口、MCP 适配器与执行策略 |
| [src/runtime](src/runtime/) | agent 回合、工具循环与治理接入 |
| [src/governance](src/governance/) | 清单、凭据、预算、工作流、签名与审计 |
| [src/structure](src/structure/) | 映射、树、队列、优先级索引、过滤器、AST 与 LRU |
| [src](src/) | 其他注意力、证据、账本、策略、内核与持久化领域 |
| [tools](tools/) | TypeScript 检查、离线扫描器、演示与探针 |
| [docs/schemas](docs/schemas/) / [docs/examples](docs/examples/) | 机器可读契约与协议示例 |
| [docs/eval](docs/eval/) / [docs/probes](docs/probes/) | 评测输入与 JSON 报告 |

## 代码风格

ESLint 检查语义和风格约束，Prettier 处理排版。命令为 `npm run lint`、`lint:fix`、`format:check`、`format`、`style-check`。配置位于 [eslint.config.mts](eslint.config.mts) 与 [prettier.config.mts](prettier.config.mts)，本地规则和 printer 位于 `tools/`。

变量显式标注类型；使用箭头函数、分号、4 空格缩进、双引号和模板字符串；参数/类型参数保持单行，控制语句使用大括号，采用 `typeof(value)` 和 `=== (void 0)`。局部变量、形参与函数值使用 lowerCamelCase，模块顶层数据使用 PascalCase；注释采用多行 JSDoc，工具指令除外。历史文件仍有 lint/format 迁移债务，功能验证通过不代表全仓风格检查通过。

## 边界与研究依据

静态依赖抽取不完整，缺失边不证明独立；Markdown/TeX 扫描器不实现全部宏或语义。摘要、关系图与长上下文应通过多跳、跨文档和变化信息任务评测。一手资料包括 [LaRA](https://proceedings.mlr.press/v267/li25dv.html)、[GraphRAG-Bench](https://arxiv.org/abs/2506.05690)、[Tree-sitter](https://tree-sitter.github.io/tree-sitter/) 与 [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920.html)，这些资料不直接证明 AMP 自身的有效性。

沙箱隔离、多租户、交互式 OAuth、生产部署与真实外部 agent 互通仍未完成。人类研究属于设计启发，不能推导模型具有相同机制或容量常数。来源证明完整性，不证明事实为真或拥有行动权限。

## 许可证与历史

[Apache License 2.0](LICENSE)，版权所有者为 Eloy Kim，2026。再分发时保留 [NOTICE](NOTICE)、许可证与署名声明。历史见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) 与 [CHANGELOG.md](CHANGELOG.md)。
