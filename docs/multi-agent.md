# Multi-Agent Collaboration（设计稿 v0.1）

**状态**：部分完成。委派语义已定；团队对象、共享任务板、结果合并、终止条件待另外两路研究回填（见 §6）。

## 1. AMP 已经有的多 Agent 表面

| 已有 | 提供什么 | 不提供什么 |
| --- | --- | --- |
| `Social` Profile | 注意力协商：请求 / 授予 / 延后 / 拒绝、类预算、安静时段、债务 | 不涉及任务与结果 |
| `Federation` Profile | 跨域 Manifest 束、摘要绑定、撤销、第三方证明 | 不涉及「谁替谁做事」 |
| `Manifest` | 能力、承诺、未知、签名 | 不涉及团队角色 |
| `Warrant Ledger` | 证据等级 T0–T4、修订留痕 | 不涉及跨 Agent 的证据传递 |

缺的正是中间那一层：**有界授权（bounded authority）**。

## 2. 核心判断：控制不等于授权

现有协议把「控制」做完了，把「授权」留空了：

| 协议 | 传了什么 | 缺什么 |
| --- | --- | --- |
| A2A v1.0 | 任务生命周期、artifact、流式、推送 | 没有 budget / deadline / authority 字段；`metadata` 是唯一扩展点 |
| MCP | 工具调用、资源、实验性 tasks | 没有 act-for 语义；令牌只对本站点有效 |
| OpenAI handoff / LangGraph | 进程内控制转移 | 无 granter 身份、无衰减、无补偿 |
| AP2 | 支付授权（mandate） | 只覆盖钱，不覆盖一般委派 |

**结论**：委派对象必须由 AMP 自己定义，放在 A2A 的 `metadata` / extension 里，绝不能依赖对端来执行预算与取消。这与 AMP 一贯的立场一致：**预算与不变量在本地强制，跨域只传声明。**

## 3. 委派对象（Delegation）

```json
{
  "amp": "0.1",
  "kind": "delegation",
  "id": "dl.7",
  "parent": "dl.6",
  "chain": ["did:web:acme.example#ops", "a.gamma", "a.delta"],
  "granter": { "sub": "a.gamma", "kid": "a.gamma#1" },
  "delegatee": { "sub": "a.delta", "kid": "a.delta#2" },
  "task": { "goal_digest": "sha256:…", "inputs_digest": "sha256:…" },
  "scope": [{ "type": "tool", "id": "logs.query", "constraints": { "tenant": "cn-east" } }],
  "budget": { "tokens": 4000, "usd_micros": 0, "calls": 6, "concurrency": 1, "reserved": 1200 },
  "deadline": "2026-10-24T03:00:00Z",
  "compensation": { "action": "rollback", "authority": "requires_human" },
  "evidence": { "tier": "T2", "required": ["observation"] },
  "cancel": { "token": "cx.9", "propagate": true },
  "may_redelegate": false,
  "depth": 1,
  "nonce": "n-7f21",
  "exp": "2026-10-24T02:30:00Z",
  "sig": "base64url…"
}
```

映射：

- **A2A**：放进 `SendMessage.metadata`（或官方 extension），用 `taskId` / `contextId` 关联；`AUTH_REQUIRED` 是升级通道；artifact 承载证据。
- **MCP**：被调工具携带 transaction-token 形状的凭据 + 每个外部效果一个幂等键。
- **Federation**：跨域时 delegation 与 bundle 一起传；摘要绑定，撤销优先。

## 4. 十条本地不变量

这些**不能委托给对端执行**，必须由本地运行时强制：

| # | 不变量 |
| --- | --- |
| D-1 | **单调衰减**：子预算 ≤ 父剩余；任何字段只能更窄，不能更宽 |
| D-2 | **单一写入者**：每个任务有租约与 fencing token，旧持有者写入被拒 |
| D-3 | **先预留后结算**：`reserved ≥ 在途最坏情况`，调用前扣减，事后按实结算 |
| D-4 | **截止时间单调**：子 deadline ≤ 父 deadline |
| D-5 | **取消粘滞**：一旦 CANCELED，不得被重试复活 |
| D-6 | **效果幂等**：每个外部效果有幂等键，重复投递不会重复生效 |
| D-7 | **证据签名**：结果由 grant 中指定的 delegatee 密钥签名 |
| D-8 | **无令牌透传**：每一跳 audience-bound，令牌不能转给下游 |
| D-9 | **再委派受限**：仅当 `may_redelegate`，且 `depth` 递减 |
| D-10 | **终态不可变**：COMPLETED / FAILED / CANCELED / REJECTED 之后不再变更 |

## 5. 计量不是控制

有报告记录：一个会计 Agent 在一小时内发起超过 15,000 次高成本调用，产生约 5 万美元费用——没有攻击者、没有注入，只是没有速率上限、成本上限与熔断。事后计数在委派竞态下可被绕过。

因此：**预留发生在派发之前**，且父级剩余预算就是子级的上限；升级不是放宽现有授权，而是由更高权限**签发一个新的 grant**。

## 5.5 实证约束（先看数字，再谈架构）

**多 Agent 不是默认更好。** 一组 260 配置 × 6 基准的比较显示，相对单 Agent 的变化从 **+80.8%**（可分解的财务推理）到 **−70.0%**（顺序规划）都有。另一组 τ²-bench 双控实验里，多 Agent 在 13 个有效格中 **12 个更差**，加权平均 **−28 分**；最好的情况也只是在 **5.5×** token 花费下打平。

**Anthropic 的 90.2% / 15× 是内部评估**：单 Agent Opus 4 对比 Opus 4 领导 + Sonnet 4 子 Agent。作者自己指出 token 使用量解释了 BrowseComp 方差的 80%——收益很大程度是「买来的算力」，不是协调本身。

**失败率很高**：MAST 对 1,642 条轨迹的标注给出 **41%–86.7%** 的失败率，主因是系统设计（44.2%）、Agent 间错位（32.3%）、验证不足（23.5%）。高频具体失败：步骤重复 15.7%、不知道自己该终止 12.4%、不遵守任务规格 11.8%、验证错误 9.1%。注意：显式信息丢失其实很少（0.85%–2.8%），**主要问题不是「传话丢信息」，而是角色、终止与验证**。

**交接必须结构化**：受控实验里，JSON 交接的可行性 **0.96**，叙述式摘要 **0.48**，不压缩 **0.88**——只求短会伤害交接。另一项研究显示摘要保事实、毁规则：边界标记存活率从 **0.80 降到 0.57**。

**投票可能删掉正确答案**：同质 Agent 讨论三轮后出现最高 85.5% 的从众采纳，oracle gap 达 **32.3pp**。共识不等于正确。

由此得到三条准入/终止规则：

| 规则 | 内容 |
| --- | --- |
| **准入** | 单 Agent 是默认。仅当任务可分解/可并行、单 Agent 基线低于约 45%、或上下文超一个窗口时才加 Agent，且必须做等算力 A/B |
| **扇出** | 深度 ≤ 2；简单查询 1 个 Agent、3–10 次调用；中等 2–4 个子 Agent；>10 仅在复杂任务 |
| **终止** | 独立验证通过 / 预算耗尽返回带 tier 的部分结果 / 连续 2 次无进展即停 / 两轮结论稳定 / 只有具名权威可宣布完成 |

## 5.6 要定义的对象

| 对象 | 内容 | 强制或建议 |
| --- | --- | --- |
| **Team Charter** | 成员、最大深度、扇出上限、总预算、终止策略、权限图 | 强制 |
| **Role Manifest**（签名） | 能力与工具 ACL、承诺（SLO、输出 schema）、弃权策略、权限上限、升级路径 | 能力强制，文字建议 |
| **Task Lease** | 租约 id、父任务、验收条件、输入工件引用、输出 schema、截止、预算、最大子租约、去重键 | 强制 |
| **Result Contract** | claims + 证据引用 + 置信度 + 未知 + 工件，schema 校验 | 强制 |
| **Termination Record** | 原因码（verified / budget / stall / verification-fail / abort）+ 回执 | 强制 |

**只建议、不强制**：分解策略、角色描述、同伴选择、自报置信度。MarketBench 显示 Agent 对成功率与 token 成本的自我估计系统性失准，**按自报分配会偏离全信息分配**——应按历史 cost-per-success 分配。



## 6. 团队对象与失败信号

人类团队靠**交互记忆**（谁擅长什么）自然分工；Agent 没有这种自发目录，所以目录必须是**带版本、带证明时间的工件**，而不是推断。这是把团队认知迁移到 Agent 时最重要的一次反转。

| 对象 | 内容 | 理由 |
| --- | --- | --- |
| **Team Manifest** | 成员、能力、权限、版本、最近证明时间、证据等级 | 显式目录；成员或能力变化必须**重新证明** |
| **Role** | 权限 + 义务 + 范围，绑定稳定 ID | 可扩展的授权，不随对话漂移 |
| **Task Board** | 负责人、状态、依赖、截止、warrant 等级 | 唯一权威状态，避免「以为对方在做」 |
| **Commitment Record** | 双方、命题、满足条件、履行/解除/违约 | 联合承诺**不可单方撤销** |
| **Handoff Artifact** | SBAR / I-PASS 字段 + **接收方复述** + 未确认假设 | 强制 grounding，不接受纯散文交接 |

三条规则：

1. **在承诺边界上做 grounding**，而不是每句话都确认；区分 `posted`（已发布）与 `grounded`（已对齐）。
2. **联合承诺需要双方接受**才能成立；解除需要双方同意；违约走通知与修复。这是防止 Agent 静默放弃共同目标的唯一结构手段。
3. **重要判断要有记录在案的真实异议**。实验显示角色扮演的魔鬼代言人会强化原观点，真实少数派异议才提升决策质量。

八个失败信号（对齐 MAST 的「Agent 间错位」簇，可用其 1,600+ 条标注轨迹做外部验证）：

| 信号 | 含义 |
| --- | --- |
| `duplicate_work` | 两个 Agent 做同一件事 |
| `stale_directory` | 证明时间过旧、版本偏斜、成员已变 |
| `ungrounded_assumption` | 低等级 warrant 支撑高风险行动 |
| `silent_divergence` | 双方投影不一致却无人提出 |
| `commitment_orphan` | 承诺无履行事件，或被单方取消 |
| `attention_starvation` | 对齐开销挤占任务本身 |
| `false_consensus` | 零异议记录 |
| `handoff_without_synthesis` | 接手方没有复述与提问 |

**团队规模**：沟通通道随 `n(n−1)/2` 增长，集成与磨合成本会吞掉新增人力。默认 2–4 个 Agent，超过 5 个必须给出理由与等算力对照。

## 7. 仍未定

- **跨 Agent 证据传递**（已实现）：非本 Agent、且接收方不能重放的观察降一级（`T2→T1`）；可重放则保留；佐证只设上限、不提升等级。
- **冲突裁决**（已实现）：证据等级 → 权威 → 升级；多数票不参与裁决。
- **共享账本粒度**（已实现）：`full` / `summary` / `reference` 三种视图，各自带完整性 digest；粒度越粗，接收方越需要回取。
- **协调开销指标**（已实现）：重复任务率、对齐占比、cost-per-success、争议率——全部由账本与任务板计算，不依赖自报。

## 7. 参考

- [delegation-and-interop.md](research/delegation-and-interop.md)：A2A/MCP 机制、令牌交换、身份三层、DS 模式、事件与十条不变量来源
