# 注意力驱动的 Agent 架构 · 完整设计文档

**版本**：1.8（终版）  
**定位**：以注意力调度为核心、Session/Turn 为交互容器、六级意图生命周期为骨架、六类一等对象贯穿全链路、六种视图约束下沉验证、单 Agent 与多 Agent 统一治理的 Agent 工作流架构。

---

## 目录

1. 文档概述
2. 核心理念与设计原则
3. 分层架构总览
4. 生命周期体系（Session / Turn / Intent / Mission / Goal / Plan / Task / Action）
5. 证据体系
6. 能力体系（Tool / Skill / Protocol / Cognition）
7. 行为体系（Behavior）
8. 职业体系（Profession）
9. 回执体系（Receipt）
10. 协作体系（Agent / Cooperation）
11. 各层详细说明（L0–L8）
12. 文件对象模块
13. 视图系统（六种视图）
14. 横切设计思想
15. 核心执行循环
16. 预算分配机制
17. 关键设计决策汇总
18. 风险与对策
19. MVP 落地路径
20. 术语表

---

## 1. 文档概述

### 1.1 目标

解决 Agent 工作流的两大核心问题：

- **Token 消耗过高**：上下文膨胀、工具输出冗余、历史回放、注意力稀释。
- **错误率偏高**：注意力错配、工具黑盒、行为错误复用、验证缺失、证据污染、能力无生命周期、角色无约束、执行无凭证、多 Agent 协作混乱、交互无边界、文件操作不安全。

### 1.2 核心思路

> **不优化"窗口里放什么"，而优化"每一步看哪里、为什么看、何时切换"。**

- 上下文是注意力调度的**结果**。
- 减少 token = **保持注意力密度**。
- 降低错误率 = **注意力不错配 + 验证兜底**。
- **Session 是容器，Turn 是原子交互**。
- **六类一等对象**贯穿全链路：能力、行为、职业、证据、回执、协作。
- **六种视图**作为关系语义投影，约束下沉为确定性验证器，渲染对 Agent 隐藏。

### 1.3 适用范围

适用于需要多步推理、工具调用、文件操作、项目构建、多轮交互、多 Agent 协作的通用 Agent 工作流。规模可从单 Session 单 Turn 单 Agent 的最小闭环，扩展到多 Session 多 Turn 多 Agent 的复杂协作。

### 1.4 版本演进

| 版本 | 新增 |
|---|---|
| v1.0 | 注意力驱动的分层架构、六级意图生命周期雏形 |
| v1.1 | Evidence 及生命周期、撤销传播、独立性判定、冲突仲裁 |
| v1.2 | Task 及生命周期（六级分解） |
| v1.3 | Tool / Skill / Protocol / Cognition 及生命周期 |
| v1.4 | Behavior / Profession / Receipt 及生命周期 |
| v1.5 | Cooperation / Agent 及生命周期（多 Agent 协作） |
| v1.6 | 脑图（Mind Map）作为第六种视图 |
| v1.7 | Session / Turn 交互生命周期 |
| **v1.8** | **文件对象完整生命周期 + 注意力 8 操作汇总 + Behavior 抽象来源演化 + 用户原始概念映射** |

---

## 2. 核心理念与设计原则

### 2.1 十八条核心理念

| # | 理念 | 含义 |
|---|---|---|
| 1 | 上下文是结果，注意力是原因 | 优化信息选择而非信息压缩 |
| 2 | 减少 token = 保持注意力密度 | 每 token 都要高信息密度 |
| 3 | 降低错误率 = 注意力不错配 + 验证兜底 | 不靠"再想想" |
| 4 | 行为复用必须经过验证 | 只沉淀验证通过的轨迹 |
| 5 | 证据是一等对象 | 生命周期、独立性、冲突、撤销 |
| 6 | 能力是一等对象 | 生命周期、版本、评测、降级 |
| 7 | 行为是一等对象 | 抽象、验证、激活、衰减 |
| 8 | 职业是一等对象 | 能力画像、认知偏好、验证标准 |
| 9 | 回执是一等对象 | 操作凭证、审计锚点、回滚锚点 |
| 10 | 协作是一等对象 | 生命周期、拓扑、协议、共享/隔离、冲突仲裁 |
| 11 | Agent 是一等对象 | 身份、信任、能力画像、职业画像 |
| 12 | 证据分级融合 | 操作历史 > 用户确认 > 搜索 > 对话 |
| 13 | Plan 策略、Task 战术、Action 原子 | 策略并行拆解为战术 |
| 14 | Workspace 是工作现场，Project 是项目知识 | 分别回答"改什么"和"是什么" |
| 15 | 编译期检查优先于运行期推理 | 约束下沉为确定性验证器 |
| 16 | Agent 的上下文 ≠ 系统运行时资源 | 视图、约束、索引由代码消费 |
| 17 | 协作有收敛，必须有仲裁与退出 | 防止无限协商、僵局、资源死锁 |
| 18 | Session 是容器，Turn 是原子交互 | Session 跨 Turn 保持状态，Turn 是 Intent 捕获和注意力切换的自然边界 |

### 2.2 二十条设计原则

| 原则 | 落地方式 |
|---|---|
| 渐进披露 | 能力/知识/行为先给 list，按需展开 |
| 分层聚焦 | 当前级别详细，上层摘要常驻 |
| 证据向上 | 只从操作历史向上汇聚 |
| 失败不越级 | 失败只传播到直接父级 |
| 预算树形 | 上层分配，下层消耗，超支强制决策 |
| 取消彻底 | 事件驱动取消，所有子项订阅 |
| 证据可撤销 | 撤销证据 → 依赖结论重评估 |
| 同源不重复计数 | independence_key + 去重 |
| Task 可并行 | DAG 拓扑调度 |
| 能力契约化 | 输入输出、前置条件、成功标准、版本 |
| 能力降级传播 | Tool→Skill→Behavior→Cognition→Protocol |
| 职业画像驱动 | Profession 决定能力选择与验证标准 |
| 操作必留回执 | 每次调用产生 Receipt，可审计可回滚 |
| 行为可抽象可衰减 | 从成功轨迹抽象，长期无效则冷却 |
| Agent 身份可信 | Agent 注册 + 信任等级 + 回执签名 |
| 协作协商充分 | 拓扑/分工/预算/协议/退出条件必须协商一致 |
| 冲突必仲裁 | 资源冲突、结果矛盾、意图冲突必须有仲裁路径 |
| Turn 边界是注意力重置点 | 每个 Turn 结束时评估：哪些注意力对象 persist、哪些 unmount |
| Session 状态可恢复 | Session 挂起/恢复时，恢复 Mission/Goal/Plan/Task 状态 + 未决 Intent + 预算余额 |
| Turn 可中断可恢复 | Turn 中断（用户打断/超时/故障）时，保留现场，支持续接 |

---

## 3. 分层架构总览

### 3.1 分层图

```
┌──────────────────────────────────────────────────────────────────┐
│ 横切能力（贯穿全层，不占上下文）                                   │
│  可观测性 · 事件溯源 · CQRS · 防腐层 · 熔断/舱壁/预算              │
│  影子/金丝雀 · 特性开关 · 仓储/DI · 模式迁移 · 幂等/可重放         │
│  证据消费审计链 · 证据撤销传播 · Task DAG 调度                     │
│  能力降级传播 · 能力版本迁移 · 能力评测 · Receipt 审计与争议       │
│  协作拓扑调度 · 跨 Agent 仲裁 · Agent 身份与信任                   │
│  Session 状态恢复 · Turn 中断续接 · 历史压缩                      │
├──────────────────────────────────────────────────────────────────┤
│ L8   学习沉淀层：验证通过轨迹 → 行为库/知识库/Skill 候选/协作模板  │
│ L7   证据融合层：证据生命周期 + 独立性 + 冲突仲裁 + 跨 Agent 信任  │
│ L6   验证层：确定性约束 + 任务标准 + Protocol 合规 + 协作一致性    │
│ L5   认知层：推理 / 自检 / 失败归因 / 停止回滚 / 问人              │
│ L4   上下文组装层：mounted 摘要 + Session 摘要 + Turn 输入         │
│ L3   注意力调度层：路由/聚焦/切换/抑制 + Task DAG + 跨 Agent 路由  │
│ L2   注意力对象层：生命周期 + 评分 + 证据/能力/行为/回执/协作引用  │
│ L1   运行时状态层：Session + Turn + 六级生命周期 + 事件流 + 预算   │
│ L0.9 Cooperation 层：协作治理 + Agent 注册 + 信任 + 仲裁           │
│ L0.8 Profession 层：职业画像 + 生命周期 + 激活切换                 │
│ L0.7 能力与行为治理层：Tool/Skill/Protocol/Cognition/Behavior      │
│ L0.6 Project 层：指令契约 + 架构大纲 + 约定 + 配置                 │
│ L0.5 Workspace 层：树形大纲 + 文件对象 + 快照 + 权限 + 隔离        │
│ L0   外部资源层：工具库 / 知识库 / 行为库（只读、按需检索）        │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 数据流

```
用户/系统输入
   ↓
Turn 接收（session_id + turn_id）→ Intent 捕获
   ↓
Session 容器：Mission → Goal → Plan → Task → Action
   ↓
注意力调度（路由/聚焦/切换/抑制）→ 上下文组装
   ↓
认知 → 能力调用 → 执行 → Receipt → 验证 → Evidence → 融合
   ↓
Turn 响应 → Turn 完成（注意力重置）→ Session 状态更新
   ↓
学习沉淀（跨 Session 后台维护）
```

### 3.3 六类一等对象 + 交互容器

| 体系 | 核心对象 | 生命周期重心 | 主要归属层 |
|---|---|---|---|
| 交互容器 | Session / Turn | 创建→活跃→挂起→恢复→关闭 | L1 |
| 六级意图生命周期 | Intent→Mission→Goal→Plan→Task→Action | 状态传播、预算、取消 | L1 |
| 能力体系 | Tool / Skill / Protocol / Cognition | 注册→校验→激活→评测→降级→退役 | L0.7 |
| 行为体系 | Behavior | 观测→抽象→验证→激活→衰减 | L0.7 |
| 职业体系 | Profession | 定义→认证→激活→轮换→再认证 | L0.8 |
| 证据与回执体系 | Evidence / Receipt | 采集→激活→冲突/争议→撤销→归档 | L7 + 横切 |
| 协作体系 | Agent / Cooperation | 注册→邀请→协商→组建→执行→冲突→收敛→解散 | L0.9 |

### 3.4 对象关系

```
Session   包含  Turn[]（多轮）
          包含  Intent[] / Mission[] / Cooperation[]
Turn      捕获  0..N Intent
          触发  Mission/Goal/Plan/Task/Action
Cooperation  包含  Agent[]
             协调  Mission/Goal/Task
             遵循  协作协议
Agent     拥有  Profession
          可调  能力/行为
          产生  Receipt / Evidence
Profession 决定  能力画像 + Cognition 偏好 + 验证标准 + 风险偏好 + Behavior 偏好
Skill     组合  Tool + Cognition + Protocol + Behavior
Tool      原子执行，产生 Receipt
Receipt   操作凭证，产生 Evidence
Evidence  结论支撑，进入融合
File      可读写单元，锚定 Workspace，Receipt 的 workspace 锚点载体
```

### 3.5 六种视图体系

| 视图 | 语义 | 回答什么 |
|---|---|---|
| ER | 实体+属性+基数 | 有哪些东西？怎么关联？约束是什么？ |
| 时序 | 参与者+消息+时序 | 谁在何时对谁做了什么？顺序合法吗？ |
| 流程 | 动作/判断+控制流 | 先做什么后做什么？会终止吗？ |
| Venn | 集合+交并差+边界 | 哪些条件同时满足？重叠在哪？ |
| 架构 | 组件+连接器+依赖 | 系统由什么组成？谁依赖谁？ |
| 脑图 | 中心主题+层级分支+跨分支关联 | 这个主题下有哪些子主题？哪些分支相关？ |

---

## 4. 生命周期体系

### 4.1 Session 生命周期

**定义**：Session 是用户与 Agent 交互的容器，跨 Turn、跨 Intent、跨 Mission。

```
Session = {
  id, 类型: user_interactive | autonomous | scheduled | delegated,
  发起者, 参与者: [agent_id...],
  状态, 创建时间, 最后活跃时间, 过期时间,

  当前上下文: {活跃 Intent / Mission / Cooperation, 当前聚焦级别},
  历史: {Turn 列表, 已关闭 Intent / 已归档 Mission, 压缩后的会话摘要},
  预算: {总预算, 已消耗, 剩余, 分配策略},
  注意力持久化: {persist 对象, session 级锚点, session 级 Profession},
  证据, 回执, 版本, 生命周期事件列表
}
```

**生命周期状态机**：

```
created → active ⇄ idle → suspended → resumed → active
                    ↓
                closing → closed → archived
                    ↓
                expired / aborted
```

| 状态 | 含义 |
|---|---|
| created | 已创建，未开始交互 |
| active | 有 Turn 在执行或刚完成 |
| idle | 无活跃 Turn，等待下一次输入（保持上下文） |
| suspended | 挂起（用户离开/等待外部/超时），保留状态 |
| resumed | 从 suspended 恢复，回到 active |
| closing | 正在关闭 |
| closed | 已关闭，只读 |
| archived | 归档 |
| expired | 过期 |
| aborted | 异常中止，保留现场 |

**生命周期操作**：

| 操作 | 触发 | 效果 |
|---|---|---|
| create | 用户/系统发起 | created |
| activate | 第一个 Turn 开始 | active |
| idle | Turn 完成且无后续输入 | active → idle |
| suspend | 用户离开/超时/等待外部 | → suspended |
| resume | 用户回来/条件满足 | suspended → active，恢复上下文 |
| close | 用户显式结束/任务完成 | → closing → closed |
| expire | 超过过期时间 | idle/suspended → expired |
| abort | 异常终止 | 任意 → aborted，保留现场 |
| archive | closed/expired 超 TTL | → archived |

**关键规则**：
- active ⇄ idle 自动切换，保持上下文
- suspended 必须能恢复：重建 Mission/Goal/Plan/Task 状态 + 未决 Intent + 预算余额 + persist 对象
- idle 有过期时间
- closing 必须处理未完成 Turn
- aborted 保留现场
- Session 可以没有 Turn，也可以有很多 Turn
- 一个 Agent 可参与多个 Session，一个 Turn 只属一个 Session

**Session 状态恢复**：
```
resume(session_id):
  1. 加载 Session 状态（事件流重放或快照）
  2. 恢复活跃 Intent / Mission / Goal / Plan / Task 状态
  3. 恢复预算余额
  4. 恢复注意力持久化对象
  5. 恢复活跃 Cooperation
  6. 重建脑图当前路径
  7. 生成 session_resume_receipt
  8. 回到 active
```

**恢复原则**：只恢复 persist 对象；stale 不恢复；预算精确恢复；恢复幂等；失败告警不静默。

---

### 4.2 Turn 生命周期

**定义**：Turn 是单次交互单元，是 Intent 捕获的原子边界和注意力重置点。**对应传统工作流的"一轮"**。

```
Turn = {
  id, session_id, 序号,
  触发: {type: user_input | system_event | agent_message | timer, 来源},
  输入: {原始输入, 模态, 附件},
  状态, 开始时间, 结束时间,
  Intent 捕获: {捕获的 Intent, 澄清轮次},
  执行: {活跃 Mission / Task / Action / 能力调用},
  响应: {输出, 模态, 引用证据},
  证据, 回执,
  中断: {是否中断, 原因, 现场快照},
  版本, 生命周期事件列表
}
```

**Turn 与传统"轮"的对应**：

| 传统工作流 | 本架构 |
|---|---|
| 一次会话 | Session |
| **一轮交互（用户输入 → Agent 输出）** | **Turn** |
| 多轮对话 | 多 Turn Session |

**Turn 额外承载的四个语义**：
1. **Intent 捕获边界**：Intent 只在 Turn.interpreting 阶段捕获
2. **注意力重置点**：Turn 完成时按 persist 规则重置注意力
3. **中断续接单元**：interrupted → resumed，保留现场续接
4. **预算结算单位**：Turn 有独立预算，完成时结算

**Turn 不等于**：一次 LLM 调用 / 一个 Action / 一个 Mission / 一个 Intent / 一次完整任务。

**生命周期状态机**：

```
received → interpreting → acting → responding → completed
                ↓            ↓          ↓
            clarifying   interrupted  failed
                ↓            ↓
            interpreting  resumed → acting
                ↓
            abandoned
```

| 状态 | 含义 |
|---|---|
| received | 已接收输入，未开始处理 |
| interpreting | 解析输入，捕获/澄清 Intent |
| clarifying | 需要澄清，等待用户回应 |
| acting | 执行 Mission/Goal/Plan/Task/Action |
| responding | 组织并输出响应 |
| completed | 正常完成 |
| interrupted | 被中断 |
| resumed | 从中断恢复 |
| failed | 失败 |
| abandoned | 放弃 |

**关键规则**：
- Intent 捕获发生在 Turn.interpreting
- clarifying 有次数上限
- interrupted → resumed 需保留现场快照
- 中断不自动回滚，由上层决策
- 中断期间 workspace 变更 → 恢复时检测 stale

**Turn 边界与注意力重置**：
```
Turn 完成时：
  1. 评估每个 mounted 对象是否 persist_across_turns
  2. 生成 turn_receipt
  3. 更新 Session 历史（追加、压缩旧 Turn）
  4. Session 状态更新（active → idle）

Turn 开始时：
  1. 从 Session 恢复 persist 对象
  2. 按当前输入重新评估注意力（路由）
  3. 新 Turn 的焦点置顶
```

**persist 规则**：
- 活跃 Mission/Goal 的验证标准：persist
- 未完成 Task 的上下文：persist
- 活跃 Cooperation 状态：persist
- 预算余额：persist
- 文件对象：默认不 persist，仅 active + 未完成 Task 引用时 persist
- 工具输出的详细内容：不 persist
- 已解决的错误：不 persist
- 过期的计划：不 persist

**Turn 中断与恢复**：

| 场景 | 处理 |
|---|---|
| 用户打断（新输入） | 当前 → interrupted，新 Turn 开始，旧 Turn 现场保留 |
| 超时 | Turn → interrupted，记录超时 |
| 外部事件（网络断/工具故障） | Turn → interrupted，可 resumed |
| 用户显式取消 | Turn → abandoned |
| Agent 故障 | Turn → failed |

**Turn 历史压缩**：
- 最近 N 个 Turn：完整摘要
- 较早 Turn：事件摘要
- 更早 Turn：只保留 Session 摘要
- 不压缩活跃 Turn / 未决 Intent 相关 / 活跃 Mission 相关
- 压缩记录为 system_rule 证据

**Session/Turn 与多 Agent**：
- 一个 Session 可包含多个 Agent，有主 Agent
- Turn 路由：用户输入 → 主 Agent 先接收；Agent 消息 → 按 Cooperation 路由；系统事件 → 按订阅路由
- Cooperation 可跨 Turn 持续
- Turn 中断不自动中止 Cooperation

---

### 4.3 Intent 生命周期

```
captured → interpreted → clarifying ⇄ clarified → confirmed → delegated
                ↓              ↓                      ↓           ↓
             rejected      abandoned              deferred    fulfilled
                                                      ↓
                                                  resumed → confirmed

任意状态 → superseded
```

| 状态 | 含义 |
|---|---|
| captured | 捕获原始表达，未解析 |
| interpreted | 解析出意图结构 |
| clarifying | 有歧义，正在澄清 |
| clarified | 歧义已消除 |
| confirmed | 确认承接 |
| delegated | 已产生至少一个 Mission |
| fulfilled | 对应 Mission 达成 |
| rejected | 拒绝 |
| deferred | 推迟，带恢复条件 |
| abandoned | 放弃 |
| superseded | 被新 Intent 替代 |

**硬规则**：没有确认动作不 confirmed；clarifying 有次数上限；superseded 必须彻底取消旧任务链。

---

### 4.4 Mission 生命周期

```
proposed → active → achieved | partially_achieved | abandoned | paused
                                                          ↓
                                                       resumed → active
                                                          ↓
                                                       archived
```

**规则**：Mission 不轻易 abandoned，需显式理由；paused 必须带恢复条件；archived 保留完整事件流。

---

### 4.5 Goal 生命周期

```
proposed → active → achieved | failed | blocked | abandoned
                                        ↓
                                     unblocked → active
```

**硬规则**：achieved 只认操作历史证据；blocked 必须记录阻塞原因和解除条件；failed 不删除。

---

### 4.6 Plan 生命周期

```
draft → approved → executing → completed | failed | superseded
                        ↓
                     paused → executing
                        ↓
                   replanning → approved（新版本）
```

**硬规则**：approved 前必须过 DAG 约束检查（无环/可达/有出口/回退完整）；executing 必须在快照上执行。

**Plan 结构**：
```
Plan = {
  tasks: [Task...],
  edges: [(from, to, 类型)...],   // data | control | resource
  entry_tasks, exit_tasks
}
```

---

### 4.7 Task 生命周期

```
proposed → ready → active → completed | failed | blocked | cancelled
                     ↓          ↓
                  paused     dead_letter
                     ↓
                  active
                     ↓
                  blocked → unblocked → ready
```

**Task 结构**：
```
Task = {
  id, plan_id, name, 摘要,
  依赖: [task_id...],
  成功标准: {必要条件, 充分条件, 证据要求},
  预算, 回退策略,
  绑定 Profession,
  状态, 证据, 回执, 版本
}
```

**Task completed 判据**：所有 Action 成功 + 必要条件全部满足 + 充分条件至少一个满足 + 证据链完整。

**Task 并行**：入度 0 → ready；前驱 completed → ready；并行度受预算和舱壁限制；资源冲突按优先级串行。

---

### 4.8 Action 生命周期

```
pending → ready → executing → succeeded | failed | skipped | cancelled
                      ↓
                   retrying → executing（有限次）
                      ↓
                   dead_letter
```

**规则**：succeeded 必须过工具输出校验；retrying 有上限；cancelled 由上层传播；dead_letter 进死信队列。

---

### 4.9 传播规则

**正向分解**：Intent → Mission → Goal → Plan → Task → Action

**反向传播（失败只到直接父级）**：

| 事件 | 向上传播 | 决策者 |
|---|---|---|
| Action failed | Task 检查重试/换路径 | Task 层 |
| Action dead_letter | Task 标记 blocked/failed | Task 层 |
| Task failed | Plan 检查重试/替换/replan | Plan 层 |
| Task blocked | Plan 检查依赖/资源/降级 | Plan 层 |
| Plan failed | Goal 检查换 Plan/blocked/failed | Goal 层 |
| Plan completed | Goal 验证 | Goal 层 |
| Goal achieved | Mission 检查所有关键 Goal | Mission 层 |
| Goal failed/blocked | Mission 检查降级/放弃 | Mission 层 |
| Mission 结果 | Intent 检查 fulfilled/deferred | Intent 层 |

**取消传播**：Intent superseded → Mission cancelled → Goal abandoned → Plan cancelled → Task cancelled → Action cancelled

**证据向上**：Action 证据 → Task 证据 → Plan 证据 → Goal 证据 → Mission 证据 → Intent fulfilled 证据。上级证据是下级证据的聚合，不是替代。

**Session/Turn 绑定**：
- Intent 只在 Turn.interpreting 捕获
- Intent 可跨 Turn 存活
- Mission/Goal/Plan/Task 跨 Turn 持续推进
- Action 不跨 Turn（除非中断续接）
- Turn 完成不等于 Mission 完成
- Session 关闭时，未完成 Mission → paused 或 abandoned

---

## 5. 证据体系

### 5.1 证据对象

```
Evidence = {
  id, level: action | task | plan | goal | mission | intent,
  parent_id,
  agent_id, cooperation_id,
  session_id, turn_id,

  source: {
    type: operation_history | user_confirmation | web_search | dialogue | system_rule,
    source_id, domain?, tool?, instruction?,
    reliability: 0-1,
    origin: original | secondary,
    reproducible, independence_key,
  },

  content: {摘要, 指针},
  timestamp, ttl, status, version,
  corroboration, conflicts, consumed_by,
  superseded_by, revoked_reason, freshness_score
}
```

### 5.2 生命周期状态机

```
captured → normalized → validated → active ⇄ corroborated
                                        ↓
                                     contested → arbitrated → active / superseded / revoked
                                        ↓
                                     stale → refresh → active
                                        ↓
                              superseded / archived / revoked → purged
```

| 状态 | 含义 |
|---|---|
| captured | 原始采集，未处理 |
| normalized | 已归一化、去重、打标 |
| validated | 格式/可复现性/来源已校验 |
| active | 有效，可被融合消费 |
| corroborated | 被独立证据佐证，权重提升 |
| contested | 有冲突证据，待仲裁 |
| stale | 时效过期或环境漂移，需刷新 |
| superseded | 被更新证据替代 |
| archived | 归档，只读 |
| revoked | 撤销，触发撤销传播 |
| purged | 物理删除 |

**关键规则**：stale 不能支撑"已验证"；contested 必须先仲裁；revoked 触发撤销传播；superseded 保留供审计；purge 只对 archived 执行且记录原因。

### 5.3 来源分级与可靠性

| 来源 | 等级 | 用途 | 可靠性 r |
|---|---|---|---|
| 操作历史 | ground truth | 正确率主导 | 0.9 |
| 用户显式确认 | 高可靠 | Intent 确认、目标仲裁 | 0.8–0.9 |
| 网络搜索 | 外部参考 | 相关性/知识补充 | 0.6 |
| 对话历史 | 意图线索 | 相关性，不用于正确率 | 0.2–0.3 |
| 系统规则 | 元证据 | 仲裁记录、撤销原因 | 0.95 |

### 5.4 独立性判定

**independence_key**：`{来源类型}:{来源ID}:{内容指纹的近似}`

| 情形 | 独立？ |
|---|---|
| 同一测试重跑 | ✗ |
| 对话复述搜索结果 | ✗ |
| 不同工具对同一文件操作 | ✓ |
| 用户确认 vs 对话推断 | ✓ |
| 同一模型两次推理 | ✗ |
| 不同 Agent 对同一事实验证 | ✓ |

同 key 证据只算一个有效样本；secondary 权重 ×0.5。

### 5.5 冲突仲裁

1. **跨级优先**：操作历史 > 用户确认 > 搜索 > 对话
2. **同级加权**：`仲裁分 = 可靠性 × 新鲜度 × 独立性权重 × 佐证数`
3. **无法仲裁 → 升级**：contested → 上升决策 → 意图冲突必须问人
4. **仲裁记录**：仲裁过程本身是 system_rule 证据

### 5.6 审计链与撤销传播

```
结论 = {id, 内容, 级别, evidence_ids, confidence, method, timestamp}
```

```
revoke(evidence_id, reason)
  → evidence.status = revoked
  → 遍历 consumed_by 的所有结论
  → 移除该证据贡献，重新计算置信度
  → 低于阈值 → 结论 invalid
  → Goal achieved 的证据被撤销 → Goal 回退
  → 递归传播到父级结论（深度限制）
  → 记录撤销事件
```

### 5.7 融合规则

- 用 r 调制似然
- 去重 + 独立性标记
- secondary 打折
- 按维度独立聚合
- 级别标签：不同级别证据不能混用
- 冷启动加权 → 证据足够切贝叶斯 → 平滑混合：

```
最终评分 = (1-w) * 加权评分 + w * 贝叶斯后验均值
w = f(有效样本量, 置信度)，带滞后防抖动
```

**"证据足够"判据**：有效样本量 ≥ N + 后验 CI 宽度 < 阈值 + 最近 K 次无漂移 + 无未仲裁 contested + stale 占比 < 阈值。

**三条硬规则**：
1. 无操作历史证据，不允许标记"已验证"
2. 对话历史不能作为验证证据
3. 定期对未挂载候选抽样验证

### 5.8 跨 Agent 证据

```
跨 Agent 证据可靠性 = 来源基线可靠性 × Agent 信任等级 × 回执验证状态
```

进入融合条件：信任 ≥ 阈值 + 回执 verified + 独立性通过 + 综合可靠性 ≥ 门槛。

---

## 6. 能力体系：Tool / Skill / Protocol / Cognition

### 6.1 五类对象定义

| 概念 | 定义 | 粒度 | 回答 |
|---|---|---|---|
| Tool | 原子能力：单一函数/命令/API | 最小 | 能做什么 |
| Skill | 组合能力：Tool + Cognition + Protocol + Behavior + 步骤 + 成功标准 | 中 | 怎么完成一类任务 |
| Protocol | 交互约定 | 跨能力 | 怎么交互 |
| Cognition | 推理策略 | 跨任务 | 怎么想 |
| Behavior | 行为模式 | 细 | 习惯怎么做 |

### 6.2 能力通用契约

```
能力通用 = {
  id, type,
  name, 版本, 摘要,
  适用条件: Venn,
  前置条件, 成功标准, 失败分类,
  证据要求, 成本估计, 权限要求,
  评测结果, 依赖,
  状态, 生命周期事件列表
}
```

### 6.3 Tool 生命周期

```
registered → validated → available ⇄ degraded
                            ↓
                       unavailable → deprecated → retired
```

**契约**：输入输出 schema、幂等性、超时、输出截断、错误分类、白名单、协议引用、熔断策略。

**规则**：degraded 由连续失败/错误率触发；半开探测恢复；unavailable 传播到 Skill；deprecated 有兼容期；每次调用产生 action_receipt。

### 6.4 Skill 生命周期

```
draft → validated → binding → ready ⇄ cooling
                        ↓       ↓
                     failed   active → completed
                        ↓
                    deprecated → retired
```

**契约**：适用条件(Venn)、数据契约(ER)、执行步骤(流程)、工具协议(时序)、Cognition 引用、Tool 引用（精确版本）、Protocol 引用、Behavior 引用、成功标准、失败回退。

**规则**：draft→validated 必须过视图结构化校验；binding 绑定精确版本；ready→cooling 由连续失败/依赖降级触发。

### 6.5 Protocol 生命周期

```
defined → negotiated → bound → active → versioned
                                    ↓
                              deprecated → migrated → retired
```

**规则**：negotiated 双向确认；breaking 变更触发迁移；protocol 违规产生 system_rule 证据；retired 前提是所有绑定方已 migrated。

### 6.6 Cognition 生命周期

```
registered → validated → available → activated ⇄ cooling
                                        ↓
                                    evaluated → promoted / demoted
                                        ↓
                                    deprecated → retired
```

**规则**：Cognition 不直接执行，决定推理策略；按任务类型路由；周期性评测；demoted 传播到引用 Skill；activated 可多个。

### 6.7 联动规则

| 事件 | 传播 | 处理 |
|---|---|---|
| Tool degraded | Skill 依赖 → cooling | 暂停使用，换版本 |
| Tool unavailable | Skill 依赖 → failed | Action 换能力 |
| Protocol versioned（breaking） | 绑定方 → validated 重校验 | 未迁移标 deprecated |
| Cognition demoted | Skill 使用 → 降权 | 换 Cognition |
| Behavior cooling | 引用 Skill → 降权；Action 跳过 | 换或不用 |
| Skill cooling | Action 无法 ready | Plan/Task 换 Skill |

### 6.8 L0.7 治理层

```
Capability & Behavior Registry = {
  注册表, 契约校验器, 评测器, 生命周期管理器, 依赖图,
  降级传播器, 版本迁移器, 影子执行器,
  证据接入, Receipt 接入,
  Behavior 抽象引擎, Behavior 效果评测,
  Receipt 聚合,
  脑图: 能力目录脑图、行为分类脑图
}
```

---

## 7. 行为体系：Behavior

### 7.1 Behavior vs Skill

| 维度 | Behavior | Skill |
|---|---|---|
| 本质 | 行为模式（习惯、策略、启发式） | 完整可调用单元 |
| 输入输出 | 可无明确 schema | 必须有明确输入输出 |
| 成功标准 | 可软性 | 必须硬性 |
| 组合性 | 被 Skill 引用，也可独立触发 | 组合 Tool/Behavior/Cognition |
| 抽象来源 | 从成功轨迹观测模式 | 从成功轨迹抽象完整技能 |
| 例子 | "先读后写"、"失败先看最小用例" | "修复 lint 错误"、"审查 PR" |

### 7.2 Behavior 分类

| 类型 | 例子 |
|---|---|
| action_pattern | "先读后写"、"改前快照"、"截断工具输出" |
| strategy | "不确定先检索"、"失败先看最小用例" |
| failure_recovery | "测试失败先看最小失败用例" |
| decision_pattern | "冲突问人"、"预算超支上升决策" |
| attention_pattern | "当前目标置顶"、"过期计划移出" |

### 7.3 Behavior 契约

```
Behavior = {
  id, type, 名称, 摘要,
  适用条件: Venn,
  触发条件,
  执行模式: {序列模式 / 启发式规则 / 决策树 / 注意力策略},
  成功标准: 软性倾向 + 可观测指标,
  失败回退,
  依赖,
  证据要求, 评测结果: {触发准确率, 效果提升, 副作用率, 样本量},
  版本, 状态, 生命周期事件列表
}
```

### 7.4 Behavior 生命周期

```
observed → abstracted → validated → registered → active ⇄ cooling
                                                    ↓
                                                promoted / demoted
                                                    ↓
                                                deprecated → retired
```

**规则**：observed → abstracted 至少 3 次独立成功；abstracted → validated 必须评测集对比"使用 vs 不使用"；active → cooling 由连续副作用/效果下降/依赖降级触发；抽象是候选，不是自动写入。

### 7.5 Behavior 抽象过程

```
成功轨迹 × N（同类任务）
   ↓ 模式挖掘
候选模式
   ↓ 形式化
Behavior 草案（触发条件 + 执行模式 + 成功标准）
   ↓ 评测集对比
validated → registered → active
```

### 7.6 Behavior 抽象来源

Behavior 不是凭空定义的，而是从验证通过的轨迹中挖掘。对应关系：

| 来源概念 | 在 Behavior 抽象中的角色 |
|---|---|
| Tool | Behavior 依赖的原子能力 |
| Action | Behavior 的动作序列模式来源 |
| Goal | Behavior 的适用条件（Venn）来源 |
| Task | Behavior 的触发上下文来源 |
| Plan | Behavior 的策略/决策模式来源 |

**抽象机制**：从验证通过的 Plan/Task/Action 轨迹中，按 Goal/Tool 分类，挖掘可表达的序列/规则/策略，形成 Behavior 候选（observed → abstracted → validated）。

---

## 8. 职业体系：Profession

### 8.1 Profession 定义

```
Profession = {
  id, 名称, 摘要,
  能力画像: {
    偏好 Skill 类别, 偏好 Cognition, 偏好 Protocol, 偏好 Behavior,
    禁用能力,
  },
  验证标准: {
    严格度: lenient | normal | strict,
    证据要求, 必须验证项,
  },
  风险偏好: {
    成本容忍度, 错误容忍度, 回滚倾向,
  },
  成功标准模板, 适用任务类型, 证据要求,
  评测结果: {任务成功率, 平均 token, 副作用率, 样本量},
  版本, 状态, 生命周期事件列表
}
```

### 8.2 Profession 生命周期

```
defined → certified → active ⇄ rotated
                        ↓
                    recertified
                        ↓
                    deprecated → retired
```

**规则**：certified 必须在评测集验证；Task 绑定主 Profession，Task 内不切换；Plan 可声明职业切换点；切换产生 profession_switch_receipt。

### 8.3 画像驱动选择

**Task 激活选择流程**：
```
1. 获取 Task 绑定的 Profession 画像
2. 检索符合画像的 Skill 候选
3. 排除不可用能力
4. 按评测分数排序
5. 按画像偏好加权
6. 选定 Skill + Cognition + Protocol + Behavior 组合
7. 生成 Action 序列
```

**验证标准画像驱动**：
- developer：normal，接受"测试通过"
- reviewer：strict，要求"测试通过 + 静态检查 + diff 审查 + 边界用例"

**风险偏好画像驱动**：
- developer：medium/medium/moderate
- reviewer：high/low/conservative
- explorer：low/high/aggressive

### 8.4 L0.8 治理层

```
Profession Registry = {
  注册表: {professions},
  认证器, 画像管理器, 切换管理器, 评测器,
  证据接入, Receipt 接入,
  脑图: 职业画像脑图
}
```

---

## 9. 回执体系：Receipt

### 9.1 Receipt 定义

```
Receipt = {
  id,
  类型: action_receipt | task_receipt | plan_receipt | mission_receipt
      | capability_receipt | profession_switch_receipt
      | delegation_receipt | merge_receipt | cooperation_receipt | arbitration_receipt
      | session_receipt | turn_receipt | session_resume_receipt | turn_resume_receipt
      | file_mount_receipt | file_flush_receipt | file_unmount_receipt,
  parent_id, agent_id, cooperation_id,
  session_id, turn_id,
  时间戳,

  执行者: {profession_id, skill_id+version, tool_id+version,
          cognition_id+version, protocol_id+version, behavior_ids},
  操作: {action_id, 命令/调用, 参数, 前置条件快照},
  结果: {状态, 输出摘要, 错误分类, 耗时, 资源消耗},
  证据引用,
  workspace锚点: {workspace_id, 快照ID, 变更哈希, 受影响文件/符号},
  签名: {内容哈希, 签名者, 签名时间},

  状态, 生命周期事件列表, 版本
}
```

### 9.2 Receipt 类型

| 类型 | 粒度 | 产生时机 |
|---|---|---|
| action_receipt | 每次能力调用 | Action 执行后 |
| task_receipt | 每个 Task | Task completed/failed |
| plan_receipt | 每个 Plan | Plan completed/failed |
| mission_receipt | 每个 Mission | Mission achieved/abandoned |
| capability_receipt | 能力状态变化 | 降级/升级/迁移 |
| profession_switch_receipt | 职业切换 | Task 边界 |
| delegation_receipt | 主 Agent 派发 Task | 派发时 |
| merge_receipt | 协作结果汇总 | 收敛时 |
| cooperation_receipt | Cooperation 整体 | 完成时 |
| arbitration_receipt | 仲裁结果 | 仲裁时 |
| session_receipt | Session 整体 | 关闭时 |
| turn_receipt | Turn 汇总 | 完成时 |
| session_resume_receipt | Session 恢复 | resume 时 |
| turn_resume_receipt | Turn 恢复 | resume 时 |
| file_mount_receipt / file_flush_receipt / file_unmount_receipt | 文件操作 | 对应操作时 |

### 9.3 Receipt 生命周期

```
issued → signed → anchored → verified → archived
                                ↓
                            disputed → revoked → purged
```

**规则**：issued→signed 必须有哈希和签名者；signed→anchored 必须关联快照和证据；任何状态→disputed 可标记；disputed→revoked 仲裁确认；回滚不删除 Receipt，标记 revoked。

### 9.4 Receipt 与回滚

```
回滚到 Receipt R 之前：
  1. 找到 R 的 workspace 快照
  2. 恢复快照
  3. 将 R 及其后续 Receipt 标记为 revoked
  4. 关联证据进入 stale
  5. 触发撤销传播
  6. 记录回滚事件
```

回滚粒度：Action 级 / Task 级 / Plan 级 / File 级。回滚记录为 system_rule 证据。

### 9.5 Receipt 与评测

- 能力评测 = 该能力所有 Receipt 聚合
- Profession 评测 = 该职业所有 Task Receipt 聚合
- Session 评测 = 该 Session 所有 Receipt 聚合
- Turn 评测 = 该 Turn 所有 Receipt 聚合
- Receipt 是客观凭证，评测优先用 Receipt 聚合，证据用于结论支撑

### 9.6 跨 Agent Receipt

- Agent A 的回执由 Agent B 验证：检查签名、锚点、证据、Agent 信任
- 回执签名者是 Agent 身份
- 回执争议可跨 Agent：A 被 B 标记 disputed，进入仲裁
- 跨 Agent 证据必须追溯到回执

---

## 10. 协作体系：Agent / Cooperation

### 10.1 Agent 对象

```
Agent = {
  id, 名称, 类型: local | remote | human | service,
  身份: {注册者, 注册时间, 能力声明, 职业画像, 权限},
  信任: {等级: 0-1, 历史: {协作次数, 成功率, 争议率, 撤销率}, 来源},
  通信: {协议, 端点},
  资源: {预算, 并行度上限},
  状态, 生命周期事件列表, 版本
}
```

### 10.2 Agent 生命周期

```
registered → invited → joined → active ⇄ paused
                                    ↓
                                 leaving → left
                                    ↓
                                 evicted / failed
```

**规则**：invited→joined 需确认能力/职业/预算匹配；active→leaving 完成当前 Task 后退出；evicted 由信任降至阈值或违反协议触发；failed 触发协作层降级。

### 10.3 Agent 信任等级

**影响**：跨 Agent 证据可靠性、回执验证严格度、共享写权限、敏感能力访问。

**调整**：`信任变化 = f(协作成功率, 争议率, 撤销率, 违反协议次数)`，由 L0.9 记录为 system_rule 证据。

### 10.4 Cooperation 对象

```
Cooperation = {
  id, 名称, 摘要,
  绑定级别: mission | goal | task,
  绑定对象: {level, object_id},
  session_id, span_turns: [turn_id...],
  拓扑: peer | orchestrator_worker | hierarchical | market | blackboard,
  参与者, 角色分配,

  协议: {
    分工协议, 通信协议, 仲裁协议, 汇总协议,
    退出协议, 预算协议, 权限协议
  },

  共享资源, 收敛, 预算, 证据, 回执,
  状态, 生命周期事件列表, 版本
}
```

### 10.5 Cooperation 生命周期

```
proposed → negotiating → formed → active ⇄ paused
                                    ↓
                              stalled / conflicted
                                    ↓
                              renegotiating → active
                                    ↓
                                converging → completed / partially_completed
                                    ↓
                                failed / dissolved / aborted
```

**硬规则**：negotiating 有次数上限；stalled 超时强制上升决策；意图冲突必须问人；aborted 保留现场供审计。

### 10.6 五种协作拓扑

| 拓扑 | 结构 | 适用 | 仲裁者 |
|---|---|---|---|
| peer | 无中心 | 小规模、能力相当 | 投票或外部仲裁者 |
| orchestrator_worker | 一个 orchestrator + workers | 主 Agent 派发 Task | orchestrator |
| hierarchical | 多层主从 | 大规模 | 每层 orchestrator |
| market | 投标竞争 | 任务可定价、能力异构 | 拍卖机制 + 外部仲裁者 |
| blackboard | 共享空间 | 探索性 | 黑板控制器 |

### 10.7 七维度协作协议

**分工协议**：任务分配规则、依赖声明（DAG）、并行约束、责任边界（互斥）。

**通信协议**：消息格式、频道、超时、重试、顺序、幂等。

**仲裁协议**：仲裁者（非冲突方）、仲裁范围、规则、升级路径、时限。

**汇总协议**：结果合并规则、冲突检测、部分完成处理、汇总者。

**退出协议**：优雅退出、故障退出、驱逐条件、解散条件、退出通知。

**预算协议**：总预算、分配规则、超支处理、预算审计。

**权限协议**：workspace 模式、隔离策略、能力访问、密钥引用、危险操作确认。

### 10.8 跨 Agent 共享与隔离

**Workspace 模式**：

| 模式 | 含义 | 适用 |
|---|---|---|
| isolated | 独立子 workspace | 默认，高风险 |
| shared_read | 共享只读 + 独立写 + 合并点 | 多 Agent 读同一代码库 |
| shared_write_with_lock | 共享写 + 文件/区域锁 | 协作编辑 |

**证据/回执跨 Agent 信任**：信任等级调制 + 回执验证 + 独立性判定 + 融合门槛。

### 10.9 冲突解决

| 类型 | 仲裁方式 |
|---|---|
| 资源冲突 | 文件锁 + 优先级 + 时间窗口 |
| 结果矛盾 | 交叉验证 + 仲裁者 + 重新执行 |
| 意图冲突 | **必须问人** |
| 协议违反 | 仲裁者 + 信任下降 |
| 预算冲突 | 按价值/成本比 |
| 拓扑冲突 | renegotiating |

**升级路径**：Level 1 协议内 → Level 2 协作内仲裁者 → Level 3 上升级别 → Level 4 人工决策。

### 10.10 Cooperation 与六级绑定

| 绑定级别 | 含义 | 典型拓扑 |
|---|---|---|
| Mission 级 | 多 Agent 共享 Mission | orchestrator_worker / hierarchical |
| Goal 级 | 多 Agent 各负责 Plan | peer / orchestrator_worker |
| Task 级 | 主 Agent 派发 Task | orchestrator_worker |

**规则**：一个 Cooperation 绑定一个级别的一个对象；跨 Agent 不共享 Action；Task 是跨 Agent 协作的最小调度单位；Cooperation 归属 Session，可跨 Turn 持续。

### 10.11 L0.9 治理层

```
Cooperation Registry = {
  Agent 注册表, Agent 信任管理器,
  Cooperation 注册表, Cooperation 生命周期管理器,
  拓扑调度器, 协议校验器, 仲裁器, 冲突检测器,
  收敛管理器, 跨 Agent 证据/回执接入, 权限管理器,
  脑图: 协作分工脑图
}
```

---

## 11. 各层详细说明（L0–L8）

### 11.1 L0 外部资源层

- 工具列表来自 L0.7，按 Agent 权限和 Profession 画像过滤
- 知识库：稳定规范与项目事实分离，带来源/置信度/版本/时效
- 行为库：带契约的静态沉淀，可激活为 Skill 或 Behavior
- 防腐层：外部输入归一化，创建 captured 证据
- 知识组织脑图：主题→子主题→事实

### 11.2 L0.5 Workspace 工作现场层

```
Workspace = {
  树形大纲: 节点树,
  物理面: 文件系统/沙箱/git,
  权限面: 可写白名单/只读/禁止,
  关系图, 变更流, 快照,
  隔离模式: isolated | shared_read | shared_write_with_lock,
  合并点,
  认知脑图
}
```

**树形大纲节点**：`{id, 路径, 类型, 摘要, 元数据, 状态, 评分, 子节点}`。规则：节点即注意力对象；惰性展开；叶子可到符号级。

### 11.3 L0.6 Project 项目知识层

```
Project = {
  指令表, 架构大纲, 配置,
  默认 Profession 画像,
  协作模板,
  架构脑图,
  状态: unloaded | loaded | active | stale,
  版本, 最后验证时间
}
```

**指令契约**：命令/参数模板、前置条件、成功标准（不能只看 exit code）、超时、输出解析、截断、失败分类、失败回退、适用条件、成本、版本、历史成功率、可展开。

### 11.4–11.6 L0.7 / L0.8 / L0.9

见第 6.8、8.4、10.11 节。

### 11.7 L1 运行时状态层

```
L1 = {
  Session 状态机 + Session 注册表,
  Turn 状态机 + Turn 队列,
  六级状态机 + 意图池,
  Plan DAG + Task DAG + Task 调度器,
  Action 队列,
  当前 Profession + 当前 Cooperation,
  事件流（含 Session/Turn/Receipt/Profession/Cooperation/Agent 事件）,
  预算树（Session → Turn → Intent → Mission → ...）,
  冲突仲裁器,
  层级脑图
}
```

**子 Agent 有独立 L1 状态**，通过 Cooperation 同步。

### 11.8 L2 注意力对象层

```
注意力对象 = {
  id, 摘要, 指针, 来源,
  评分向量: {相关性, 正确率, 代价, 新鲜度, 证据强度},
  状态: candidate | mounted(focus/blur) | persisted | unmounted | stale,
  过期条件,
  evidence_ids, receipt_ids, capability_ids, behavior_ids,
  profession_id, cooperation_id, agent_id,
  session_id, turn_id,
  persist_across_turns: bool,
  级别: intent | mission | goal | plan | task | action,
  parent_id,
  workspace锚点, project锚点,
  mindmap_node_id
}
```

**生命周期分组**：强度（focus/blur）、驻留（mount/unmount/persist）、内容（update）、关系证据（associate/verify）。

**硬规则**：mount 带预算和过期条件；persist 必须有理由；blur 不删除只降权；stale 禁止读写。

#### 11.8.5 注意力 8 操作汇总

```
强度组（对象仍在窗口，权重变化）
  focus   → 提权，置顶或高优先
  blur    → 降权，保留摘要，不删除

驻留组（对象是否在窗口）
  mount   → 进入上下文，必须带预算和过期条件
  unmount → 离开上下文，保留摘要或指针
  persist → 跨步骤/跨 Turn 保留，必须有理由

内容组
  update  → 新证据/变更传播触发，刷新评分和摘要

关系证据组（操作，非状态）
  associate → 展开候选，返回评分树，深度≤2，剪枝，top-N
  verify    → 对候选打分，加权/贝叶斯混合，输出后验+证据+建议动作
```

### 11.9 L3 注意力调度层

**四机制**：路由、聚焦、切换、抑制。

**阶段切换**：

| 阶段 | 聚焦级别 | 看什么 |
|---|---|---|
| 接收 | Turn | 当前输入、Session 历史摘要 |
| 解析 | Turn + Intent | 输入解析、Intent 候选、歧义点 |
| 战略 | Mission | 价值、约束、资源总盘 |
| 规划 | Goal + Plan | 终态、备选、DAG 约束 |
| 战术 | Task DAG | ready Task、依赖、并行度 |
| 执行 | Action | 当前命令、前置条件、预期输出 |
| 验证 | 当前级别标准 + 下级证据 | 成功标准 vs 实际 |
| 失败诊断 | 最小失败单元 + 回退路径 | 失败分类、回退路径 |
| 响应 | Turn | 响应组织、证据引用 |

**脑图路由**：从中心节点展开 1–2 层，按评分排序，沿关联边扩展候选，选高分节点锚点展开，记录注意力决策日志。

**变更传播**：workspace/project/知识库变更 → 对象/视图 stale；证据生命周期事件 → 引用对象 update；Task 状态变化 → Plan DAG 重评估；能力/行为/职业/协作状态变化 → 引用对象 update；脑图 stale 传播。

**Turn 边界重置**：Turn 完成时按 persist_across_turns 决定对象去留。

### 11.10 L4 上下文组装层

```
上下文 = [
  Session 历史摘要（1–2 行：主题、未决事项、预算余额）,
  当前 Turn 输入（原始输入 + 模态）,
  Intent 目标对象 + 期望变化（1 行）,
  Mission 约束（1-2 行）,
  Goal 验证标准（始终置顶）,
  当前 Profession 画像摘要（1 行）,
  当前 Cooperation 上下文（1-2 行）,
  当前脑图路径摘要（1 行）,
  Plan 策略摘要（1-2 行）,
  Task 当前焦点（摘要 + 成功标准）,
  Action 详细内容,
  mounted 资源摘要（含证据置信度 + 最近 Receipt 状态）
]
```

**原则**：只放摘要+指针；目标/约束/验证标准置顶；长输出做注意力摘要；视图渲染不进上下文；证据摘要带置信度；跨 Agent 详细上下文不进本 Agent 窗口；协作冲突摘要置顶；Session 历史只放压缩摘要。

### 11.11 L5 认知层

**不同级别的推理模式**：

| 级别 | 推理模式 | 关注 |
|---|---|---|
| Turn | 解析、澄清、响应组织 | 输入意图、歧义、响应质量 |
| Intent | 解析、澄清、价值判断 | 是否承诺 |
| Mission | 价值判断、资源分配 | 是否继续、是否降级 |
| Goal | 终态验证、备选评估 | 达成度、阻塞原因 |
| Plan | 策略规划、DAG 设计、replan | 终止性、并行度、回退 |
| Task | 战术执行、依赖管理、局部重试 | 成功标准、Action 编排 |
| Action | 执行、调试、重试 | 前置条件、输出、失败分类 |

**失败归因分层**：Intent（误解/不可行/冲突）、Mission（价值/外部）、Goal（不可达/标准/资源）、Plan（DAG/依赖/并行度）、Task（编排/标准/竞争）、Action（工具/前置/参数/注意力错配）、Turn（输入解析/澄清不足/响应差/中断不当）。

**能力/职业/协作归因**：Tool 错误/Skill 不适用/Protocol 违规/Cognition 不适配；画像不匹配/验证过松/风险偏好错配；分工不合理/通信失败/仲裁失败/信任不足。

### 11.12 L6 验证层

**六类视图约束**：

| 视图 | 可执行约束 | 验证什么 |
|---|---|---|
| ER | 基数、必填、唯一、类型 | 数据一致性 |
| 时序 | 消息顺序、同步点、超时 | 工具调用合法、无竞态 |
| 流程 | 可达性、终止性、分支完备 | 计划不死循环 |
| Venn | 覆盖完整性、互斥性、包含 | 候选覆盖、权限边界 |
| 架构 | 分层规则、依赖方向、禁止环 | 代码依赖不反向 |
| 脑图 | 中心唯一、父子无环、深度上限、锚点存在、关联可解释 | 大纲结构合法 |

**生命周期验证**：

| 级别 | 验证方式 | 证据要求 |
|---|---|---|
| Session | 状态一致性、预算余额正确 | 事件流重放校验 |
| Turn | 输入被正确解析、Intent 捕获完整、响应引用证据有效、中断处理正确 | turn_receipt |
| Intent | 理解正确性 + 承接正确性 | 用户确认证据 |
| Mission | 业务价值、约束满足 | Goal 达成证据聚合 |
| Goal | 可执行成功标准 | 操作历史证据，active |
| Plan | DAG 约束 | 流程视图 + Task 证据 |
| Task | 成功标准（必要+充分） | Action 证据聚合，active |
| Action | 工具输出校验、指令契约 | 操作历史证据 |

**能力/职业/回执验证**：Tool 输出符合契约；Skill 成功标准满足；Protocol 合规；Cognition 契约；Behavior 副作用检查；验证标准按 Profession 画像执行；操作必须有 Receipt 且已 verified。

**协作一致性验证**：分工/通信/汇总/退出协议是否被遵守；跨 Agent 证据信任是否达标；跨 Agent 回执是否 verified。

**证据相关规则**：stale 不能支撑"已验证"；contested 必须先仲裁；revoked 结论必须重评估；同源不能重复计数；跨级不能跳过验证标准。

### 11.13 L7 证据融合层

职责：
1. 证据生命周期状态机管理
2. 独立性判定与去重
3. 冲突检测与仲裁
4. 时效衰减与刷新
5. 佐证聚合
6. 加权/贝叶斯融合
7. 消费审计链维护
8. 撤销传播
9. 归档与清理
10. 跨 Agent 证据信任调制
11. Receipt → Evidence 映射
12. Session/Turn 级证据聚合
13. 证据组织脑图

**融合流程**：采集 → 独立性判定 → 校验 → 激活 → 佐证 → 冲突 → 仲裁 → 时效检查 → 融合消费 → 聚合 → 审计链记录 → decay/archive/purge。

### 11.14 L8 学习沉淀层

**沉淀流程**：验证通过轨迹 → 压缩去噪 → 抽象行为候选 → 影子/金丝雀验证 → 人工/评测确认 → 写入行为库

**沉淀粒度**：

| 粒度 | 沉淀物 | 用途 |
|---|---|---|
| Session 级 | 成功 Session 模式（Turn 序列、Intent 捕获模式） | 交互优化 |
| Turn 级 | 成功 Turn 模式（输入解析、响应组织） | 交互优化 |
| Intent 级 | Intent→Mission 映射模式 | 降低 Intent 层开销 |
| Mission 级 | 成功 Mission 模板 | 工作流片段 |
| Plan 级 | 成功 Plan 模板（Task DAG） | 工作流片段 |
| Task 级 | 成功 Task 模板 | 动作模板 |
| Action 级 | 成功操作序列 | 微动作模板 |
| 失败 Plan/Task/Action | 失败修复模式 | 负面知识 |
| 协作级 | 成功 Cooperation 的拓扑+分工+协议 | 协作模板 |

**行为契约用视图结构化**：适用条件(Venn) + 数据契约(ER) + 执行步骤(流程) + 工具协议(时序) + 成功标准(六类约束) + 大纲结构(脑图)。

---

## 12. 文件对象模块

### 12.0 定位

**文件是 Workspace 中的可读写单元，是注意力对象在物理面的锚点，是 Receipt 的 workspace 锚点载体，是 Evidence 的原始来源。**

文件对象必须解决四件事：
1. **生命周期**：从磁盘到内存到编辑到写回，状态可追踪
2. **定位安全**：符号级行列字节必须带版本哈希，否则一改就错位
3. **写入安全**：AST 结构化重写，禁止裸字节替换
4. **跨对象绑定**：与 Session/Turn/Receipt/Evidence/Cooperation 的归属关系

### 12.1 生命周期状态机

```
                    mount()                    load()
   unmounted ──────────────→ mounted ──────────────→ active
       ↑                        │                     │  ↑
       │                        │ reload()            │  │ write()
       │                        │ 或 外部变更检测      │  │
       │                        ↓                     ↓  │
       │                      stale ←────────────── dirty
       │                        │                     │
       │                        │ reload()            │ flush()
       │                        ↓                     ↓
       └──────────────────── active ←──────────── active
                                │
                                │ unmount()
                                ↓
                            unmounted
```

| 状态 | 含义 | 内容是否加载 | 是否可写 |
|---|---|---|---|
| unmounted | 只有路径引用 | ✗ | ✗ |
| mounted | 已加载元数据 + 大纲，未加载全文 | 元数据 + 大纲 | ✗ |
| active | 内容已加载，有版本哈希，可读可写 | 全文 + 大纲 | writable 时可写 |
| stale | 磁盘版本 ≠ 记录哈希 | 旧内容（只读） | ✗ |
| dirty | 有未持久化编辑 | 编辑中内容 + 大纲 | ✓（仅内存） |

**访问模式**（与状态正交）：`read-only | writable`，由 Workspace 权限面决定，mount 时锁定。

**用户概念映射**：

| 用户原始概念 | 演化后 | 理由 |
|---|---|---|
| mount | 状态 `mounted` + 操作 `mount()` | 保留 |
| view | 访问模式 `read-only` + 操作 `read()` | view 不是状态，是权限+读取 |
| edit | 访问模式 `writable` + 状态 `dirty` + 操作 `write()` | edit 不是状态，是写权限+编辑过程 |
| unmount | 状态 `unmounted` + 操作 `unmount(force?)` | 保留，增加 force 处理 dirty |

新增状态 `active`（内容已加载）和 `stale`（版本失效）是 view/edit 能安全工作的前提。

### 12.2 生命周期操作

**mount(path, mode?)**：前置路径存在、权限允许；动作读元数据、算哈希、构建大纲、锁 mode、生成 file_mount_receipt；后置 mounted。

**load() / read(range?)**：前置 mounted 或 active；动作加载全文或切片、校验哈希；不一致 → stale 拒绝；后置 active。

**write(range, content)**：前置 active + writable + 哈希匹配；动作 AST 结构化重写、保留缩进/换行、重新解析校验、失败回滚内存编辑、成功标 dirty、受影响符号 stale；后置 dirty。

**flush()**：前置 dirty；动作语法校验、原子写回、更新哈希、生成 action_receipt、触发变更传播；后置 active。

**reload()**：前置 stale 或 active 且无 dirty（或 force）；动作重新加载、重算哈希、重解析大纲、生成 reload_receipt；后置 active。

**unmount(force?)**：前置 mounted/active，或 dirty 且 force；动作 dirty 非 force 拒绝、force 丢弃并记录 system_rule 证据、释放内容、保留或丢弃大纲缓存、生成 unmount_receipt；后置 unmounted。

**validate()**：返回语法合法、大纲一致、哈希匹配，不改状态。

**diff(base?)**：base = 磁盘版本 / 快照版本 / 指定 Receipt 版本；返回结构化 hunk 列表，每个 hunk 标注受影响符号。

**用户操作映射**：

| 用户原始操作 | 演化后 | 理由 |
|---|---|---|
| outline | 操作 `outline(node_id?)` | 保留 |
| range(line, byte) | **参数** `{line\|byte, start, end}`，用于 read/write/locate | range 是定位方式，不是独立操作 |
| charset | `metadata().encoding`（含 BOM/newline） | charset 是元数据，不单独作为操作 |
| diff | 操作 `diff(base?)` | 保留，返回结构化 hunk |

### 12.3 状态 × 操作矩阵

| 操作 | unmounted | mounted | active | stale | dirty |
|---|---|---|---|---|---|
| mount | ✓ | ✗ | ✗ | ✗ | ✗ |
| load / read | ✗ | ✓（首次） | ✓ | ✗ | ✓ |
| outline | ✗ | ✓（缓存） | ✓ | ✗（需 reload） | ✓ |
| locate | ✗ | ✓ | ✓ | ✗ | ✓ |
| metadata | ✗ | ✓ | ✓ | ✓（只读） | ✓ |
| write | ✗ | ✗ | ✓（writable） | ✗ | ✓ |
| flush | ✗ | ✗ | ✗ | ✗ | ✓ |
| diff | ✗ | ✗ | ✓ | ✓ | ✓ |
| validate | ✗ | ✗ | ✓ | ✗ | ✓ |
| reload | ✗ | ✓ | ✓ | ✓ | 需 force |
| unmount | ✗ | ✓ | ✓ | ✓ | 需 force |

**非法调用直接拒绝，不靠模型自觉。**

### 12.4 符号节点与定位安全

```
符号节点 = {
  id(限定名), 
  type: file | class | function | method | property | variable | import,
  name, parent_id,
  定位: {
    版本哈希,
    start_line, end_line,
    start_byte, end_byte,
    start_col?, end_col?,
  },
  摘要, 状态,
  元数据: {语言, 修饰符, 签名, docstring摘要}
}
```

**定位安全规则**：
- 版本哈希是命门：节点定位只在 `文件版本 == 节点记录的版本哈希` 时有效
- 行号对齐工具链，字节用于切片，互相校验
- 换行归一化（CRLF/LF）后再算字节
- 多字节字符按 UTF-8 字节偏移

**符号粒度规则**：文件、类/命名空间、函数/方法、类字段/实例属性、模块级变量、dict/JSON/YAML 键值对 → 节点；局部变量、表达式内部临时变量 → 不节点。

**解析器与增量失效**：tree-sitter；解析失败降级文件级 + 报错位置；稳定 ID `路径::限定名`；增量失效按 diff hunk；大文件分层懒加载。

### 12.5 文件对象与 Session/Turn 的绑定

- **Session**：文件操作归属当前 Session，file_mount_receipt 带 session_id
- **Turn**：文件操作在 Turn.acting 阶段发生，receipt 带 turn_id
- **跨 Turn 持久化**：文件对象默认不 persist_across_turns；只有 active 且有未完成 Task 引用时才 persist
- **Session 关闭**：所有文件对象 unmount（dirty 需处理，否则拒绝关闭）
- **Session 恢复**：文件对象不自动恢复，按需重新 mount；大纲缓存可从 Session 级缓存恢复

**Turn 边界文件处理**：dirty 且未 flush → 有未完成 Task 则 persist，否则提示 flush 或 force unmount；active 且有引用 → persist，无引用 → 评估是否 unmount。

**Turn 中断文件处理**：打 workspace 快照（含 dirty 内存编辑）；恢复时检测 stale，冲突解决或续接。

### 12.6 文件对象与 Receipt/Evidence 的绑定

**Receipt workspace 锚点**：
```
action_receipt.workspace锚点 = {
  workspace_id, 快照ID, 变更哈希,
  受影响文件: [file_path...],
  受影响符号: [symbol_id...],
  变更范围: [{path, start_byte, end_byte, 旧哈希, 新哈希}],
}
```

**Evidence 来源**：flush 成功/失败、validate 通过/失败、diff 辅助证据。Evidence 必须引用 Receipt。

**回滚**：文件级回滚到 Receipt 之前 → 恢复快照、标记后续 Receipt revoked、关联 Evidence stale、触发撤销传播、文件状态 → active。

### 12.7 文件对象与多 Agent 协作的绑定

**隔离模式对文件的影响**：

| 模式 | 可见性 | 写入方式 | 冲突处理 |
|---|---|---|---|
| isolated | 独立子 workspace | 各自写 | 汇总合并 |
| shared_read | 共享只读 + 独立写 + 合并点 | 独立写 | 合并检测 |
| shared_write_with_lock | 共享写 | 加锁写 | 文件锁/区域锁 |

**文件锁**：exclusive / shared / region，带 TTL 自动释放，死锁检测。

**跨 Agent 冲突**：文件级（版本哈希检测）、区域级（区域锁重叠）、语义级（合并后语法错误）、删除冲突（问人）。

**合并点**：收集变更 → 冲突检测 → 仲裁 → 应用 → 语法校验 → merge_receipt。

### 12.8 文件对象与能力/职业的绑定

**规则**：文件操作优先通过 Skill 执行，不直接调用裸 Tool。Skill 带成功标准、失败回退、验证规则，受 Profession 画像约束。

**直接调用例外**：显式理由（system_rule 证据）+ 完整验证 + action_receipt。

**Profession 约束**：developer 可写；reviewer 只读（禁用写能力）；tester 只读源码可写测试；explorer 只读。

### 12.9 文件对象的风险与对策

| 风险 | 对策 |
|---|---|
| 版本哈希缺失改错位置 | 定位必带哈希，不匹配拒绝读写 |
| 字节替换破坏语法 | AST 结构化重写 + 写后校验 |
| 多字节/换行漂移 | UTF-8 字节统一 + 换行归一化 + 行列校验 |
| dirty 丢编辑 | unmount 需 force + 记录证据 |
| stale 误读写 | 禁止 read/write，必须 reload |
| 符号节点爆炸 | 只收稳定命名成员，大文件懒加载 |
| 解析失败 | 降级文件级 + 报错位置 |
| 跨 Agent 写冲突 | 文件锁/区域锁/版本哈希检测 |
| 合并后语法错误 | 合并点语法校验 + merge_receipt |
| 回滚掩盖失败 | 回滚记录为 system_rule 证据 |
| 快照开销大 | 增量快照 + git 原生 + 按步骤 |
| dirty 阻塞 Session 关闭 | closing 时强制处理 |
| Turn 中断丢文件现场 | 中断前快照 + 续接时 stale 检测 |
| 文件操作绕过 Skill | 直接调用需显式理由 + 完整验证 |
| 审查者误写文件 | Profession 禁用能力过滤 |

---

## 13. 视图系统（六种视图）

### 13.1 六种视图总览

| 视图 | 语义 | 主要消费方 |
|---|---|---|
| ER | 实体+属性+基数 | 知识库 schema、证据模型 |
| 时序 | 参与者+消息+时序 | 工具协议、行为契约 |
| 流程 | 动作/判断+控制流 | 执行循环、计划、状态机 |
| Venn | 集合+交并差+边界 | 候选筛选、权限边界 |
| 架构 | 组件+连接器+依赖 | Project outline、依赖验证 |
| 脑图 | 中心主题+层级分支+跨分支关联 | 大纲组织、路由联想、能力目录、协作分工 |

### 13.2 统一抽象

```
View = {
  类型: ER | 时序 | 流程 | Venn | 架构 | 脑图,
  实体集, 关系集, 约束集,
  消费目的: 路由 | 验证 | 计划 | 诊断 | 沉淀,
  版本, 新鲜度,
  来源, 锚点
}
```

### 13.3 三条原则

1. 视图是投影，不是真相
2. 视图可查询、可验证、可驱动
3. 视图有版本和 stale

### 13.4 一致性规则

- 跨视图锚点一致
- 变更传播
- 视图版本化
- 脑图 stale 传播

### 13.5 对 Agent 隐藏

| 东西 | 对 Agent | 去哪 |
|---|---|---|
| 视图的渲染 | 完全隐藏 | 外部 UI/报告 |
| 视图的约束 | 不进上下文，但必须执行 | 确定性验证器 |
| 违反约束的报告 | 只给简短结论 | 进上下文 |
| 脑图结构 | 不直接进上下文 | 确定性路由器和导航器 |
| 当前脑图路径的节点摘要 | 进上下文（1–2 行） | L4 上下文组装 |

### 13.6 脑图视图

**结构**：
```
MindMap = {
  类型: mind_map,
  中心节点,
  分支: [{层级, 节点, 子分支}],          // 递归，深度上限 D
  关联边: [{from, to, 类型, 权重, 理由}],  // 可跨分支
  约束集, 版本, 新鲜度, 来源, 锚点
}
```

**节点模型**：
```
脑图节点 = {
  id, 主题(≤N token), 摘要,
  类型: topic | subtopic | leaf | reference,
  锚点: {object_type, object_id, version_hash?},
  评分: {相关性, 新鲜度, 证据强度},
  状态: expanded | collapsed | stale | forbidden,
  子节点
}
```

**关联边类型**：supports、depends、related、conflicts、refines、evidences、references。

**生命周期**：`defined → built → active ⇄ stale → rebuilt → archived / retired`

**脑图与树形大纲的区别**：

| 维度 | 树形大纲 | 脑图 |
|---|---|---|
| 结构 | 严格树（单父） | 层级树 + 跨分支关联边 |
| 用途 | 物理结构定位 | 知识组织 + 大纲 + 联想 |
| 环 | 禁止 | 父子边禁止；关联边允许（需标记） |

**脑图约束**：中心唯一（硬）、父子无环（硬）、深度 ≤ D（硬）、节点锚点存在（硬）、关联边理由非空（硬）、关联边数 ≤ N（硬）、同级节点数 ≤ M（硬）、锚点哈希一致（硬）、同级摘要不重复（软）、关联边不形成纯关联环（软）。

**脑图在各层的应用**：

| 层 | 应用 |
|---|---|
| L0 | 知识组织脑图 |
| L0.5 | 认知脑图（与树共享锚点） |
| L0.6 | 架构脑图（与架构图共享锚点） |
| L0.7 | 能力目录脑图、行为分类脑图 |
| L0.8 | 职业画像脑图 |
| L0.9 | 协作分工脑图 |
| L1 | 层级脑图；Session 历史脑图；Turn 执行脑图 |
| L2 | 脑图节点即注意力对象锚点 |
| L3 | 脑图作为路由视图 |
| L4 | 只放当前路径摘要 |
| L5 | 帮助理解"当前位置" |
| L6 | 脑图约束进入验证层 |
| L7 | 证据组织脑图 |
| L8 | 沉淀组织脑图 |

**associate 与脑图的统一**：关联边扩展 = associate 评分树；深度限制 = 脑图层级深度限制；阈值剪枝 = 关联边权重阈值；top-N = 每层节点数上限。

---

## 14. 横切设计思想

| 思想 | 落点 | 作用 |
|---|---|---|
| 事件溯源 | L1 历史、L7 证据、L6 回滚、L0.7 能力事件、Receipt 事件、Cooperation 事件、脑图重建事件、Session/Turn 事件 | 历史即真相 |
| CQRS | L2/L3 读侧，L0.5/L6 写侧，Session 读侧 / Turn 写侧 | 读写分离 |
| 编译期约束 | L6、Project 约定、能力契约、Profession 标准、协作协议、脑图约束 | 确定性验证 |
| 防腐层 | L0 知识入口、L7 采集 | 外部噪声归一化 |
| 熔断/舱壁/配额 | L0 工具、L0.6 指令、L3 调度、Task 并行度、能力熔断、Agent 配额 | 单点失败不拖垮 |
| 影子/金丝雀 | L7 评分、L8 沉淀、能力升级、Behavior 验证、Profession 再认证、协作模板验证 | 变更安全阀 |
| 幂等/可重放 | L0 工具、L1 历史、L6 回滚、Receipt 重放、协作消息幂等、Session 恢复幂等 | 重试安全 |
| 死信队列 | L5 停止、L6 失败、Task dead_letter、Action 死信、协作 stalled | 不阻塞主循环 |
| 仓储/DI | L0、全局 | 可替换可测试 |
| 模式迁移 | L8 行为库、L0 知识库、能力版本、Profession 版本、协作协议版本 | 契约演进 |
| 不可变/写时复制 | L2、L0.5 快照、证据、能力版本、Receipt、协作事件、Turn 现场快照 | 并发安全 |
| 可观测性三件套 | 横切 L3/L4/L7/L0.7/L0.8/L0.9，Session/Turn 级归因 | 日志/归因/追踪 |
| 故障注入 | L6 评测、L8 回归、能力降级、Profession 压测、Agent 故障注入、Turn 中断注入 | 测回退熔断 |
| 特性开关 | L7、L3、Cognition/Behavior/Profession/协作模板灰度 | 灰度新策略 |
| 无环依赖 | L0.6 架构图、L6、Task DAG、能力依赖图、协作 Task 依赖图、脑图父子边 | 依赖方向验证 |
| 证据审计链 | 横切 L5/L6/L7 | 结论可追溯 |
| 撤销传播 | 横切 L7 + 事件驱动 | 错误不扩散 |
| DAG 调度 | L1 Task 调度器、L3 | 并行执行 |
| 能力降级传播 | L0.7 + 事件驱动 | 坏能力自我收敛 |
| 能力版本迁移 | L0.7 迁移器 + 影子 | 版本演进安全 |
| 回执审计 | 横切 Receipt 存储 + 采样审计 | 操作可追溯可回滚 |
| 争议仲裁 | L7 + L0.7/L0.8/L0.9 | 可疑执行可作废 |
| 职业画像驱动 | L0.8 + L3/L5/L6 | 角色约束能力选择 |
| 行为抽象引擎 | L0.7 + L8 | 从轨迹提炼习惯 |
| 身份与信任 | L0.9 + 横切 | 跨 Agent 证据/回执可信 |
| 协作拓扑 | L0.9 + L3 | 多 Agent 分工调度 |
| 冲突仲裁 | L0.9 + L5/L6 | 协作分歧可解决 |
| 收敛机制 | L0.9 + L8 | 协作结果可汇总 |
| 脑图路由 | L3 + L2 | 从中心展开、按关联跳转 |
| 脑图导航 | L4 + L5 | 当前路径 + 相关提示 |
| 状态恢复 | Session resume + Turn resume | 跨会话/中断续接 |
| 边界重置 | Turn 边界注意力重置 | 防上下文无限累积 |

**可观测性三件套**：注意力决策日志、Token 归因（含能力/行为/职业/协作/脑图/Session/Turn）、证据追踪（含跨 Agent）、Task DAG 状态、Receipt 计数、协作状态、脑图路径。

---

## 15. 核心执行循环

```
 0. Session 创建/恢复：
    - 新建：create → active
    - 恢复：resume → 恢复状态 → active
 1. Turn 接收：received（session_id + turn_id）
 2. Turn 解析：interpreting
    a. 解析输入，提取意图候选
    b. 如需澄清 → clarifying（有次数上限）
    c. 捕获 0..N 个 Intent → Intent.captured
 3. Turn 执行：acting
    a. Intent 解析/确认/承接 → Mission
    b. Mission → Goal → Plan → Task → Action
    c. 能力调用 → Receipt → Evidence → 融合
    d. 协作（如需要）→ Cooperation 跨 Turn 持续
 4. Turn 响应：responding
    a. 组织响应，引用证据
    b. 输出
 5. Turn 完成：completed
    a. 生成 turn_receipt
    b. 更新 Session 历史
    c. 注意力边界重置（persist_across_turns 评估）
    d. Turn 预算结算
 6. Session 状态更新：active → idle
 7. 下一个 Turn 或 Session 操作：
    - 用户输入 → 新 Turn
    - 超时 → suspend
    - 显式关闭 → closing → closed
    - 异步 Mission 继续 → 在 Session 级保留预算下推进
 8. Session 关闭：
    a. 处理未完成 Turn（等待/中断）
    b. 未完成 Mission → paused 或 abandoned
    c. 活跃 Cooperation → 完成/中止/解散
    d. 生成 session_receipt
    e. 归档历史
 9. 后台维护（跨 Session）：
    - 证据生命周期维护
    - Receipt 维护
    - 能力/行为/职业/协作生命周期维护
    - 脑图维护
    - 沉淀
10. 循环或终止（Session closed/expired/aborted）
```

---

## 16. 预算分配机制

### 16.1 预算树

```
Session 总预算
  ├─ Session 级保留预算（跨 Turn Mission/Cooperation）
  ├─ Turn 1 预算
  │   ├─ Intent 1 预算
  │   │   ├─ Mission 预算
  │   │   │   ├─ Goal 预算
  │   │   │   │   ├─ Plan 预算
  │   │   │   │   │   ├─ Task 预算
  │   │   │   │   │   │   └─ Action 预算
  │   │   │   │   │   └─ ...
  │   │   │   │   └─ ...
  │   │   │   └─ ...
  │   │   └─ ...
  │   └─ Intent 2 预算
  ├─ Turn 2 预算
  └─ 通信/仲裁/收敛/脑图构建预算
```

### 16.2 规则

- 上层分配，下层消耗
- Session 总预算由发起者分配
- Turn 预算从 Session 预算划拨，Turn 完成时结算
- 未用完的 Turn 预算：可回收或保留（按策略），默认回收
- 跨 Turn 的 Mission 使用 Session 级保留预算
- Turn 预算耗尽：Turn → interrupted，上升决策
- Session 预算耗尽：Session → closing 或 suspended
- 单 Agent 超支 → 暂停并上升
- 通信/仲裁/收敛/脑图构建预算独立计算

### 16.3 预算维度

Token、时间、工具调用次数、重试次数、每工具/行为/workspace 配额、Intent 澄清次数上限、证据采集与融合预算、Task 并行度上限、能力调用配额、Cognition 成本乘数、协作总预算/Agent 预算/通信预算/仲裁预算/收敛预算、脑图构建/重建预算、Session 总预算、Turn 预算、Session 级保留预算、跨 Turn 通信预算。

---

## 17. 关键设计决策汇总

| 决策 | 选择 | 理由 |
|---|---|---|
| 上下文定位 | 注意力调度的输出 | 防默认全量注入 |
| 注意力机制 | 路由/聚焦/切换/抑制 + 8 操作 | 从概念变可执行 |
| 生命周期 | 分组管理，blur 不删除 | 防抖动 |
| associate | 深度限制+剪枝+预算 | 防组合爆炸 |
| Session 定位 | 交互容器，跨 Turn 跨 Intent 跨 Mission | 状态可恢复、预算可池化 |
| Turn 定位 | 交互原子，Intent 捕获边界，对应传统"一轮" | 明确的输入-响应单元 |
| Session 生命周期 | created→active⇄idle→suspended→resumed→closing→closed→archived | 覆盖创建/活跃/挂起/恢复/关闭 |
| Turn 生命周期 | received→interpreting→acting→responding→completed/interrupted/resumed/failed/abandoned | 覆盖解析/执行/响应 |
| Turn 边界 | 注意力重置点 | 防上下文无限累积 |
| persist 规则 | 活跃 Mission/Goal/Task/Cooperation 持久化，工具输出不持久化 | 平衡连续性和 token |
| Intent 捕获 | 只在 Turn.interpreting 发生 | 边界清晰 |
| Action 跨 Turn | 不跨 Turn（除非中断续接） | 原子性 |
| Mission 跨 Turn | 可跨 Turn 持续推进 | 长任务需要 |
| Cooperation 跨 Turn | 可跨 Turn 持续 | 异步协作需要 |
| Session 恢复 | 重放事件流 + 快照，幂等 | 可靠恢复 |
| Turn 中断 | 保留现场，支持续接 | 用户打断/超时常见 |
| Session 关闭 | 处理未完成 Turn，未完成 Mission → paused/abandoned | 优雅收尾 |
| 历史压缩 | 按 Turn 压缩，活跃相关不压缩 | 防历史膨胀 |
| 多 Agent Session | 有主 Agent，Turn 按协议路由 | 多 Agent 协作 |
| Intent vs Mission | 未承诺 vs 已承诺 | 语义精确 |
| Mission vs Workspace | 知识层 vs 工作现场 | 分层清晰 |
| 指令 | 契约化+结构化输出+失败分类 | 防黑盒 |
| Workspace 表示 | 树形大纲+外挂 | 树只承载结构与定位 |
| 文件对象 | 状态机+访问模式正交 | 语义清晰 |
| 文件操作 | 四类+状态×操作矩阵 | 非法调用可拒绝 |
| 文件 view/edit | 访问模式，不是状态 | view/edit 是权限+过程 |
| 文件 range/charset | range 是参数，charset 是元数据 | 不是独立操作 |
| 符号定位 | 行+字节+版本哈希 | 防改错位置 |
| 符号写入 | AST 结构化重写 | 防破坏语法 |
| 视图定位 | 关系语义投影，横切不增层 | 避免可视化负担 |
| 视图对 Agent | 隐藏渲染，约束下沉 | 省 token 零幻觉 |
| 脑图定位 | 第六种视图，大纲+联想 | 补层级+跨分支关联的缺口 |
| 脑图节点 | 必须锚定真实对象 | 投影不造真相 |
| 证据定位 | 一等对象，有生命周期 | 可追溯可撤销可审计 |
| 证据独立性 | independence_key 去重 | 防同源重复计数 |
| 证据冲突 | 跨级优先+同级加权+无法仲裁升级 | 防弱证据污染 |
| 证据撤销 | 触发撤销传播 | 错误不扩散 |
| Plan 定位 | 策略：Task DAG+控制流 | 区分策略与战术 |
| Task 定位 | 战术：可并行、可独立跟踪 | 补上并行和局部失败处理 |
| Task 依赖 | DAG，拓扑调度 | 并行执行 |
| Task 验证 | 成功标准+Action 证据 | 比 Action 粗、比 Goal 细 |
| Task 失败 | 局部处理，不自动取消兄弟 | 失败隔离 |
| Tool 定位 | 原子能力，有生命周期 | 防坏工具扩散 |
| Skill 定位 | 组合能力，运行时激活 | 区分沉淀与激活 |
| Protocol 定位 | 交互约定，独立管理 | 跨能力一致 |
| Cognition 定位 | 推理策略，可切换可评测 | 任务适配 |
| Behavior 定位 | 行为模式，一等对象 | 区分"习惯"和"能力" |
| Behavior 抽象 | 至少 3 次成功+评测对比，来源=Tool/Action/Goal/Task/Plan | 防单次偶然；演化关系明确 |
| Profession 定位 | 职业角色，独立层 | 角色约束能力选择 |
| Profession 绑定粒度 | Task 级 | Task 内不切换 |
| Receipt 定位 | 操作凭证，一等对象 | 审计回滚争议评测 |
| Receipt 粒度 | Action 级+Task/Plan/Mission 汇总+Session/Turn 汇总+文件操作 | 多级审计 |
| Receipt 不可变 | signed 后只改状态 | 防篡改 |
| Receipt 回滚 | Receipt 是回滚锚点 | 精确回滚 |
| Cooperation 定位 | 一等对象，独立生命周期 | 多 Agent 协作可治理 |
| Agent 定位 | 一等对象，身份+信任 | 跨 Agent 证据/回执可信 |
| 协作绑定级别 | Mission/Goal/Task 任意 | 灵活适配 |
| 协作最小调度单位 | Task | Action 不跨 Agent |
| 协作拓扑 | 五种 | 场景适配 |
| 协作协议 | 七维度 | 协商充分 |
| 默认 workspace 模式 | isolated | 安全优先 |
| 共享写 | 文件锁/区域锁/版本哈希 | 防覆盖 |
| 跨 Agent 证据 | 信任等级调制+回执验证 | 防不可信证据污染 |
| 协作收敛 | 冲突检测→仲裁→合并→cooperation_receipt | 结果可汇总 |
| 意图冲突 | 必须问人 | 语义矛盾不能自动裁决 |
| 仲裁升级 | Level 1→2→3→4 | 防无限仲裁 |
| Agent 信任 | 历史累积+可调整 | 动态可信 |
| 冷启动 | 加权评分映射为先验 | 解决无历史 |
| 收敛 | 贝叶斯按维度独立切换 | 维度积累速度不同 |
| 切换方式 | 平滑混合+滞后 | 防评分跳变 |
| 验证门槛 | 正确率只认操作历史，且证据 active | 挡自证和幻觉 |
| 行为沉淀 | 仅验证通过+影子+人工确认 | 防错误复用放大 |
| 历史 | 事件溯源，状态是投影 | 可重放回滚审计 |
| 失败传播 | 只向直接父级传播不越级 | 保持层级语义 |
| 预算 | 树形分配，超支强制决策 | 防死循环 |
| Intent 承诺 | 无确认不 confirmed | 防 Agent 自行承诺 |

---

## 18. 风险与对策

| 风险 | 对策 |
|---|---|
| 粒度失控 | 从"片段/摘要/事实卡/技能契约/符号/Task/能力"起步 |
| 调度本身烧 token | associate/verify 计入预算 |
| 过度工程 | MVP 砍到最小闭环 |
| 错误行为复用放大 | 验证层+影子+版本回滚+评测集 |
| 验证数据选择偏差 | 对 blur/unmounted 候选抽样验证 |
| 后验过期 | 遗忘因子/滑动窗口+回退加权 |
| 同源重复计数 | independence_key+去重 |
| 证据污染 | 防腐层+来源可靠性+跨级优先 |
| 证据冲突未仲裁 | contested+仲裁器+升级决策 |
| 错误证据扩散 | 撤销传播+审计链+结论重评估 |
| 证据池膨胀 | TTL+archive+purge+定期清理 |
| 撤销传播过深 | 传播深度限制+上升决策 |
| 注意力错配 | 显式记录注意力决策+验证兜底 |
| 树爆炸 | 惰性加载+聚合折叠+评分剪枝 |
| 摘要失真 | 标来源+TTL+stale 不可信 |
| 版本哈希缺失 | 定位必带哈希 |
| 字节替换破坏语法 | AST 结构化重写+写后校验 |
| 多字节/换行漂移 | UTF-8 字节统一+换行归一化 |
| 指令过期/假成功 | 版本+成功率+连续失败 stale；成功标准含输出模式+产物 |
| 视图漂移成假真相 | 视图是投影，冲突回真相 |
| 约束验证开销大 | 硬约束必查，软约束抽样 |
| 脑图爆炸 | 深度上限+节点数上限+惰性展开+评分剪枝 |
| 脑图 stale 未重建 | 锚点变更触发+增量重建+消费前校验 |
| 快照开销大 | 增量快照+git 原生+按步骤 |
| 变更传播抖动 | 批量+滞后+只传播高影响 |
| 回滚掩盖失败 | 回滚记录为证据 |
| 权限越界 | 最小权限+危险操作显式确认 |
| 单点拖垮全局 | 熔断+舱壁+配额+死信 |
| Intent 歧义 | 清晰度评分+clarifying+隐含假设 |
| clarifying 无限追问 | 追问次数上限 |
| 多 Intent 冲突 | 冲突检测+仲裁器+目标矛盾问人 |
| 修订传播不彻底 | 事件驱动取消 |
| Agent 自行承诺 Intent | 硬规则：无确认不 confirmed |
| 层级过多开销大 | 小任务可跳过 Mission/Goal/Plan 层 |
| 失败传播循环 | replan 次数上限+预算约束 |
| Task DAG 设计错误 | 审批检查无环/可达/有出口/回退完整 |
| Task 并行资源冲突 | 资源依赖边+舱壁+优先级串行 |
| Task 级失败扩散 | 局部处理，不自动取消兄弟 Task |
| 能力降级误传播 | 保守阈值+半开探测+人工确认 |
| 能力版本地狱 | 精确版本+迁移路径+影子验证 |
| Cognition 评测偏差 | 按任务类型分层+最小样本量 |
| Protocol 违规未感知 | L6 强制校验+system_rule 证据 |
| Skill 依赖链过深 | 深度限制+循环检测+扁平化 |
| Behavior 过度抽象 | 可表达模式+评测对比+人工确认 |
| Behavior 副作用未测 | validated 必须测副作用率 |
| Profession 画像与实际不符 | 周期性再认证+证据驱动调整 |
| Profession 验证标准过松 | strict 职业必须有硬性验证项 |
| Profession 被绕过 | Task 必须绑定 Profession |
| Receipt 存储膨胀 | 分层存储+TTL+摘要归档 |
| Receipt 签名伪造 | 哈希+签名者+采样审计 |
| Receipt 争议无限 | 仲裁时限+上升决策 |
| Receipt 回滚过深 | 回滚深度限制+上升决策 |
| 协作协商失败 | 协商次数上限+超限 dissolved |
| 协作僵局 | stalled 超时告警+人工决策 |
| Agent 故障卡死协作 | 故障退出协议+Task 重分配 |
| 跨 Agent 证据污染 | 信任等级+回执验证+独立性判定 |
| workspace 共享冲突 | 默认隔离+锁+合并点 |
| 意图冲突自动裁决 | 硬规则：意图冲突必须问人 |
| 协作结果掩盖失败 | 部分完成显式声明+汇总者不能掩盖 |
| 通信风暴 | 通信预算+消息合并+频道限制 |
| Session 状态膨胀 | 历史压缩+摘要化+详细归档 |
| Session 恢复失败 | 重放校验+快照备份+失败告警 |
| Session 过期误删 | 过期前告警+归档而非删除+恢复窗口 |
| Turn 中断丢现场 | 中断前打快照+续接机制 |
| Turn 边界注意力抖动 | persist 规则明确+阈值滞后 |
| Turn 澄清无限 | 澄清次数上限+超限 abandoned |
| Session 预算被单 Turn 耗尽 | 单 Turn 预算上限+超支上升 |
| 多 Agent Session 路由混乱 | 主 Agent 显式+协议路由 |
| Session 跨 Turn 证据污染 | stale 检测+恢复时重评估 |
| Turn 历史压缩丢关键信息 | 活跃相关不压缩+压缩记录为证据 |
| Session 关闭时 Mission 状态不明 | 显式 paused/abandoned+记录原因 |
| 异步 Mission 跨 Turn 失控 | Session 级预算+定期检查+告警 |
| 文件 dirty 丢编辑 | unmount 需 force+记录证据 |
| 文件 stale 误读写 | 禁止 read/write，必须 reload |
| 文件跨 Agent 写冲突 | 文件锁/区域锁/版本哈希检测 |
| 文件操作绕过 Skill | 直接调用需显式理由+完整验证 |
| 审查者误写文件 | Profession 禁用能力过滤 |
| 文件 dirty 阻塞 Session 关闭 | closing 时强制处理 |

---

## 19. MVP 落地路径

### 阶段一：单 Agent 最小闭环

- **Session 最小版**：created → active → idle → closed
- **Turn 最小版**：received → interpreting → acting → responding → completed
- Intent 捕获在 Turn.interpreting
- Turn 边界：简单 persist 规则（活跃 Mission/Goal 持久化）
- Session 预算：总预算 + Turn 预算
- session_receipt + turn_receipt
- 六级串行：2–3 Task，重试上限 2
- 单 Project + 单 Workspace，3–5 核心指令契约化
- **文件对象最小版**：unmounted → mounted → active → unmounted；mount/read/outline/locate/metadata；符号节点文件+函数/类两级；版本哈希；stale 简单哈希对比；无写入
- 注意力对象：含 session_id/turn_id/persist_across_turns
- 调度：路由+聚焦+抑制，associate 深度 1，Task 串行
- 验证：Plan DAG 无环 + Task 成功标准 + 工具输出校验
- 证据最小版：对象+独立性键+审计链+Goal achieved 只认 active 操作历史证据
- 能力最小版：Tool（3–5）、Skill（3–5 固定）、Protocol（1）、Cognition（1 确定性）
- Behavior 最小版：3 个内置（先读后写、失败先看最小用例、diff 自审），registered→active
- Profession 最小版：2 个固定（developer、reviewer），defined→active，Task 绑定
- Receipt 最小版：action_receipt + task_receipt + turn_receipt + session_receipt + file_mount_receipt，issued→signed→anchored→verified→archived
- 脑图最小版：1 个 Mission/Goal/Plan/Task 层级脑图；父子边，深度 ≤ 3
- 预算：Session → Turn → Goal → Task
- 可观测性：注意力日志+token 归因+证据追踪+Task DAG 状态+Receipt 计数+脑图路径+Session/Turn 归因

### 阶段二：Task 并行 + 证据完整 + Session 恢复 + 文件写入

- Task DAG 调度器、并行度、资源冲突串行
- 证据完整生命周期 + 冲突仲裁 + 撤销传播
- 符号级大纲 + 属性节点 + 字节切片
- Project stale 检测 + 指令失败分类
- ER/架构图视图
- 事件溯源：执行+证据+Task+能力+Receipt+Profession 切换+Session/Turn 事件
- 能力完整生命周期：熔断+冷却+Protocol 版本+Cognition 评测
- Behavior 完整生命周期
- Profession 认证：评测集门槛+recertified
- Receipt disputed：争议流程+仲裁
- Intent clarifying + 多 Mission 候选 + 冲突检测
- 脑图扩展：关联边、深度 ≤ 5、stale 检测、增量重建
- Session suspended/resumed：挂起 + 恢复 + 状态校验
- Turn interrupted/resumed：中断 + 现场快照 + 续接
- Session 历史压缩：按 Turn 压缩
- persist 规则完整：按对象类型评估
- Session 级保留预算
- **文件对象完整版**：+ stale / dirty 状态；+ write / flush / reload / diff / validate / unmount(force)；+ 属性节点；AST 结构化写入+写后校验；增量失效；文件锁

### 阶段三：贝叶斯 + 视图 + 影子 + 多 Turn 协作 + 双 Agent 协作 + 文件跨对象绑定

- 正确率 Beta-Binomial + 平滑混合
- 时序图 + Venn
- 六类约束进入验证层
- 完整冲突仲裁 + superseded 修订传播
- 能力/行为/Profession 影子验证
- Cognition 按任务类型路由
- Receipt 采样审计 + 分层存储
- 脑图成熟：协作分工脑图、知识沉淀脑图、与 associate 统一
- Cooperation 跨 Turn 持续
- 多 Agent Session：主 Agent + Turn 路由
- Session 级能力/职业评测
- Session 历史脑图
- 双 Agent 协作最小闭环
- **文件对象跨对象绑定**：Receipt workspace 锚点 + 回滚；Evidence 来源 + 审计链；Session/Turn 绑定 + persist 规则；跨 Agent 冲突检测 + 合并点；Profession 约束过滤

### 阶段四：沉淀闭环 + 多 Agent 完整协作 + Session/Turn/文件高级治理

- 验证通过轨迹 → 影子 → 行为候选 → Skill 激活
- Behavior 自动抽象
- Profession 画像优化
- 特性开关灰度
- Cooperation 完整生命周期（含 conflicted/stalled/renegotiating/dissolved/aborted）
- 五种协作拓扑
- 七维度协作协议
- 跨 Agent 证据独立性判定、回执争议仲裁、Agent 信任完整调整
- 协作模板沉淀
- Mission/Goal/Task 三级协作
- 脑图高级：自动构建、评分驱动排序、重建预算控制、跨视图一致性校验
- Session 过期策略、Turn 中断策略、Session 恢复幂等性保证、Session 级沉淀
- **文件对象高级治理**：大规模文件性能优化、跨 workspace 文件引用、文件变更的语义影响分析、快照压缩与增量恢复

### 阶段五：全视图 + 大规模协作 + 大规模 Session 治理

- 多 Project/多 Workspace/多 Agent 集群
- 层级/市场/黑板拓扑
- 故障注入（Agent 故障、网络断、消息乱序、Turn 中断注入、文件冲突注入）
- 协作协议版本迁移
- 跨组织协作
- 协作性能优化
- associate 评分树 + 多维度贝叶斯 + 关系图
- CQRS 读写分离
- 证据池大规模治理
- 能力/行为/Profession/Receipt 高级治理
- Session 池管理、Session 迁移、Session 级 A/B 测试
- 大规模脑图治理：性能优化、自动重构、与知识图谱融合

---

## 20. 术语表

| 术语 | 定义 |
|---|---|
| **Session** | 用户与 Agent 交互的容器，跨 Turn、跨 Intent、跨 Mission，有生命周期、预算、状态恢复 |
| **Session 生命周期** | created → active ⇄ idle → suspended → resumed → closing → closed → archived / expired / aborted |
| **Session 状态恢复** | 从挂起/关闭恢复 Mission/Goal/Plan/Task 状态 + 未决 Intent + 预算余额 + persist 对象 |
| **Session 历史压缩** | 按 Turn 压缩旧历史，活跃相关不压缩 |
| **Session 级保留预算** | 用于跨 Turn 的 Mission/Cooperation，不占 Turn 预算 |
| **Turn** | 单次交互单元（对应传统工作流"一轮"），是 Intent 捕获的原子边界和注意力重置点 |
| **Turn 生命周期** | received → interpreting → clarifying → acting → responding → completed / interrupted / resumed / failed / abandoned |
| **Turn 边界** | Turn 完成时的注意力重置点，按 persist 规则决定对象去留 |
| **persist_across_turns** | 注意力对象是否跨 Turn 保留的标记 |
| **Turn 中断** | 用户打断/超时/外部事件导致 Turn 暂停，保留现场 |
| **Turn 续接** | 从中断恢复，检查 stale 后从断点继续 |
| **session_receipt / turn_receipt** | Session/Turn 汇总凭证 |
| **session_resume_receipt / turn_resume_receipt** | Session/Turn 恢复凭证 |
| **主 Agent** | 多 Agent Session 中的协调者，负责 Turn 路由 |
| Intent | 未承诺的原始意图 |
| Mission | 对 Intent 的正式承诺 |
| Goal | 可验证终态 |
| Plan | 策略层：Task DAG + 控制流 |
| Task | 战术层：可并行、可独立跟踪的执行单元 |
| Action | 执行层：原子操作，通过能力调用执行 |
| Task DAG | Task 的有向无环图 |
| Tool | 原子能力 |
| Skill | 组合能力 |
| Protocol | 交互约定 |
| Cognition | 推理策略 |
| Behavior | 行为模式 |
| Behavior 抽象 | 从成功轨迹模式挖掘候选，经评测对比验证；来源 = Tool/Action/Goal/Task/Plan |
| Profession | 职业角色 |
| 职业画像 | 能力偏好、验证严格度、风险偏好 |
| Receipt | 操作凭证 |
| action_receipt | 每次能力调用的回执 |
| delegation_receipt | 主 Agent 派发 Task 给子 Agent 的凭证 |
| merge_receipt | 协作结果汇总的凭证 |
| cooperation_receipt | Cooperation 整体汇总凭证 |
| arbitration_receipt | 仲裁结果凭证 |
| file_mount_receipt / file_flush_receipt / file_unmount_receipt | 文件操作凭证 |
| Agent | 协作参与者，有身份、信任、能力画像、职业画像 |
| Agent 信任等级 | 0-1 的信任分值 |
| Cooperation | 协作对象，绑定 Mission/Goal/Task |
| 协作拓扑 | 对等/主从/层级/市场/黑板 |
| 协作协议 | 七维度契约 |
| workspace 隔离模式 | isolated / shared_read / shared_write_with_lock |
| 文件对象 | Workspace 中的可读写单元，状态机 + 四类操作 + 符号节点 |
| 文件状态 | unmounted / mounted / active / stale / dirty |
| 文件访问模式 | read-only / writable（与状态正交） |
| 符号节点 | 文件内函数/类/属性节点，带行列字节 + 版本哈希定位 |
| AST 结构化重写 | 按语法树重写，非裸字节替换 |
| Capability & Behavior Registry | L0.7 治理层 |
| Profession Registry | L0.8 治理层 |
| Cooperation Registry | L0.9 治理层 |
| 注意力对象 | 上下文的组成单元 |
| focus / blur / mount / unmount / persist / update / associate / verify | 注意力 8 操作，分四组：强度/驻留/内容/关系证据 |
| Workspace | 工作现场 |
| Project | 项目知识 |
| 视图 | 关系语义的投影：ER/时序/流程/Venn/架构/脑图 |
| 脑图（Mind Map） | 中心主题 + 层级分支 + 跨分支关联的大纲视图 |
| 证据（Evidence） | 一等对象，支撑结论的可追溯输入 |
| 证据生命周期 | captured → ... → purged |
| independence_key | 独立性判定键 |
| 撤销传播 | 撤销证据 → 依赖结论重评估 |
| 审计链 | 结论记录的 evidence_ids |
| 有效样本量 | 按 independence_key 折算 |
| 证据分级 | 操作历史 > 用户确认 > 搜索 > 对话 |
| 平滑混合 | 加权与贝叶斯按证据量融合 |
| 防腐层 | 外部输入归一化 |
| 事件溯源 | 历史即真相 |
| 影子/金丝雀 | 先影子跑再启用 |
| 熔断 | 连续失败降级 |
| 死信队列 | 不可回退失败的人工队列 |

---

## 文档结束

本架构的核心一句话：

> **以注意力为调度核心，Session 为交互容器，Turn 为交互原子（对应传统"一轮"），六级生命周期（Intent→Mission→Goal→Plan→Task→Action）管理"意图到执行"；六类一等对象贯穿全链路——能力（Tool/Skill/Protocol/Cognition）、行为（Behavior）、职业（Profession）、证据（Evidence）、回执（Receipt）、协作（Cooperation+Agent），每类都有完整生命周期、独立评测、冲突仲裁、降级传播、版本迁移；文件对象作为 Workspace 的可读写单元，有完整状态机（unmounted/mounted/active/stale/dirty）、四类操作、符号节点定位安全和 AST 结构化写入；六种视图（ER/时序/流程/Venn/架构/脑图）作为关系语义投影横切融入，渲染对 Agent 隐藏、约束下沉确定性验证器；Session 跨 Turn 保持状态，支持挂起恢复和预算池化；Turn 是 Intent 捕获边界、注意力重置点、中断续接单元、预算结算单位；Profession 画像驱动能力选择与验证标准，Receipt 作为操作凭证支撑审计回滚争议，Cooperation 通过 Agent 身份与信任、五种拓扑、七维度协议、跨 Agent 共享/隔离、冲突仲裁与收敛机制，把单 Agent 治理扩展到多 Agent 协作；Project 管项目知识、Workspace 管工作现场；证据三级分级+跨 Agent 信任调制，加权冷启动、贝叶斯收敛、平滑混合；用事件溯源做历史真相，用熔断/影子/可观测性做安全阀和度量；只把验证通过且证据链、回执链完整的轨迹沉淀为可激活的 Skill、Behavior、协作模板和 Session/Turn 模式。MVP 先跑通单 Agent 最小闭环（含最小 Session/Turn/文件对象），再逐步加 Task 并行、证据完整生命周期、Session 恢复、Turn 中断、文件写入、能力/行为/职业生命周期、Receipt 争议、双 Agent 协作、多 Agent 完整协作、脑图扩展、多视图约束、贝叶斯和行为沉淀。**