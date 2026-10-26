# 内核：进程、线程、句柄与权限

> 状态：v0.2 草案。实现位于 `src/process/`、`src/thread/`、`src/kernel/`、`src/concurrency/`、`src/store/`。

## 0. 一句话

把 **agent 作为进程**（持久存在，拥有预算、记忆与能力），把**任务/目标作为线程**（agent 调度的可完成工作单元）；隔离靠**能力（capability）**而不是地址空间；多 worker 的并发靠 **SQLite 原子认领 + fencing lease**。

这是逻辑内核，不是操作系统：它提供命名、记账、调度与撤销，不提供硬件隔离。真正的沙箱仍然要一个 agent 一个 OS 进程/容器。

## 1. 对象与所有权

| 对象 | 对应 | 所有者 | 生命周期 |
| --- | --- | --- | --- |
| **Process** | **agent**（持续存在的执行者） | 自己 | `created → running → idle ⇄ running → suspended → terminated` |
| **Thread** | **任务/目标**（agent 正在做的一件事） | 进程 | `ready → running → blocked → done/failed/abandoned` |
| **Process object** | 不可变的 claim/evidence/frame，属于 agent 的记忆 | 进程（地址空间） | 只追加 |
| **Capability** | 句柄：subject + resource + rights + expiry | 授予者 | 可转授、可过期、可递归撤销 |
| **Mailbox** | agent 之间的消息队列 | 接收方进程 | 有界，投递一次 |
| **Worker** | 一个内核实例 | 自己 | 注册、心跳、过期回收 |

**同一 agent 的任务之间共享**：agent 预算、记忆/地址空间、能力表。
**任务私有**：上下文窗口、当前焦点、调度状态。
**agent 之间**：默认不共享；只能通过显式 `grant` 把对象/邮箱/预算的能力授予另一个 agent。

这对应 CPU 的模型：一个 agent（进程）一次只跑一个任务（线程），任务完成或阻塞后切换到下一个；agent 本身不因任务结束而消失。

## 2. 调度

- 可运行集合：`threads.state = 'ready'` 且 agent 处于 `created/idle/running`，按 `priority DESC, tid ASC` 选取。
- **原子认领**：`UPDATE threads SET state='running', owner_worker=?, lease=lease+1 WHERE tid=? AND state='ready'`；`changes=1` 才算拿到。
- **一个 agent 一个运行任务**：`threads_one_running_per_process` 唯一索引保证同一 `pid` 至多一个 `running` 线程。
- **Fencing lease**：认领返回 `lease`；提交时 `owner_worker` 与 `lease` 必须同时匹配，否则 `lease_lost`。
- **预算**：先扣任务线程的 slice，再扣 agent 的总预算；任务超限 → 任务失败，agent 回到 `idle`；agent 超限 → agent `suspended`，当前任务失败。
- **完成**：任务结束写 `outcome=success|failure` 回执；agent 回到 `idle`，不因任务结束而终止。终止 agent 是显式的 `terminateProcess`。
- **睡眠/阻塞**：`wake_at` 到点唤醒；`blocked_on` 由条件通知唤醒（mailbox / blackboard）。
- **故障恢复**：worker 心跳过期后，其 `running` 任务被重新入队并递增 lease；agent 置 `idle`，不假装恢复栈。

## 3. 线程安全（多 worker）

Node 的事件循环是单线程的，但 `worker_threads` 可以共享同一个 SQLite 文件。因此正确性依赖数据库，而不是内存锁：

| 机制 | 作用 |
| --- | --- |
| `PRAGMA journal_mode=WAL` | 多读者 + 单写者 |
| `PRAGMA busy_timeout=5000` | 写锁竞争时等待而不是立即失败 |
| `BEGIN IMMEDIATE` | 提交阶段先拿写锁，避免读后写升级死锁 |
| 条件 UPDATE | 认领、状态转移、撤销都以 `WHERE` 里的旧状态为准 |
| `lease` | 过期 worker 的写被拒绝（fencing） |
| `workers` 心跳 | 判断谁还活着；过期才允许回收 |
| `idempotency` 表 | 外部副作用重试只执行一次 |
| `Mutex` / `NamedLocks` | **进程内**串行化；不能跨 worker |
| 每 worker 一个连接 | 不共享 `DatabaseSync` 实例 |

`src/structure/` 的容器不是线程安全的：堆、双端队列、LRU 只能作为 **worker 本地缓存**，且不得成为正确性来源。当前已接：`UnorderedMap`（NamedLocks、Proxy 缓存、证据图）、`LRUUnorderedMap`（上下文窗口、实体缓存）、`BinaryHeap`（mission 队列）、`UnorderedSet`（队列成员/证据邻接）、`Stack`（证据环检测）。双端队列、过滤器与线段树留给 mailbox、幂等预筛与预算聚合。

## 4. 权限与隔离

隔离不是「查的时候加个 if」，而是三条规则：

1. **默认拒绝**：跨 subject 访问必须有一条 live capability。
2. **所有权隐式**：进程对自己的对象、线程、邮箱拥有全部权限；host 是唯一超级主体。
3. **授予只能衰减**：`rights` 是授予者权限的子集，`expires_at` 不得晚于授予者，撤销沿 `parent_hid` 递归生效。

资源粒度：`object`、`process`、`thread`、`mailbox`、`budget`。
动作粒度：`read`、`write`、`append`、`grant`、`revoke`、`spawn`、`kill`、`send`、`receive`。

已实现：能力表、`grant/revoke`（权限衰减、过期、递归撤销、审计事件）、地址空间 `attach/read/write`、`fork/join`、mailbox（容量 + 投递回执 + 条件唤醒）、原子认领、lease、恢复、幂等、进程内锁、窗口接入 step。
待实现：`deque` 邮箱缓冲（当前 mailbox 直接走 SQL）、定时器堆、真实 `worker_threads` 端到端。

**诚实边界**：进程表是逻辑隔离，不是 MMU。若 agent 运行不可信代码，必须落到 OS 进程/容器，本内核只做账本与调度。

## 5. 不变量

- **K-1** 一个 agent（进程）同一时刻最多一个运行中的任务（部分唯一索引）。
- **K-2** 任务只能被一个 worker 以匹配的 lease 提交。
- **K-3** 任务结束必须有一条 success/failure 回执；agent 本身不因任务结束而终止。
- **K-4** 预算在提交时扣：先任务 slice，后 agent 总预算；超限失败而不是截断。
- **K-5** 过期 worker 的任务只能被回收，不能被续跑。
- **K-6** 每个外部副作用有幂等键；重试不重复执行。
- **K-7** agent 默认看不到另一个 agent 的对象；共享必须显式授予。
- **K-8** 撤销父能力使所有子能力失效。
- **K-9** 终态（done/failed/abandoned/terminated）没有出边。
- **K-10** 崩溃恢复只重排 `running` 任务并把 agent 置 `idle`，不伪造未提交的步骤。

## 6. 与协议的关系

- `Receipt` 是每个 step 的结算对象；`target` 指向任务（thread），`usage` 记录预算。
- `Frame` 是任务的上下文快照；由 `StepContext` 携带，任务窗口的页表落在 `window_pages`。
- `Warrant` 对象进入 agent 的记忆（`process_objects`），跨 agent 共享必须走 capability。
- 协议再定位：内核只负责**语义与证据**；传输仍走 A2A/MCP。

## 7. 窗口、缓存与数据库分层

- **database**：`entity` / `repository` / `service` / `sql` / `store` 五层；每个 service 与一个 entity 一一对应（object、process、thread、handle、message、worker、step、window）。
- **store**：`Proxy` 读穿缓存 + `LRUUnorderedMap` + `UnorderedMap` 记录 TTL；上限可配，失效显式。它不是响应式状态库，`configureStore` 切换数据库时自动重建。
- **window**：`ContextWindow` 以 token 为容量，页是 claim/evidence/frame/tool-result 的引用；`fault` 触发加载与 LRU 驱逐，`pin` 防止被驱逐，`assembleContext` 按预算装配并显式列出 `excluded`。
- **wiring**：`Kernel.step` 在 handler 前从 `window_pages` 恢复窗口，handler 之后在同一事务里写回；handler 可通过 `StepContext.window` 访问。寻址空间方面，`attachObject` 映射对象，`readProcessObject` 对 `mapped` 页检查 capability，`forkProcess` 只继承只读视图，`joinProcess` 合并子进程自己的对象。
- **mailbox**：`Mailbox.send` 要求接收方 mailbox 的 `send` 能力，容量满时抛 `mailbox_full`；`receive` 写 `read` 回执并唤醒 `mailbox:<pid>` 条件。
- **agent facets**：`process` 就是 agent/person；`src/process/agent.ts` 拥有 profile、self narrative、roles、memories、affect、background、life events，`src/context/agentContext.ts` 按预算装配。`Kernel.step` 通过 `KernelOptions.agentContext` 注入 `StepContext.agentContext`，不依赖具体存储；`src/ipc/social.ts` 拥有 relationship/institution/membership。

## 8. 注册表：概念与模块即数据

目录结构不是证据。`concepts`、`modules`、`module_concepts`、`module_dependencies`、`attestations` 五张表把概念与模块变成可查询、可追溯的行：

- `declareConcept/declareModule` 每次声明都写一条 `concept.<id>.v<n>` / `module.<id>.v<n>` 对象，行里保留 `version`、`object_seq`、`digest`。重复声明自动升版本，不改写历史。
- `contentDigest` 是模块目录的内容摘要（排序后的文件清单再哈希）。`verifyModuleContent` 重算并报告漂移，因此声明绑定的是实际代码，不只是路径。
- `linkConcept` 记录模块与概念的关系（`owns/uses/constrains/implements`），并拒绝悬空引用。
- `linkDependency` 记录模块依赖，插入后立即检查环；`hasDependencyCycle` 用 `UnorderedMap`/`UnorderedSet`/`Stack` 做 DFS，环上的边会被回滚。
- `attest` 把注册表行与一条 `claim` 绑定，写入 `evidence` 对象和 `attestations` 行，因此“这个模块存在/由它负责”是可被证据支持的主张。
- `verifyRegistry` 重算对象链，逐行核对 object 的 id/version/digest/contentDigest，检查关系、依赖与证明是否悬空或成环。
- `tools/registry-check.ts` 扫描 `src/` 的每个目录注册为模块（带内容摘要）、注册核心概念、建立关系与依赖、做 attestation，并测试漂移与环检测。

这意味着新增一个模块时，**除了建目录，还要有注册记录、内容摘要和声明对象**；`registry-check` 会让“漏注册/改了代码没更新声明”变成 CI 失败，而不是口头约定。
