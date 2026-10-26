# 盲标 campaign：52 条真实回答

> 目的：替换 `docs/eval/annotations.json` 里的 fixture A/B 标签，得到独立人工标签，再决定 calibration 是否激活。

## 1. 文件

- `docs/annotation-campaign.csv`：52 条（12 replay + 40 recorded），已含 `input/answer/expected`，**不含 checker/actual**。
- 每行 `annotator` 和 `label` 为空，供两名标注者分别填写。
- `expected` 只对 replay 有值；recorded 留空，避免按 expected 对齐。

## 2. 标注规则

- 只判 `correct` / `incorrect` / `unsure`；
- 先独立完成，不讨论、不看另一方；
- 不确定就用 `unsure`，不要猜；
- `note` 写理由，尤其是 incorrect/unsure；
- 不要参考 repo 里的 `humanLabel` / `actual` / probe 结果。

## 3. 操作

1. 复制两份：
   - `docs/annotation-campaign-A.csv`
   - `docs/annotation-campaign-B.csv`
2. A/B 各自填 `annotator`（A/B）和 `label`。
3. 合并：

```bash
node tools/import-campaign.ts docs/annotation-campaign-A.csv docs/annotation-campaign-B.csv
```

4. Audit：

```bash
AMP_ANNOTATIONS_PATH=docs/eval/annotations.imported.json node tools/label-audit.ts
```

5. 平票用第三人裁决，再填 `resolveUnresolved` 或人工修订 `annotations.imported.json`。

## 4. 当前输出预期

- coverage 应接近 100%；
- κ 是真实标注者之间的一致性，不再是 fixture 的 0.571；
- 如果 κ 低，先修标注指南/案例，不要直接拿来激活 calibration。

## 5. 禁止

- 不得用模型生成 `label` 冒充人工；
- 不得用 `actual`/checker 自动填标签；
- 不得只报 accuracy 不报 κ 与 coverage；
- 不得在平票时强行平均。

## 6. 与 calibration 的关系

`CalibrationRegistry` 只在 `samples >= minSamples` 且 CV ECE 比 raw 至少改善 `minImprovement` 时激活。人工标签进来后：

```bash
node tools/eval-recorded-replay.ts
node tools/eval-summary.ts
```

如果 registry 仍选 raw，就接受 raw；不要为了“激活”而降低阈值。
