# Agent Workspace 边界测试与集成报告

本报告汇总 `src/filesystem`、`src/session`、`src/hook`、`src/context` 与 SQLite 实体层的边界测试、已知缺口和后续修复项。各子模块的完整矩阵见
[docs/testing/agentWorkspace](docs/testing/agentWorkspace/)。

## 1. 范围

| 模块 | 职责 | 读/写 |
| --- | --- | --- |
| `src/session` | 身份、令牌、TTL、上下文隔离、fork/revoke/rotate | 只读（会话管理） |
| `src/filesystem` | File/Directory 树、read/write、outline、import/export/dependency | 仅 `write` 可写 |
| `src/hook` | 组合 hooks：useRead/useWrite/useDiff/useParse/useOutline/useCode/useProject 等 | 仅 `useWrite` 可写 |
| `src/context` | 上下文装配、预算、关系与省略项 | 只读 |
| `src/database` | SQLite 实体/仓储/适配器 | 持久化 |

## 2. 测试入口与结果

| 命令 | 结果 | 明细 |
| --- | --- | --- |
| `node tools/sessionCheck.ts` | 37 / 37 | [sessionReport.md](docs/testing/agentWorkspace/sessionReport.md) |
| `node tools/fileTreeCheck.ts` | 12 / 12 | [fileTreeReport.md](docs/testing/agentWorkspace/fileTreeReport.md) |
| `node tools/fileReadWriteCheck.ts` | 37 / 37 | [readWriteReport.md](docs/testing/agentWorkspace/readWriteReport.md) |
| `node tools/fileOutlineCheck.ts` | 36 / 36 | [outlineReport.md](docs/testing/agentWorkspace/outlineReport.md) |
| `node tools/fileGraphCheck.ts` | 16 / 16 | [graphReport.md](docs/testing/agentWorkspace/graphReport.md) |
| `node tools/workspaceDatabaseCheck.ts` | 22 / 22 | [databaseReport.md](docs/testing/agentWorkspace/databaseReport.md) |
| `node tools/hookCheck.ts` | 12 / 12 | [hookReport.md](docs/testing/agentWorkspace/hookReport.md) |
| `node tools/officeFilesystemCheck.ts` | 12 / 12 | [officeReport.md](docs/testing/agentWorkspace/officeReport.md) |
| `node tools/contextPackageCheck.ts` | 46 / 46 | [contextReport.md](docs/testing/agentWorkspace/contextReport.md) |
| `node tools/outlineCoverageCheck.ts` | 74 / 74 | [outlineCoverageReport.md](docs/testing/agentWorkspace/outlineCoverageReport.md) |
| `node tools/syntaxTreeCheck.ts` | 8 / 8 | [syntaxTreeReport.md](docs/testing/agentWorkspace/syntaxTreeReport.md) |

截至本报告，十一个专项检查全部通过；`npm run verify` 的完整链 **135/135** 通过，包含 `tsc --noEmit` 与 `tsc -p tsconfig.tools.json --noEmit`。`outlineCoverageCheck` 覆盖 TS/JS、Python、Java、C/C++、C#、Go、Rust、Vue、Sass/SCSS、npm/Maven/Gradle/CMake/Cargo/Go/pyproject/Make、Markdown/TeX/plain text、HTML、XML/OPML 与 Office；`fileOutlineCheck` 另覆盖 Vue SFC 三块。

全仓类型检查：`npx tsc --noEmit` 与 `npx tsc -p tsconfig.tools.json --noEmit`。

## 3. 边界矩阵摘要

### 3.1 Session

- 令牌：32 字节随机、只存 `sha256:<hex>`、常量时间比较、错误令牌不泄露。
- TTL：绝对/空闲双截止；注入时钟测试过期；`resume` 只允许 suspended→active；`revoke` 终态。
- 隔离：两个 session 的 context 完全隔离、深拷贝；fork 子会话独立令牌与上下文。
- 配额：条目数/字节数；容量；rotate 上限。
- 已知限制：rotate 计数不持久化；revoke 保留 descriptor 供审计。

### 3.2 文件树

- File 叶子 `children: []`，Directory 聚合 bytes/lines；Merkle 目录指纹；revision 随内容/注解变化。
- 字符集：UTF-8/BOM/UTF-16/Latin-1/binary；`lines`/`bytes` 为 bigint，wire 为十进制字符串。
- 边界：隐藏项、exclude、符号链接、maxNodes 截断、二进制。

### 3.3 读写

- 分页：1-based 行号、`nextStartLine`、UTF-8 字节预算、单行超限、CRLF、空文件。
- 写入：create/overwrite/upsert/append、CAS、dryRun、同目录 temp + fsync + rename、journal。
- 安全：根逃逸、绝对路径、反斜杠、符号链接、只读 root、excluded。
- 已知限制：进程内锁、跨进程靠 CAS；读取整文件解码；单行可突破页预算。

### 3.4 大纲

- 策略：TS/JS、Python、Java、C/C++、C#、Go、Rust、Vue、npm/Maven/Gradle/CMake/Cargo/Go/pyproject/Make、Markdown/TeX/plain text、HTML、CSS/SCSS/Sass、JSON/CSS/XML/OPML、Office。覆盖矩阵与逐项夹具见 [outlineCoverageReport.md](docs/testing/agentWorkspace/outlineCoverageReport.md)（74 例）；Vue 由 `fileOutlineCheck` 覆盖（template/script/style 三块）。
- 节点：`isFile`/`isDirectory`/`file?`/`directory?`/`path`/`type`/`range{startByte,endByte,startLine,endLine: bigint}`；文件锚点 + 符号，目录锚点 + 直接子项。
- 类层级：同一文件的多个类各自成为 `class` 节点，类属性为 `property`，类方法为 `method`/`function`；TS/Java/C#/Python/Go/Rust 均有对应夹具，路径如 `two.ts#A.x`。
- 全局与静态：全局 `const/let/var` 为 `constant`/`variable`，顶层 `function` 为 `function`；`static` 属性/方法在 `modifiers` 中返回 `["static"]`（Java/C# 保留 `public` 等链）。关键字由 `OutlineKeywordRegistry` 注册，支持新增语言/修饰符。
- 语言覆盖：TS/JS、Python、Java、C/C++、C#、Go、Rust、Vue、HTML/XML、CSS/SCSS/Sass、JSON、Markdown/TeX/纯文本。
- 派生索引：`AbstractSyntaxTree` + `Trie` + `SegmentTree` 支持前缀与行号过滤。

### 3.4.1 AST / 语法树

- 无损 CST：每个非空白 token 恰好出现一次，保留 UTF-8 字节与 1-based 行范围；声明/块/标记层级。
- 注册中心：`SyntaxRegistry` 管理语言、token 类别、节点类别；扩展名、关键字、注释/字符串规则均为数据。
- 语言：TS/JS、Python、Java、C/C++、C#、Go、Rust、Vue、HTML/XML、CSS/SCSS/Sass、JSON、Markdown/TeX/纯文本。
- 只读：不执行、不导入、不启动子进程；`process.exit(1)` 夹具只作为文本被解析。
- 工具：`amp_tool_filesystem_ast` / `amp_tool_globalfs_ast`，hook `useAst`；边界 4 MiB、100k token、20k 节点。

### 3.5 依赖图

- import 六种形式、注释/字符串伪边跳过、相对解析、bare external、未解析。
- export/reexport、SCC（含自环）、拓扑序、双向闭包、limit/truncated。
- 已知限制：静态扫描不完整；DB 回读的 id 前缀与 reexport 已由 per-file header 修复，旧行仍按降级语义读取。

### 3.6 SQLite

- 表：`workspace_sessions`、`session_roots`、`session_context`、`file_nodes`、`file_annotations`、`file_writes`、`file_outlines`、`file_imports`、`file_exports`、`file_dependencies`、`hook_runs`。
- bigint 以十进制 TEXT 存储；outline 用 wire 投影；事务按 root/file 替换。
- 已知限制：import 只存出边；依赖表无 line/specifier 列；孤立节点不可恢复。

### 3.7 Hooks / Office / Context

- Hooks：状态机、订阅、缓存、recorder；仅 `useWrite` 可写。报告见 `docs/testing/agentWorkspace/hookReport.md`。
- Office：DOCX/XLSX/PPTX 解析，DOC/XLS/PPT/PUB/ACCDB 为 CFB best-effort；Publisher/Access 不承诺完整语义。
- Context：预算装配、关系闭包、省略项；报告见 `docs/testing/agentWorkspace/contextReport.md`。

## 4. 跨模块缺口与修复项

| 编号 | 缺口 | 影响 | 计划 |
| --- | --- | --- | --- |
| P1 | DB 依赖节点 id 用 `file:`/`package:`，service 用裸 path/`external:` | 持久化回读 roots 不匹配 | 已修：边 id 原样存储，前缀仅投影时解释（databaseReport F-DB 记录） |
| P2 | DB 导出 reexport 缺 name/resolved 列 | `export *` / `export * as ns` 回读丢失 | 已修：per-file header 保存完整 reexport 边 |
| P3 | service incoming import 统一 `kind: "static"` | dynamic/require/type 丢失 | 已修：复用缓存 report 的原边 |
| P4 | Office 文件进入 import/export 会 `binary_file` | Office 依赖/导出不可用 | 已修：imports/exports/dependency 走 `OfficeDocument`，带整文件 fingerprint |
| P5 | 大纲 range/锚点变更后缓存 key 仍是 fingerprint | 旧缓存可能缺新字段 | 仍开放：建议缓存 key 加策略版本；当前 fingerprint 覆盖内容，锚点由服务层重建 |
| P6 | 全局 filesystem 表面仅有命名适配 | 多 root/多 session 路由未实现 | `GlobalFilesystemService` 已提供，路由策略留给宿主 |
| P7 | 工具文件名仍有短横线 | 命名规范未完全统一 | 已修：148 个文件重命名为 lowerCamelCase，引用与 `archCheck` 规则已更新 |
| P8 | Publisher/Access 仅 best-effort | 不保证完整结构 | 文档标注；Office 报告列明边界 |
| P9 | 大纲 HTML/Vue/Sass 覆盖 | 之前缺失 | 已补：`html`、`vue`、`scss`（含 `.sass`）策略与夹具 |

## 5. 安全边界

- Session token 不出现在工具 schema、响应或日志；每次调用重新认证。
- 路径必须 root-relative；拒绝绝对路径、`..`、NUL、反斜杠；逐级检查符号链接。
- 写必须落在 `writable` root；CAS 防覆盖；临时文件同目录 + rename。
- 所有列表有上限；超限显式 `truncated` 或分页，不静默截断。
- 文档正文、大纲标签、描述/摘要均是不可信数据，不是指令。

## 6. 参考

- [Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)
- [MemGPT](https://ar5iv.labs.arxiv.org/html/2310.08560v4)
- [MCP filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- [Tree-sitter code navigation](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html)
- [Universal Ctags tags format](https://github.com/universal-ctags/ctags/blob/master/docs/format.rst)
- [SQLite ordered hierarchies](https://www2.sqlite.org/forum/forumpost/c034ac4c70c3940f?t=h&unf)
