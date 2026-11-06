# Attention Manifest Protocol（AMP）

[English](README.md) · **简体中文** · [更新日志](CHANGELOG.zh-CN.md)

AMP 是面向 agent 的元认知协议：它让 agent 声明自己知道什么、承担什么，分配有限的注意力，记录证据与成本，并通过一个由宿主严格控制的窄接口行动。本仓库是参考实现：TypeScript ESM，**Node.js 24 或更高版本**，Apache-2.0，版本 `0.6.1`（未发布的改动记录在[更新日志](CHANGELOG.zh-CN.md)中）。

模型只提议，宿主才授权。每一个持久化副作用都带版本、经过哈希校验，并在需要时可以被独立验证。库中不存在"只要函数存在就等于拥有权力"的假设。

## 设计原则

- **先声明，后行动。** 知识、义务、预算与排除项都是显式对象，而不是隐含状态。
- **权力属于宿主。** 策略、预算、租约、能力注册与行为发布都是宿主的决定；模型可以请求，不能授予。
- **投影是只读的。** 大纲、上下文与发现结果都是预览，不编译、不执行，也不证明真值。
- **端口而非全局。** 存储、时间、锁与模型访问都以端口注入，运行时不依赖数据库即可嵌入。

## 架构

根入口按领域暴露命名空间。各模块相互独立，关键连接是宿主传入的端口。

| 分组 | 模块 | 职责 |
| --- | --- | --- |
| 交互 | `session`、`turn`、`intent`、`mission`、`goal`、`plan`、`task` | 身份、轮次、意图承接、目标与验收条件、计划与任务 |
| 执行 | `action`、`execution`、`tool`、`tooling`、`manifest`、`policy`、`budget`、`capability` | 尝试、工具契约、策略执行、预算账本、能力注册 |
| 注意力 | `attention`、`context`、`reactive` | 注意力对象、聚焦与持久化、上下文编译、基于代理的懒加载视图 |
| 证据 | `evidence`、`provenance`、`receipt`、`verification`、`retrieval` | 主张与引用、来源链、执行回执、独立验证、候选检索 |
| 工作区 | `workspace`、`file` | 作用域文件、大纲、编辑原语、存储适配器、文档与归档读取 |
| 项目 | `project` | 规则、元数据、视图、项目大纲、项目类型、环境与工具链系列 |
| 协作 | `cooperation`、`profession`、`behavior`、`governance` | 委派、权限收紧、行为发布、治理流程 |
| Agent 接口 | `agent`、`model`、`runtime`、`workflow` | 模型可见的工具注册表、分发网关、模型端口、单写者生命周期 |
| 持久化 | `repository`、`entity`、`service`、`sql` | 持久状态的端口与适配器 |

Agent 永远拿不到可变存储，只能拿到投影、版本号，以及一份明确列出"允许尝试哪些动作"的清单。

## 快速开始

```sh
npm ci
npm run check:architecture     # 严格类型检查，不允许未使用符号
npm run test:architecture      # 460 项测试
npm run scenario               # 单独运行端到端场景套件
npm run build                  # 浏览器演示构建到 dist/
npm run build:lib              # 生成可发布的 ESM 库到 lib/
npm run demo:architecture      # 可执行的小型演示
```

## 作为库使用

```ts
import { Workspace } from "attention-manifest-protocol/workspace";
import { NodeFileStorage, createOutlineProvider } from "attention-manifest-protocol/file";
import { Project, createProjectFromKind, kinds } from "attention-manifest-protocol/project";
import { AgentGateway } from "attention-manifest-protocol/agent";
```

| 说明符 | 解析结果 |
| --- | --- |
| `attention-manifest-protocol` | `lib/index.js`，每个领域作为一个命名空间 |
| `attention-manifest-protocol/<domain>` | `lib/<domain>/index.js` |
| `attention-manifest-protocol/<domain>/<file>.js` | 单个编译后的模块 |

`npm run build:lib` 重新生成 `lib/`；`prepublishOnly` 会在发布前自动执行。Vite 演示入口（`src/main.ts`）不属于库构建。

## 工作区与文件

`Workspace` 绑定租户、根与存储端口；`File` 是某个路径的挂载视图，带版本。

```ts
const workspace = new Workspace({
    tenantId: "tenant-a",
    rootId: "root-1",
    storage: new NodeFileStorage({ root }),
    outline: createOutlineProvider(),
});

const file = workspace.mount("src/index.ts", { mode: "writable", owner: "agent" });
file.outline();                                        // 带范围的符号大纲
file.replace({ mode: "string", text: "return a - b;" }, "return a + b;");
file.flush({ idempotencyKey: "fix-add-1" });            // CAS 提交
```

挂载即激活；可写挂载会获取租约。`flush()` 是比较并交换：基准哈希、租约栅栏与文件锁必须同时匹配，否则以 `version_conflict`、`stale` 或 `fence_rejected` 失败，并且不写入任何内容。

### 写入与替换模式

`write(content, target?)`——省略 target 表示替换整个缓冲区。

| Target | 含义 |
| --- | --- |
| `{ mode: "line", start, end }` | 0 基行号，`end` 不含；保留周边行结构与行尾 |
| `{ mode: "byte", start, end }` | UTF-8 字节偏移，`end` 不含；必须落在码点边界 |
| `{ mode: "outline", id }` | 替换某个大纲节点的完整范围；标题节点覆盖整节 |

`replace(target, replacement, options?)` 支持 `string`（字面量，不展开 `$`）、`regex`（只允许无状态标志；支持 `$$`、`$&`、`` $` ``、`$'`、`$1`–`$99`、`$<name>`），以及上述三种结构目标。字面量与正则默认要求唯一匹配；歧义时返回 `ambiguous_match`，而不是任选一个。

两条路径都接受 `expectedBaseHash` 与 `expectedBufferVersion`；`planWrite`/`planReplace`/`locate`/`diff` 可以在提交前查看编辑结果。脏缓冲区不会被隐式提交。

### 范围与大纲

每个大纲节点都带 `range`：`startLine`/`endLine` 为 0 基（end 不含），`startByte`/`endByte` 为 UTF-8 偏移（end 不含）。`dirty` 标记尚未提交到存储的节点。范围始终针对缓冲区校验，过期的范围不会静默指向别的字节。

### 二进制文档

无法按文本解码的挂载会作为不透明字节处理：`snapshot().binary` 为 `true`，`readBytes()` 读取缓冲区（可指定字节区间），`writeBytes()` 替换，`flush()` 通过 `compareAndSwapBytes` 提交。文本 API（`read`、`write`、`replace`、`readLines`、`outline`、`diff`）会以 `invalid_target` 失败，而不是把二进制文件改坏。`documentOutline()` 直接作用于字节缓冲区，包含尚未提交的编辑。

专有格式的**写入**不在本库实现：`writeBytes` 只提交不透明字节。创建或修改 Office、PSD、CAD 与归档文件由宿主插件负责。

### 存储与锁

`NodeFileStorage` 将路径限制在真实根目录内，拒绝 `..`、绝对路径、反斜杠、NUL 与符号链接逃逸，强制文件大小上限，并以临时文件 + `fsync` + 原子重命名 + 目录 `fsync` 提交。`InMemoryFileStorage` 提供相同契约用于测试。磁盘锁是咨询式的：它通过单调栅栏保护协作进程，绕过协议的外部进程仍可能竞争——但结果表现为哈希冲突，而不是静默丢失。

## 文档与归档大纲

大纲是结构化预览：不解码像素、网格、公式、宏或外部关系，也从不修改源文件。

**内置 32 种语言**：Markdown、纯文本、TeX、JavaScript、TypeScript、C、C++、Java、C#、Python、Go、Swift、XML、JSON、MySQL、Oracle SQL、SQL Server、HTML、Vue、CSS、SCSS、Sass，以及压缩归档（文本大纲）；Word、Excel、PowerPoint、Access、Publisher、Photoshop、CAD、3ds Max、SolidWorks（二进制格式，经 `documentParser`）。

| 格式 | 投影内容 |
| --- | --- |
| DOCX / `.doc` | 标题、段落与表格；旧版经 FIB 与 Clx/PlcPcd piece table 还原 |
| XLSX / `.xls` | 工作表与单元格；旧版 BIFF8 使用 `BOUNDSHEET`、`SST`（含 `CONTINUE`）、`RK`、`MULRK` 与公式缓存值 |
| PPTX / `.ppt` | 幻灯片与文本；旧版按 MS-PPT 记录树遍历 |
| PSD v1 / PSB v2 | 完整图层树，含组（`lsct`/`lsdk`）、`luni` 名称、bounds、blend 与 opacity |
| DXF | 图层、块与实体类型计数 |
| DWG R13/R14/R2000 | section 表（编号、偏移、大小）；实体图不解码 |
| 3DS | 命名对象块 |
| `.max`、SolidWorks | 完整 CFB 容器：目录树、流大小与 CLSID、摘要信息属性 |
| ZIP / TAR / TAR.GZ / GZ | 归档条目列表（中央目录、tar 头、gzip 成员）；从不解压成员 |

明确不支持（返回精确错误，而不是空大纲）：DWG R2004+（逐 section 的 LZ77 压缩 + Reed–Solomon 加密）、DWG R10–R12、Access `.mdb/.accdb`、Publisher `.pub`、7z、RAR、XZ、bzip2、zstd、加密的 Word/BIFF 文档，以及 `.max` 与 SolidWorks 流内部的专有语义（场景图、特征树、配置）。这些需要专门的解码器或宿主适配器；上述容器元数据不能替代它们。

## 项目模型

`Project` 保存带版本的项目知识：规则、元数据（路径、标签、规则 id）与派生视图，同时持有 **environment**：

```ts
const project = createProjectFromKind(
    kinds.createDefaultProjectKindRegistry().requireKind("go"),
    { tenantId: "tenant-a", rootId: "root-1" },
);
project.environment;                    // 变量、路径、依赖（冻结）
project.configureEnvironment(
    { dependencies: [{ id: "go", scope: "build", version: ">=1.22" }] },
    { expectedVersion: 0 },             // CAS
);
project.environmentPlan();              // 缺口：未设置变量、缺失路径、未固定依赖
project.describeEnvironment();          // 带编号下一步的 Markdown 简报
```

- `variables` 是默认值；空字符串表示"已声明但未设置"，会成为缺口。
- `paths` 是规范的工作区相对 POSIX 路径；`dependencies` 带 `id`、可选 `version`/`manager`、`scope` 与 `optional`。
- `planEnvironment` 把声明的路径与项目元数据比对，报告 agent 还需配置什么；`describeEnvironment` 生成该简报。这是**引导**，不是写权限：配置由宿主或插件应用。
- `project.kinds` 注册七种项目类型（`go`、`tex`、`text`、`photoshop`、`cad`、`max3d`、`solidworks`），带识别标记与默认环境，可按文件列表检测，支持原子批量注册与 id 永久退休。
- `project.serie` 注册工具链系列（`npm`、`pnpm`、`node`、`maven`、`gradle`、`make`、`android`、`ios`），步骤是声明式的，不执行任何命令。
- `project.outline` 是项目树的有根森林，与文件大纲共享 `range`/`dirty` 契约。

## Agent 接口

`src/agent/surface.ts` 是声明式三层注册表，工具名为 `attention_manifest_protocol_<module>.<verb>`。

| 层级 | 模块 | 暴露方式 |
| --- | --- | --- |
| `agent` | `session`、`turn`、`intent`、`mission`、`goal`、`plan`、`task`、`action`、`attention`、`project`、`workspace`、`cooperation`、`evidence`、`execution`、`budget` | 提供给模型；`budget` 只暴露 `remaining` |
| `host` | `capability`、`manifest`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime` | 仅宿主；不会出现在工具列表 |
| `hidden` | `workflow`、`policy`、`profession`、`behaviour` | 永不暴露；`assertAgentAccessible` 直接拒绝 |

`AgentGateway` 按注册表分发，并强制以下机制：

1. binding（`tenantId`、`principalId`、`sessionId`、`policyVersion`、`cancellationEpoch`）由宿主提供并校验；
2. 工具必须存在且在当前 surface 中可见；
3. 模型参数不得携带宿主上下文（`tenantId`、`sessionId`、`policyVersion`、`owner`、`fence` 等），任意深度都会被拒绝；
4. 变更型动词必须带幂等键；
5. 宿主 `authorize` 钩子会收到声明的 authority；
6. 每次调用写一条 journal。

错误类型固定：`binding_invalid`、`unknown_tool`、`not_exposed`、`invalid_parameters`、`unauthorized`、`mutating_requires_idempotency_key`、`handler_missing`、`handler_failed`。网关不实现策略、预算与租约；缺少它们时它只会拒绝分发。

## 执行、证据与治理

- `execution` 通过执行器运行类型化的子调用；`policy` 提供 PEP，`budget` 提供账本。工具成功不等于验收通过。
- `receipt` 与 `provenance` 记录实际发生的事；`verification` 独立于执行器检查业务语义。
- `workflow` 是带版本守卫与取消 epoch 的单写者生命周期，因此刻意不在 Agent 接口中。
- `capability`、`manifest`、`profession`、`behaviour` 与 `governance` 负责收紧或释放权力，都是宿主动作。

## 测试

测试套件即可执行文档：领域测试共 **460 项**，另有在真实临时目录上运行的端到端场景。

| 范围 | 覆盖内容 |
| --- | --- |
| 文件 | 大纲定位、计划/替换、幂等提交、过期检测、租约互斥、BOM/CRLF 保真、码点字节边界、持久性 |
| 文档 | DOCX/XLSX/PPTX、旧版 DOC/XLS/PPT、PSD/PSB 图层树、DXF/DWG 容器、3DS、CFB 容器、归档 |
| 失败路径 | 损坏归档、不支持格式、路径穿越、体积上限、预算截断 |
| 项目 | 环境播种、缺口、CAS、类型应用与覆盖 |
| Agent | surface 分层、网关授权、隐藏工具屏蔽、参数注入、审计日志 |

```sh
npm run scenario                          # 14 个端到端场景
node --test src/file/document/archive.test.ts
```

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [src](src/) | `src/index.ts` 导出的领域模块 |
| [src/file](src/file/) | 范围、字符集、编辑、大纲、语言、文档、归档、存储适配器 |
| [src/workspace](src/workspace/) | 挂载与文件生命周期 |
| [src/project](src/project/) | 规则、元数据、视图、大纲、项目类型、环境、工具链系列 |
| [src/agent](src/agent/) | Agent surface 注册表与分发网关 |
| [src/scenario](src/scenario/) | 端到端场景套件 |
| [tools](tools/) | 测试发现、演示与声明重写 |
| [document](document/) | 实现说明 |

## 边界

- 大纲是与源版本绑定的预览，不是编译器、语言服务器或类型检查器。缺少节点只表示"未识别"，不表示源码无效。
- 文档读取器是只读且结构化的：不解码像素、网格、公式、宏或外部链接，也从不写回源文件。
- 不支持的格式会以 `unsupported_format` 与原因失败，绝不返回看起来成功的空大纲。
- 来源证明完整性，不证明真值或行动权威。沙箱隔离、多租户与生产加固仍是宿主的责任。

## 许可证与历史

[Apache License 2.0](LICENSE)，版权 2026 Eloy Kim；再分发时请保留 [NOTICE](NOTICE)、许可证与署名声明。历史记录见 [CHANGELOG.md](CHANGELOG.md) 与 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)。
