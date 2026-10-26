# 校准、行为裁决与审计：调研与修复方案

> 目标：修当前四个已知问题——后验校准弱、fixture 标签、behavior 冲突、审批/审计分散。
> 结论：**behavior priority/hard guardrail + 独立 approval outbox 已落地；isotonic 校准在 40 条真实 recorded 数据上反而变差，不能上线，需要更多人工标签。**

## 1. 当前问题（来自实测）

```text
recorded replay 40 runs: accuracy=82.5%
text-only ECE=0.314  Brier≈0.241
oracle ECE=0.222
fixture labels=10，agreement=100%（非独立人工）
```

问题不是「模型全错」，而是：

1. 后验几乎不随对错变化；
2. 标签太少，无法验证校准；
3. 多个 behavior 同时激活时只做并集，没有裁决；
4. 审批/拒绝只存在 turn 里，没有独立审计事件。

## 2. 调研结论

### 2.1 校准：ECE/Brier 只是起点，post-hoc 会过拟合

- ECE 是分箱后的加权置信度-准确率差，Brier 是概率预测的平方误差；两者都不能单独证明校准。
- 常见 post-hoc 方法：temperature scaling、isotonic regression、Beta calibration；它们不改变模型参数，只改输出映射。
- 小样本上 isotonic 很容易把噪声当单调关系；必须用 **交叉验证/留出集**，否则「校准后 ECE 下降」可能只是 in-sample overfit。

来源：[Calibration across methods](https://export.arxiv.org/pdf/2610.24969#9#9#9)、[post-processing calibration](https://dl.acm.org/doi/pdf/10.1145/3832783.3837465?download=true#2#5#2)、[calibration comparison table](https://www.nature.com/articles/s41598-026-54840-2/tables/3)。

**本项目的实测**：40 条 recorded 上，raw text ECE=0.314；5-fold isotonic 后 ECE=**0.361**，更差。加入 `selectCalibration` 后，selector 选择 **raw**，因此不再强行上线校准映射。结论：当前数据量不足以拟合校准，保留 raw + 区间。

### 2.2 行为裁决：subsumption / behavior tree 都强调「单一控制权」

- Brooks 的 subsumption architecture 用分层行为，每层可以抑制/覆盖低层；同一时刻只有一层控制执行器。
- Behavior tree 的 selector/sequence 也是显式优先级/条件控制，而不是把所有叶节点都执行。
- 对本项目的含义：behavior 不能只做 guardrail 并集；必须有 **priority + hard/soft**，并且记录冲突。

来源：[subsumption behavior preference](https://utoronto.scholaris.ca/bitstreams/92719b2f-c6d5-4580-ad15-468ac5c94567/download#16#26#16)、[Brooks decomposition](https://open.metu.edu.tr/bitstream/handle/11511/15019/index.pdf#2#6#2)、[composite behaviors](https://cs.gmu.edu/media/techreports/GMU-CS-TR-2009-4.pdf#3#3#3)。

**已落地**：

- `Behavior.priority`；
- `BehaviorPolicy.hardGuardrail`；
- `BehaviorPlan.preferredActions` / `winner` / `conflicts`；
- 硬 guardrail 始终保留，但 action preference 由最高优先级 soft behavior 决定；
- `SingleActionPlanner` 使用 winner 的 preferredActions。

实测：`overwhelmed, fix it` 同时触发 affect（80）与 clarify（75）；affect 胜出，conflict 被记录，action=`acknowledge_then_converge`。

### 2.3 审计：审批应是独立事件，不是 turn 的附属字段

- HITL 审计日志/审批门通常要求：谁、对什么、什么风险、批准/拒绝、何时、为什么。
- 事务性 outbox 适合把「业务提交」和「审计事件」放在同一事务，再由 dispatcher 分发。
- 对本项目的含义：`runtime.approval` 应该是独立 topic，而不是只塞进 `runtime.receipt`。

来源：[HITL audit log](https://gdplabs.gitbook.io/sdk/gl-aip-ai-agent-package/resources/reference/rest-api/hitl-audit-log)、[approval-gate](https://pypi.org/project/approval-gate/#1)、[regulated approval workflows](https://learn.microsoft.com/zh-cn/training/modules/aaai-design-human-in-loop-approval-workflows/5-configure-audit-workflows-regulated-decisions?pivots=video)。

**已落地**：

- `ApprovalRecord`（operationId/tool/risk/decision/status）；
- `RuntimeTurn.approvals`；
- `KernelRuntime` 为每个 approval 发独立 `runtime.approval` outbox 事件；
- destructive 未审批时 status=denied，且 executor 不执行。

### 2.4 人工评估：agreement 不是 accuracy 的替代品

- 人工标注要报告 inter-rater agreement（Cohen's κ / Fleiss κ），并保留分歧，而不是只报平均分。
- LLM-as-judge 只能做弱证据；关键任务需要独立标注者。
- 对本项目的含义：10 条 fixture labels 只能验证 label→metric 路径，不能宣称「人工验证」。

来源：[Cohen's κ in LLM annotation](https://zenodo.org/records/23332934/files/R8_preprint_v1.9.3.pdf?download=1#6#11#6)、[inter-rater reliability study](https://zenodo.org/records/21740239#1)、[conflict-aware disagreement](https://ieeexplore.ieee.org/document/11430705/citations#citations#3)。

### 2.5 心理学：冲突监控与元认知控制

- ACC 的 conflict monitoring 假说：冲突信号用于调整控制强度，而不是直接决定动作。
- 元认知监控/控制：置信度监控应触发「追问/验证/休息」，而不是只产生一个分数。

来源：[ACC conflict monitoring](https://www.sciencedirect.com/science/article/abs/pii/S1053811901909231#1)、[metacognitive monitoring/control](https://scholar.google.com.mx/citations?view_op=view_citation&hl=fa&user=3eFuVhgAAAAJ&sortby=pubdate&citation_for_view=3eFuVhgAAAAJ:Tyk-4Ss8FVUC)。

**设计含义**：

- Behavior conflict 不是错误，而是控制信号；记录冲突用于调参/审计。
- 后验区间宽时，触发追问/验证，而不是硬答。
- 不要把「答对率」当成「校准好」。

## 3. 修复方案

### P0（已落地）

1. `BehaviorRegistry` priority / hardGuardrail / conflict arbitration。
2. `ApprovalRecord` + `runtime.approval` outbox。
3. `src/bayes/calibration.ts`：ECE/Brier/isotonic/cross-validation；先只用于 eval，不上线。
4. `calibration-check` + recorded replay 报告 calibrated ECE。

### P1（下一步）

1. **更多标签**：至少 100 条独立标注；报告 Cohen's κ；不要用 `correct` 自动生成标签。
2. **分层先验**：按用户/任务建 `Beta(α,β)`，而不是全局 `Beta(2,2)`。
3. **校准门控**：只有 cross-val ECE 显著优于 raw 才启用映射；否则保持 raw + 区间。
4. **行为冲突指标**：记录 winner/loser 频率，按场景调 priority。
5. **审计保留**：`runtime.approval` 独立表/保留策略、脱敏、访问控制。

**已落地（P1 的两块基础设施）**：

- `SourceReliability`：按 source 记录 α/β，`BayesianEngine` 接受 `sourceWeights`，低可靠来源的证据权重下降；未见过来源默认 1，不改变旧行为。
- `src/evaluation/agreement.ts`：`agreementRate` / `cohenKappa` / `fleissKappa`；`eval-replay` 用两组 fixture 标签报告 κ=0.571。
- `selectCalibration`：raw / isotonic / shrunk 三候选，5-fold CV 选 ECE 最低；recorded 40 条上选择 **raw**，拒绝更差的 isotonic。
- `runtime_approvals` 独立表：`outboxEventSink` 在 `runtime.approval` 事件时双写 outbox + approval 表；支持 `list(pid)` / `prune(before)`；`listForSubject` 走 authz（owner 或 read grant），tool/decision 写入前脱敏。
- `RuntimeSession.behaviorConflicts`：记录 winner←loser 频次，并随 session snapshot 持久化。
- `TurnFeedback.actualCorrect`：用户给出实际对错后，更新 `SourceReliability`，并通过 `BayesianEngine.setSourceWeights` 影响后续评分；reliability 随 session snapshot 持久化。
- `ScopedPriors`：`global prior + local counts`；支持 `globalWeight` 部分池化；未见 scope 回退到 global。
- `RuntimeSession` 已接 `scope`：每轮用 `engineFor(scope)` 评分，record/feedback 更新 local counts，snapshot 恢复 scope priors；未显式指定时自动派生 `session:primary-scenario`。
- `calibration-sim.ts`：合成 400 条带信号的 overconfident 数据上，raw ECE 0.173 → isotonic 0.058，证明 selector 在数据足够时会启用映射；在 recorded 40 条上仍选择 raw。
- `scoped-priors-pooling.ts`：partial pooling 下未见 scope 从共享证据得到先验（pooled mean 0.963 vs unpooled 0.500）。
- `CalibrationRegistry`：只有 `samples >= minSamples` 且 CV ECE 比 raw 至少改善 `minImprovement` 才激活映射；否则保持 raw。recorded 40 条 → status=raw。

这仍然不是独立人工标注，只是把「可靠性」「一致性」「审计保留」变成可计算/可查询量。

### P2

1. 主动学习：优先标注后验不确定/行为冲突的样本。
2. Conformal prediction：给区间覆盖率，而不是只给点估计。
3. 多标注者一致性 + adjudication 流程。

## 4. 验收标准

- behavior conflict 有 winner/conflicts，且 destructive hard guardrail 不被覆盖；
- 每次 destructive 审批都有独立 `runtime.approval` 事件；
- calibration 模块有交叉验证，且不会在样本不足时宣称改善；
- eval 报告 raw/calibrated/oracle 三组 ECE/Brier；
- 全量 verify + tsc 绿。

## 5. 当前实测结论

```text
raw text ECE      0.314
isotonic CV ECE   0.361   ← 更差
selected method   raw     ← selector 拒绝校准映射
oracle ECE        0.222
```

这证明：**校准不是「加一个 isotonic 就变好」；没有足够标签时，最诚实的做法是保留 raw + 不确定性区间，并继续收集标签。**

## 6. 参考

- [Calibration across methods](https://export.arxiv.org/pdf/2610.24969#9#9#9)
- [Post-processing calibration](https://dl.acm.org/doi/pdf/10.1145/3832783.3837465?download=true#2#5#2)
- [Calibration comparison](https://www.nature.com/articles/s41598-026-54840-2/tables/3)
- [Subsumption behavior preference](https://utoronto.scholaris.ca/bitstreams/92719b2f-c6d5-4580-ad15-468ac5c94567/download#16#26#16)
- [HITL audit log](https://gdplabs.gitbook.io/sdk/gl-aip-ai-agent-package/resources/reference/rest-api/hitl-audit-log)
- [Cohen's κ](https://zenodo.org/records/23332934/files/R8_preprint_v1.9.3.pdf?download=1#6#11#6)
- [ACC conflict monitoring](https://www.sciencedirect.com/science/article/abs/pii/S1053811901909231#1)
