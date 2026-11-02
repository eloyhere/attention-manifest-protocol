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
- 宿主发现：以一棵结构树返回获准项目、内部模块（service/tool/controller/route/repository/model/config/test/...）、文件名、有界内容匹配，以及宿主注册的插件、服务、工具、skills 和 knowledge。项目节点带描述、用途与简介；skill/knowledge 节点只暴露元数据，详情由注册中心按 ID 查询。
- Markdown、TXT、DOCX、XLSX、PPTX、TeX/LaTeX/BibTeX 的结构提取、原生定位与摘要/详情分层。
- `amp_protocol_workspace` v1 服务、8 个 agent 工具、本地运行时接入与 MCP stdio 服务端。
- 带显式策略的指纹：值使用 RFC 8785 规范化 JSON，文件按字节哈希，目录树使用域分隔的 Merkle 根，`verify` 比较算法、`kind` 与策略，而不是只比对裸十六进制字符串。未配对代理项与 `-0` 被拒绝，而不是被静默改写。
- 协议、服务与工具身份（`amp_protocol_*` / `amp_service_*` / `amp_tool_*`）共用一张命名表，带文法、解析器与签名的 catalog 摘要，使分派、固定与审计共用同一套拼写。
- 两层压缩与剪枝。`planPrune()` 为每次丢弃给出理由和回看条件；`compactLedger()` 用检查点替换已验证的冷前缀，`verifyCompaction()` 重新推导该承诺，且不会埋掉保留尾部仍然引用的条目。`pruneConcept()` 与 `compactConceptHistory()` 对概念内容和版本历史执行同样的约束。

离线解析器位于 `tools/support/`；运行时通过端口接入数据，不依赖数据库，持久化适配器与运行时核心分离。具体契约见 [Schema](docs/schemas/)、[协议示例](docs/examples/) 与 [可执行检查](tools/)。

### 职责与交互

`responsibility-assignment` 把职责、RACI、权限、预算、窗口与证据绑定到 assignee；`interaction-binding` 固定一次会话的参与方、协议角色、模式混合、节奏、升级与交接状态。两者分别由 `assignment-check` 与 `interaction-binding-check` 检查，契约位于 [docs/schemas](docs/schemas/)。`AssignmentLedger` 的 `onRevoke` 钩子可调用 `BindingLedger.revokeForAssignment()`，把职责撤销级联到交互绑定。

### 发现

`amp_tool_workspace_discover` 和 global 对应工具通过 Elasticsearch 检索统一目录。传入 `queries`（一个字符串或最多八个字符串），每个命中条目作为根节点返回一棵结构树，因此一个查询也可以返回多棵树。响应为 `{ trees: [{ query, tree, total, totalRelation, took, timedOut, truncated }] }`；没有命中时 `trees` 为空。`tree` 包含元数据及由 SQLite 实体关系展开的 `children`，不返回 skill 指令或 knowledge 正文。`limit` 限制每个查询的命中数量，`maxDepth` 和 `nodeLimit` 分别限制每棵树的深度和节点数。可用 `kinds`、`tags` 筛选元数据。宿主通过 `HostCatalog`、`SkillRegistry`、`KnowledgeRegistry`、`ProtocolRegistry` 登记条目，再统一投影为 `CatalogRecord`；其他模块通过同一记录格式及关系接入。

目录沿 `entity → cache → service → repository → SQL → SQLite` 持久化。Elasticsearch 保存可重建的搜索投影，SQLite 保存完整条目、关系和同步 generation。宿主必须在快照变更后显式同步；失败或并发修改会保留未同步状态，discover 拒绝使用过期索引。查询命中及全部关联节点都按服务的 `projectIds` 和工作区 revision 再次检查，全局条目由 `includeGlobal` 控制。元数据发现不会授予详情读取或执行权限；原本的 `buildDiscoveryTree` 仍可作为本地结构构建 API 使用。

这些 registry 是各自领域的宿主目录，不要求每个概念都复制成同构 registry。Ability、cognition、progress 等若已有运行时状态、策略或事件模型，应由现有领域模块维护；需要统一枚举时增加只读 catalog/discovery 投影即可。Agent 默认只读正式目录；可选的登记工作流应先创建带来源、版本和提案状态的候选项，再经宿主权限校验、人工审核与审计后发布，不授予模型直接改写已生效条目的能力。

每个可变的注册中心对宿主都是可读写的：`SkillRegistry`、`KnowledgeRegistry`、`ProtocolRegistry`、`ToolRegistry`、`OutlineRegistry`、`OutlineKeywordRegistry`、`SyntaxRegistry`（语言、token 类别与节点类别）、`SqlDialectRegistry`、`CalibrationRegistry`、`BehaviorRegistry` 与 `EntityRegistry` 都在 `register` 和读取接口之外提供 `update`/`remove`（列表型容器另有 `clear`）。更新保留原登记位置并执行与注册相同的校验，宿主可以原地修改或删除条目，而不必再建一份与前者不一致的注册中心；`SyntaxRegistry.updateLanguage`/`removeLanguage` 会释放并允许复用扩展名。写这些目录的仍只能是宿主。

`environment` 模块将运行时、应用程序、编程语言与项目类型作为 `HostCatalog` 的 module 条目维护。`category` 为 `runtime`、`application`、`language` 或 `projectType`；`availability` 为 `unknown`、`available` 或 `unavailable`，与组件生命周期 `status` 分开。可选的 `platforms`、`extensions`、`relatedIds`、`skillIds`、`knowledgeIds`、`toolIds`、`protocolIds` 描述平台、格式与关联，不授予执行权限。可用性由宿主确认，登记目录不会安装软件或探测本机。

```ts
import { HostCatalog, loadDefaultEnvironments } from "attention-manifest-protocol";

const host = new HostCatalog();
loadDefaultEnvironments(host);
// 将 host 投影到统一目录并同步 Elasticsearch，然后注入服务的 search 选项。
// 发现参数：{ revision, queries: "runtime", kinds: ["module"] }
```

默认目录包括 PowerShell 7/Windows PowerShell 5.1、sh/bash/zsh、Word/Excel/PowerPoint/Publisher/Access/Microsoft Project、常见编程语言，以及 npm/Maven/CMake 等项目类型，默认可用性全部为 `unknown`。`getDefaultEnvironments()` 返回独立定义副本；`loadDefaultEnvironments(host)` 只返回本次新增项，遇到已有 ID 会跳过并保留宿主覆盖。因此，宿主可在加载默认值之前登记已确认的条目。分类、可用性及平台信息会进入搜索投影，可在 `queries` 中检索并以 `kinds: ["module"]` 限定条目类型。本地 `buildDiscoveryTree` 保留原有分类和可用性筛选。

宿主接线示例（需要宿主提供已运行的 Elasticsearch 9 服务；`index` 用作各 namespace 独立快照索引的前缀）：

```ts
import { CatalogSearch, projectSearchRecords, WorkspaceAgentService } from "attention-manifest-protocol";
import { Database } from "attention-manifest-protocol/database/service";

const database = new Database("catalog.sqlite");
const search = CatalogSearch.create({
    namespace: "host-catalog",
    catalog: database.catalogService,
    cache: database.catalogStore,
    elasticsearch: {
        connection: { node: "http://127.0.0.1:9200" },
        index: "amp-host-catalog",
    },
});
search.replaceSnapshot(projectSearchRecords({
    namespace: "host-catalog", revision: snapshot.revision,
    workspace: snapshot.entities, relations: snapshot.relations,
    projects: host.projects(), host: host.components(),
    skills: skills.list(), knowledge: knowledge.list(), protocols: protocols.list(),
    // records: [...其他模块提供的 CatalogRecord]
}));
await search.sync();
const service = new WorkspaceAgentService({ ...options, snapshot, search });
const response = await service.callAsync("amp_tool_workspace_discover", {
    revision: snapshot.revision, queries: ["repository", "runtime"],
    limit: 10, maxDepth: 3, nodeLimit: 50,
});
// response.data.trees 中，同一个 query 可以对应多个根节点及其关联树。
// 宿主退出：先 await search.close()，再 database.close()。
```

`replaceSnapshot` 替换该 namespace 的完整快照；已删除条目及其出边会清理。它通过同步 SQLite SAVEPOINT 提交，不跨越网络等待。每次 `sync` 创建独立、带 namespace 归属的 concrete index，验证内容并封锁写入，再通过 SQLite epoch CAS 发布索引名、digest 和 generation。后启动的尝试会阻止更早的构建发布，因此失败或超时后可立即重试；远程迟到写入只能影响它自身未发布的索引。配置的索引及 alias 不会被清空或接管。发现查询前后重新校验具体索引、归属 marker、写封锁、文档数量与内容摘要，返回前还要确认 SQLite generation。`CatalogSearch` 在实例内排队，独立协调器分别构建并通过发布 CAS 协调；同步取消和超时包含排队耗时。调用前必须提交外层 SQLite 事务，也不要在等待 Elasticsearch 时在共享连接上开启事务。失败尝试及旧快照可能遗留闲置索引，宿主应管理保留策略，避免删除正在发布的索引或活动构建。写封锁和 namespace marker 无法隔离能移除或修改它们的 Elasticsearch 管理员。连接、认证和 TLS 选项通过 SDK 的 `connection` 在宿主侧配置，不会写入目录。没有搜索配置时 discover 返回 `search_unavailable`，同步 `call` 返回 `async_required`；MCP 集成使用 `handleAsync`。旧的 discover 工具参数 `text`、`scope` 等已移除。

作用域控制新增八个规范工具：global/workspace 的 `adjust`，以及 global/workspace/session 的 `interaction`、`scenario`。注册元数据和默认值按 workspace 持久隔离，配置继承并接入运行时；完整身份接线、action、CAS、dry-run 与 stdio 配置见[作用域控制说明](docs/scoped-control.zh-CN.md)。

作用域控制新增八个规范工具：global/workspace `adjust`，以及 global/workspace/session 的 `interaction` 与 `scenario`。宿主绑定身份、workspace 持久隔离、配置继承、CAS、dry-run 和 stdio 配置见[作用域控制文档](docs/scoped-control.zh-CN.md)。

## 快速开始

```sh
npm ci
npm run build
npm run build:lib
node --test tools/controlProtocolCheck.ts tools/controlPersistenceCheck.ts tools/controlIntegrationCheck.ts
```

## 作为库使用

`npm install attention-manifest-protocol` 会安装 `lib/` 中的编译产物及其声明文件、JSON Schema 和作用域控制文档。源码和可执行检查保存在 GitHub 仓库中。运行时要求 Node.js 24 及以上。包根入口提供文档中的协议核心接口，其余模块均可按子路径导入。

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
大纲节点带 `isFile`/`isDirectory`/`file?`/`directory?`/`path`（如 `add.py#add`）与 `range`（UTF-8 字节 + 1-based 行，bigint；JSON 中为十进制字符串）。`outlineAddress(range, charset, bounds)`（[src/outline/rangeBridge.ts](src/outline/rangeBridge.ts)）把该 range 转成 workspace `read`、`write`、`diff_write` 接受的 `startLine`/`endLine` 与 `offsetBytes`/`endBytes`：扣除 UTF-8 BOM 前缀，字节半开、行闭区间；倒序、越界或无法精确表示时直接报错而不做静默裁剪。文件写入成功后会在同一次调用内重建该文件大纲并删除旧的缓存代次，之后读取大纲不会返回写入前的树。策略覆盖代码、Vue、项目清单、Markdown/TeX/纯文本、CSS/SCSS/Sass、HTML、XML/OPML 与 Office；Office 文件由 `office.ts` 解析 DOCX/XLSX/PPTX，DOC/XLS/PPT/PUB/ACCDB 为 CFB best-effort。

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
| [src/environment](src/environment/) | 运行时、应用、语言和项目类型的默认目录、可用性与关联元数据 |
| [src/skill](src/skill/) | 可复用 agent skill 注册、校验、查询与隔离副本 |
| [src/knowledge](src/knowledge/) | 带来源元数据的 knowledge 注册、校验、查询与隔离副本 |
| [src/protocol](src/protocol/) | 线上协议契约、通道，以及宿主维护的协议元数据注册中心 |
| [src/file](src/file/) | File/Directory 树、元数据、分页读、原子写、会话运行时/服务、模块图与 ZIP/CFB 容器 |
| [src/syntax](src/syntax/) | 字符集检测/编解码、字节/行索引、语法注册表与无损只读语法树 |
| [src/outline](src/outline/) | 代码/文档大纲、范围与标签索引、关键字/策略注册表、React/Shell/SQL/Visual Basic 策略与 Office 解析 |
| [src/hook](src/hook/) | 面向 agent 的组合 hooks 与运行记录 |
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
