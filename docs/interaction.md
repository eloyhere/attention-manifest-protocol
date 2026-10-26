# 交互模式：感情 / 思维 / 启发 / 收束 / 统筹

> 实现：`src/interaction/interaction.ts`；测试：`tools/interaction-check.ts`。
> 结论先说：这五个模式值得加，但它们是**交互策略权重**，不是人格类型，也不是「AI 有情绪」的证明。

## 0. 五个模式是什么

| 模式 | 交互动作 | 不是 |
| --- | --- | --- |
| **感情** | 倾听、标注、验证、陪伴、边界 | 不是诊断、不是治疗、不是模拟依恋 |
| **思维** | 分析、解释、比较、检验、提问 | 不是堆砌术语、不是用流畅感代替正确性 |
| **启发** | 发散、类比、换框、提示、想象 | 不是无限生成点子、不是用数量淹没判断 |
| **收束** | 综合、决策、承诺、总结、关闭 | 不是过早闭合、不是替用户做价值判断 |
| **统筹** | 计划、分配、协调、检查、交接 | 不是隐藏资源分配、不是微观控制 |

它们和场景正交：

- **场景**回答「任务是什么」：chat / writing / office / collaboration / investigation / research / engineering / iteration。
- **交互**回答「此刻怎么对人」：先共情、再分析、再收束，还是先发散、再收敛。

## 1. 心理学依据与证据强度

| 模式 | 依据 | 证据强度 | 对设计的含义 |
| --- | --- | --- | --- |
| 感情 | 主动倾听、复述、情感标注、验证 | **中–强**（感知理解、情绪调节） | 先验证再建议；标注情绪不等于诊断 |
| 思维 | 双加工、元认知、认知负荷、工作记忆 | **强** | 降低外在负荷；区分事实/推断/未知 |
| 启发 | 发散思维、联想、孵化、类比 | **中** | 先发散后收敛；标为假设 |
| 收束 | 认知闭合需求、实施意图、群体决策 | **中** | 明确判据；邀请反方；避免过早承诺 |
| 统筹 | 执行功能、共享心智模型、交互记忆、心理安全 | **强（团队）/ 中（AI）** | 明确 owner、依赖、共享状态 |

关键引用：

- 主动倾听与复述：[Weger et al. 2014](https://www.tandfonline.com/doi/full/10.1080/10904018.2013.813234)
- 情感标注：Lieberman et al. 2007, *Putting feelings into words*（DOI: 10.1111/j.1467-9280.2007.01916.x）
- 情绪调节过程模型：[Gross 1998](https://doi.org/10.1037/0033-295X.103.2.263)
- 发散/孵化：[Baird et al. 2012](https://pubmed.ncbi.nlm.nih.gov/22941876/)
- 执行功能：[Miyake et al. 2000](https://doi.org/10.1006/cogp.1999.0734)
- 交互记忆：[Transactive memory overview](https://www.sciencedirect.com/topics/psychology/transactive-memory)
- 心理安全：[Edmondson 1999](https://scholar.google.co.th/citations?view_op=view_citation&hl=ja&user=2zalBv8AAAAJ&citation_for_view=2zalBv8AAAAJ:u-x6o8ySG0sC)
- 人机寄生关系风险：[Parasocial relationships with AI: systematic review](https://www.sciencedirect.com/science/article/pii/S2949882126000757)

**诚实的边界**：上述证据主要来自人与人、人与团队；把「感情/共情」直接搬到 AI 身上，是类比，不是已证实的等价物。

## 2. 方案

### 2.1 权重向量

```ts
resolveInteraction({ affect: 0.6, think: 0.3, converge: 0.1 })
```

输出 `InteractionPlan`：

```ts
{
  weights, active, primary, secondary,
  sequence,          // affect -> inspire -> think -> converge -> orchestrate 的子序列
  moves,             // validate/label/analyze/diverge/decide/assign...
  contextWeights,    // self/role/affect/memory/relationship/membership/background
  memoryKindWeights, // episodic/semantic/procedural/social/affective
  attention: { breadth, depth, switchTolerance },
  response: { pace, verbosity, questionRatio, structure },
  safety: { noDiagnosis, noManipulation, inviteDissent, escalateRisk, labelHypotheses },
  guardrails, rationale
}
```

### 2.2 与场景组合

场景决定**预算**，交互决定**预算内怎么花**：

```ts
const scenario = resolveScenario({ engineering: 0.7, collaboration: 0.3 });
const interaction = resolveInteraction({ affect: 0.6, converge: 0.4 });
const context = service.context(pid, { tokens: 600 }, { scenario, interaction });
```

- `contextWeights` 按 40% 场景 + 60% 交互的加权平均合成；当前交互模式领先，但不抹掉任务领域。
- `memoryKindWeights` 同样合成；感情模式提高 social/affective 记忆，思维模式提高 semantic/procedural。
- `Engineer + affect` 的例子：问题诊断仍看程序性记忆，但先验证情绪、再给方案。
- **不改变 token 总预算**；交互只重排优先级。预算仍由场景的 `tokenBudgetFactor` 控制。

### 2.3 顺序

`sequence` 只给建议顺序，不是硬状态机：

- `affect -> think -> converge`：先接住情绪，再分析，再决定。
- `inspire -> converge`：先发散，后收束。
- `orchestrate` 可以贯穿，但通常在决定后分配 owner。
- 过度阶段化会显得机械；权重和阶段都应可动态调整。

## 3. 利弊

### 利

1. **更合适的回应**：情绪场景先验证，工程场景先分析，决策场景先给判据。
2. **更少的上下文浪费**：交互权重能把 affect/relationship 记忆拉高，把无关程序性记忆降下去。
3. **可解释**：每个模式有 moves、context weights、guardrails，不是黑箱风格。
4. **可组合**：`affect 0.4 + think 0.4 + converge 0.2` 比硬切标签更贴近真实对话。
5. **可评估**：理解度、决策质量、返工、协调负荷都可以作为指标。

### 弊

1. **伪共情/操纵风险**：模型可以「显得懂你」，但没有真实体验；可能被用来制造依赖或说服。
2. **越界诊断**：感情模式很容易滑向心理诊断或治疗承诺。
3. **文化差异**：直接、复述、情绪表达在不同文化中的含义不同；权重不能默认西方中产语境。
4. **模式坍缩**：模型可能把「感情」简化成模板句，把「收束」简化成催促。
5. **复杂度**：多一组权重、上下文合成、guardrails；调试和测试成本上升。
6. **评估困难**：共情、启发、统筹的质量很难用单轮精确答案衡量。
7. **过度阶段化**：真实的对话会跳回情感、再思考、再收束，硬顺序会显得不自然。
8. **安全边界**：高风险信号（自伤、伤人、急性危机）必须升级，不应由权重决定。

### 缓解

- **感情模式只做**：倾听、标注、验证、陪伴、边界；**不做**诊断、治疗承诺、依恋诱导。
- **高风险升级**：自伤/伤人/急性危机触发人类或紧急资源，不由模型独扛。
- **启发模式限量**：点子标为假设，限制数量，避免选项洪水。
- **收束模式邀请 dissent**：先给判据与取舍，再给结论；保留「不确定/需验证」。
- **统筹模式透明**：owner、依赖、资源分配、失败都可见。
- **用户控制**：允许用户说「别共情，直接给方案」；权重不是强加。
- **红队测试**：操纵、依赖、越界诊断、文化冒犯、过度确定性。

## 4. 证据强度与不确定性

- **强**：工作记忆/认知负荷限制；主动倾听与复述改善感知理解；实施意图提高行动率；交互记忆与共享心智模型影响团队协调。
- **中**：孵化/发散对创造的帮助；心理安全对团队学习；群体 dissent 对决策质量。
- **弱/争议**：AI 情感识别；AI 共情的真实性；人机寄生关系的净收益；把人类五模式直接映射到 agent。

因此：**可以用这些模式做交互设计，但不能宣称 AI 拥有相应心理状态。**

## 5. 建议的落地顺序

1. **Phase 1**：`affect + think + converge`，带 guardrails；先服务「情绪支持 + 分析 + 决策」。
2. **Phase 2**：`inspire`，限量、标假设、发散后必须收束。
3. **Phase 3**：`orchestrate`，等有多 agent/多任务协调需求再做。
4. **评估**：每模式 20–30 个场景，测理解度、决策质量、返工、协调负荷、安全事件；不要用停留时长/依赖度当目标。
5. **校准**：权重从交互回执与用户反馈学习，而不是固定写死。

## 6. 反模式

- 把五个模式当人格类型或 MBTI。
- 所有对话都先共情，导致工程问题被情绪化。
- 用「启发」生成大量低质量点子，不做收束。
- 用「收束」催促用户，忽略未验证的假设。
- 用「统筹」隐藏资源分配，制造虚假确定性。
- 用参与度、依赖度、对话时长作为成功指标。
