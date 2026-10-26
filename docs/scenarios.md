# 场景：加权混合，不是互斥模式

> 实现：`src/scenario/scenario.ts`；测试：`tools/scenario-check.ts`。
> 设计原则：任务通常不是「纯聊天」或「纯工程」，而是 `chat 0.6 + engineering 0.3 + collaboration 0.1` 这样的权重向量。

## 0. 场景列表

| 场景 | 主要用途 | context depth | token 乘数 | 典型记忆 |
| --- | --- | ---: | ---: | --- |
| `chat` | 闲聊、情绪支持、快速确认 | 0.20 | 0.4× | social / affective |
| `writing` | 写作、改写、风格 | 0.50 | 0.8× | semantic / procedural |
| `office` | 邮件、日程、文档、流程 | 0.60 | 0.7× | semantic / procedural |
| `collaboration` | 协作、会议、分工、冲突 | 0.70 | 0.8× | social / episodic |
| `investigation` | 事故、审计、取证 | 0.90 | 1.2× | episodic / semantic |
| `research` | 文献、假设、长链路研究 | 0.90 | 1.3× | semantic / procedural |
| `engineering` | 代码、调试、架构 | 0.85 | 1.1× | procedural / semantic |
| `iteration` | 快速试错、版本迭代 | 0.70 | 0.8× | episodic / procedural |

## 1. 权重组合

输入：

```ts
resolveScenario({ chat: 0.6, engineering: 0.3, collaboration: 0.1 })
```

输出：

```ts
{
  weights: { chat: 0.6, engineering: 0.3, collaboration: 0.1, ... },
  active: ["chat", "engineering", "collaboration"],
  contextWeights: { self, role, affect, memory, relationship, membership, background },
  memoryKindWeights: { episodic, semantic, procedural, social, affective },
  tokenBudgetFactor: ...,
  contextDepth: ...,
  mode: "bare" | "compact" | "full",
  attention: { maxForegroundUtil, reserveRatio, minSliceSlots, restAfterCycles },
  style: { verbosity, toolBias },
}
```

规则：

1. 权重必须非负、至少一个正数；内部归一化到 1。
2. 所有数值属性按权重加权平均；离散属性（verbosity/tool bias）按权重投票。
3. `contextWeights` 再归一化，用于 context 预算分配。
4. `mode`：`depth < 0.35` → bare；`< 0.7` → compact；否则 full。
5. `tokenBudgetFactor` 限制在 `[0.3, 1.5]`，避免极端组合放大预算。
6. `contextWeights` 为 0 的段不加载；`memoryKindWeights` 为 0 的记忆不参与排序。

## 2. 与 AgentContext 的接线

```ts
const plan = resolveScenario({ chat: 0.5, engineering: 0.5 });
const context = service.context(pid, { tokens: 600 }, { scenario: plan });
```

效果：

- `total = contextBudgetTokens(plan, 600)`；chat+engineering 0.5/0.5 → `600 × 0.75 = 450`。
- 每个 context 段的 cap 用 `plan.contextWeights[kind]`，而不是固定 `Shares`。
- memory 排序乘以 `0.5 + memoryKindWeights[kind]`；权重 0 的记忆直接跳过。
- `context.scenario` 保留在结果里，便于追溯。

## 3. 与注意力的接线

```ts
const policy = scenarioAttentionPolicy(plan);
planAttention(processAttention(pid, state, policy), candidates, policy);
```

- `chat`：前台 0.5、reserve 0.35、rest cycles 10；
- `engineering`：前台 0.8、reserve 0.2、min slice 2、rest cycles 6；
- `research`：前台 0.8、reserve 0.2、token 1.3×。

场景只提供**建议**；内核仍可选择拒绝/降级，而不是无条件服从。

## 4. 实测（DeepSeek）

同一组任务，`chat 0.5 + engineering 0.5` 对比全量 person+attention：

| 条件 | objective 正确率 | objective 平均 token | context 正确率 | context 平均 token |
| --- | ---: | ---: | ---: | ---: |
| person+attention | 80% | 318 | 100% | 309 |
| person+attention+scenario | 100% | 290 (-9%) | 100% | 281 (-9%) |

详见 `docs/deepseek-probe.md`。注意：objective 的 +20pp 来自贝叶斯题的单次通过，样本太小，不能归因于场景本身。

## 5. 为什么不是互斥标签

- 同一句话可能是「聊天 + 写作」：情绪支持 + 改写。
- 一次事故处理是「调查 + 协作 + 工程」。
- 硬切场景会丢掉次要但关键的 facet；权重混合保留它，只是降低预算。

## 6. 反模式

- 把场景当 system prompt 的一句话，而不是预算/权重。
- 给每个场景固定 1.0 预算；chat 也全量注入。
- 忽略权重为 0 的段，却仍加载其存储。
- 用场景标签替代任务判断；权重应由任务/回执校准。
- 只降 token，不看质量；场景应接受质量回归测试。

## 7. 下一步

1. **自动推断 mix**：从任务文本、工具调用、角色、历史回执推断权重，而不是人工输入。
2. **用回执校准**：错误率、返工率、延迟、token 反推每个场景的 `tokenFactor` 与 `contextDepth`。
3. **缓存优化**：相同 scenario/system prompt 前缀复用，降低实际成本。
4. **强制策略**：scene 的 `mode=bare` 时跳过 person context；attention `rest` 时拒绝前台任务。
5. **A/B 扩展**：每场景 20–30 题，报告置信区间。
