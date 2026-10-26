# DeepSeek 探针：质量、token 与注意力

> 运行：`DEEPSEEK_API_KEY=... node tools/deepseek-probe.ts`
> 数据：`docs/probes/deepseek-probe.json`
> 模型：`deepseek-flash`，`thinking: disabled`，`temperature: 0`，`max_tokens: 256`

## 0. 设计

同一组任务，四种 prompt 条件：

| 条件 | 注入内容 |
| --- | --- |
| `bare` | 短 system prompt，只要求输出答案 |
| `person` | `AgentService` 生成的 self / role / memory / affect 上下文 |
| `person+attention` | 上述内容 + `planAttention` 的进程容量/线程分配/储备/恢复债 |
| `person+attention+scenario` | 上述内容 + `chat 0.5 + engineering 0.5` 的加权场景计划 |

任务分两组：

- **objective**：5 个有唯一答案的通用题（算术、三段论、JS 表达式、时间差、贝叶斯）。
- **context**：5 个只有读取 agent 上下文才能答对的题（记忆、角色义务、注意力槽位、压力值、约束）。

评分是精确匹配/正则判定，不使用模型自评。

## 1. 结果

| suite / condition | 正确率 | 平均 token | 总成本 (USD) | 质量/1k token |
| --- | ---: | ---: | ---: | ---: |
| objective / bare | 80% | 54 | 0.000046 | 14.76 |
| objective / person | 80% | 247 | 0.000191 | 3.24 |
| objective / person+attention | 100% | 318 | 0.000150 | 3.14 |
| context / bare | **20%** | 47 | 0.000054 | 4.26 |
| context / person | **80%** | 238 | 0.000194 | 3.36 |
| context / person+attention | **100%** | 309 | 0.000150 | 3.24 |
| objective / person+attention+scenario | **100%** | 290 | 0.000129 | 3.45 |
| context / person+attention+scenario | **100%** | 281 | 0.000129 | 3.56 |

40 次调用合计 **8,922 tokens / $0.001043**（off-peak，`deepseek-flash`）。

## 2. 解释

### 2.1 简单客观题：上下文是纯开销

`bare` 与 `person` 都是 80%（贝叶斯题都答 8.3%，正确约 7.5%）。
person 上下文把平均 token 从 54 提到 247（约 4.6×），质量没有提升。
attention/scenario 这轮到了 100%，只是因为贝叶斯题单次答对；单样本，不足以证明稳定收益。
**结论：通用推理任务不需要人格上下文；默认全量注入是浪费。**

### 2.2 上下文任务：person 上下文是必要的

`context/bare` 只有 20%，`person` 到 80%：

- 记忆题、角色题、压力题只能从 self/role/memory/affect 读出；
- 没有上下文时模型会编造一个「Analyst」或压力值。

### 2.3 注意力计划：再 +20pp

`person+attention` 到 100%，唯一增量是 `attention-slots` 题：

- 只有注入 `foreground slots = 2; safety floor = 1` 才能答对；
- 代价是平均 token 从 238 到 309（约 +30%）。

注意力指标（合成状态）：

```text
capacity 4 slots
foreground cap 3
reserve 1
safety floor 1
foreground allocation 2
utilization 75%
headroom 25%
pressure 0%
recovery debt 28%
rest=false
```

### 2.4 场景加权：更少 token，保持 100%

`person+attention+scenario` 使用 `chat 0.5 + engineering 0.5`：

- objective 平均 token 290（vs 318，-9%），正确率 100%（vs 100%）；
- context 平均 token 281（vs 309，-9%），正确率 100%；
- 这次贝叶斯题答对 7.5%，但只有一个样本，不能归因于场景本身。

场景把 token 预算乘以 0.75，并重新分配 context/memory 权重；质量没有下降。
成本也下降了（0.000129 vs 0.000150），因为相同前缀命中了缓存。

### 2.5 缓存改变了成本结论

`person+attention` 的 prompt 在 5 次调用间重复，命中 640 个缓存 token：

- 平均 token 最高（318），成本却低于 `person`（0.000150 vs 0.000191）；
- 所以「token 多」不等于「钱多」，重复上下文应利用 prompt caching。

### 2.6 贝叶斯题是模型弱点，不是上下文问题

`bare`、`person` 都输出 **8.3%**，`person+attention`、`person+attention+scenario` 这轮答对 **7.5%**，正确值约 **7.5%**（0.008 / (0.008 + 0.099)）。
但每个条件只有一次样本；不能把一次通过当作稳定收益。这说明该题失败主要与模型自身的计算/校准有关，而不是人格上下文。

## 3. 注意力的局限

这个探针里的 AttentionPlan 只是**文本注入**，不是内核强制执行：

- 模型可以读它，也可以忽略它；
- `rest=true` 没有真正阻止调度；
- `floor`/`reserve` 没有在 API 层生效。

因此它测试的是「注意力上下文是否有信息价值」，不是「调度策略是否提升长期效率」。
后者需要内核在 `rest` 时拒绝前台任务，并做多轮/跨会话实验。

## 4. 可复现

```bash
DEEPSEEK_API_KEY=... node tools/deepseek-probe.ts
```

密钥只从环境变量读取，不写入 JSON/仓库。结果文件不含密钥。

## 5. 结论

1. **人格上下文不是免费收益**：对简单任务，它是 4–6× token 的纯开销。
2. **对上下文依赖任务，它是决定性的**：20% → 80%。
3. **注意力计划在需要资源状态的任务上再加 20pp**，但只值得在相关任务上注入。
4. **场景加权（chat 0.5 + engineering 0.5）把 token 降 9%，本次保持 100%**；样本小，需重复验证。
5. **应按任务类型/场景混合做上下文准入**，而不是默认全量注入。
6. **成本要按缓存命中/未命中算**，不能只看 token 总数。
7. **贝叶斯题暴露模型校准问题**，与人格层无关，应单独修。
