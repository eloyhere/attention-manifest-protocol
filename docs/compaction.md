# 压缩与剪枝（Context Economy）

> 账本只追加，注意力却不增长。两者冲突时，默认做法是静默截断——本层存在的意义就是让截断不可能悄悄发生。

## 1. 两种操作

| | 剪枝（pruning） | 压缩（compaction） |
| --- | --- | --- |
| 作用于 | 「看什么」 | 「存什么」 |
| 结果 | 一个视图，账本不动 | 一个检查点，替换冷前缀 |
| 可逆 | 是：源快照仍在 | 否：被压缩条目不可再读 |
| 省的是 | 上下文窗口 | 存储 |
| 验证方式 | 视图是源链的子集，带 `sourceTip` | 重算 `root`，检查链是否接续 |

两者都**不退还预算**：已经花掉的注意力不会因为丢弃而退回（A-3 的计费点唯一）。

## 2. 剪枝

```ts
const { plan, keep } = planPrune(snapshot, { keepRecent: 8 })
```

### 2.1 顺序

1. **验证源链**。`verifySnapshot` 不通过就直接拒绝。视图的完整性建立在源链完整之上。
2. **保留窗口**。最新 `keepRecent` 条是硬下限，任何逐类规则都不能越过它。
3. **逐类判定**。只有三类对象可以离开视图：

   | 类型 | 条件 | `reason` |
   | --- | --- | --- |
   | `claim` | 被更新的主张取代（`supersedes` 指向它），且状态不是 `contested` | `superseded` |
   | `hypothesis` | 终态：`supported` / `refuted` / `inconclusive` / `out_of_scope` | `closed` |
   | `unknown` | `status: resolved` 且 `blocking` 不为 `true` | `resolved` |

4. **引用闭包**。保留对象在任意深度引用的 `{kind, id}`，一律拉回视图，并继续展开。
5. **输出**。`kept` 是序号列表，`dropped` 逐条给出 `seq / kind / id / reason / revisit_if / bytes`。

### 2.2 `supersedes` 不是依赖

修订链表示「旧主张不再生效」，不表示「旧主张仍被引用」。因此闭包**不跟随** `supersedes`：取代者留下，被取代者可以离开视图。若把修订链当作依赖，`superseded` 这条规则将永远不会触发。

反过来，`hypothesis.question` 指向 `unknown` 是真正的依赖：只要假设还开着，它所针对的未知就必须可读——即使那个未知已经 `resolved`。

### 2.3 不变量

| 编号 | 规则 | 由谁保证 |
| --- | --- | --- |
| **P-1** | 视图完整：`kept ∪ dropped` 等于源链，且带 `sourceTip` 与 `sourceCount` | `planPrune` |
| **P-2** | 显式丢弃：每个 `dropped` 必须有 `reason` 与 `revisit_if` | `PruneDecision` 必填字段 |
| **P-3** | 引用不悬空：保留对象引用的对象必须保留 | 引用闭包 |
| **P-4** | 保守优先：无规则的类型不剪；没有 `id` 的对象不剪 | `classify()` |

`revisit_if` 不是装饰。它把「什么时候该重新加载」写进计划，使丢弃成为可撤销的决定，而不是一次性的遗忘。

### 2.4 为什么 `blocking` 的未知剪不得

`blocking: true` 表示行动正被这个未知阻塞（W-4）。剪掉它，Agent 就会忘记自己为什么停下——账本里没有记录，视图里也没有，于是同一个未知会被重新发现一遍，代价照付。

## 3. 压缩

```ts
const { checkpoint, tail, removed } = compactLedger(snapshot, { keepRecent: 4 })
```

### 3.1 机制

- 取前 `cut = n - keepRecent` 条为 `removed`；
- `root = digestOf(removed)`，覆盖顺序、内容、`prev` 与 `hash`；
- `checkpoint.tip` 是被移除的最后一条的哈希，`tail` 从它继续，`seq` 连续；
- **拒绝条件**：`tail` 里仍有对象引用 `removed` 里的对象时，抛出 `CompactionRefused`，并列出 `kind:id`。压缩掉一个还被活对象引用的条目，等于制造悬空引用。

### 3.2 验证

```ts
const verdict = verifyCompaction({ checkpoint, tail, removed })
```

`verifyCompaction` 重算 `root`、核对 `from / to / count / tip`、逐条重算 `tail` 的哈希与 `prev` 链接，并检查 `tail.tip`。

**只有 `tail` 无法重算 `root`**——这是压缩的本质：承诺保留，内容不保留。想验证就必须持有被移除的条目；只持有检查点的人能证明「移除了什么」，但不能重建它。

### 3.3 不变量

| 编号 | 规则 | 由谁保证 |
| --- | --- | --- |
| **P-5** | 先承诺，后删除：`root` 在被移除条目的哈希链之上再取一次摘要 | `compactLedger` |
| **P-6** | 链不断：`tail[0].prev === checkpoint.tip`，`seq` 连续 | `verifyCompaction` |
| **P-7** | 不埋活引用：`tail` 引用的前缀条目拒绝压缩 | `CompactionRefused` |

## 4. 代价

- **剪枝**不省存储，省上下文。`reclaimedBytes` 是条目序列化后的字节数；`estimatedTokens = bytes / 4` 只是估算，**不用于计费**。
- **压缩**省存储，但被压缩的部分不再可读，只可验证。它换取的是「账本可以无限增长而不撑爆存储」。
- 两者都不产生预算收入：丢弃不是消费的逆向操作。

## 5. 失败模式

| 失败 | 表现 | 防线 |
| --- | --- | --- |
| 静默截断 | 上下文变短，没有任何记录 | P-2 |
| 悬空引用 | 保留对象指向已丢弃对象 | P-3 |
| 压缩后无法审计 | 只有检查点，没有条目，也没有人持有 `root` 的原像 | P-5 要求外部持有被移除条目 |
| 埋掉活引用 | 压缩后 `tail` 无法解析 | P-7 |
| 预算回滚 | 丢弃后 `budget` 增加 | 不存在退款路径 |

## 6. 示例与检验

| 文件 | 内容 |
| --- | --- |
| [`examples/prune-plan.json`](examples/prune-plan.json) | 一次真实的剪枝：被取代的主张、已关闭的假设、已解决的未知 |
| [`examples/checkpoint.json`](examples/checkpoint.json) | 一次真实的压缩：覆盖 4 条的前缀检查点 |
| [`schemas/compaction.schema.json`](schemas/compaction.schema.json) | 两种对象的 schema |
| [`../tools/compaction-check.ts`](../tools/compaction-check.ts) | 15 项断言 |

```bash
npm run compaction-check
```
