# Attention Manifest Protocol（AMP）

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.zh-CN.md)

AMP 是供 agent 使用的元认知协议：声明知识和义务，分配有限注意力，获取证据，记录成本与结果。当前参考实现为 `0.4.2`，要求 **Node.js 24 或以上**，使用 Apache-2.0 许可证。

## 架构

| 构件 | 职责 |
| --- | --- |
| Warrant Ledger（凭据账本） | 主张、证据、假设、未知、概念与计划：为什么相信一个结论？ |
| Attention Ledger（注意力账本） | 帧、预算、回执与打断：注意力花在了哪里？ |
| Manifest | 可持久化、可签名的身份、能力、承诺与限制声明 |
| Assignment | 把职责、权限、预算与交互契约绑定到 agent |
| Attention | 选择候选并记录选择理由 |
| Frame | 固化本轮引用、预算和显式排除项 `ignored` |
| Context | 将分配物化为摘要、关系与受限的详情读取 |
| Session | 无状态 bearer 令牌绑定的身份、根目录、权限、TTL 与上下文隔离 |
| Filesystem | File/Directory 树、分页读写、大纲、导入/导出/依赖图与 Office 解析 |
| Hook | 面向 agent 的组合 hooks：`useRead`/`useWrite`/`useDiff`/`useParse`/`useOutline` 等，只读 hook 不产生编辑 |
| Receipt | 记录实际成本和结果，支持审计与校准 |
| Compaction（压缩与剪枝） | 按明确理由剪掉冷数据或已失效对象，再用检查点替换已验证的前缀 |
| Fingerprint（指纹） | 定义摘要覆盖哪些内容；算法与规范化策略随摘要一起携带 |
| Naming（命名） | 协议、服务与工具身份的统一文法，带解析器与 catalog 摘要 |

```text
Attention 选择 → Frame 固化 → Context 物化 → Receipt 结算 → Ledger
```

Context 使用结构树和类型化关系图。项目依赖、导入、调用与引用属于可含环的描述性关系；`depends` 单独表示先决条件。关系不会自动扩大 Frame。摘要保留来源和修订，原文按内容寻址哈希校验。结构和来源本身不证明事实正确。

## 已实现的能力

- T0–T4 证据等级、置信度限制、修订、可证伪条件、预注册与显式弃权。
- 预算内注意力、排除项、打断、租约、委派以及合并与仲裁。
- 职责与交互分配：带 RACI、权限/预算/窗口衰减、接受、证据验收与级联撤销的职责绑定；带协议角色、模式混合、节奏、升级与交接的交互契约。
- 签名清单与凭据、治理工作流、工具门控、带认证的本地/HTTP 通信、审计链和持久化适配器。
- MCP 执行、参数 Schema 校验、摘要固定与旧式握手回退，以及 A2A 发现与消息绑定。
- 项目树、项目依赖图、TS/JS 的部分静态导入/调用/引用图，以及知识库词法检索。
- Agent 工作区：`File`/`Directory` 树（指纹、字符集、bigint 行数/字节数、时间、描述/摘要/用途）；分页读、CAS 原子写、按策略提取的大纲（代码/项目/文章/Office）；import/export/dependency 图（Tarjan SCC、拓扑序、有界闭包）；Session 身份与上下文隔离；`src/hook` 组合层；SQLite 实体与仓储。
- 宿主发现：以一棵结构树返回获准项目、内部模块（service/tool/controller/route/repository/model/config/test/...）、文件名、有界内容匹配，以及宿主注册的插件、服务与工具。项目节点带描述、用途与简介。
- Markdown、TXT、DOCX、XLSX、PPTX、TeX/LaTeX/BibTeX 的结构提取、原生定位与摘要/详情分层。
- `amp_protocol_workspace` v1 服务、8 个 agent 工具、本地运行时接入与 MCP stdio 服务端。
- 带显式策略的指纹：值使用 RFC 8785 规范化 JSON，文件按字节哈希，目录树使用域分隔的 Merkle 根，`verify` 比较算法、`kind` 与策略，而不是只比对裸十六进制字符串。未配对代理项与 `-0` 被拒绝，而不是被静默改写。
- 协议、服务与工具身份（`amp_protocol_*` / `amp_service_*` / `amp_tool_*`）共用一张命名表，带文法、解析器与签名的 catalog 摘要，使分派、固定与审计共用同一套拼写。
- 两层压缩与剪枝。`planPrune()` 为每次丢弃给出理由和回看条件；`compactLedger()` 用检查点替换已验证的冷前缀，`verifyCompaction()` 重新推导该承诺，且不会埋掉保留尾部仍然引用的条目。`pruneConcept()` 与 `compactConceptHistory()` 对概念内容和版本历史执行同样的约束。

离线解析器位于 `tools/support/`；运行时通过端口接入数据，不依赖数据库，持久化适配器与运行时核心分离。具体契约见 [Schema](docs/schemas/)、[协议示例](docs/examples/) 与 [可执行检查](tools/)。

### 职责与交互

`responsibility-assignment` 把职责、RACI、权限、预算、窗口与证据绑定到 assignee；`interaction-binding` 固定一次会话的参与方、协议角色、模式混合、节奏、升级与交接状态。两者分别由 `assignment-check` 与 `interaction-binding-check` 检查，契约位于 [docs/schemas](docs/schemas/)。`AssignmentLedger` 的 `onRevoke` 钩子可调用 `BindingLedger.revokeForAssignment()`，把职责撤销级联到交互绑定。

### 发现

`amp_tool_workspace_discover` 以一棵结构树返回获准项目。文件节点带模块分类（`service`、`tool`、`controller`、`route`、`repository`、`model`、`config`、`test`、`middleware`、`component`、`util`）、扩展名与有界内容匹配。宿主通过 `HostCatalog` 登记项目的描述、用途、简介，以及插件、服务和工具；项目元数据附在项目节点上，未登记的项目回退到 workspace 摘要。发现是只读的，不会扩大 `projectIds`；内容匹配只是发现证据，不能替代 Frame 分配后的详情读取。

## 快速开始

```sh
npm ci
npm run build
npm run verify
npm run scenario
```

## 作为库使用

`npm install attention-manifest-protocol` 会安装 `lib/` 中的编译产物及其声明文件，同时附带源码、JSON Schema 与可执行检查。运行时要求 Node.js 24 及以上。包根入口提供文档中的协议核心接口，其余模块均可按子路径导入。

```js
import { generateSigningKey, signManifest, verifyManifest } from "attention-manifest-protocol";
import { Ledger } from "attention-manifest-protocol/ledger";
import { sha256Hex } from "attention-manifest-protocol/semantic/sha256.js";
import { fingerprintText, fingerprintTree, verify } from "attention-manifest-protocol/fingerprint";
import { ToolIds, parseId } from "attention-manifest-protocol/naming";
```

| 说明符 | 解析结果 |
| --- | --- |
| `attention-manifest-protocol` | `lib/index.js`：attention、assignment、context、discover、frame、ledger、manifest、receipt、warrant |
| `attention-manifest-protocol/<module>` | `src/` 下每个模块对应 `lib/<module>/index.js` |
| `attention-manifest-protocol/<module>/<file>.js` | 单个编译后的模块 |
| `attention-manifest-protocol/schemas/<name>.json` | `docs/schemas/` 中的 JSON Schema |

`npm run build:lib` 重新构建 `lib/`，发布前由 `prepublishOnly` 自动执行。该构建只编译库代码，Vite 演示入口（`src/main.ts`）不在其中。

专项检查为 `npm run workspace-agent-check`、`workspace-project-check`、`workspace-diff-check`、`workspace-reactive-diff-check` 与 `workspace-*-boundary-check` 系列、`workspace-context-check`、`document-context-check`、`tex-context-check`、`governance-check`、`assignment-check`、`interaction-binding-check`、`discover-check`、`discover-agent-check`、`typecheck` 与 `typecheck:tools`。`verify` 执行完整验证链和两份类型检查。评测输入/结果以 JSON 保存在 [docs/eval](docs/eval/) 与 [docs/probes](docs/probes/)，夹具与录制探针不等同于独立的人类研究或生产质量证明。

## Agent 工具

`amp_protocol_workspace` v1 的响应包含 `protocol`、`version`、`revision`、`ok`，以及 `data` 或 `error`。两种适配器共用输入 Schema；响应外层由[协议类型](src/protocol/workspace.ts)定义。除能力发现外，每个业务工具都必须提供当前 `revision`。工具名来自 [`src/naming/`](src/naming/) 中冻结的命名表；0.5 之前的 `amp_workspace_*` 拼写仍作为输入别名接受，并出现在能力响应的 `deprecatedAliases` 之下。每个 workspace 工具还以 `amp_tool_global_<leaf>` 镜像到宿主全部授权项目。

| 工具 | 用途 |
| --- | --- |
| `amp_tool_workspace_capabilities` | 发现获准项目、已登记 Frame、工具及额度 |
| `amp_tool_workspace_tree` | 分页读取项目根或结构子项，保留原生来源定位 |
| `amp_tool_workspace_query` | 使用词法 AND 与有界关系遍历返回候选 ID |
| `amp_tool_workspace_relations` | 分页查询依赖、调用、引用等关系与来源 |
| `amp_tool_workspace_discover` | 以一棵结构树返回获准项目、模块、文件名、有界内容匹配与宿主组件 |
| `amp_tool_workspace_materialize` | 将宿主已登记的 Frame 物化为预算内 Context |
| `amp_tool_workspace_read` | 按字符偏移、1-based 行或 UTF-8 字节分页读取 CAS 校验的详情；附带 `importation`/`exportation`，即该文件导入的相对文件与被哪些相对文件导入 |
| `amp_tool_workspace_write` | 按整个节点、行范围或 UTF-8 字节范围替换项目内容；宿主授权、CAS 与 dry-run；返回同样的 `importation`/`exportation` |
| `amp_tool_workspace_project` | 依据 manifest/lockfile 判定项目 brand，并交给宿主执行一条 `build`/`compile`/`run`/`test` 命令 |
| `amp_tool_workspace_outline` | 级联大纲：项目 → 目录 → 文件 → symbol/knowledge，带 1-based 范围与有界深度 |
| `amp_tool_workspace_dependency` | 项目级依赖与被依赖，附声明来源与提取方式 |
| `amp_tool_workspace_reactive_read` | 以 Proxy 返回树结构，属性递归懒加载并缓存 |
| `amp_tool_workspace_reactive_write` | 修改节点属性（`summary`/`label`/`tags`）并刷新受影响的缓存；`content` 走受控写入路径 |
| `amp_tool_workspace_diff_read` | 可比较的项目树，携带内容修订号与字节/行统计 |
| `amp_tool_workspace_diff_write` | 全文件、1-based 行拼接或 UTF-8 字节拼接写入，并返回行级 diff 与 hunks |
| `amp_tool_workspace_release` | 释放读取句柄，不退款，也不重新开放 Frame |

`read` 与 `write` 都要求目标已被显式分配并物化；祖先节点与发现片段不构成授权。`importation` 列出目标文件导入的相对文件（裸包名进入 `external`，其 `externalTotal`/`externalTruncated` 让 `maxFileLinks` 截断可见），`exportation` 列出导入它的相对文件，因此一次编辑不必再查一次关系。写入某个文件后，从其快照抽取的 symbol/knowledge 页会返回 `stale_detail`，直到宿主刷新快照，避免用旧字节配新修订号。`write` 自身不触碰文件系统：宿主在 `WorkspaceServiceOptions.writer` 提供写端口；未提供时会话以 `write_unavailable` 失败，而 `dryRun` 仍可预演编辑。

`project` 的判定是离线的（只看 manifest/lockfile 文件名）；执行动作只会把 brand 表中的一条命令交给 `WorkspaceServiceOptions.runner`，agent 无法自带命令文本。`reactive_read`/`reactive_write` 增加每服务的注解覆盖层与子节点索引缓存：写入会递增 `cacheVersion` 并报告所有失效的祖先。`diff_read` 暴露每个文件的内容修订号，两个快照无需正文即可比较；`diff_write` 支持全文件、行、字节三种拼接并返回 hunks，复用写端口、CAS 与 dry-run。

### 文件系统工具

`amp_tool_filesystem_*` 绑定一个已认证 Session；令牌不出现在工具参数里。除 `write` 外全部只读。

| 工具 | 用途 |
| --- | --- |
| `amp_tool_filesystem_session` | 当前身份、根、权限、剩余 TTL 与配额 |
| `amp_tool_filesystem_file` | 返回一个 File/Directory 节点；`depth`/`offset`/`limit` 控制子树与分页 |
| `amp_tool_filesystem_directory` | 平铺列出一级子节点 |
| `amp_tool_filesystem_read` | 按 1-based 行号读取文本页；返回指纹、字符集与下一页行号 |
| `amp_tool_filesystem_write` | 原子写入；create/overwrite/upsert/append、CAS、dry-run |
| `amp_tool_filesystem_outline` | 结构化大纲；支持 `query`/`startLine`/`endLine` 过滤 |
| `amp_tool_filesystem_import` | 出边/入边/两向导入关系 |
| `amp_tool_filesystem_export` | 导出符号、签名与 re-export 边 |
| `amp_tool_filesystem_dependency` | 环、拓扑序、依赖/被依赖闭包 |
| `amp_tool_filesystem_ast` | 无损语法树：每个非空白 token、声明/块/标签层级、UTF-8 字节与行范围；只读，不执行 |

全局变体为 `amp_tool_globalfs_*`，由 [src/global/filesystem.ts](src/global/filesystem.ts) 做命名适配；它不扩大任何根或权限。
大纲节点带 `isFile`/`isDirectory`/`file?`/`directory?`/`path`（如 `add.py#add`）与 `range`（UTF-8 字节 + 1-based 行，bigint；JSON 中为十进制字符串）。策略覆盖代码、Vue、项目清单、Markdown/TeX/纯文本、CSS/SCSS/Sass、HTML、XML/OPML 与 Office；Office 文件由 `office.ts` 解析 DOCX/XLSX/PPTX，DOC/XLS/PPT/PUB/ACCDB 为 CFB best-effort。

### Hooks

`src/hook` 把同一组只读能力包装成带状态与订阅的组合函数；只有 `useWrite` 会落盘：

```ts
import { useRead, useWrite, useDiff } from "attention-manifest-protocol/hook";

const read = useRead(session);
await read.run({ path: "src/main.ts", maxLines: 80, includeLineNumbers: true });
const write = useWrite(session);
await write.run({ path: "src/new.ts", content: "export const value = 1;\n", mode: "create" });
const diff = useDiff(session);
await diff.run({ path: "src/new.ts", before: "" });
```

`useParse` 在各模块中返回该模块的解析结果（`useOutlineParse`、`useImportationParse`、`useExportationParse`、`useDependencyParse`、`useCodeParse`、`useProjectParse`、`useAstParse`）；`useCode`/`useProject` 是组合模型，`useAst` 返回无损只读语法树。缓存命中前会校验 session revision；hook 运行可写入 `hook_runs`。

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
        "R:/project/attention-manifest-protocol/tools/workspaceAgentServer.ts",
        "--config",
        "R:/project/attention-manifest-protocol/.cache/workspace-agent.local"
      ]
    }
  }
}
```

可信宿主配置包含 `version: 1`、`agentId`、显式 `projectIds`、`WorkspaceSnapshot`、CAS 引用到文本的 `contents` 映射、`frames`、可选的更低 `limits`，以及可选的 `discovery.projects` / `discovery.components` 项目描述与组件登记。启动时校验内容哈希。演示生成器使用示例输入；真实宿主将获准文件清单交给 [documentScanner.ts](tools/support/documentScanner.ts) 中的 `scanStructuredWorkspace`。

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
| [src/semantic](src/semantic/) | 无策略的基础原语：严格 SHA-256、规范化 JSON 与 I-JSON 谓词 |
| [src/fingerprint](src/fingerprint/) | 算法、预映像封装、策略、引用、校验、文件与 Merkle 树 |
| [src/naming](src/naming/) | 冻结的 ID 表、ID 文法、兼容别名与 catalog 摘要 |
| [src/context](src/context/) | Context 生命周期、树/图投影、CAS、工作区事实、上下文装配与 agent 服务 |
| [src/session](src/session/) | 身份、令牌、TTL、上下文隔离、fork/revoke/rotate |
| [src/file](src/file/) | File/Directory 树、元数据、分页读、原子写、会话运行时/服务、模块图与 ZIP/CFB 容器 |
| [src/syntax](src/syntax/) | 字符集检测/编解码、字节/行索引、语法注册表与无损只读语法树 |
| [src/outline](src/outline/) | 代码/文档大纲、范围与标签索引、关键字/策略注册表、React/Shell/SQL/Visual Basic 策略与 Office 解析 |
| [src/hook](src/hook/) | 面向 agent 的组合 hooks 与运行记录 |
| [src/protocol](src/protocol/) | 线上契约：信封、A2A、通道与 `amp_protocol_workspace` 接口 |
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

变量显式标注类型；使用箭头函数、分号、4 空格缩进、双引号和模板字符串；参数/类型参数保持单行，控制语句使用大括号，采用 `typeof(value)` 和 `=== (void 0)`。局部变量、形参与函数值使用 lowerCamelCase，模块顶层数据使用 PascalCase；源码文件名使用小写字母开头的 lowerCamelCase（如 `workspaceService.ts`、`fileGraph.ts`），不使用短横线；SQL 标识符沿用既有 snake_case。注释采用多行 JSDoc，工具指令除外。历史文件仍有 lint/format 迁移债务，功能验证通过不代表全仓风格检查通过。

## 边界与研究依据

静态依赖抽取不完整，缺失边不证明独立；Markdown/TeX 扫描器不实现全部宏或语义。摘要、关系图与长上下文应通过多跳、跨文档和变化信息任务评测。一手资料包括 [LaRA](https://proceedings.mlr.press/v267/li25dv.html)、[GraphRAG-Bench](https://arxiv.org/abs/2506.05690)、[Tree-sitter](https://tree-sitter.github.io/tree-sitter/) 与 [RFC 6920](https://www.rfc-editor.org/rfc/rfc6920.html)，这些资料不直接证明 AMP 自身的有效性。

沙箱隔离、多租户、交互式 OAuth、生产部署与真实外部 agent 互通仍未完成。人类研究属于设计启发，不能推导模型具有相同机制或容量常数。来源证明完整性，不证明事实为真或拥有行动权限。

## 许可证与历史

[Apache License 2.0](LICENSE)，版权所有者为 Eloy Kim，2026。再分发时保留 [NOTICE](NOTICE)、许可证与署名声明。历史见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) 与 [CHANGELOG.md](CHANGELOG.md)。
