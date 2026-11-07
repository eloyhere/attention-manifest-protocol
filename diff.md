# 实现差异（仅未解决项）

> 本文件只记录当前代码与 `refract.md` 之间**尚未解决**的差异。已修复的条目直接删除，不保留历史段落，避免阅读时注意力错配。
> 审计基线：2026-11-07；`npm run check:architecture` 通过；持久化/内核/会话/项目/协作/职业定向测试 125/125。
> 审计范围：`refract.md` §4、§5、§6、§8、§9、§10、§11、§12、§13、§16；只列可定位到代码的差异。

## P0 — 发布前必须解决

| # | 标准 | 现状 | 差异 | 位置 |
| --- | --- | --- | --- | --- |
| 1 | §4.2/§9 事件可恢复 | kernel 与独立持久化层事件命名不同（业务事件名 vs `<kind>.created\|transitioned`） | 共用同一 DB 时 `restoreAll` 可能无法重建 kernel 写入的历史 | `src/kernel/persistence.ts`、`src/persistence/**`（代理修复中） |
| 2 | §4.8 Action 尝试生命周期 | 31 个 `EntityKind` 无 attempt 聚合；`restoreAll` 跳过含 `attemptIds` 的 action | 重启后尝试/重试历史丢失 | `src/entity/declarations.ts`、`src/persistence/workflow.ts` |
| 3 | §5/§9.6 证据可追溯 | 独立 `EvidenceLedger` 为内存态，重启不重建 | 历史证据不可查，无法支撑审计链 | `src/evidence/ledger.ts`、`src/persistence/**`（代理修复中） |

## P1 — 标准硬规则未落地

| # | 标准 | 差异 | 位置 |
| --- | --- | --- | --- |
| 4 | §4.9/§9.1 事件含执行者与理由 | 持久化事件 payload 缺 `actor`/`reason`/`cancellationEpoch`；重建时 actor 固定 `"persistence"` | `src/persistence/workflow.ts` |
| 5 | §11.2/§11.3/§12 流程绑定 | kernel 仅把 project/workspace/file 作为端口，主流程没有项目配置与文件读写步骤 | `src/kernel/kernel.ts` |
| 6 | §16.2 预算耗尽传播 | `BudgetTree` 耗尽只返回 `budget_exhausted`/回调，未触发 Turn→interrupted、Session→closing/suspended | `src/budget/tree.ts`、`src/session\|turn/service.ts` |
| 7 | §4.9/§12.6 级联与回执 | cascade 仅声明不执行；Session/Turn/File 回执未写入证据账本（file 有 hook，未接 EvidenceLedger） | `src/entity/**`、`src/service/store.ts`、`src/file/core.ts` |
| 8 | §10.8/§12.7 协作隔离 | `isolated/shared_read/shared_write_with_lock` 仅声明校验，未接文件锁/合并点 | `src/cooperation/**` |
| 9 | §8.2/§8.4 职业评测 | `certify` 只消费外部 evaluation，无评测集/影子执行 | `src/profession/certification.ts` |

## P2 — 契约完整性

| # | 标准 | 差异 | 位置 |
| --- | --- | --- | --- |
| 10 | §13.6 视图锚点 | 锚点依赖 host 注入，无规范锚点注册表；脑图缺 graph 级 version/constraints/anchors | `src/project/{types,mindmap}.ts` |
| 11 | §16.3 预算维度 | `shared.ts` 的 `Budget` 仍四维，`BudgetTree` 六维仅存在于 `src/budget`，跨层不一致 | `src/shared.ts`、`src/budget/types.ts` |
| 12 | §12.4 定位安全 | `OutlineEntry.versionHash` 可选，读写入口未强制校验节点级版本哈希 | `src/file/{types,core}.ts` |
| 13 | §12.4 解析器 | 手写扫描器而非 tree-sitter（**有意偏离**，见下） | `src/file/language/**` |

## 有意偏离（不是缺陷，需在标准/发布说明中登记）

1. **无第三方解析器**：语言/文档大纲为手写结构扫描，不编译、不做类型检查。
2. **line/byte/string/regex 写入**：标准 §12.2 要求 AST 结构化重写；当前是显式范围写入 + 唯一匹配 + CAS。
3. **二进制字节挂载**：`writeBytes` 只提交不透明字节，专有格式写入交给插件。
4. **cascade 声明式**：JPA 级联未执行，避免跨聚合隐式删除。

## 未审计 / 超范围

- 真实 A2A/网络传输、远端 registry、沙箱隔离、多租户部署。
- 真实模型评测、影子执行、Bayesian 融合（§5.7）与 L8 沉淀（§14）。
- `refract.md` §17/§18/§19 的阶段性路线未逐条对照。

## 修复顺序

P0（1→2→3）→ P1（4→5→6→7→8→9）→ P2。每项修复需同时补测试，并在本文件中删除对应行；本文件保持“只列未解决项”。
