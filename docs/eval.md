# Runtime Eval：确定性流水线 + 校准指标

> 实现：`tools/runtime-eval.ts`；数据：`docs/probes/runtime-eval.json`。
> 全量 verify 包含它；不调用网络。

## 1. 它测什么

**220 条生成 case**，覆盖：算术、唯一行、逻辑、记忆、角色、注意力、贝叶斯：

| 类别 | n | 期望 |
| --- | ---: | --- |
| arithmetic | 50 | a+b，输出数字 |
| unique-rows | 40 | n 行 d 重复 → n-d |
| syllogism | 30 | All A are B; no B are C → no |
| memory | 30 | Mira 的 code-i |
| role | 30 | Analyst + ground claims in evidence |
| attention | 20 | 2 foreground slots; safety floor 1 |
| bayes | 20 | 7.5% 左右 |

其中约 8% 是故意错误答案，用来测校准，不是测模型能力。`humanLabel` 字段是人工标注 hook；当前 `humanLabeled=0`。

模型用 `ScriptedLlm` 固定回答，所以这是**流水线 eval**，不是模型能力 benchmark。它验证：

- runtime 是否按 scenario/interaction/attention 组装；
- answer posterior 是否产生；
- token/usage/receipt 是否闭环；
- 后验 correctness 是否校准。

## 2. 指标

```text
accuracy = correct / n
ECE      = Σ (n_bin / n) · |accuracy_bin - confidence_bin|
Brier    = mean((p - y)^2)
```

同时报两个后验：

- **text-only**：不把 checker 结果喂给评分，模拟真实运行时；
- **oracle**：把 `correct` 作为强证据，代表「有可靠 checker 时」的上界。

## 3. 当前结果（220 条，确定性）

```text
cases=220 accuracy=91.8%
textECE=0.407   textBrier=0.241
oracleECE=0.222
tokens=2850     cost~$0.000427
```

分类：

```text
arithmetic   90.0%  ece=0.387
unique-rows  90.0%  ece=0.387
syllogism    93.3%  ece=0.425
memory       90.0%  ece=0.387
role        100.0%  ece=0.491
attention   100.0%  ece=0.487
bayes        80.0%  ece=0.287
```

观察：

1. text-only correctness 仍几乎平在 **.51**：没有 checker 时，词法启发式不足以区分对错；220 条下 ECE 0.407，比 6 条时更稳定，也更明确地坏。
2. oracle 后验 ECE 0.222：即使有强证据，`Beta(2,2)` + 5 次证据只到 .778/.222，仍与 0/1 有距离。
3. 分类 accuracy 的差异来自故意错误比例，不是模型能力。
4. 成本极低是因为 ScriptedLlm 的 token 是固定的；不要拿它当真实模型成本。

## 4. 局限

- **生成 case 同质化**：220 条主要是模板生成，不能替代真实用户分布。
- **ScriptedLlm 是固定答案**：不能测语言质量、工具选择、真实延迟。
- **oracle 是上界**：真实场景没有免费 checker；需要 rubric/人工/可验证任务。
- **主 eval 的 `humanLabeled=0`**：只有 hook；`replay-cases.json`（12 条）和 `recorded-labels.json`（10 条）都是 **fixture labels**，不是人工研究。
- **类别不均衡**：role/attention 全对，ECE 高但信息量低。
- **ECE 仍受模板/分布影响**：220 条模板 + 40 条 recorded，不是真实用户分布。
- **只测英文/短答案**：语言与文化偏差未覆盖。

## 4.1 Replay（fixture labels）

`tools/eval-replay.ts` 读取 `docs/eval/replay-cases.json`：

```text
cases=12 accuracy=67%
labelAgreement=100%  annotatorAgreement=83%  Cohen's kappa=0.571
brier=0.247
```

它验证的是 label→metric 路径和 replay plumbing，不是人工标注质量；两组标签都是 fixture，κ=0.571 只说明「有分歧时指标能反映」，不是独立标注者研究。

## 4.2 Recorded model replay

`tools/eval-recorded-replay.ts` 读取 `deepseek-probe.json` 的 40 条真实模型回答，重新走 runtime（不调用 API）：

```text
runs=40 accuracy=82.5%
textECE=0.314  calibratedECE=0.281  selected=temperature(T=0.25, CI=-0.034..-0.030)  oracleECE=0.222
labels=10      labelAgreement=100%
```

**校准结果（checker 标签，不是人工）**：isotonic 的 ECE 是 0.361（更差），temperature 的 5-fold ECE 是 0.281，`CalibrationRegistry` 因此激活 temperature。它证明机制可用，但**不证明人工泛化**；`docs/annotation-campaign.csv` 的 A/B 人工标签到位前，不把这次激活当人工研究结论。详见 `docs/calibration-control-audit.md`。

统一汇总见 `docs/eval-summary.md`（由 `tools/eval-summary.ts` 生成）。

按条件：

```text
objective/bare                      80%  textECE=.288
context/bare                        20%  textECE=.309
objective/person                    80%  textECE=.288
context/person                      80%  textECE=.291
objective/person+attention         100%  textECE=.488
context/person+attention           100%  textECE=.490
objective/...scenario              100%  textECE=.488
context/...scenario                100%  textECE=.490
```

注意：attention 条件 accuracy 100% 但 text ECE 更高，说明「答对」不等于「后验校准」；ECE 变差是因为模型答对时后验仍偏保守。oracle ECE 仍 .222。

## 5. 下一步

1. 每 scenario/interaction 20–30 条，共 ≥200 条；固定随机种子。
2. 用真实/recorded 模型扩到更多任务；CI 仍用 ScriptedLlm。
3. 加 rubric 评分与 10% 人工抽检；报告 inter-rater agreement。
4. 报告 p50/p95 latency、tool call 成功率、rest 触发率、安全事件。
5. 用 ECE/Brier 选先验/证据可靠性，而不是手调。
6. 按用户/任务分层报告，避免平均值掩盖冷启动问题。
