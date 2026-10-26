# 人格层：把 agent 建模成一个人

> 状态：v0.1 设计稿。本文只定义边界与端口，不写数据库目录；database 重构由另一个会话负责。
> 代码落点：`src/process/agent.ts`（自我/角色/记忆/情绪/背景）、`src/ipc/social.ts`（关系/制度）、`src/context/agentContext.ts`（人格上下文装配）。

## 0. 一句话

**Person 是进程，Task 是线程；Self 是进程的自模型，Role 是长寿命社会位置，Memory 是有类型的重建，Affect 是状态，Relationship/Institution 是社会事实，Background process 是不占前台的习惯与情绪。**

主流 agent 设计把 agent 当成「无状态策略 + 工具调用循环 + 一段提示词」。这在工程上够用，但在心理学上不成立：人不是一次任务，人有传记、角色、关系、情绪、制度身份，并且会变。

## 1. 为什么主流 agent 模型不够

| 主流假设 | 心理学/社会科学的问题 |
| --- | --- |
| agent = 一次会话/一个 prompt | 人跨情境持续存在；prompt 是一次注意分配，不是人格 |
| agent = 单线程理性执行者 | 人有前台任务，也有习惯、情绪、监控、走神等后台过程 |
| 角色 = system prompt 的一段话 | 角色是社会位置，带义务、观众、脚本与冲突 |
| 记忆 = 向量库 | 记忆分 episodic/semantic/procedural/social/affective，重建而非回放 |
| 情绪 = 噪声/要压制 | 情绪是 appraisal 与行动倾向，影响显著性但不决定真值 |
| 关系 = 消息历史 | 关系是持续的信任、依恋、义务与互惠 |
| 身份 = 配置 | 身份是叙事，随生命事件修订，且有版本 |
| 权限 = 角色 | 角色是「应该做什么」，权限是「允许做什么」；两者不能合并 |

## 2. 理论锚点

- **自我是过程，不是实体**：Parfit 的心理连续性、Hume 的 bundle、James 的意识流都反对「一个不动的小人」。见 [SEP: Personal Identity](https://plato.stanford.edu/entries/identity-personal/) 与 [James, *Principles*, Ch. X](https://psychclassics.yorku.ca/James/Principles/prin10.htm)。
- **自我是社会过程**：Mead 的 I/Me 把自我放在社会互动中；Goffman 的前台/后台把角色看成表演与观众关系；Stryker 的身份理论用 salience 解释多重角色的激活。见 [IEP: Mead](https://iep.utm.edu/mead/) 与 [Stryker & Burke 2000](https://doi.org/10.2307/2695840)。
- **自我是对话与多重**：Hermans 的 dialogical self 把心理描述为多个 I-positions 的对话；IFS 与解离研究进一步说明「一个声音」不是常态。见 [Hermans 2001](https://doi.org/10.1177/1354067X0173001)。
- **自我是叙事**：McAdams 的 narrative identity 认为人通过持续整合的故事获得同一性；生命事件会触发修订。见 [McAdams & McLean 2013](https://doi.org/10.1177/0963721413475622)。
- **记忆是重建**：Conway 的自我记忆系统把 episodic memory 与 self 绑定；回忆是重建，不是读取。见 [Conway 2005](https://doi.org/10.1016/j.jml.2005.08.005)。
- **情绪是建构与 appraisal**：Barrett 的 constructed emotion 与 Scherer 的 appraisal 都反对「情绪是纯噪声」。见 [Barrett 2017](https://doi.org/10.1093/scan/nsw154)。
- **关系是依恋与互惠**：Bowlby 的 attachment 说明关系不是消息记录，而是安全基地与内部工作模型。
- **人是被制度构成的**：Mead、Mauss、Searle 的 institutional facts；Markus & Kitayama 的独立/互依自我说明「人」的边界有文化差异。见 [Markus & Kitayama 1991](https://doi.org/10.1037/0033-295X.98.2.224)。
- **认知延展到环境**：Clark & Chalmers 的 extended mind 说明记忆与推理可以分布在工具、他人与制度中。见 [Clark & Chalmers 1998](https://doi.org/10.1093/analys/58.1.7)。
- **人格是 if-then 模式**：Mischel & Shoda 的 CAPS 说明跨情境一致性不是单一特质，而是情境-行为签名。见 [Mischel & Shoda 1995](https://doi.org/10.1037/0033-295X.102.2.246)。
- **动机是基本需要**：Deci & Ryan 的自我决定理论把自主、胜任、关联作为持续动机。见 [Deci & Ryan 2000](https://doi.org/10.1207/S15327965PLI1104_01)。

## 3. 本体论：人的六个面

### 3.1 Self：叙事与承诺

`AgentProfile` 是当前摘要；`SelfNarrative` 是**只追加的版本链**。每次重大修订写一个新版本，并可在 `life_events` 里留下触发事件。

- 身份：名字、生命章节、价值观、硬约束。
- 叙事：我如何理解自己、当前挣扎、转折点。
- 承诺：对他人/制度的 open commitments（与 `manifest.Commitment` 共享语义）。
- 校准：仍然只能从回执计算，不能自报（见 `manifest` 的 M-1）。

### 3.2 Role：社会位置，不是权限

角色包含：标签、义务、期望、观众、脚本、salience、状态。角色**不授予 capability**；它只描述「在这个位置上，别人期待我做什么」。权限仍由 `authz` 的 handle 决定。

- 一个人同时拥有多个角色，但**最多一个 active**（前台人格）。
- 角色切换是上下文切换，要记事件。
- 角色冲突：两个角色的义务要求不相容的行动；检测靠 obligation 的 `conflicts_with` 标签，而不是靠权限冲突。

### 3.3 Memory：有类型、会重建、会遗忘

记忆类型：`episodic`（发生了什么）、`semantic`（我知道什么）、`procedural`（怎么做）、`social`（关于谁）、`affective`（当时的感觉）。

- 记忆是只追加的内容，`salience`、`consolidated` 是可变的元数据。
- 回忆按 salience、时间、角色相关性、情绪一致性重排；不是简单 top-k。
- 遗忘是显式操作；consolidation 把 episodic 压成语义摘要，但不删除原始事件（除非隐私要求）。
- 记忆可以引用 warrant 的 claim/evidence，但记忆本身不是证据。

### 3.4 Affect：状态与 appraisal

`AffectState`：valence、arousal、stress、fatigue、mood。它不是「情绪标签」，而是影响显著性、风险偏好、注意广度的状态。

- 情绪影响**选择**，不影响**真值**。
- 压力/疲劳降低有效预算与抑制控制；这是预算模型的一部分，不是修辞。
- appraisal 输入：目标受阻/推进、威胁、公平、关系变化；输出：affect + action tendency。

### 3.5 Relationship / Institution：社会事实

- `Relationship`：trust、attachment、obligations、last contact；是持续的关系，不是消息历史。
- `Institution`：norms、memberships、status；制度授予「社会人格」（例如法人、职位、资格）。
- 社会人格是 capability/status，不是内部线程。
- 关系与制度都有规范力量：它们能改变什么算「合理行动」，但不直接等于权限。

### 3.6 Background process：不占前台的习惯与情绪

`BackgroundProcess`：habit、emotion、monitor、drive；有 intensity、trigger、script、status。

- 后台过程不占「一个 agent 一个前台任务」的槽位。
- 它们可以在 idle 时运行，也可以以低强度并行；它们影响上下文与优先级，但不伪造前台完成。
- 习惯是 if-then 脚本；情绪过程是 appraisal 循环；监控是环境扫描；drive 是未满足需要的持续压力。

### 3.7 Development：生命事件与章节

`LifeEvent`：turning-point、role-transition、relationship、achievement、loss、insight。生命事件可以触发 narrative revision 与角色重排。

人格不是静态配置；`life_chapter` 和 narrative version 让「变化」成为一等事实，而不是悄悄覆盖。

## 4. 与现有模块的关系

| 现有模块 | 关系 |
| --- | --- |
| `process` | **运行时句柄**：pid 是人的进程；AgentProfile 以 pid 为外键。不要建第二套生命周期。 |
| `thread` | **任务/目标**：当前在做的事；不是人格。 |
| `manifest` | **对外签名快照**：`issueManifest(person)` 从 person 状态生成；manifest 不是人格的 source of truth。 |
| `concept` | **知识概念**：价值观/角色不是 concept；可以引用 concept。 |
| `warrant` | **信念与证据**：记忆可以引用 claim/evidence；记忆本身不是证据。 |
| `goal` | **目标**：当前 concern 可以是 goal；任务实现 goal。 |
| `authz` | **权限**：角色不授予权限；角色可以请求/约束 capability 的使用。 |
| `ipc` | **传输**：mailbox 是消息通道；Relationship 是持续关系。 |
| `kernel` | **调度**：通过 `AgentReader` 读人格，不直接读表。 |
| `registry` | **架构元数据**：模块/概念注册；不是运行时人格。 |
| `window` / `context` | **注意**：person context 是候选内容，window 决定这次真的放什么。 |

## 5. 聚合与端口

### 5.1 聚合边界

| 聚合 | 拥有 | 不拥有 |
| --- | --- | --- |
| **Person** | profile、self narrative、roles/assignments、memories、affect、background、life events | 权限、任务、窗口、证据 |
| **Social** | relationships、institutions、memberships、messages | 人格叙事、任务 |
| **Execution** | process、thread、steps | 人格内容 |
| **Attention** | window、pages、frame、context assembly | 人格存储 |
| **Epistemics** | objects、claims、evidence、receipts | 人格叙事 |
| **Registry** | concepts/modules/attestations（架构） | 运行时 person |

### 5.2 端口

定义在 `src/process/agent.ts`、`src/ipc/social.ts`、`src/context/agentContext.ts`：

- `AgentReader` / `AgentStore`：进程（agent）的自我、角色、记忆、情绪、背景、生命事件。
- `SocialReader` / `SocialStore`：关系、制度、成员。
- `AgentContextAssembler`：把 agent facets + social 装配成有预算的上下文。
- `AgentEvent` / `SocialEvent`：agent 层发出的事件，供 ledger/observability 消费。

约束：

1. 领域层不 import `node:sqlite`。
2. 端口方法同步（当前 SQLite 适配器同步）；未来异步适配器可加 `AsyncAgentStore`，不改领域类型。
3. 所有写入返回新状态；事件由适配器或 service 在事务后发出。
4. 端口只传 id/值对象，不传数据库 row。

## 6. 不变量

- **P-1** 一个 pid 最多一个 AgentProfile；agent 的生命周期由 process 承载，不另建。
- **P-2** SelfNarrative 只追加版本；修订必须升版本，旧版本可查。
- **P-3** 一个 person 最多一个 active role；切换要记事件。
- **P-4** 角色不授予权限；权限只来自 authz handle。
- **P-5** 记忆内容只追加；salience/consolidated 可变；遗忘/删除是显式操作。
- **P-6** affect 是状态，不是证据；不能提升 claim 的 tier。
- **P-7** background process 不占前台 running 槽位，也不产生 success receipt 来「完成」前台任务。
- **P-8** relationship/membership 的变更要可审计（since/status/事件）。
- **P-9** 生命事件可以触发 narrative revision；revision 必须引用事件或理由。
- **P-10** person context 装配必须尊重 token budget，并显式列出 excluded。
- **P-11** 自报的 calibration/能力不算证据；仍由 receipt 派生。
- **P-12** 多重性（subpersonality/dissociation）用 process group + shared/partitioned memory 建模，不硬塞成 role。

## 7. 上下文装配

`AgentContextAssembler.assemble(pid, budget)` 的顺序与预算建议：

| 段 | 预算占比 | 内容 |
| --- | --- | --- |
| self | 25% | 当前 narrative 摘要、价值观、承诺 |
| role | 15% | active role 的义务/期望/观众/脚本 |
| affect | 10% | valence/arousal/stress/fatigue + 一句状态解释 |
| memory | 35% | 按 salience/recency/role relevance 选出的记忆 |
| relationship | 10% | 重要关系与义务 |
| background | 5% | 高强度后台过程摘要 |

规则：

1. self/role 先放；剩余预算按分值竞争。
2. 每个 segment 带 `ref`（memory id / role id / relationship id），便于追溯。
3. 超预算的段落进入 `excluded`，并给原因（budget/low-salience/role-mismatch）。
4. 不把整段记忆原文塞入；episodic 记忆先压成一句 + ref。
5. 情绪一致性可以加权，但不能压过 role relevance 与 truth constraints。

## 8. 生命周期与事件

```text
person.created
person.narrative.revised
person.role.added
person.role.assigned
person.role.activated
person.role.retired
person.memory.recorded
person.memory.consolidated
person.memory.forgotten
person.affect.changed
person.background.added
person.background.changed
person.life_event.recorded
social.relationship.updated
social.membership.changed
```

事件不是装饰：它们进入 ledger/observability，支持「我当时为什么这样做」的重建。

## 9. 记忆的检索与遗忘

检索分两阶段：

1. **候选**：按 pid、kind/role、时间窗、最小 salience 过滤。
2. **重排**：`score = salience × recency × roleRelevance × affectiveCongruence`；权重可配置，但必须有测试。

遗忘：

- `forget(memoryId)` 显式删除或脱敏。
- `consolidate(ids)` 生成语义摘要，保留 refs；原始 episodic 可标记 `consolidated=1`，不静默删除。
- 隐私要求优先于「完整历史」：支持按 subject/relationship 的 redaction。

## 10. 情绪、压力与预算

- `stress` 高 → 有效 token 预算下降、切换成本上升。
- `fatigue` 高 → 后台 monitor 强度下降、错误率上升。
- `valence` 负 → 威胁相关记忆 salience 上升，但**不能**改变 claim 的 tier。
- `arousal` 高 → 注意窄化，context 更偏向当前 concern。

这些是**调度/装配参数**，不是「情绪 prompt」。

## 11. 多重性：role、subpersonality、dissociation

三者不要混为一谈：

- **Role**：社会位置，共享大部分记忆与意图；切换是上下文切换。
- **Subpersonality**：有独立视角/记忆簇，但通常共享现实检验；可用 process group + shared memory。
- **Dissociation**：记忆/身份分区更硬；需要 partitioned address space 与显式合并协议。

近期只实现 role；process group 作为 P-12 的未来扩展，不在第一版硬做。

## 12. 隐私与安全

- 记忆是敏感数据：跨 person 默认不可见；读取需要 capability。
- Context assembler 不得把别人的关系/记忆拼进来。
- 关系/制度数据可被用于操纵；需要来源与同意记录。
- 遗忘/脱敏是能力，不是可选优化。

## 13. 反模式

| 反模式 | 为什么错 |
| --- | --- |
| prompt-as-person | 一次注意分配不是人格 |
| role = permission | 社会期待 ≠ 授权 |
| memory = vector store | 丢失 episodic/social/affective 结构与时间 |
| self-report as evidence | 校准必须来自回执 |
| one-thread rationality | 忽略习惯、情绪、后台过程 |
| single voice | 忽略角色冲突与多重性 |
| affect as noise | 情绪是 appraisal/行动倾向 |
| person = static config | 人格会随生命事件变化 |

## 14. 实施顺序

1. **Phase 0（本文 + ports）**：冻结本体论与端口，不写 database。
2. **Phase 1（database 会话）**：实现 `AgentStore`/`SocialStore` 适配器；schema 由该会话统一重构。
3. **Phase 2（person service）**：createPerson、narrative revision、role activation、memory recall、affect、context assembler。
4. **Phase 3（kernel）**：`StepContext.agentContext` 通过 `AgentReader` 注入；不直接读表。
5. **Phase 4（social）**：relationship/institution/membership 接入 context 与 authz。
6. **Phase 5（background/multiplicity）**：后台过程调度；process group；再谈 dissociation。

## 15. 开放问题

- 角色冲突的裁决：义务优先级、观众压力、制度规范，谁赢？
- 叙事真实 vs 自我欺骗：narrative 是「我认为的我」，如何与 warrant 的 claim 对账？
- 记忆再巩固：回忆是否应改写 salience/内容？改写要不要留旧版本？
- 文化配置：独立/互依自我如何影响 role salience 与关系权重？
- 多重性的边界：什么时候是 role，什么时候是 subpersonality，什么时候需要独立 process？
- 人格的度量：除了行为一致性，是否存在可验收的「人格连续性」指标？

## 16. 参考

- Olson, E. *Personal Identity*, SEP.
- James, W. *The Principles of Psychology*, Ch. X.
- Mead, G. H. *Mind, Self, and Society*.
- Goffman, E. *The Presentation of Self in Everyday Life*.
- Stryker, S. & Burke, P. J. (2000). *The past, present, and future of an identity theory*.
- Hermans, H. J. M. (2001). *The dialogical self*.
- McAdams, D. P. & McLean, K. C. (2013). *Narrative identity*.
- Conway, M. A. (2005). *Memory and the self*.
- Barrett, L. F. (2017). *The theory of constructed emotion*.
- Bowlby, J. *Attachment and Loss*.
- Markus, H. R. & Kitayama, S. (1991). *Culture and the self*.
- Clark, A. & Chalmers, D. (1998). *The extended mind*.
- Mischel, W. & Shoda, Y. (1995). *A cognitive-affective system theory of personality*.
- Deci, E. L. & Ryan, R. M. (2000). *The "what" and "why" of goal pursuits*.
- Parfit, D. *Reasons and Persons*.
- Schwartz, R. C. *Internal Family Systems Therapy*.
