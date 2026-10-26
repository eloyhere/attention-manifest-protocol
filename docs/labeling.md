# 标注、一致性、adjudication

> 实现：`src/evaluation/labels.ts`、`tools/label-audit.ts`。
> 责任：把人工标签变成可审计输入，而不是把 `correct` 字段当“人类研究”。

## 1. 标注格式

JSONL/JSON array，或 CSV：

```csv
caseId,annotator,label,note
a,A,correct,"grounded, concise"
a,B,incorrect,wrong constraint
```

JSONL：

```json
{ "caseId": "r-arith-1", "annotator": "A", "label": "correct" }
{ "caseId": "r-arith-1", "annotator": "B", "label": "incorrect" }
```

可选 `note`。同一 `(caseId, annotator)` 只能出现一次；重复会被 audit 标记。

## 2. Audit 输出

`auditLabels(caseIds, annotations)` 返回：

| 字段 | 含义 |
|---|---|
| `coverage` | 至少有一个标注的 case 比例 |
| `missing` | 没有任何标注的 case |
| `duplicates` | 同 annotator 重复标注 |
| `disagreements` | 同一 case 出现多个 label |
| `pairwiseKappa` | 每对 annotator 的 Cohen's κ |
| `adjudicated` | 多数票；平票为 `null`（需要第三人） |

## 3. 当前 fixture

`docs/eval/annotations.json` 由 replay 的 A/B 两组 fixture 生成：

```text
cases=12 covered=12 annotations=24 coverage=100%
disagreements=2 kappa=0.571 unresolved=2
calibration on adjudicated labels: n=10 method=raw ece=0.289
```

最后一行验证“导入标签 → calibration selector”的路径；10 条仍然太少，selector 选择 raw。**这不是独立人工研究**：A/B 都是 fixture，κ 只验证 audit 能发现分歧。正式使用必须换成真实标注者。

## 4. 使用

```bash
node tools/label-audit.ts
node tools/labels-workflow-check.ts
```

Active learning：`selectLabelCandidates` 优先选 `predicted` 接近 0.5、uncertainty 高的样本；预算由 `budget` 控制。

平票：`adjudicated` 为 `null`，用 `resolveUnresolved(audit, {caseId: label})` 填第三人裁决；已有多数票的 case 不会被覆盖。

Coverage gate：`requireLabelCoverage(audit, { minCoverage, maxDuplicates })`；低于阈值/有重复直接抛错，batch 不能进入 calibration。

导入到校准：`node tools/calibrate-imported.ts`；它先检查 coverage/duplicates/unresolved，再调用 `CalibrationRegistry`，证据不足只输出 `refused`。

未来接入真实标注时：

1. 导出 JSONL；
2. 跑 audit，先看 coverage/duplicates；
3. 平票样本交第三人 adjudication；
4. 用 adjudicated label 重跑 `eval-recorded-replay` / calibration selector；
5. 报告 κ 与 ECE，而不是只报 accuracy。

## 5. 规则

- 不允许用模型的 `correct` 自动生成 human label；
- 不允许只报 agreement 不报 κ；
- 不允许把 fixture κ 当人工研究结论；
- 关键样本必须保留分歧，不要强行平均。
