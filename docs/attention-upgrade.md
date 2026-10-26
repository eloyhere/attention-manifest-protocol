# 注意力分配升级提案（AMP v0.2）

**状态**：提案，非规范 · 2026-10
**证据底座**：[`docs/research/human-attention-allocation.md`](research/human-attention-allocation.md)（描述性：人的注意力机制如何运转）
与 [`docs/research/attention-economics.md`](research/attention-economics.md)（规范性：什么值得注意）
**模型推导**：[`docs/cognitive-model.md`](cognitive-model.md)（为什么是这些字段、每个状态变量什么条件下应被推翻）
**范围**：`§5 注意力层` · `§3.6 控制器` · `§3.8 不变量` · `§8.4 校准` · `§9/§13` 与 `src/attention/`、`src/runtime/`

---

## 0. 一句话诊断

> **两个账本都写进去了，但注意力账本从来没有被读回来。**

`schema` 与不变量描述的是一个**有状态控制器**：它记得刚看过什么（`ignored.revisit_if`）、会习惯化（§5.7 的 ×0.8 衰减）、会防抖（§5.3 的「10 周期内模式切换 ≤3 次」）、会用实测校准自己的 VOI（§5.2 的 MAE > 0.25 降级）、会按边际收益决定何时离开（`ttl_turns`）。参考实现是一个**无状态打分函数**：`selectFocus(candidates, { budgetTokens })` 只看见当前候选列表。

这在心理学上恰好是最不成立的一种设计。人的注意力分配之所以不是一个排序问题，正因为它是**由选择史、当前负载、在任务上的时长和他人注意力共同调制的**（见研究简报 §1–§7）。这些调制机制当前一条都不在代码里。

这句话是可验证的，见 §1 的诊断表：每一条都指向一个具体文件与行号。

---

## 1. 诊断：规格说了一套，实现是另一套

| # | 规格承诺 | 实现现状 | 证据位置 |
| --- | --- | --- | --- |
| **D1** | 控制器「评估 → 选择 → 提交 → 结算 → **再评估**」六步闭环（§3.6） | `attend()` 是纯函数：不读父帧、不读回执、不看 `mode`。`mode` 只被写进帧，选择器从没见过它 | `runtime.ts:312–347`、`attention.ts:52` |
| **D2** | VOI 误差持续偏高时必须降低对 VOI 的依赖（§5.2） | 误差被算出来了（`runtime.ts:471–475`），然后被丢弃。没有任何降级路径 | `runtime.ts:471` |
| **D3** | 习惯化：同对象反复注意无新信息，`novelty` ×0.8，保底 0.1，新证据重置（§5.7） | `novelty` 由调用方手填（`demo.ts` 里是 0.6 / 0.3 / 0.2），既不衰减也不重置；`ignored.reason: 'habituated'` 从未被产出 | `attention.ts:31`；`frame.ts:28` |
| **D4** | 防抖动：10 周期内模式切换 ≤3 次，`goal` slot 有粘性（§5.3） | 无计数器、无粘性、无父帧比较 | — |
| **D5** | 安全与承诺类目标有**硬性下限，不受显著性公式约束**（§3.6） | `Candidate` 没有 class、没有 floor。乘法公式里 `goalFit` 小就直接把分数压到阈值以下，记为 `low_voi` | `attention.ts:31,63` |
| **D6** | 外部内容 `salience ≤ 0.3`、不得占 `goal` slot、份额 ≤15%（A-4 / §5.6） | `admitExternal()` 只在测试里被调用，**分配点从不调用它** | `interrupts.ts:59` vs `attention.ts:52` |
| **D7** | 9 种僵局状态各有规定动作（§3.6） | 只有 `STUCK` / `TIE` / `BUDGET` 会被产出；`STALLED` `CONFLICT` `INFEASIBLE` `UNKNOWN` `UNVERIFIED` `DRIFT` 六个状态**没有检测器** | `attention.ts:75,105` |
| **D8** | `rest` 模式（不行动）是五种模式之一 | `rest` 与 `exploit` 在选择上完全等价——都只是写进帧的一个字符串 | `runtime.ts:312` |
| **D9** | `Slot.ttl_turns` 限定槽位存活 | 只做类型校验，没有任何驱逐逻辑 | `boundary/frame.ts:133` |
| **D10** | 校准是「声明与实测分离」的一等指标（§8.4） | 只有 ECE/Brier/VOI-MAE；没有 `d'` 与判据 `c` 的区分，也没有 resolution | `runtime.ts:471` |

**这不是实现偷懒，是对象模型少了几个字段。** 下面每一条升级都对应上表的一行或几行。

---

## 2. 升级原则

1. **不改变 ADR-003。** 显著性仍然「规定契约，不规定公式」。新增的是**输入与单调性约束**，不是新的神奇权重。
2. **每个新字段必须能被回执重算。** 沿用 §6 的承重规则：「任何不能从日志重算的字段，只是注释」。
3. **能被证伪的机制优先。** 不引入情绪、疲惫、直觉这类无法从外部检验的量。凡是「人脑有」而「日志测不出」的，写成探针，不写成公式。

---

## 3. 变更 A：让选择成为状态的函数（P1）

**对应**：D1 / D2 / D3 / D4 / D9
**依据**：选择史是独立于「目标驱动 / 刺激驱动」的第三类注意驱动（Awh et al. 2012；Theeuwes 2019）；返回抑制是其中唯一被反复复制的**负向**机制（Posner & Cohen 1984；Klein 2000）。

### A.1 接口

```ts
selectFocus(candidates, {
  budgetTokens,
  parent?: Frame,          // 新增：父帧
  history?: SelectionHistory, // 新增：从账本派生的选择史
  policy?: SelectionPolicy,   // 新增：模式对应的策略
})
```

`SelectionHistory` 不是存储，是**派生视图**，由宿主从 `Frame[]` + `Receipt[]` 计算：

```ts
interface SelectionHistory {
  seen:    number   // 该 target 被候选化的次数
  selected: number  // 进入焦点的次数
  realized: number  // 进入焦点后 realized_voi 的均值（无回执则 undefined）
  lastSelectedAt?: Timestamp
  lastIgnoredAt?: Timestamp
  lastReason?: IgnoredReason
}
```

### A.2 新的参考公式（仍非规范）

```text
hist_i   = 1 + α·(realized_i − 0.5) − β·exp(−Δt_i / τ_ior)
S(i)     = floor_i ⊕ [ EVSI_i · P(accept_i) · hist_i ]
           / [ c_tok + c_tool + c_money + c_human + c_switch + c_meta ]
```

- `τ_ior` 取 **3 个周期**（对应返回抑制的秒级尺度在 LLM 周期上的类比，**这是一个类比，不是测量**）；
- `realized_i` 无样本时不参与（`hist_i = 1`），不许用 0.5 假装有样本；
- `⊕` 表示硬底线是**加法/旁路**，不是乘法因子（见变更 E）。

### A.3 新增单调性约束（一致性测试必须覆盖）

| # | 约束 |
| --- | --- |
| 6 | `realized` 上升 ⇒ `salience` 不下降 |
| 7 | `Δt_lastSelected` 减小（越近）⇒ `salience` **不上升**（返回抑制） |
| 8 | `c_switch` 上升 ⇒ `salience` 不上升 |
| 9 | `hard_floor = true` ⇒ `salience ≥ floor`，与 `goalFit` 无关 |

### A.4 新增不变量

**A-6 选择可复现。** 任何一个 `Frame.slots[].salience` 必须能由「帧链 + 回执」重算到 ε 以内。实现不得存储学习到的权重，只能存派生统计。检验方式与 W-3 的修订链同类：给定日志，重算第 N 帧。

### A.5 代价

一次 O(1) 的哈希查表 + 一次衰减函数。真正的成本在宿主：要维护派生索引。**对已有账本的实现是零迁移**——`history` 缺失时退化为当前行为。

---

## 4. 变更 B：容量按 chunk 计（P0）

**对应**：D5 之外的容量缺口
**依据**：Miller 的 7±2 是「有复述的 chunk」；无复述的容量约 4（Cowan 2001）。异构、未复述、每槽一个子任务的焦点集，落在 4 一侧。

### B.1 字段

```ts
interface Slot {
  // ...既有字段
  chunk_weight: number   // ≥1；一个槽里放了两个不相干子目标就是 2
}
```

### B.2 规则

- 焦点集约束从「槽数 ≤ 7」改为 **Σ `chunk_weight` ≤ 4（默认）/ 9（硬上限）**；
- `chunk_weight > 2` 的槽必须在 `why` 里解释为什么不能被拆成两个周期；
- 超容量时的 `ignored.reason` 从 `deferred` 改为 **`capacity`**（新枚举值），因为「下轮再说」与「装不下」是不同的失败。

### B.3 新增不变量

**A-7 容量按 chunk。** 焦点集规模以 `Σ chunk_weight` 计；默认 4，硬上限 9。超限必须显式记入 `ignored{reason: capacity}`，不得静默丢弃。

### B.4 为什么不直接改成 4 个槽

因为「4 个槽」会让复杂目标无法在一个周期内保持连贯，把拆解成本推给模型——那是把容量问题伪装成规划问题。chunk 权重让两种成本可比。

---

## 5. 变更 C：离场是一个决策，不是一次到期（P1）

**对应**：D9
**依据**：边际价值定理——离开斑块的条件是**边际收益率低于环境平均收益率**，且旅行/重入成本越高，停留越久（Charnov 1976；Pirolli & Card 1999）。

### C.1 字段

```ts
interface Slot {
  admitted_at: Timestamp
  yield: { realized: number; cost: { tokens: number; ms: number } }  // 该槽累计产出/投入
  reentry_cost: { tokens: number; calls: number }                     // 重入要付多少
}
```

### C.2 离场规则

```text
marginal_i     = Δyield_i / Δcost_i            // 滑动窗口 w=3 周期
environment    = Σ realized_voi / Σ attention  // 全账本的平均收益率
leave_i  iff   marginal_i < environment  AND  expected_gain(新槽) > reentry_i
```

`ttl_turns` 降级为**建议**，不再单独构成驱逐理由。

### C.3 新增忽略原因

| 原因 | 含义 |
| --- | --- |
| `exhausted` | 边际收益低于环境均值，主动离场（**新**） |
| `inhibited` | 返回抑制：刚被拒，冷却中（**新**） |
| `capacity` | chunk 容量不足（**新**） |
| `deferred` | 预算或轮次不足，非质量原因（保留） |

### C.4 新增不变量

**A-8 离场有据。** 槽位离开焦点只能经由 `done` / `exhausted` / `evicted` / `deferred`，且离开时必须记录当时的 `marginal_yield` 与 `environment_rate`。`ttl` 到期不得作为唯一理由。

### C.5 反直觉的部分

高 `reentry_cost` 应当**延长**停留，而不是鼓励切换。这条对 Agent 特别重要：重入成本是上下文重建，通常远大于人类翻页的成本。一个按「均匀轮转」设计的调度器会系统性地过度切换——这正是 §5.3 防抖动规则想表达但无法度量的东西。

---

## 6. 变更 D：阈值从两种错误的代价推导（P2）

**对应**：D2 的一半、§5.4 的 `abstain` τ、§5.5 的打断阈值
**依据**：SDT 把敏感度 `d'` 与判据 `c` 分开（Green & Swets 1966）；证据累积模型的边界随收益与紧迫性移动（Ratcliff & McKoon 2008）。

### D.1 字段

```ts
interface Frame {
  criterion?: {
    beta: number                 // 判据；>1 保守，<1 激进
    source: 'policy' | 'default' | 'calibrated'
    costs: { false_accept: number; false_reject: number }  // 归一化后的代价
  }
}
```

### D.2 规则

```text
beta = cost(false_accept) / cost(false_reject)
τ_abstain = τ_0 · beta        // 或等价地：向 d' 与 c 的联合决策
```

- 检索弃权阈值、打断阈值、`TIE` 的比较精度，全部由 `beta` 派生；
- 常数 τ 只允许作为**标注为 default 的默认值**，且帧里必须能看见它从哪来；
- 高风险不可逆行动的 `beta` 自动抬高（与 §6.1 的最低等级表联动）。

### D.3 新增不变量

**A-9 阈值可推导。** 任何弃权/打断/比较阈值必须记录其 `beta` 与两种错误代价的来源；未记录来源的阈值视为 `default`，不得用于不可逆行动的前置判断。

### D.4 与「证据累积」的关系（可延后）

完整的漂移扩散实现需要每问题一个累积器，成本高于收益。**建议只实现边界的一半**：保留静态比较，但让边界随 `beta` 与剩余预算移动。这已经能消掉「同一问题在两个周期里判据不同」这类不一致。

---

## 7. 变更 E：硬底线旁路（P0）

**对应**：D5 / D6
**依据**：目标驱动的过滤与刺激驱动的突破是**两条通道**，不是一条通道上的两个权重（Awh et al. 2012 之后的标准提法）。乘法评分只有一条通道。

### E.1 字段

```ts
interface Candidate {
  // ...既有字段
  class: 'safety' | 'commitment' | 'goal' | 'curiosity' | 'ambient'
  hard_floor?: number   // 0..1；仅 safety / commitment 可 >0
}
```

### E.2 规则

1. `hard_floor > 0` 的候选**先于**显著性排序占位，占位后剩余容量才按公式分配；
2. `hard_floor > 0` 必须带 `why` 与 `revisit_if`，否则拒绝（沿用 A-1/A-2 的精神）；
3. 若硬底线候选因容量不足仍无法占位，帧必须记 `impasse: {state: 'INFEASIBLE', detail: 'floor_conflict'}`，**不得**记为 `low_voi`；
4. `admitExternal()` 必须在 `selectFocus()` 内被调用，而不是只在测试里。外部内容的 `trustCap ≤ 0.3` 与「不得占 `goal` 槽」在**分配点**强制。

### E.3 新增不变量

**A-10 底线旁路。** `hard_floor` 类候选不受乘法显著性公式影响；外部来源内容不得携带 `hard_floor`，且其显著性上限在分配点强制执行。

### E.4 为什么这是 P0

因为当前行为有一个可指出的错误：一个 `goalFit = 0.05` 的安全信号，`voi = 0.3`，会被算成 0.034，落到阈值 0.12 以下，然后被记成 `low_voi` 进入忽略集——**系统的日志会声称这是「价值低」，而规格说它不该经过这个判断**。这不是性能问题，是审计问题。

---

## 8. 变更 F：元成本计入预算（P2）

**对应**：§3.9 的五维预算只计量了「看什么」，没计量「决定看什么」
**依据**：控制的期望价值理论（Shenhav et al. 2013）；认知需求回避（Kool et al. 2010）；元推理有成本（Russell & Wefald 1991；Lieder & Griffiths 2020）。

### F.1 规则

- 选择器必须声明筛选基数 `k`（默认 `k = 2 × 容量`）；
- 先用**廉价键**（例如：硬底线 → 目标贴合度 → 上次是否被拒）取前 `k`，再对 `k` 个候选跑完整评分；
- 筛选本身的成本记入 `usage.meta`，并从同一租约扣除；
- `N` 远大于 `k` 时，**不得**静默截断候选池：未进入筛选的候选必须批量记 `ignored{reason: 'capacity', detail: 'prefiltered'}`，并给出计数。

### F.2 新增不变量

**A-11 元成本计入。** 分配决策本身的成本与内容消费共用同一租约；实现必须声明筛选基数，且不得以牺牲可审计性为代价省略候选（批量记录即可）。

### F.3 观测价值

新增指标 `meta_ratio = meta / total`。人类在这一项上的表现是「廉价判断占绝大多数」，一个 `meta_ratio > 0.3` 的控制器应该被怀疑在过度规划；`meta_ratio → 0` 而 `voi_mae` 高，说明它在瞎猜。

---

## 9. 变更 G：时间在任务上，以及切换，都要计价（P2）

**对应**：D8，以及 §3.9 缺失的第六个维度
**依据**：警戒衰减真实存在且是高负荷的（Warm et al. 2008）；任务切换有独立的重配置成本（Rubinstein et al. 2001；Monsell 2003）；切换后仍有注意残留（Leroy 2009）；目标记忆在打断中按秒衰减（Altmann & Trafton 2002）。

### G.1 两个字段

```ts
interface Frame {
  switch_cost?: { tokens: number; ms: number; from_class: string }
  on_task?:    { cycles: number; since_rest: number; source: 'measured' | 'uncalibrated' }
}
```

### G.2 切换计价

- 每帧与父帧的「主导槽类」不同时，计一次 `switch`，写入 `budget.spent`；
- 防抖动规则因此变成**可计算**的：`switch_debt` 累积超过阈值即触发 `STALLED`，而不是靠一个裸计数器；
- 这条同时给出人类数据的对应物：任务切换成本是时间与错误的双重成本，而当前预算里它根本不存在。

### G.3 时间在任务上：只许实测

- `rest` 模式必须**有行为**：进入 `rest` 的帧不得产生新的检索或行动预算，且必须记录离开 `rest` 的原因；
- 长跑任务必须记录 `on_task.cycles`；
- 任何「疲劳衰减」只能来自该 Agent 自己的回执统计；`n < 30` 时标 `uncalibrated` 且**不得应用**（与 §8.4 的 UNCALIBRATED 规则同构）；
- **禁止**引入「意志力耗尽」式的常数——该模型在 23 实验室、N=2141 的预注册复现中效应为零（Hagger et al. 2016）。这是本提案里唯一一条**明确禁止**的设计。

### G.4 新增不变量

**A-12 时间与切换可测。** 切换成本与在任务时长必须由回执/帧链得出；未达样本量的衰减项必须标记 `uncalibrated` 且不得生效。

---

## 10. 变更 H：校准从一维拆成两维（P2）

**对应**：D10
**依据**：SDT 的 `d'` 与 `c`；元认知效率 `meta-d'`（Maniscalco & Lau 2012；Fleming & Lau 2014）。

### H.1 字段

```ts
interface CalibrationBucket {
  lo: number; hi: number
  predicted: number; observed: number; n: number
  d_prime?: number          // 分辨能力
  criterion_c?: number      // 偏向
  meta_d_ratio?: number     // 元认知效率，样本足够时有意义
}
```

### H.2 规则

- §8.4 的上限规则改写为**按 resolution 施加**：当 `meta_d_ratio < 0.6` 时压置信度上限；`c` 的偏移只影响阈值（变更 D），不影响上限；
- 忽略原因增加两个，专门用于审计时的归因：
  - `low_sensitivity`：分不清（`d'` 低）
  - `conservative_criterion`：分得清但选择了不反应（`c` 高）
- 两者混为 `habituated` 时，日志无法回答「是模型变笨了还是变保守了」。

### H.3 新增不变量

**W-6 校准二分。** 校准摘要必须同时报告分辨能力与判据；置信度上限只能由分辨能力与样本量决定，不得由判据偏移触发。

---

## 11. 变更 I：团队注意力（P3，Profile `Social`）

**对应**：D1 在多 Agent 下的放大
**依据**：共享信息偏差（Stasser & Titus 1985；元分析：隐藏剖面的组比全信息组正确率低约 **8 倍**，65 项研究 / 101 个效应，Lu, Yuan & McLeod 2012）；责任分散（Latané et al. 1979）；交互记忆（Wegner 1987）；问责改变整合性思维（Lerner & Tetlock 1999）。详见研究简报 §8。

三条结构性规则，都不需要模型"更会合作"：

1. **D-11 独特贡献。** 每次委派的回报必须包含至少一条「只有它观察到」的证据，或显式声明 `nothing_unique`。合并时 `nothing_unique` 的比例作为指标暴露——它度量的是团队在重复劳动上的花费。
2. **D-12 注意力目录。** 每个 Agent 发布它已经注意过的 `(target, digest, at)`；委派前先查目录，命中则复用而不是重取。这是交互记忆系统的机器版本：目录坏了，团队会比个人更笨。
3. **D-13 唯一责任。** 每个 `blocking: true` 的 `Unknown` 必须有且只有一个 owner；无主或双主的阻塞未知直接构成 `CONFLICT` 僵局。

---

## 12. 僵局检测器（P0，补齐六个空状态）

| 状态 | 可观测签名 | 当前 |
| --- | --- | --- |
| `TIE` | 前两名分数差 < δ | ✅ 已实现 |
| `STUCK` | 无候选超过阈值 | ✅ 已实现 |
| `BUDGET` | 剩余预算 < 任一候选成本 | ✅ 已实现 |
| `STALLED` | 最近 w 周期 `Σ marginal_yield ≤ 0` 且焦点集未变 | ❌ 新增 |
| `CONFLICT` | 两个硬底线槽的 `refutes_if` 同时触发；或 D-13 冲突 | ❌ 新增 |
| `INFEASIBLE` | 全部候选被策略阻断；或硬底线与容量冲突 | ❌ 新增 |
| `UNKNOWN` | 无 `tier ≥ 所需等级` 的能力 | ❌ 新增 |
| `UNVERIFIED` | 连续 k 次行动无 `realized_voi` | ❌ 新增 |
| `DRIFT` | 当前 `goal` 与 `Manifest.commitments/role` 不一致 | ❌ 新增 |

**为什么要补齐**：§3.6 自己写了「僵局必须作为证据写入日志，而不是只在内部重试——一个从不记录卡住的系统，无法知道自己卡住了多少次」。当前 9 个状态里 6 个没有检测器，等于这句话对三分之二的失败模式不生效。

---

## 13. 指标增量（§13）

| 指标 | 定义 | 方向 |
| --- | --- | --- |
| `foraging_efficiency` | `Σ realized_voi / 注意力花费`，按 target 分桶 | ↑ |
| `over_harvest_ratio` | 停留超过边际规则建议的周期数 / 总停留 | ↓ |
| `switch_ratio` | `switch` 成本 / 总成本 | ↓ |
| `meta_ratio` | `meta` 成本 / 总成本 | 适中（0.05–0.25） |
| `resolution` | 元认知效率 `meta_d_ratio` | ↑ |
| `criterion_drift` | `\|c\|` 随时间的变化率 | 接近 0 |
| `duplicate_attention_ratio` | 团队内被 ≥2 个 Agent 重复注意的 target 占比 | ↓ |
| `unique_contribution_rate` | 含 `unique` 证据的委派占比 | ↑ |

---

## 14. 验收向量（V16–V24）

| # | 场景 | 期望行为 |
| --- | --- | --- |
| V16 | 同一 target 上轮进入焦点但 `realized_voi = 0` | 本轮 `salience` 严格低于上轮；`history.realized` 可重算 |
| V17 | 刚以 `inhibited` 被拒的 target 立即重新候选 | 3 周期内不得回升到阈值以上；忽略原因不得写成 `low_voi` |
| V18 | 5 个异构候选，默认策略 | 第 5 个被记 `capacity`，前 4 个进入焦点；不改变硬上限 9 |
| V19 | `goalFit = 0.02`、`class: safety` 的候选 | 仍占位；`salience ≥ hard_floor`；若无法占位则 `INFEASIBLE` |
| V20 | 500 个候选 | 完整评分次数 ≤ 2×容量；`usage.meta > 0`；未进入筛选者批量记 `capacity:prefiltered` |
| V21 | 槽位 `ttl_turns` 到期但边际收益高于环境均值 | 不得驱逐；帧内记录 `marginal_yield` 与 `environment_rate` |
| V22 | 误接受代价翻倍 | 弃权阈值单调变严；`Frame.criterion.source` 可追溯 |
| V23 | 三个 Agent 检索同一问题，两个重复 | 合并报告 `duplicate_attention_ratio`；无 `unique` 者必须声明 `nothing_unique` |
| V24 | 连跑 50 周期且 `n < 30` 的衰减表 | 衰减项不生效，帧标 `uncalibrated`；不得静默应用 |

V16/V17/V19/V21 直接检验 `respectsMonotonicity()` 的扩展，不需要新基础设施。

---

## 15. 优先级

| 阶段 | 内容 | 工作量 | 出口条件 |
| --- | --- | --- | --- |
| **P0** | 变更 B（chunk 容量）、变更 E（硬底线 + 分配点调用 `admitExternal`）、§12 六个检测器、`ignored` 枚举拆分 | 3–4 天 | V18/V19 通过；`INFEASIBLE` 不再被误记为 `low_voi` |
| **P1** | 变更 A（选择史 + 返回抑制）、变更 C（边际离场） | 1.5 周 | V16/V17/V21 通过；`foraging_efficiency` 可算 |
| **P2** | 变更 D（判据）、变更 F（元成本）、变更 G（切换与在任务时长）、变更 H（校准二分） | 2 周 | V20/V22/V24 通过 |
| **P3** | 变更 I（团队三规则） | 1 周 | V23 通过 |

**P0 里没有任何一项需要新的运行时依赖**：它们都是给已有函数加参数与分支。这也是为什么建议先做 P0——它把「日志说了一件规格没让它说的事」这类审计风险先消掉。

---

## 16. 不建议做的事

| 想法 | 为什么不做 |
| --- | --- |
| 引入「情绪」「直觉」「疲惫」作为显著性的因子 | 无法从日志重算，违反 §6 的承重规则；且疲惫的心理学原型（自我损耗）已复现失败 |
| 把人的注意力数据直接拿来做默认权重 | 视觉范式的效应量不能跨到语义任务；只借结构，不借数值（与 Itti & Koch 的既有警告一致） |
| 让模型自己报告选择史 | 这正好是 A-4 的镜像：自授显著性。历史必须由宿主派生 |
| 用一个大一统的注意力总分替代五维预算 | 心理学上容量是**多个资源池**（Wickens 2008），单一总分会在维度间隐式兑换，而 §3.9 明确禁止兑换 |
| 为了防抖把模式切换锁死 | 切换有成本，但「不切换」也有成本。正确做法是给切换定价（变更 G），不是禁止 |

---

## 17. 待并入的 ADR 草案

- **ADR-013 选择必须是有状态的。** 账本不只是审计产物，也是控制器的输入。拒绝「纯函数控制器」，因为它无法表达习惯化、返回抑制与防抖动，而这三条已是规格承诺。
- **ADR-014 容量以 chunk 计。** 槽数是可数的，容量不是。默认 4 的来源是未复述容量，而非任意保守。
- **ADR-015 离场用边际规则，不用到期。** 到期是一个时钟，边际是一个决策。只有后者能被证伪。
- **ADR-016 阈值从两类错误的代价推导。** 常数阈值把敏感度与判据混成一个数，使日志无法归因。
- **ADR-017 硬底线走旁路。** 目标通道与刺激通道在结构上分离；乘法评分只有一条通道，因此必然吞掉目标外的安全信号。
- **ADR-018 元成本是注意力。** 决定看什么也要花钱，且必须与内容消费共用租约。
- **ADR-019 时间与切换只许实测。** 禁止引入未复现的意志力模型；衰减曲线必须来自本 Agent 的回执。

---

## 18. 一句话结论

AMP 的对象模型已经足够新（`ignored[]` 与可签名 Manifest 确实没有直接先例），但**控制器**还在用 1950 年代的判断论形式建模 2020 年代的注意力。心理学给出的最便宜的一条修正不是更聪明的公式，而是让控制器**读回自己的账本**：一旦 `selectFocus` 能看见父帧与选择史，习惯化、返回抑制、防抖动、边际离场、切换计价这五条规格承诺会同时变成可实现的，而不是五个各自独立的补丁。
