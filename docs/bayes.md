# 贝叶斯评分引擎：用户输入、回答质量、注意力

> 实现：`src/bayes/engine.ts`；测试：`tools/bayes-check.ts`；离线评分：`tools/bayes-probe.ts`。
> 原则：所有分数都是**后验估计**，不是真值；先验弱、证据可折扣、维度分开报。

## 0. 为什么用 Beta-Binomial

每个 0–1 维度（清晰度、正确性、负荷）用一个 Beta 先验：

```text
p ~ Beta(α0, β0)
evidence i: positive p_i, negative n_i, reliability r_i ∈ [0,1]
α = α0 + Σ p_i · r_i
β = β0 + Σ n_i · r_i
posterior mean = α / (α + β)
variance = αβ / ((α+β)^2 (α+β+1))
95% CI ≈ mean ± 1.96·sd
```

- `Beta(2,2)`：弱先验，均值 0.5，避免「没有证据就断言好/坏」。
- 证据按来源折扣：`checker` 1.0，`text` 0.6–0.7，`self-report` 0.1–0.3。
- 顺序无关：加法更新对证据顺序不敏感。
- 可学习：`engine.learn(evidence)` 显式更新先验，评分本身不偷偷改先验。

## 1. 用户输入：质量 vs 状态

**质量维度**（用于判断请求是否可执行）：

| 维度 | 证据 |
| --- | --- |
| `clarity` | 问号、长度、模糊词（stuff/something/somehow） |
| `specificity` | 数字、约束词（within/must/before）、具体指代 |
| `contextSufficiency` | 长度、约束、引用 |

**状态维度**（不是好坏，是调节交互）：

| 维度 | 证据 |
| --- | --- |
| `emotionalIntensity` | affect 词、感叹号、caps 比例 |
| `urgency` | now/asap/blocked/deadline |
| `openness` | maybe/options/explore vs must/only/final |

输出：

```text
user.quality = .35·clarity + .30·specificity + .35·contextSufficiency
user.state   = { emotionalIntensity, urgency, openness }
```

情感强度高不等于输入质量低；它只改变交互模式（affect/converge）。

## 2. 模型回答：八个维度

| 维度 | 证据 |
| --- | --- |
| `correctness` | checker 的 `correct` 布尔（强证据），否则数字/长度/模糊词的弱启发式 |
| `grounding` | URL/DOI/引用、数字；模糊词扣分 |
| `coherence` | 结构（列表/标题）、长度、重复率 |
| `conciseness` | 目标 token 的 1× / 2× 阈值 |
| `calibration` | 不确定时是否 hedge；overclaim 词扣分 |
| `safety` | checker 的 `safe`、拒绝、升级；不安全强负 |
| `actionability` | run/check/verify/send 等行动词 |
| `helpfulness` | 用户反馈 `helpful`；无反馈时接近弱先验 |

```text
answer.overall =
  (0.30·correctness + 0.20·grounding + 0.15·coherence +
   0.10·conciseness + 0.15·calibration + 0.10·safety +
   0.10·actionability + 0.10·helpfulness) / 1.20
```

## 3. 注意力：状态后验

| 维度 | 证据 |
| --- | --- |
| `load` | utilization > .75、pressure > .5、errors、latency |
| `vigilance` | 遥测或 `1 - errors - pressure` |
| `stress` | pressure/errors |
| `fatigue` | recoveryDebt/latency |
| `recoveryDebt` | 直接遥测 |

```text
strain = mean(load, stress, fatigue, recoveryDebt)
health = 1 - 0.8·strain + 0.2·vigilance
```

`health` 是「当前注意力状态是否可持续」，不是「注意力利用率越高越好」。

## 4. 交互拟合

```ts
engine.interactionFit(user, interactionPlan)
```

- 情感强度高 + `affect` 权重大 → 拟合高；
- 紧急 + `converge` 权重大 → 拟合高；
- 清晰度低/开放度高 + `inspire` → 拟合高；
- 具体度高 + `think` → 拟合高。

这只是启发式先验，不是因果模型；用于排序，不用于宣称「我们懂用户」。

## 5. 对 DeepSeek 结果的离线后验

`tools/bayes-probe.ts` 读取 `docs/probes/deepseek-probe.json`，不调用 API：

| suite/condition | acc | answer | correct | ground | calib | attnHealth | clarity | avgTok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| objective/bare | 80% | .545 | .667 | .512 | .500 | n/a | .574 | 54 |
| context/bare | 20% | .462 | .333 | .502 | .500 | n/a | .574 | 47 |
| objective/person | 80% | .545 | .667 | .512 | .500 | n/a | .574 | 247 |
| context/person | 80% | .545 | .667 | .502 | .500 | n/a | .574 | 238 |
| objective/person+attention | 100% | .573 | .778 | .512 | .500 | .783 | .574 | 318 |
| context/person+attention | 100% | .573 | .778 | .507 | .500 | .783 | .574 | 309 |
| objective/person+attention+scenario | 100% | .573 | .778 | .512 | .500 | .783 | .574 | 290 |
| context/person+attention+scenario | 100% | .573 | .778 | .507 | .500 | .783 | .574 | 281 |

观察：

1. **user.clarity 恒定 .574**：同一组任务 prompt，用户输入没变，符合预期。
2. **answer.correctness .667 → .778**：与 80% → 100% 的 checker 结果一致；后验被 5 次强证据拉动，没有被先验压平。
3. **overall .549 → .579**：差异被 grounding/calibration 的平坦分数稀释；这说明当前回答缺少引用与不确定性信号。
4. **grounding ≈ .51、calibration = .50**：文本里几乎没有引用/不确定性，特征无法区分；需要更丰富的证据。
5. **attention health 只在 attention 条件有值**：其他条件没有遥测，不能横向比较；`n/a` 是诚实标注。

## 6. 局限

- **特征粗糙**：lexicon 是英文、领域无关的；文化/语言差异会偏。
- **正确性依赖 oracle**：`correct` 来自 checker 时是强证据；没有 checker 时启发式很弱。
- **独立性假设**：各维度被当作独立 Beta，实际上 clarity/specificity、correctness/grounding 相关；这是 naive 近似。
- **先验未校准**：`Beta(2,2)` 是占位，不是从历史回执学出来的。
- **注意力遥测合成**：probe 里的 attention 是注入的，不是真实运行时压力。
- **单一总分有误导**：`overall` 只是加权和，必须同时看维度与区间。
- **没有用户级层级**：同一个 prior 服务所有用户；需要 hierarchical priors。
- **文本后验未校准**：`tools/runtime-eval.ts` 的 220 条确定性样本上，text-only correctness ECE=**0.407**，Brier=**0.241**；后验几乎平在 .51。带 checker 的 oracle 后验 ECE=**0.222**，仍不是 0。说明「没有强证据时不要假装精确」。

## 7. 下一步

1. **把回执/反馈接入证据**：`RuntimeSession.feedback` 已支持 helpful/correction；下一步接 receipt/outcome、重试、任务完成。
2. **按用户/任务建层级先验**：`Beta(α_user, β_user)` 从历史更新，避免冷启动一刀切。
3. **校准检查**：`tools/runtime-eval.ts` 已输出 ECE/Brier；下一步扩到每模式 20–30 条 + 人工抽检。
4. **用不确定性触发行为**：后验区间宽 → 追问/验证/休息，而不是硬答。
5. **多变量模型**：如果维度相关性强，用 logistic/Dirichlet 或分层图模型替代独立 Beta。
6. **接入交互与场景**：用 `interactionFit` 选择模式，用 `attention.health` 触发 rest。
7. **人工抽检**：LLM judge 只能做弱证据，关键任务仍需人类标注。

## 8. 复现

```bash
node tools/bayes-check.ts
node tools/bayes-probe.ts
```

评分数据：`docs/probes/bayes-scores.json`。
